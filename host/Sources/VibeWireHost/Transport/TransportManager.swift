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
        /// The port the host is serving on, so a client can build an origin out
        /// of the addresses below without being told separately.
        var port: UInt16 = 8787

        /// Every origin this Mac can be reached on, in the order a phone should
        /// try them.
        ///
        /// The tailnet first: it is a direct route where a direct route exists,
        /// and it falls back to DERP rather than to nothing. The LAN address
        /// next, since it answers only at home but answers fastest there. The
        /// Cloudflare tunnel last, because it is a round trip through Cloudflare
        /// — and it is on the list at all because it is the one address that
        /// answers from a phone with no Tailscale and no Wi-Fi.
        ///
        /// A client stores the whole list. One address is what made the phone
        /// work on exactly the network it was paired on.
        var candidates: [String] {
            var origins: [String] = []
            if let tailscale = tailscaleAddress { origins.append("http://\(tailscale):\(port)") }
            if let lan = lanAddress { origins.append("http://\(lan):\(port)") }
            if cloudflareRunning, let tunnel = cloudflareHostname {
                origins.append(tunnel.hasSuffix("/") ? String(tunnel.dropLast()) : tunnel)
            }
            return origins
        }

        /// The address to hand out when only one can be given.
        ///
        /// The tunnel wins here even though it is last in `candidates`, and the
        /// two are not in disagreement: a client that can hold a list should
        /// prefer the fast path and fall back, while a client that gets one
        /// address should get the one that works from anywhere. A browser opened
        /// from an `https` page is the second kind and cannot open an `http`
        /// address at all.
        var preferredOrigin: String? {
            if cloudflareRunning, let tunnel = cloudflareHostname {
                return tunnel.hasSuffix("/") ? String(tunnel.dropLast()) : tunnel
            }
            return candidates.first
        }

        var wire: [String: Any] {
            var payload: [String: Any] = [
                "t": "transport",
                "path": path.rawValue,
                "tailscaleRunning": tailscaleRunning,
                "cloudflareRunning": cloudflareRunning,
                "port": Int(port),
                "candidates": candidates,
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
    private var lastRefresh: Date?

    /// The same child process, reachable without going through the actor.
    ///
    /// `applicationWillTerminate` gets one synchronous moment before the process
    /// is gone, and an `await` does not survive it: the teardown hop was
    /// scheduled and the host exited first, so every restart left a cloudflared
    /// running — a public endpoint to this Mac, owned by nothing, accumulating
    /// one per launch. This box is what termination can reach in that moment.
    private let liveTunnel = Guarded<Process?>(nil)
    private let port: UInt16
    /// cloudflared's own metrics server, pinned rather than left to the random
    /// port it picks otherwise. `/quicktunnel` on it reports the hostname the
    /// tunnel is actually serving, which is the authoritative answer — see
    /// `quickTunnelHostname()`.
    private let metricsPort: UInt16
    /// Whether the cloudflared on `metricsPort` is the one this host started.
    private var metricsOwned = false

    init(port: UInt16) {
        self.port = port
        self.metricsPort = port &+ 2
    }

    func status() -> Status { cached }

    /// Refreshes unless it was done in the last `interval` seconds.
    ///
    /// The full refresh forks `tailscale status --json`, so it is not something
    /// to do on a one-second heartbeat. It is also not something that can be
    /// left to the heartbeat's *socket*, which is where it lived: `tick()`
    /// returns early when no phone is connected, so a host sitting idle kept
    /// whatever addresses it had a second after launch — before the tunnel it
    /// had just started had finished coming up. The QR then handed out an
    /// address the phone could not use, which is the failure this is under.
    func refreshIfStale(after interval: TimeInterval = 10) async {
        if let lastRefresh, Date().timeIntervalSince(lastRefresh) < interval { return }
        await refresh()
    }

    func noteContact() {
        cached.lastContact = Date()
    }

    // MARK: Refresh

    func refresh() async {
        var next = cached
        next.port = port
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

        // A tunnel that died stays dead otherwise, and nothing says so: the
        // relay switch reads on, the status pane reads on, and the only symptom
        // is that the phone stops answering to anything but the LAN.
        if let existing = cloudflared, !existing.isRunning {
            Log.warn(.transport, "cloudflare tunnel exited; restarting")
            cloudflared = nil
            cloudflareHostname = nil
            if Config.loadSettings().relayOverInternet {
                await startCloudflareTunnel()
            }
        }

        next.cloudflareRunning = cloudflared?.isRunning ?? false
        // Asked of cloudflared rather than remembered from its output. The
        // hostname used to be scraped once out of the startup banner, which
        // makes the whole relay path depend on a log line arriving in one piece:
        // a chunk boundary in the middle of the URL, or a tunnel that reconnects
        // under a new name, and the host advertises a plain `http` IP address
        // for the rest of its life while a perfectly good tunnel is up. Every
        // client then gets an address it cannot use from anywhere but the LAN,
        // and a browser on an `https` page cannot use it at all.
        if next.cloudflareRunning, let live = await quickTunnelHostname() {
            cloudflareHostname = live
        }
        if !next.cloudflareRunning { cloudflareHostname = nil }
        next.cloudflareHostname = cloudflareHostname

        cached = next
        lastRefresh = Date()
    }

    /// The hostname cloudflared says it is serving, read from its metrics server.
    ///
    /// Only asked when this host is the one that put a cloudflared on that port.
    /// A tunnel outlives its host when the host is killed rather than quit, and
    /// the orphan keeps the metrics port — so a host that asked without checking
    /// would read a hostname belonging to a *different* tunnel, pointing at a
    /// process that may not be serving any more, and hand it out on the QR as
    /// its own. Silently advertising someone else's address is the exact failure
    /// this whole path exists to end.
    private func quickTunnelHostname() async -> String? {
        guard metricsOwned,
              let url = URL(string: "http://127.0.0.1:\(metricsPort)/quicktunnel")
        else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        guard let (data, response) = try? await URLSession.shared.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200,
              let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let hostname = body["hostname"] as? String,
              !hostname.isEmpty
        else { return nil }
        let origin = hostname.contains("://") ? hostname : "https://\(hostname)"
        if origin != cloudflareHostname {
            Log.info(.transport, "cloudflare tunnel serving \(origin)")
        }
        return origin
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

        // Whoever is already on that port is not ours, and the hostname it would
        // report is not ours either. cloudflared is left to pick its own port in
        // that case and the startup banner is the only source — which is what
        // this was before, so nothing is lost but the certainty.
        metricsOwned = Self.portIsFree(metricsPort)
        if !metricsOwned {
            Log.warn(.transport, "metrics port \(metricsPort) is taken — probably an orphaned "
                + "cloudflared from a host that was killed rather than quit; "
                + "reading the tunnel hostname from its output instead")
        }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: binary)
        process.arguments = [
            "tunnel",
            "--no-autoupdate",
            "--url", "http://127.0.0.1:\(port)",
        ]
        if metricsOwned {
            // Left to itself cloudflared picks a random metrics port, and the
            // hostname it is serving can then only be had by reading its log.
            // Pinned, `refresh()` can ask it outright.
            process.arguments?.append(contentsOf: ["--metrics", "127.0.0.1:\(metricsPort)"])
        }

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
            liveTunnel.withLock { $0 = process }
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

    /// True when nothing holds `port` on loopback right now.
    ///
    /// Asked by binding it, because that is the only answer that is not a guess.
    /// The port is released immediately and handed to cloudflared, which is a
    /// race in theory and has one contender in practice.
    private static func portIsFree(_ port: UInt16) -> Bool {
        let fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP)
        guard fd >= 0 else { return false }
        defer { close(fd) }

        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = port.bigEndian
        address.sin_addr.s_addr = inet_addr("127.0.0.1")

        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        return bound == 0
    }

    /// Kills the tunnel synchronously, from wherever the caller happens to be.
    ///
    /// The one thing `applicationWillTerminate` can do about a child process.
    /// Callable from outside the actor precisely because reaching the actor is
    /// what the exiting process has no time left to do.
    nonisolated func terminateTunnelNow() {
        liveTunnel.withLock { process in
            if let process, process.isRunning { process.terminate() }
            process = nil
        }
    }

    func stopCloudflareTunnel() {
        guard let cloudflared else { return }
        if cloudflared.isRunning { cloudflared.terminate() }
        liveTunnel.withLock { $0 = nil }
        metricsOwned = false
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
