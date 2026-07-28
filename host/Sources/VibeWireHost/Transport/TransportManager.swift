import Foundation
import Network
import os

/// Knows how the phone is reaching this Mac, and keeps the fallback path alive.
///
/// Tailscale is primary: on the same Wi-Fi it takes the direct LAN route, and
/// from cellular it either punches through NAT or falls back to a DERP relay.
/// Cloudflare Tunnel is the secondary path for the case where Tailscale is not
/// running on the phone at all.
///
/// The real value here is honesty. Screen 02D lists both transports with their
/// own verdict rather than one vague "offline", and this is where those
/// verdicts come from.
actor TransportManager {
    enum Path: String, Sendable {
        case direct     // peer-to-peer, usually LAN
        case relay      // DERP or Cloudflare edge
        case none
    }

    struct Status: Sendable {
        var tailscaleRunning: Bool
        var tailscaleAddress: String?
        var tailscaleDNSName: String?
        var path: Path
        var relayName: String?
        var peerLatencyMillis: Double?
        var cloudflareRunning: Bool
        var cloudflareHostname: String?
        var lanAddress: String?
        var lastContact: Date?

        var wire: [String: Any] {
            var payload: [String: Any] = [
                "t": "transport",
                "path": path.rawValue,
                "tailscaleRunning": tailscaleRunning,
                "cloudflareRunning": cloudflareRunning,
            ]
            payload["tailscaleAddress"] = tailscaleAddress
            payload["tailscaleDNSName"] = tailscaleDNSName
            payload["relayName"] = relayName
            payload["peerLatencyMillis"] = peerLatencyMillis.map { ($0 * 10).rounded() / 10 }
            payload["cloudflareHostname"] = cloudflareHostname
            payload["lanAddress"] = lanAddress
            payload["lastContact"] = lastContact.map(ISO8601DateFormatter().string(from:))
            return payload
        }
    }

    private var cached = Status(
        tailscaleRunning: false,
        tailscaleAddress: nil,
        tailscaleDNSName: nil,
        path: .none,
        relayName: nil,
        peerLatencyMillis: nil,
        cloudflareRunning: false,
        cloudflareHostname: nil,
        lanAddress: nil,
        lastContact: nil
    )

    private var cloudflared: Process?
    private var cloudflareHostname: String?
    private let port: UInt16

    init(port: UInt16) {
        self.port = port
    }

    func status() -> Status { cached }

    func noteContact() {
        cached.lastContact = Date()
    }

    // MARK: Refresh

    func refresh() async {
        var next = cached
        next.lanAddress = Self.primaryLANAddress()

        if let tailscale = await Self.tailscaleStatus() {
            next.tailscaleRunning = tailscale.running
            next.tailscaleAddress = tailscale.address
            next.tailscaleDNSName = tailscale.dnsName
            next.path = tailscale.activePeerIsDirect == nil
                ? (tailscale.running ? .direct : .none)
                : (tailscale.activePeerIsDirect! ? .direct : .relay)
            next.relayName = tailscale.relay
            next.peerLatencyMillis = tailscale.latencyMillis
        } else {
            next.tailscaleRunning = false
            next.tailscaleAddress = nil
            next.path = next.cloudflareRunning ? .relay : .none
        }

        next.cloudflareRunning = cloudflared?.isRunning ?? false
        next.cloudflareHostname = cloudflareHostname

        cached = next
    }

    // MARK: Tailscale

    private struct TailscaleInfo {
        var running: Bool
        var address: String?
        var dnsName: String?
        var relay: String?
        var latencyMillis: Double?
        /// nil when no peer is actively connected.
        var activePeerIsDirect: Bool?
    }

    static func tailscaleBinary() -> String? {
        let candidates = [
            "/Applications/Tailscale.app/Contents/MacOS/Tailscale",
            "/usr/local/bin/tailscale",
            "/opt/homebrew/bin/tailscale",
        ]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    private static func tailscaleStatus() async -> TailscaleInfo? {
        guard let binary = tailscaleBinary() else { return nil }
        guard let output = await runCapturing(binary, ["status", "--json"], timeout: 3) else {
            return nil
        }
        guard let root = try? JSONSerialization.jsonObject(with: output) as? [String: Any]
        else { return nil }

        let backendState = root["BackendState"] as? String ?? "Stopped"
        let running = backendState == "Running"

        var info = TailscaleInfo(
            running: running,
            address: nil,
            dnsName: nil,
            relay: nil,
            latencyMillis: nil,
            activePeerIsDirect: nil
        )

        if let this = root["Self"] as? [String: Any] {
            info.address = (this["TailscaleIPs"] as? [String])?.first
            // DNSName arrives fully qualified with a trailing dot.
            info.dnsName = (this["DNSName"] as? String)?
                .trimmingCharacters(in: CharacterSet(charactersIn: "."))
        }

        // Find the most recently active peer. That is the phone, when it is
        // connected, and it carries the direct-vs-relay answer.
        if let peers = root["Peer"] as? [String: [String: Any]] {
            var best: (active: Bool, lastSeen: Date, peer: [String: Any])?
            for (_, peer) in peers {
                let active = peer["Active"] as? Bool ?? false
                let lastSeenString = peer["LastSeen"] as? String ?? ""
                let lastSeen = ISO8601DateFormatter().date(from: lastSeenString) ?? .distantPast
                if best == nil || (active && !best!.active)
                    || (active == best!.active && lastSeen > best!.lastSeen) {
                    best = (active, lastSeen, peer)
                }
            }

            if let best, best.active {
                // CurAddr is populated only on a direct connection. When it is
                // empty and Relay names a DERP region, traffic is relayed.
                let currentAddress = (best.peer["CurAddr"] as? String) ?? ""
                let relay = (best.peer["Relay"] as? String) ?? ""
                info.activePeerIsDirect = !currentAddress.isEmpty
                info.relay = relay.isEmpty ? nil : relay
            }
        }

        return info
    }

    // MARK: Cloudflare Tunnel

    static func cloudflaredBinary() -> String? {
        let candidates = [
            "/opt/homebrew/bin/cloudflared",
            "/usr/local/bin/cloudflared",
        ]
        return candidates.first { FileManager.default.isExecutableFile(atPath: $0) }
    }

    /// Starts a quick tunnel and captures the hostname cloudflared prints.
    ///
    /// This path is only started when the user turns on "Relay over internet"
    /// in Settings, because it does create a publicly reachable endpoint. The
    /// device handshake is what defends it.
    func startCloudflareTunnel() async {
        guard cloudflared == nil else { return }
        guard let binary = Self.cloudflaredBinary() else {
            Log.warn(.transport, "cloudflared not installed; relay unavailable")
            return
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: binary)
        process.arguments = [
            "tunnel",
            "--no-autoupdate",
            "--url", "http://127.0.0.1:\(port)",
        ]

        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe

        pipe.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else { return }
            let text = String(decoding: chunk, as: UTF8.self)
            // cloudflared announces the hostname in a banner line.
            if let range = text.range(of: #"https://[a-z0-9-]+\.trycloudflare\.com"#,
                                      options: .regularExpression) {
                let hostname = String(text[range])
                Task { await self?.noteCloudflareHostname(hostname) }
            }
        }

        do {
            try process.run()
            cloudflared = process
            Log.info(.transport, "cloudflare tunnel starting")
        } catch {
            Log.error(.transport, "failed to start cloudflared: \(error)")
        }
    }

    private func noteCloudflareHostname(_ hostname: String) {
        guard cloudflareHostname != hostname else { return }
        cloudflareHostname = hostname
        cached.cloudflareHostname = hostname
        cached.cloudflareRunning = true
        Log.info(.transport, "cloudflare tunnel live at \(hostname)")
    }

    func stopCloudflareTunnel() {
        guard let cloudflared else { return }
        if cloudflared.isRunning { cloudflared.terminate() }
        self.cloudflared = nil
        cloudflareHostname = nil
        cached.cloudflareRunning = false
        cached.cloudflareHostname = nil
        Log.info(.transport, "cloudflare tunnel stopped")
    }

    // MARK: Helpers

    /// The address to show in the menu bar for a plain LAN connection.
    private static func primaryLANAddress() -> String? {
        var addresses: [String] = []
        var pointer: UnsafeMutablePointer<ifaddrs>?
        guard getifaddrs(&pointer) == 0, let first = pointer else { return nil }
        defer { freeifaddrs(pointer) }

        var current: UnsafeMutablePointer<ifaddrs>? = first
        while let interface = current {
            defer { current = interface.pointee.ifa_next }
            let flags = Int32(interface.pointee.ifa_flags)
            guard flags & IFF_UP == IFF_UP, flags & IFF_LOOPBACK == 0 else { continue }
            guard let addr = interface.pointee.ifa_addr,
                  addr.pointee.sa_family == UInt8(AF_INET) else { continue }

            let name = String(cString: interface.pointee.ifa_name)
            // en0/en1 are Wi-Fi and Ethernet; skip utun (Tailscale) and bridges.
            guard name.hasPrefix("en") else { continue }

            var host = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            guard getnameinfo(
                addr, socklen_t(addr.pointee.sa_len),
                &host, socklen_t(host.count), nil, 0, NI_NUMERICHOST
            ) == 0 else { continue }
            addresses.append(String(cString: host))
        }
        return addresses.first
    }

    private static func runCapturing(_ path: String, _ arguments: [String], timeout: TimeInterval) async -> Data? {
        await withCheckedContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: path)
            process.arguments = arguments
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = FileHandle.nullDevice

            // A hung `tailscale status` must not wedge the status poller.
            let timer = DispatchSource.makeTimerSource(queue: .global())
            timer.schedule(deadline: .now() + timeout)

            // Both the timeout and the termination handler race to finish this
            // continuation; resuming twice would trap, so the first one wins.
            let resumed = Guarded(false)
            let finish: @Sendable (Data?) -> Void = { data in
                let alreadyResumed = resumed.withLock { state -> Bool in
                    defer { state = true }
                    return state
                }
                guard !alreadyResumed else { return }
                timer.cancel()
                continuation.resume(returning: data)
            }

            timer.setEventHandler {
                if process.isRunning { process.terminate() }
                finish(nil)
            }
            timer.resume()

            process.terminationHandler = { _ in
                let data = pipe.fileHandleForReading.readDataToEndOfFile()
                finish(data.isEmpty ? nil : data)
            }

            do {
                try process.run()
            } catch {
                finish(nil)
            }
        }
    }
}
