import Foundation
import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
import CoreGraphics

/// The Mac's own window onto itself: `/dashboard/<key>` and `/v1/dashboard/…`.
///
/// This is the whole control surface of the host — pairing, revoking, capture,
/// settings, the log — so the first thing it does with any request is check the
/// launch key, and the second is refuse everything else. The port is reachable
/// over the tailnet by design and the host speaks plain HTTP by design, so
/// "only this Mac can reach it" is not a claim this file is allowed to make.
///
/// It answers by polling rather than over a socket. The dashboard is on the
/// same machine as the host, a second apart is what most of these readings are
/// worth anyway — the heartbeat that produces them runs at 1 Hz — and every
/// value that genuinely streams (Claude's output) arrives through `events`,
/// which is a cursor over the same messages the phone's socket receives, not a
/// second description of them.
actor DashboardService {
    private weak var router: HostRouter?
    private let trust: TrustStore
    private let pairing: PairingService
    private let catalog: DisplayCatalog
    private let transport: TransportManager
    private let telemetry: Telemetry
    private let system: SystemServices

    /// The bundle, when one was built. Same three-place resolution as the web
    /// client's — see `Config.dashboardRoot`.
    private let assets = WebAssets(root: Config.dashboardRoot)

    /// Measured once. Walking the bundle directory on every state poll would be
    /// a directory enumeration a second for a number that changes when someone
    /// runs a build.
    private var webBundleBytes: Int?
    private var dashboardBundleBytes: Int?

    /// The last answer the keychain gave, and whether one is being asked for.
    ///
    /// The trust store is never awaited on the request path. `TrustStore` says
    /// in its own notes that the first read after a rebuild can take tens of
    /// seconds — macOS puts up a SecurityAgent prompt and the read only returns
    /// once that is settled — and a state poll that waited for it would hang
    /// every second of that behind a window drawing nothing at all. So this
    /// serves the last answer and asks for a fresh one behind it, which is the
    /// shape the menu bar already uses for the same store and the same reason.
    ///
    /// Three states, not two. `nil` is "never asked", `.failure` is "the
    /// keychain did not answer", and an empty array is "nothing paired" — the
    /// middle one being the fact a blank list would print as the last one.
    private var lastDevices: Result<[TrustedDevice], Error>?
    private var devicesRefresh: Task<Void, Never>?

    /// The host's own key fingerprint, which costs the same keychain read and
    /// is therefore fetched the same way.
    private var hostIdCache: String?
    private var hostIdRefresh: Task<Void, Never>?

    init(
        router: HostRouter,
        trust: TrustStore,
        pairing: PairingService,
        catalog: DisplayCatalog,
        transport: TransportManager,
        telemetry: Telemetry,
        system: SystemServices
    ) {
        self.router = router
        self.trust = trust
        self.pairing = pairing
        self.catalog = catalog
        self.transport = transport
        self.telemetry = telemetry
        self.system = system
    }

    // MARK: Routing

    /// The response for anything the dashboard owns, or nil to let the request
    /// fall through to the web client.
    func response(for request: HTTPRequest) async -> HTTPResponse? {
        if request.path.hasPrefix("/v1/dashboard/") {
            guard authorised(request) else { return .error(401, "unauthorized") }
            return await api(request)
        }
        if request.path == "/dashboard" || request.path.hasPrefix("/dashboard/") {
            return bundle(request)
        }
        return nil
    }

    /// Constant-time, because the key is a secret compared on every request and
    /// the endpoint may be reachable from another machine on the tailnet.
    private func authorised(_ request: HTTPRequest) -> Bool {
        guard let presented = request.header("x-vibewire-dashboard") ?? request.query["k"]
        else { return false }
        return Self.constantTimeEqual(presented, Config.dashboardKey)
    }

    private static func constantTimeEqual(_ lhs: String, _ rhs: String) -> Bool {
        let a = Array(lhs.utf8), b = Array(rhs.utf8)
        guard a.count == b.count else { return false }
        var difference: UInt8 = 0
        for index in 0..<a.count { difference |= a[index] ^ b[index] }
        return difference == 0
    }

    // MARK: The bundle

    /// `/dashboard/<key>` and everything under it.
    ///
    /// A wrong key gets 404 rather than 403. There is no useful distinction to
    /// draw for a caller who is guessing, and 403 would confirm that the path
    /// exists — which is the one thing a guess learns for free otherwise.
    private func bundle(_ request: HTTPRequest) -> HTTPResponse {
        guard request.method == "GET" else { return .error(404, "not_found") }

        let prefix = "/dashboard/\(Config.dashboardKey)"
        guard request.path == prefix || request.path.hasPrefix(prefix + "/") else {
            return .error(404, "not_found")
        }

        // The trailing slash is load-bearing, which is not obvious and is worth
        // enforcing here rather than trusting every caller to get right.
        //
        // The bundle is built with `base: './'` — it has to be, since the key in
        // the path changes every launch and no absolute base could ever be
        // correct. A relative `./assets/…` resolves against the *directory* of
        // the document URL, so at `/dashboard/<key>` it resolves to
        // `/dashboard/assets/…`, drops the key, and 404s: a window that loads
        // and then draws nothing at all.
        if request.path == prefix {
            return HTTPResponse(
                status: 308,
                headers: ["Location": prefix + "/"],
                body: Data()
            )
        }
        guard let assets else {
            return HTTPResponse(
                status: 503,
                headers: ["Content-Type": "text/html; charset=utf-8"],
                body: Data(Self.noBundlePage.utf8)
            )
        }

        var remainder = String(request.path.dropFirst(prefix.count))
        if remainder.isEmpty { remainder = "/" }
        return assets.response(for: remainder) ?? .error(404, "not_found")
    }

    /// What a host with no dashboard build says, in the one place it can say
    /// it: the window that just opened onto nothing.
    ///
    /// Plain HTML rather than the design system, deliberately — this is the
    /// case where the design system's stylesheet is exactly what is missing.
    private static let noBundlePage = """
    <!doctype html><meta charset="utf-8"><title>VibeWire</title>
    <style>
      body { margin:0; display:grid; place-items:center; min-height:100vh;
             background:#0F1114; color:#F2F3F6; font:15px/1.5 -apple-system, system-ui, sans-serif }
      div { max-width:34rem; padding:2rem }
      code { font:13px ui-monospace, SFMono-Regular, Menlo, monospace; color:#96ADFF }
      p { color:#A5A9B1 }
    </style>
    <div>
      <h1>No dashboard build on this host</h1>
      <p>The host is serving normally &mdash; pairing, the socket and the web client are
      unaffected. This window has nothing to draw because <code>web/dist-dashboard</code>
      does not exist yet.</p>
      <p>Build it with <code>npm ci &amp;&amp; npm run build:dashboard</code> in <code>web/</code>,
      then reopen this window. No restart is needed.</p>
    </div>
    """

    // MARK: The API

    private func api(_ request: HTTPRequest) async -> HTTPResponse {
        switch (request.method, request.path) {
        case ("GET", "/v1/dashboard/state"):
            return .json(200, await state())

        case ("GET", "/v1/dashboard/events"):
            let since = Int(request.query["since"] ?? "") ?? 0
            guard let router else { return .error(503, "router_gone") }
            let drained = router.drainEvents(since: since)
            return .json(200, [
                "next": drained.next,
                "dropped": drained.dropped,
                "messages": drained.messages,
            ])

        case ("GET", "/v1/dashboard/snapshot"):
            return snapshot(request)

        case ("GET", "/v1/dashboard/qr"):
            return await qr(request)

        case ("POST", "/v1/dashboard/command"):
            return await command(request)

        default:
            return .error(404, "not_found")
        }
    }

    // MARK: State

    // swiftlint:disable:next function_body_length
    private func state() async -> [String: Any] {
        let facts = router?.facts
        let displays = await catalog.refresh()
        let status = await transport.status()
        let link = await telemetry.snapshot()
        let progress = await pairing.currentProgress()
        let code = await pairing.currentCode()
        let lockout = await pairing.lockoutRemaining

        refreshTrustInBackground()
        var devices = try? lastDevices?.get()
        // A device that has just paired is in the store but not yet in this
        // cache: pairing arrives on `/v1/pair`, not through a dashboard command,
        // so nothing here got the chance to refresh on the way past. Without
        // this the sheet says PAIRED while the Devices pane behind it still
        // shows the old list — two panes of one window disagreeing about the
        // thing that just happened.
        //
        // The store is warm from its own write, so this costs a cache read.
        if let paired = progress.deviceId,
           let known = devices,
           !known.contains(where: { $0.id == paired }) {
            await refreshTrustNow()
            devices = try? lastDevices?.get()
        }
        let connected = router?.server?.connectedDeviceIds ?? []
        let power = system.powerState()

        let screenRecording = DisplayCatalog.hasScreenRecordingPermission()
        let accessibility = InputInjector.hasAccessibilityPermission()

        // Which of the streams, if any, is showing which display.
        let streamsByDisplay = Dictionary(
            (facts?.streams ?? []).map { ($0.displayId, $0) },
            uniquingKeysWith: { first, _ in first }
        )

        var payload: [String: Any] = [
            "t": "dashboardState",
            "at": ISO8601DateFormatter().string(from: Date()),
        ]

        payload["host"] = [
            "name": Config.machineName,
            "model": Config.machineModel,
            "os": Config.osVersion,
            "version": Config.hostVersion,
            "protocol": Config.protocolVersion,
            "uptimeSeconds": Int(Date().timeIntervalSince(Config.launchedAt)),
            "hostKey": hostIdCache ?? "",
            "port": Int(facts?.settings.port ?? Config.loadSettings().port),
            "pathWord": Self.pathWord(status),
            "awake": power.isAwake,
            "onPower": power.isOnPower,
            "frontmostApp": system.frontmostApplication().name,
            "webBundle": webBundle(),
            "dashboardBundle": dashboardBundle(),
        ]

        payload["permissions"] = [
            "screenRecording": screenRecording,
            "accessibility": accessibility,
            // Probed on this request rather than cached, so the pane's
            // "CHECKED 3S AGO" is a fact about this reading and not about a
            // reading taken at launch.
            "checkedAt": ISO8601DateFormatter().string(from: Date()),
        ]

        // Link quality is the phone's report of a round trip it measured. With
        // nothing attached there is no round trip and every value here is nil,
        // which is what makes the pane draw dashes instead of a healthy zero.
        var linkPayload: [String: Any] = [
            "attached": facts?.attachedDeviceId != nil,
            "rttHistory": link.rttHistory.map { $0.rounded() },
            "samples": link.sampleCount,
        ]
        linkPayload["rtt"] = link.rttMillis.map { $0.rounded() }
        linkPayload["jitter"] = link.jitterMillis.map { $0.rounded() }
        // Loss is only a number once enough pings have arrived to divide by.
        let loss: Double? = link.sampleCount >= 2
            ? (link.lossPercent * 10).rounded() / 10
            : nil
        linkPayload["loss"] = loss
        linkPayload["outMbps"] = (link.downMbps * 10).rounded() / 10
        linkPayload["stalledSeconds"] = facts?.secondsSincePong.map { Int($0) }
        linkPayload["onExpensiveLink"] = facts?.phoneOnExpensiveLink ?? false
        payload["link"] = linkPayload

        let live = facts?.streams ?? []
        var encoder: [String: Any] = [
            "capturing": !live.isEmpty,
            "rateHistory": link.mbpsHistory.map { ($0 * 10).rounded() / 10 },
            "ladderSetting": facts?.settings.quality.rawValue ?? "auto",
            "dropped": facts?.attachedFramesDropped ?? 0,
            "sentBytes": facts?.attachedBytesSent ?? 0,
        ]
        if let first = live.first {
            encoder["ladder"] = String(first.ladder)
            encoder["fps"] = first.fps
            encoder["bitrate"] = first.bitrate
            encoder["gop"] = first.gop
            encoder["keyframeSeconds"] = first.keyframeSeconds
            encoder["framesEncoded"] = live.reduce(0) { $0 + $1.framesEncoded }
            encoder["mbps"] = (live.reduce(0.0) { $0 + $1.measuredMbps } * 10).rounded() / 10
        }
        payload["encoder"] = encoder

        payload["displays"] = displays.map { display -> [String: Any] in
            var entry: [String: Any] = display.wire
            entry["selected"] = facts?.selectedDisplays.contains(UInt32(display.id)) ?? false
            if let stream = streamsByDisplay[UInt32(display.id)] {
                entry["stream"] = [
                    "streamId": stream.streamId,
                    "sentWidth": stream.width,
                    "sentHeight": stream.height,
                    "fps": stream.fps,
                    "ladder": String(stream.ladder),
                    "mbps": (stream.measuredMbps * 10).rounded() / 10,
                    "frames": stream.framesEncoded,
                    "gop": stream.gop,
                ]
            }
            return entry
        }
        payload["sideBySide"] = (facts?.selectedDisplays.count ?? 0) > 1

        payload["devices"] = (devices ?? []).map { device -> [String: Any] in
            let isAttached = device.id == facts?.attachedDeviceId
            var entry: [String: Any] = [
                "id": device.id,
                "name": device.name,
                "kind": device.kind,
                "pairedAt": ISO8601DateFormatter().string(from: device.pairedAt),
                "connected": connected.contains(device.id),
                "attached": isAttached,
                "keyFingerprint": Self.fingerprint(device.publicKey),
            ]
            entry["lastSeenAt"] = device.lastSeenAt.map(ISO8601DateFormatter().string(from:))
            // Session figures belong to the socket, and there is one. Attributing
            // them to a device that is not on it would be inventing a reading.
            if isAttached {
                entry["session"] = [
                    "since": facts?.attachedSince.map(ISO8601DateFormatter().string(from:)) ?? "",
                    "bytesSent": facts?.attachedBytesSent ?? 0,
                    "framesDropped": facts?.attachedFramesDropped ?? 0,
                    "watching": live.map { $0.streamId },
                ]
            }
            return entry
        }
        // The keychain not answering and this Mac having nothing paired are
        // different facts, and the pane says so rather than drawing an empty
        // list for both.
        // Three states on the wire, matching the three the cache holds: not yet
        // asked, asked and refused, asked and answered.
        payload["devicesReadable"] = lastDevices == nil
            ? "asking"
            : (devices != nil ? "yes" : "no")

        payload["transport"] = status.wire
        payload["addresses"] = Self.addresses(
            status: status,
            port: facts?.settings.port ?? Config.loadSettings().port
        )

        var pairingPayload: [String: Any] = [
            "open": code != nil,
            "rotateSeconds": Int(Config.pairingCodeLifetime),
            "reusable": await pairing.isReusable,
            "maxAttempts": Config.maxPairAttempts,
        ]
        pairingPayload["code"] = code?.value
        pairingPayload["secondsRemaining"] = code?.secondsRemaining
        pairingPayload["lockoutSeconds"] = lockout
        pairingPayload["name"] = await pairing.pendingName
        pairingPayload.merge(progress.wire) { current, _ in current }
        payload["pairing"] = pairingPayload

        if let settings = facts?.settings {
            payload["settings"] = [
                "quality": settings.quality.rawValue,
                "capOnCellular": settings.capOnCellular,
                "cellularCeilingMbps": settings.cellularCeilingMbps,
                "sensitivity": settings.sensitivity,
                "naturalScrolling": settings.naturalScrolling,
                "requireBiometricEachSession": settings.requireBiometricEachSession,
                "relayOverInternet": settings.relayOverInternet,
                "targetFps": settings.targetFps,
                "port": Int(settings.port),
                "webClientURL": settings.webClientURL ?? "",
            ]
        }

        payload["log"] = [
            "entries": EventLog.shared.recent(limit: 240).map(\.wire),
            "dropped": EventLog.shared.dropped,
            "areas": ["net", "capture", "input", "claude", "transport", "app"],
        ]

        return payload
    }

    /// Asks the trust store for a fresh answer, at most one ask at a time.
    ///
    /// Nothing awaits this. A second poll arriving while the first read is still
    /// blocked on a SecurityAgent prompt must not start a second read: that is
    /// how one slow prompt becomes one prompt per second.
    private func refreshTrustInBackground() {
        if devicesRefresh == nil {
            devicesRefresh = Task { [trust] in
                let answer: Result<[TrustedDevice], Error>
                do {
                    answer = .success(try await trust.all())
                } catch {
                    answer = .failure(error)
                }
                self.noteDevices(answer)
            }
        }
        if hostIdCache == nil, hostIdRefresh == nil {
            hostIdRefresh = Task { [trust] in
                let identifier = try? await trust.hostId()
                self.noteHostId(identifier)
            }
        }
    }

    private func noteDevices(_ answer: Result<[TrustedDevice], Error>) {
        lastDevices = answer
        devicesRefresh = nil
    }

    /// Re-reads the device list *before* answering a command that changed it.
    ///
    /// The state poll serves a cached list on purpose, and that cache is one
    /// poll behind a mutation — which is the one place the lag is not
    /// acceptable. A revoke that still showed the device a second later would
    /// read as a revoke that did not work, and the second click is the one that
    /// revokes the wrong device.
    ///
    /// This does not reintroduce the blocking read it was cached to avoid: the
    /// mutation itself just wrote through `TrustStore`, so the store's own
    /// in-memory cache is warm and this returns without touching the keychain.
    /// A failure here is recorded and not raised — the mutation already
    /// succeeded, and reporting it as failed would be worse than a stale list.
    private func refreshTrustNow() async {
        do {
            lastDevices = .success(try await trust.all())
        } catch {
            lastDevices = .failure(error)
        }
    }

    private func noteHostId(_ identifier: String?) {
        hostIdCache = identifier
        hostIdRefresh = nil
    }

    private static func pathWord(_ status: TransportManager.Status) -> String {
        if status.cloudflareRunning, status.cloudflareHostname != nil { return "TUNNEL" }
        if status.tailscaleRunning { return "DIRECT" }
        if status.lanAddress != nil { return "LAN" }
        return "NONE"
    }

    /// A device's public key, short enough to compare by eye.
    private static func fingerprint(_ key: Data) -> String {
        let hex = key.map { String(format: "%02x", $0) }.joined()
        guard hex.count > 8 else { return hex }
        return "\(hex.prefix(4))…\(hex.suffix(4))"
    }

    /// Every address this Mac can be reached on, and what each one is worth.
    ///
    /// The same reasoning the pairing window used to carry: Tailscale first
    /// because that address survives leaving the house, the tunnel above it
    /// when it is up because that is the only path from cellular, and loopback
    /// named as the absence of an address rather than as a fourth one.
    private static func addresses(
        status: TransportManager.Status,
        port: UInt16
    ) -> [String: Any] {
        let reachable = status.tailscaleAddress ?? status.lanAddress ?? status.tailscaleDNSName
        let host = reachable ?? "127.0.0.1"

        let origin: String
        let reach: String
        if let tunnel = status.cloudflareHostname, status.cloudflareRunning {
            origin = tunnel.hasSuffix("/") ? String(tunnel.dropLast()) : tunnel
            reach = "Works on cellular."
        } else {
            origin = "http://\(host):\(port)"
            if reachable == nil {
                reach = "No address to reach it on."
            } else if status.tailscaleAddress == nil {
                reach = "Same network only."
            } else {
                reach = "On the tailnet."
            }
        }

        return [
            "origin": origin,
            "reach": reach,
            "reachable": reachable != nil,
            "host": host,
            "port": Int(port),
            "listening": [
                "LISTENING ON :\(port)",
                reachable == nil ? "NO ADDRESS BUT LOOPBACK" : nil,
                status.tailscaleRunning ? "TAILSCALE UP" : "TAILSCALE DOWN",
                status.cloudflareRunning ? "TUNNEL ON" : "TUNNEL OFF",
            ].compactMap { $0 }.joined(separator: " · "),
            "publishedSite": Config.webClientURL ?? "",
            "webBundlePresent": Config.webRoot != nil,
        ]
    }

    private func webBundle() -> [String: Any] {
        if webBundleBytes == nil { webBundleBytes = Self.directorySize(Config.webRoot) }
        return ["present": Config.webRoot != nil, "bytes": webBundleBytes ?? 0]
    }

    private func dashboardBundle() -> [String: Any] {
        if dashboardBundleBytes == nil {
            dashboardBundleBytes = Self.directorySize(Config.dashboardRoot)
        }
        return ["present": Config.dashboardRoot != nil, "bytes": dashboardBundleBytes ?? 0]
    }

    private static func directorySize(_ root: URL?) -> Int {
        guard let root,
              let walker = FileManager.default.enumerator(
                  at: root,
                  includingPropertiesForKeys: [.fileSizeKey]
              )
        else { return 0 }
        var total = 0
        for case let url as URL in walker {
            total += (try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        }
        return total
    }

    // MARK: Snapshot

    /// One frame of a display, as a PNG, for the Overview hero.
    ///
    /// Not the video stream. The encoder's output is H.264 addressed to the
    /// phone, and decoding it a second time in this window to draw a thumbnail
    /// would put a decoder on the same machine as the encoder for no gain. This
    /// is a screenshot, taken on request, and the pane labels it as one — it
    /// never claims a frame rate it is not delivering.
    private func snapshot(_ request: HTTPRequest) -> HTTPResponse {
        guard DisplayCatalog.hasScreenRecordingPermission() else {
            return .error(403, "no_screen_permission")
        }
        let displayId = UInt32(request.query["display"] ?? "") ?? CGMainDisplayID()
        let width = min(1600, max(160, Int(request.query["width"] ?? "") ?? 900))
        guard let png = system.screenshot(display: displayId, maxWidth: width) else {
            return .error(503, "capture_failed")
        }
        return HTTPResponse(
            status: 200,
            headers: [
                "Content-Type": "image/png",
                // Every request is a fresh moment; a cached one is a lie about
                // what the Mac is doing now.
                "Cache-Control": "no-store",
            ],
            body: png
        )
    }

    // MARK: QR

    /// The two ways in, as images.
    ///
    /// Rendered here rather than in the page because CoreImage already does it
    /// and the alternative is shipping a QR encoder in the bundle to redraw a
    /// string this process produced.
    private func qr(_ request: HTTPRequest) async -> HTTPResponse {
        guard let code = await pairing.currentCode() else {
            return .error(409, "not_pairing")
        }
        let status = await transport.status()
        let port = Config.loadSettings().port
        let addresses = Self.addresses(status: status, port: port)
        let origin = addresses["origin"] as? String ?? "http://127.0.0.1:\(port)"
        let host = addresses["host"] as? String ?? "127.0.0.1"

        let payload: String
        switch request.query["kind"] {
        case "app":
            // A custom scheme, which only the iOS app can open. It carries the
            // address as well as the code, because the app has no origin to
            // read one off.
            payload = "vibewire://pair?host=\(host)&port=\(port)&code=\(code.value)"
        default:
            if let site = Config.webClientURL, !site.isEmpty {
                let trimmed = site.hasSuffix("/") ? String(site.dropLast()) : site
                guard var components = URLComponents(string: trimmed) else {
                    return .error(422, "web_client_url_not_a_url")
                }
                components.queryItems = [
                    URLQueryItem(name: "host", value: origin),
                    URLQueryItem(name: "code", value: code.value),
                ]
                guard let built = components.url?.absoluteString else {
                    return .error(422, "web_client_url_would_not_build")
                }
                payload = built
            } else {
                guard Config.webRoot != nil else { return .error(409, "no_web_bundle") }
                // Only the code: the page comes from this host, so it reads the
                // address off its own origin and the QR stays small.
                payload = "\(origin)/?code=\(code.value)"
            }
        }

        guard let png = Self.qrPNG(from: payload) else {
            return .error(500, "qr_failed")
        }
        return HTTPResponse(
            status: 200,
            headers: [
                "Content-Type": "image/png",
                "Cache-Control": "no-store",
                // The page prints the string under the code as well: reading a
                // URL off a QR is not the same as being able to copy it.
                "X-VibeWire-Payload": payload,
            ],
            body: png
        )
    }

    private static func qrPNG(from string: String) -> Data? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: 10, y: 10))
        let context = CIContext()
        guard let image = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return NSBitmapImageRep(cgImage: image).representation(using: .png, properties: [:])
    }

    // MARK: Commands

    // swiftlint:disable:next cyclomatic_complexity function_body_length
    private func command(_ request: HTTPRequest) async -> HTTPResponse {
        guard let body = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
              let verb = body["do"] as? String
        else { return .error(400, "malformed_request") }

        guard let router else { return .error(503, "router_gone") }

        func string(_ key: String) -> String? { body[key] as? String }
        func bool(_ key: String) -> Bool? { body[key] as? Bool }

        switch verb {
        case "pair.begin":
            let code = await pairing.beginPairing(
                name: string("name"),
                reusable: bool("reusable") ?? false
            )
            return .json(200, ["ok": true, "code": code.value])

        case "pair.end":
            await pairing.endPairing()
            return .json(200, ["ok": true])

        case "device.revoke":
            do {
                let removed = try await router.dashboardRevoke(
                    deviceId: string("deviceId"),
                    all: bool("all") ?? false
                )
                await refreshTrustNow()
                return .json(200, ["ok": true, "revoked": removed])
            } catch {
                return .error(500, "revoke_failed", extra: ["detail": "\(error)"])
            }

        case "device.sever":
            guard let deviceId = string("deviceId") else { return .error(400, "missing_device") }
            router.dashboardSever(deviceId: deviceId)
            return .json(200, ["ok": true])

        case "device.rename":
            guard let deviceId = string("deviceId"), let name = string("name") else {
                return .error(400, "missing_device")
            }
            do {
                let renamed = try await router.dashboardRename(deviceId: deviceId, to: name)
                if renamed { await refreshTrustNow() }
                return renamed ? .json(200, ["ok": true]) : .error(404, "no_such_device")
            } catch {
                return .error(500, "rename_failed", extra: ["detail": "\(error)"])
            }

        case "display.select":
            let ids = (body["displayIds"] as? [Int])?.map { UInt32($0) } ?? []
            await router.dashboardSelectDisplays(ids, sideBySide: bool("sideBySide") ?? false)
            return .json(200, ["ok": true])

        case "capture.stop":
            await router.dashboardStopCapture()
            return .json(200, ["ok": true])

        case "setting.set":
            guard let key = string("key"), let value = Self.settingValue(body["value"]) else {
                return .error(400, "malformed_setting")
            }
            await router.dashboardApplySetting(key: key, value: value)
            return .json(200, ["ok": true])

        case "transport.tunnel":
            // Routed through the setting rather than started directly, so the
            // toggle on the Transport pane and the one on the Settings pane
            // cannot disagree about whether the relay is meant to be on.
            await router.dashboardApplySetting(
                key: "relayOverInternet",
                value: .bool(bool("on") ?? false)
            )
            return .json(200, ["ok": true])

        case "transport.refresh":
            await transport.refresh()
            return .json(200, ["ok": true])

        case "permission.request":
            switch string("which") {
            case "screen": DisplayCatalog.requestScreenRecordingPermission()
            case "accessibility": InputInjector.requestAccessibilityPermission()
            default: return .error(400, "unknown_permission")
            }
            return .json(200, ["ok": true])

        case "claude":
            guard let inbound = Self.claudeInbound(body) else {
                return .error(400, "malformed_claude_command")
            }
            await router.dashboardClaude(inbound)
            return .json(200, ["ok": true])

        case "log.clear":
            // Not offered. The log is what happened, and a control that erases
            // it is a control for making the record disagree with the machine.
            return .error(405, "not_offered")

        default:
            return .error(400, "unknown_command", extra: ["verb": verb])
        }
    }

    private static func settingValue(_ raw: Any?) -> SettingValue? {
        switch raw {
        case let value as Bool: return .bool(value)
        case let value as Int: return .int(value)
        case let value as Double: return .double(value)
        case let value as String: return .string(value)
        case let value as NSNumber:
            // JSONSerialization hands numbers back as NSNumber; the boolean
            // check has to come first or `true` arrives as the integer 1.
            if CFGetTypeID(value) == CFBooleanGetTypeID() { return .bool(value.boolValue) }
            return value.doubleValue == value.doubleValue.rounded()
                ? .int(value.intValue)
                : .double(value.doubleValue)
        default: return nil
        }
    }

    private static func claudeInbound(_ body: [String: Any]) -> ClaudeInbound? {
        switch body["sub"] as? String {
        case "listSessions":
            return .listSessions(cwd: body["cwd"] as? String)
        case "open":
            return .open(
                sessionId: body["sessionId"] as? String,
                cwd: body["cwd"] as? String,
                mode: ClaudeMode(rawValue: body["mode"] as? String ?? "code") ?? .code
            )
        case "send":
            guard let text = body["text"] as? String else { return nil }
            return .send(text: text)
        case "interrupt":
            return .interrupt
        case "permission":
            guard let requestId = body["requestId"] as? String,
                  let behavior = body["behavior"] as? String
            else { return nil }
            return .permission(
                requestId: requestId,
                allow: behavior == "allow",
                scope: PermissionScope(rawValue: body["scope"] as? String ?? "once") ?? .once,
                message: body["message"] as? String
            )
        case "diff":
            return .diff(path: body["path"] as? String)
        case "close":
            return .close
        default:
            return nil
        }
    }
}
