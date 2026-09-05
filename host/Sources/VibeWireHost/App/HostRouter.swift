import Foundation
import CoreGraphics
import AppKit

/// The seam between the network layer and everything the Mac can do.
/// Owns session state: which displays are streaming, what the link looks like,
/// and whether a Claude session is open.
final class HostRouter: Router, @unchecked Sendable {
    /// Everything mutable, behind one lock. Grouped in a struct so a critical
    /// section is always a single short `withLock` rather than a lock/unlock
    /// pair straddling other work.
    private struct State {
        var settings: HostSettings
        var streams: [UInt16: ScreenStream] = [:]
        var selectedDisplays: [CGDirectDisplayID] = []
        var activeSocket: SocketConnection?
        var lastKeyframe: (data: Data, at: Date)?
        /// Reported by the phone. The Mac cannot see the phone's radio,
        /// so the cellular cap is only honest if the phone says so.
        var phoneOnExpensiveLink = false

        /// The bitrate ceiling to apply right now, or nil for no cap.
        /// Honours the setting *and* the phone's actual radio, so a LAN
        /// session is never throttled by a cellular preference.
        var cellularCap: Double? {
            guard settings.capOnCellular, phoneOnExpensiveLink else { return nil }
            return settings.cellularCeilingMbps
        }
    }

    private let trust: TrustStore
    private let pairing: PairingService
    private let catalog: DisplayCatalog
    private let injector: InputInjector
    private let system: SystemServices
    private let telemetry: Telemetry
    private let claude: ClaudeBridge
    /// Bridge to a Claude Code session already running in a terminal.
    private let channel = ChannelBridge()
    /// Reserved session id standing for "the live one", not a transcript file.
    static let liveSessionId = "vibewire-live-session"
    private let transport: TransportManager
    private let state: Guarded<State>

    /// The built web client, when there is one. Resolved once at launch — see
    /// `Config.webRoot` — so a host without a bundle costs nothing per request.
    private let web = WebAssets(root: Config.webRoot)

    /// The Mac dashboard's own surface: its bundle and its API, both behind the
    /// launch key. Built at the end of `init` because it holds this router.
    private(set) var dashboard: DashboardService?

    /// Messages the phone's socket would have received, kept for the dashboard
    /// to collect on its next poll.
    ///
    /// The dashboard shows the same Claude session the phone does — that is the
    /// point of it — so it reads the same `claude` messages rather than a
    /// parallel description of them. A ring rather than a queue: a dashboard
    /// nobody has open must not grow a backlog for the life of the process.
    private let events = Guarded(EventRing())

    private struct EventRing {
        var messages: [(sequence: Int, payload: [String: Any])] = []
        var nextSequence = 1
        static let capacity = 400
    }

    weak var server: HTTPServer?

    /// What the menu bar reports before any menu item.
    ///
    /// Three measured facts and nothing else, because the reason to open that
    /// menu is almost always to check whether the Mac is still serving. Read
    /// under the same lock as everything else here, and cheap enough to answer
    /// every time the menu opens.
    struct Serving {
        var clientAttached: Bool
        var streams: Int
    }

    var serving: Serving {
        state.withLock { current in
            Serving(clientAttached: current.activeSocket != nil, streams: current.streams.count)
        }
    }

    init(
        trust: TrustStore,
        pairing: PairingService,
        catalog: DisplayCatalog,
        injector: InputInjector,
        system: SystemServices,
        telemetry: Telemetry,
        claude: ClaudeBridge,
        transport: TransportManager,
        settings: HostSettings
    ) {
        self.trust = trust
        self.pairing = pairing
        self.catalog = catalog
        self.injector = injector
        self.system = system
        self.telemetry = telemetry
        self.claude = claude
        self.transport = transport
        self.state = Guarded(State(settings: settings))
        injector.update(sensitivity: settings.sensitivity, naturalScrolling: settings.naturalScrolling)
        self.dashboard = DashboardService(
            router: self,
            trust: trust,
            pairing: pairing,
            catalog: catalog,
            transport: transport,
            telemetry: telemetry,
            system: system
        )
    }

    /// Points Claude's output at this router rather than at whichever socket
    /// happened to open last.
    ///
    /// Called once at launch. It used to be set inside `socketOpened`, which
    /// meant Claude's output existed only while a phone was attached — and the
    /// dashboard, which is on the same Mac and never opens a socket, could not
    /// see the session it was showing. Routing everything through `fanOut`
    /// leaves the phone's behaviour identical: the active socket still gets
    /// every message, and now so does the window on this desk.
    func activateClaudeFanOut() async {
        await claude.setEmitter { [weak self] payload in
            self?.fanOut(payload)
        }
        await channel.setEmitter { [weak self] payload in
            self?.fanOut(payload)
        }
    }

    /// One message to both surfaces: the attached phone, and the dashboard's
    /// next poll.
    private func fanOut(_ payload: [String: Any]) {
        state.read { $0.activeSocket }?.sendJSON(payload)
        events.withLock { ring in
            ring.messages.append((ring.nextSequence, payload))
            ring.nextSequence += 1
            if ring.messages.count > EventRing.capacity {
                ring.messages.removeFirst(ring.messages.count - EventRing.capacity)
            }
        }
    }

    /// Everything emitted after `since`, and the sequence to ask from next.
    ///
    /// A dashboard that has fallen behind the ring gets whatever survives and a
    /// `dropped` count, rather than a silently truncated transcript.
    func drainEvents(since: Int) -> (next: Int, dropped: Int, messages: [[String: Any]]) {
        events.read { ring in
            let fresh = ring.messages.filter { $0.sequence > since }
            let oldestHeld = ring.messages.first?.sequence ?? ring.nextSequence
            let dropped = since > 0 ? max(0, oldestHeld - since - 1) : 0
            return (ring.nextSequence, dropped, fresh.map(\.payload))
        }
    }

    // MARK: HTTP

    func handle(_ request: HTTPRequest) async -> HTTPResponse {
        switch (request.method, request.path) {
        case ("GET", "/v1/health"):
            // Deliberately says nothing about pairing state to an unauthenticated
            // caller; it exists so a tunnel can health-check the origin.
            return .json(200, ["ok": true, "protocol": Config.protocolVersion])

        case ("POST", "/v1/pair"):
            return await handlePair(request)

        case ("GET", "/v1/challenge"):
            // The same shape is returned whether or not the device id is known,
            // so this endpoint cannot be used to enumerate paired devices. An
            // unknown device simply fails later at signature verification.
            return .json(200, [
                "nonce": await pairing.issueNonce(),
                "expiresIn": Int(Config.nonceLifetime),
            ])

        case ("GET", "/v1/verify"):
            // Exists for the web client, and for one reason: a browser cannot see
            // the status line of a refused WebSocket upgrade. An HTTP 401 and an
            // unplugged cable both arrive as close code 1006, so a revoked browser
            // would retry for the full 30 seconds and then report "unreachable"
            // about a Mac that was answering perfectly — the collapsed-failure
            // defect this product has already paid for once.
            //
            // It is the same challenge-response as the upgrade and grants nothing:
            // a caller who can sign the nonce could have opened the socket instead,
            // and one who cannot learns only what the upgrade would already have
            // told them.
            guard let device = await verifyQuery(request) else {
                return .error(401, "unauthorized")
            }
            return .json(200, ["ok": true, "deviceId": device.id])

        case ("OPTIONS", _):
            return HTTPResponse(
                status: 200,
                headers: [
                    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                    "Access-Control-Allow-Headers":
                        "Content-Type, X-VibeWire-Device, X-VibeWire-Nonce, X-VibeWire-Signature",
                ],
                body: Data()
            )

        default:
            // The Mac dashboard: its own bundle behind the launch key, and its
            // own API behind the same key. Both are checked before the web
            // client, because `/dashboard/…` is not a route the phone client has
            // and must not fall through to its index.
            if let response = await dashboard?.response(for: request) {
                return response
            }

            // The web client, served from the same port so the browser sees one
            // origin for the page and the protocol both. Anything under /v1 has
            // already been matched above, and `WebAssets` refuses that prefix too.
            if request.method == "GET", let response = web?.response(for: request.path) {
                return response
            }
            return .error(404, "not_found")
        }
    }

    private func handlePair(_ request: HTTPRequest) async -> HTTPResponse {
        // Every exit below used to be silent, so an empty log read as "the
        // phone never called" when it may well have called and been rejected.
        Log.info(.net, "pair request received (\(request.body.count) bytes)")

        guard let body = try? JSONSerialization.jsonObject(with: request.body) as? [String: Any],
              let code = body["code"] as? String,
              let publicKeyBase64 = body["publicKey"] as? String,
              let publicKey = Data(base64Encoded: publicKeyBase64)
        else {
            Log.info(.net, "pair rejected 400 malformed_request")
            return .error(400, "malformed_request")
        }

        let deviceName = (body["deviceName"] as? String) ?? "iPhone"
        let deviceKind = (body["deviceKind"] as? String) ?? "phone"

        do {
            let result = try await pairing.pair(
                code: code,
                deviceName: deviceName,
                deviceKind: deviceKind,
                publicKey: publicKey
            )
            Log.info(.net, "pair accepted: \(deviceName) (\(deviceKind)) as \(result.device.id)")
            return .json(200, [
                "hostId": result.hostId,
                "hostName": result.hostName,
                "hostKey": result.hostPublicKey.base64EncodedString(),
                "deviceId": result.device.id,
                "pairedAt": ISO8601DateFormatter().string(from: result.device.pairedAt),
                "protocol": Config.protocolVersion,
            ])
        } catch PairingService.PairError.lockedOut(let retryAfter) {
            Log.info(.net, "pair rejected 429 too_many_attempts, retry in \(retryAfter)s")
            return .error(429, "too_many_attempts", extra: ["retryAfter": retryAfter])
        } catch PairingService.PairError.codeExpired {
            Log.info(.net, "pair rejected 409 code_expired")
            return .error(409, "code_expired")
        } catch PairingService.PairError.notPairing {
            Log.info(.net, "pair rejected 409 not_pairing (pairing window is closed)")
            return .error(409, "not_pairing")
        } catch PairingService.PairError.badPublicKey {
            Log.info(.net, "pair rejected 400 bad_public_key")
            return .error(400, "bad_public_key")
        } catch PairingService.PairError.badCode {
            Log.info(.net, "pair rejected 401 bad_code")
            return .error(401, "bad_code")
        } catch {
            // Everything left is the trust store failing to record the pairing,
            // and it is not a bad code. It used to be reported as one, which is
            // the collapsed-failure defect this product has already paid for
            // once: the phone said "wrong code" and the person retyped a code
            // that was right five times, into a host whose keychain was the
            // thing that would not answer.
            //
            // The digits were already accepted at this point — `pair()` records
            // that in its progress — so the honest answer is that the Mac could
            // not store the trust, and retrying the code will not help.
            Log.error(.net, "pair failed after the code was accepted: \(error)")
            return .error(503, "trust_unavailable", extra: ["detail": "\(error)"])
        }
    }

    // MARK: Socket lifecycle

    /// Two spellings of the same challenge-response, because one client cannot use
    /// the other's.
    ///
    /// The phone sends `X-VibeWire-Device` / `-Nonce` / `-Signature` as headers. A
    /// browser cannot: `new WebSocket(url)` takes a URL and a subprotocol list and
    /// nothing else, so no header can be set on the handshake. The same three values
    /// are accepted from the query string instead.
    ///
    /// This is not a weakening. The nonce is single-use and dead in 30 seconds, and
    /// the signature covers that nonce — a URL that ends up in a proxy log is a URL
    /// that cannot be replayed. Nor is a query string reachable by a hostile page:
    /// signing requires the private key, which the browser holds non-extractably and
    /// scopes to its own origin, so a cross-site socket attempt cannot produce a
    /// signature at all. That is why no `Origin` check is needed here — possession
    /// of the key *is* the check.
    func authenticateUpgrade(_ request: HTTPRequest) async -> TrustedDevice? {
        guard let credentials = Self.credentials(in: request) else { return nil }
        return await pairing.verify(
            deviceId: credentials.deviceId,
            nonce: credentials.nonce,
            signature: credentials.signature
        )
    }

    /// The same check over plain HTTP, for `GET /v1/verify`.
    private func verifyQuery(_ request: HTTPRequest) async -> TrustedDevice? {
        await authenticateUpgrade(request)
    }

    private static func credentials(
        in request: HTTPRequest
    ) -> (deviceId: String, nonce: String, signature: Data)? {
        let deviceId = request.header("x-vibewire-device") ?? request.query["device"]
        let nonce = request.header("x-vibewire-nonce") ?? request.query["nonce"]
        let signatureBase64 = request.header("x-vibewire-signature") ?? request.query["sig"]

        guard let deviceId, let nonce, let signatureBase64,
              let signature = Data(base64Encoded: signatureBase64)
        else { return nil }
        return (deviceId, nonce, signature)
    }

    func socketOpened(_ socket: SocketConnection, device: TrustedDevice) async {
        // There is one active socket, and Claude's output is emitted to it. A
        // second socket silently takes that slot, so anything the CLI says goes
        // to the newcomer while the phone may still be reading the first. That
        // is worth saying out loud rather than leaving to be inferred.
        let displaced = state.withLock { current -> Bool in
            let hadOne = current.activeSocket != nil
            current.activeSocket = socket
            return hadOne
        }
        if displaced {
            Log.warn(.net, "second socket for \(device.name) replaced the active one — the phone should hold exactly one")
        }

        await telemetry.reset()
        await transport.noteContact()
        system.preventSleep(true)

        // The fourth step of the pairing window's handshake list, and the only
        // one that arrives from a different request than the other three. It is
        // ignored unless this is the device that window just paired.
        await pairing.noteSocketOpened(deviceId: device.id)

        let hostId = (try? await trust.hostId()) ?? ""
        socket.sendJSON(Outbound.hello(
            hostId: hostId,
            hostName: Config.machineName,
            model: Config.machineModel,
            osVersion: Config.osVersion,
            capabilities: [
                "screenRecording": DisplayCatalog.hasScreenRecordingPermission(),
                "accessibility": InputInjector.hasAccessibilityPermission(),
                "claude": ProcessInfo.processInfo.environment["VIBEWIRE_DISABLE_CLAUDE"] != "1",
                "wakeOnLan": system.canWakeOverNetwork(),
            ]
        ))

        await pushDisplays(to: socket)
        await pushStatus(to: socket)
        await pushTransport(to: socket)
        socket.sendJSON(settingsPayload())
        await pushDevices(to: socket)
    }

    func socketClosed(_ socket: SocketConnection) async {
        let wasActive = state.withLock { current -> Bool in
            guard current.activeSocket === socket else { return false }
            current.activeSocket = nil
            return true
        }
        guard wasActive else { return }

        // "Nothing is left running on the Mac" — the promise at the end of the
        // timed loop on screen 07.
        await stopAllStreams()
        await claude.close()
        injector.releaseAllModifiers()
        system.preventSleep(false)
        Log.info(.net, "session ended, host idle")
    }

    // MARK: Socket messages

    func socketReceived(_ socket: SocketConnection, text: Data) async {
        let decoded: (id: String?, message: InboundMessage)
        do {
            decoded = try InboundMessage.decode(text)
        } catch {
            Log.debug(.net, "inbound decode failed: \(error)")
            socket.sendJSON(Outbound.error("bad_message", "\(error)"))
            return
        }
        await dispatch(decoded.message, id: decoded.id, socket: socket)
    }

    // swiftlint:disable:next cyclomatic_complexity function_body_length
    private func dispatch(_ message: InboundMessage, id: String?, socket: SocketConnection) async {
        switch message {
        case .ping(let tMicros, let sequence, let rttMillis):
            socket.sendJSON(Outbound.pong(tMicros: tMicros))
            await telemetry.notePing(sequence: sequence, reportedRttMillis: rttMillis)
            await transport.noteContact()

        case .link(let expensive, _):
            let changed = state.withLock { current -> Bool in
                let previous = current.phoneOnExpensiveLink
                current.phoneOnExpensiveLink = expensive
                return previous != expensive
            }
            if changed {
                Log.info(.net, "phone link is now \(expensive ? "cellular/expensive" : "unmetered")")
                await retuneStreams(force: true)
            }

        case .selectDisplay(let displayIds, let sideBySide):
            let ids = displayIds.map { CGDirectDisplayID($0) }
            let selection = state.withLock { current -> [CGDirectDisplayID] in
                current.selectedDisplays = sideBySide ? ids : Array(ids.prefix(1))
                return current.selectedDisplays
            }
            if let first = selection.first { injector.focus(display: first) }
            await pushDisplays(to: socket)

        case .startStream(let displayIds, let maxHeight, let targetFps):
            let ids = displayIds.isEmpty
                ? (await catalog.refresh().first(where: \.isMain).map { [$0.id] } ?? [])
                : displayIds.map { CGDirectDisplayID($0) }
            await startStreams(displays: ids, maxHeight: maxHeight, fps: targetFps, socket: socket)

        case .stopStream:
            await stopAllStreams()
            socket.sendJSON(["t": "streamState", "state": "stopped"])

        case .setQuality(let ladder, let cellularCap):
            let updated = state.withLock { current -> HostSettings in
                current.settings.quality = ladder
                if let cellularCap { current.settings.cellularCeilingMbps = cellularCap }
                return current.settings
            }
            Config.saveSettings(updated)
            await retuneStreams()
            socket.sendJSON(settingsPayload())

        case .pointer(let event):
            if let sensitivity = event.sensitivity {
                injector.update(sensitivity: sensitivity, naturalScrolling: nil)
            }
            injector.movePointer(
                dx: event.dx,
                dy: event.dy,
                display: event.display.map { CGDirectDisplayID($0) }
            )

        case .click(let button, let count, let display):
            injector.click(
                button: button,
                count: count,
                display: display.map { CGDirectDisplayID($0) }
            )

        case .drag(let phase, let dx, let dy, let count):
            injector.drag(phase: phase, dx: dx, dy: dy, count: count)

        case .scroll(let dx, let dy, let momentum):
            injector.scroll(dx: dx, dy: dy, momentum: momentum)

        case .zoom(let scale, _, _, let locked):
            injector.zoom(scale: scale, locked: locked)

        case .modifiers(let held, _):
            injector.setModifiers(held)

        case .key(let code, let chars, let down):
            injector.key(code: code, chars: chars, down: down)

        case .combo(let keys):
            injector.combo(keys: keys)

        case .text(let value):
            injector.type(text: value)

        case .hubAction(let action):
            await performHubAction(action, socket: socket)

        case .clipboardPush(let text):
            system.writeClipboard(text)
            socket.sendJSON(["t": "clipboard", "direction": "toMac", "ok": true])

        case .wake:
            // The Mac is by definition awake if it answered, so this nudges the
            // display awake rather than the machine. A synthetic mouse move was
            // measured not to do that — a slept panel stays slept through it —
            // so the nudge is a declared user activity, which does.
            let woke = system.wakeDisplays()
            let onScreen = await system.waitForDisplaysAwake()
            // The phone asked for a picture, so the answer carries a fresh
            // display list and a fresh status rather than making it wait for
            // the next heartbeat to find out it can now open the screen.
            _ = await catalog.refresh(force: true)
            await pushDisplays(to: socket)
            await pushStatus(to: socket)
            // A stream that ran through the sleep has been sending nothing
            // since the panels went dark, and the phone is holding the frame
            // from just before that. An IDR is what replaces it.
            for stream in currentStreams() { stream.requestKeyframe() }
            socket.sendJSON(["t": "wake", "ok": woke && onScreen])

        case .retry:
            await retuneStreams()
            for stream in currentStreams() { stream.requestKeyframe() }

        case .lastFrame:
            let snapshot = state.read { $0.lastKeyframe }
            if let snapshot {
                socket.sendJSON([
                    "t": "lastFrame",
                    "ageSeconds": Int(Date().timeIntervalSince(snapshot.at)),
                ])
                socket.sendBinary(snapshot.data)
            } else {
                socket.sendJSON(Outbound.error("no_last_frame", "no frame captured yet"))
            }

        case .claude(let inbound):
            await handleClaude(inbound)

        case .revoke(let deviceId, let all):
            await handleRevoke(deviceId: deviceId, all: all, socket: socket)

        case .setting(let key, let value):
            await applySetting(key: key, value: value)
            socket.sendJSON(settingsPayload())
        }

        if let id { socket.sendJSON(Outbound.ack(id)) }
    }

    // MARK: Streaming

    private func currentStreams() -> [ScreenStream] {
        state.read { Array($0.streams.values) }
    }

    private func startStreams(
        displays: [CGDirectDisplayID],
        maxHeight: Int?,
        fps: Int?,
        socket: SocketConnection
    ) async {
        guard DisplayCatalog.hasScreenRecordingPermission() else {
            socket.sendJSON(Outbound.error(
                "no_screen_permission",
                "Screen Recording permission is not granted on the Mac.",
                retriable: false
            ))
            return
        }

        await stopAllStreams()
        socket.sendJSON(["t": "streamState", "state": "starting"])

        let verdict = await telemetry.linkVerdict()
        let (ladderHeight, cap) = state.read { current -> (Int?, Double?) in
            (
                maxHeight ?? current.settings.quality.maxHeight,
                current.cellularCap
            )
        }

        var quality = ScreenStream.Quality.forLink(
            maxHeight: ladderHeight,
            rttMillis: verdict?.rtt ?? 20,
            lossPercent: verdict?.loss ?? 0,
            capMbps: cap
        )
        if let fps { quality.fps = fps }

        var started: [UInt16: ScreenStream] = [:]
        for (index, displayId) in displays.enumerated() {
            let streamId = UInt16(index)
            let stream = ScreenStream(
                streamId: streamId,
                displayId: displayId,
                quality: quality,
                onFrame: { [weak self] data in
                    self?.deliverVideo(data)
                },
                onKeyframeSnapshot: { [weak self] data, at in
                    self?.state.withLock { $0.lastKeyframe = (data, at) }
                }
            )
            do {
                try await stream.start()
                started[streamId] = stream
            } catch {
                Log.error(.capture, "failed to start stream for display \(displayId): \(error)")
                socket.sendJSON(Outbound.error("capture_failed", "\(error)", retriable: true))
            }
        }

        state.withLock { current in
            current.streams = started
            current.selectedDisplays = displays
        }

        if let first = displays.first { injector.focus(display: first) }

        for (streamId, stream) in started {
            let size = stream.currentSize
            socket.sendJSON([
                "t": "videoConfig",
                "streamId": Int(streamId),
                "displayId": Int(stream.displayId),
                "width": size.width,
                "height": size.height,
                "fps": stream.currentQuality.fps,
                "bitrate": stream.currentQuality.bitrate,
                "ladder": String(stream.currentQuality.maxHeight),
            ])
        }

        socket.sendJSON(["t": "streamState", "state": started.isEmpty ? "stopped" : "live"])
    }

    private func deliverVideo(_ data: Data) {
        state.read { $0.activeSocket }?.sendBinary(data)
    }

    private func stopAllStreams() async {
        let live = state.withLock { current -> [ScreenStream] in
            let existing = Array(current.streams.values)
            current.streams.removeAll()
            return existing
        }
        for stream in live { await stream.stop() }
    }

    /// Called on a timer and whenever settings change. This is what makes the
    /// picture drop to 540p on a thin link instead of stuttering at 1080p.
    ///
    /// `force` skips the not-enough-samples guard, for the case where the
    /// reason to retune is a changed setting rather than a changed link.
    func retuneStreams(force: Bool = false) async {
        let measured = await telemetry.linkVerdict()
        // Without enough samples the link verdict is noise; hold the current
        // setting rather than thrashing the encoder. A forced retune (a changed
        // setting or a changed radio) proceeds on optimistic defaults instead.
        guard let verdict = measured ?? (force ? (rtt: 20.0, loss: 0.0) : nil) else { return }

        let (ladderHeight, cap, live) = state.read { current -> (Int?, Double?, [ScreenStream]) in
            (
                current.settings.quality.maxHeight,
                current.cellularCap,
                Array(current.streams.values)
            )
        }
        guard !live.isEmpty else { return }

        let quality = ScreenStream.Quality.forLink(
            maxHeight: ladderHeight,
            rttMillis: verdict.rtt,
            lossPercent: verdict.loss,
            capMbps: cap
        )

        for stream in live where stream.currentQuality.maxHeight != quality.maxHeight
            || stream.currentQuality.bitrate != quality.bitrate {
            await stream.apply(quality: quality)

            let size = stream.currentSize
            state.read { $0.activeSocket }?.sendJSON([
                "t": "videoConfig",
                "streamId": Int(stream.streamId),
                "displayId": Int(stream.displayId),
                "width": size.width,
                "height": size.height,
                "fps": quality.fps,
                "bitrate": quality.bitrate,
                "ladder": String(quality.maxHeight),
            ])
        }
    }

    // MARK: Hub actions

    private func performHubAction(_ action: HubAction, socket: SocketConnection) async {
        switch action {
        case .copy:
            socket.sendJSON([
                "t": "clipboard",
                "direction": "fromMac",
                "text": system.readClipboard() ?? "",
            ])

        case .paste:
            // The phone pushes text first, then asks for the paste keystroke.
            injector.combo(keys: ["cmd", "v"])
            socket.sendJSON(["t": "clipboard", "direction": "toMac", "ok": true])

        case .shot:
            let target = state.read { $0.selectedDisplays.first } ?? CGMainDisplayID()
            if let png = system.screenshot(display: target) {
                socket.sendJSON([
                    "t": "screenshot",
                    "png": png.base64EncodedString(),
                    "bytes": png.count,
                ])
            } else {
                socket.sendJSON(Outbound.error("screenshot_failed", "could not capture display"))
            }

        case .lock:
            system.lockScreen()
            socket.sendJSON(["t": "locked", "ok": true])

        case .keys, .mods:
            // Presentation-only on the phone; nothing to do on the Mac.
            break
        }
    }

    // MARK: Claude

    /// Replies go to `fanOut`, not to the socket that asked.
    ///
    /// There is one Claude session on this Mac, and both surfaces are looking at
    /// it. A session list answered only to the asker would leave the dashboard
    /// showing an empty picker while the phone had one, and a permission prompt
    /// answered only to the asker would leave whichever surface is nearer the
    /// user unable to say yes.
    private func handleClaude(_ inbound: ClaudeInbound) async {
        switch inbound {
        case .listSessions(let cwd):
            var listed = ClaudeSessionIndex.recentSessions(cwd: cwd).map(\.wire)
            // The channel server only exists while a Claude Code session is
            // running it, so reaching it *is* the test for "there is a live
            // session to join". It goes first: it is the only entry where the
            // phone and the terminal share one conversation.
            let liveAvailable = await channel.isAvailable()
            Log.info(.claude, "session list: \(listed.count) on disk, live session \(liveAvailable ? "OFFERED" : "not reachable on 8790")")
            if liveAvailable {
                listed.insert([
                    "id": Self.liveSessionId,
                    "summary": "Live session in your terminal",
                    "cwd": "",
                    "gitBranch": "",
                    "modifiedAt": ISO8601DateFormatter().string(from: Date()),
                ], at: 0)
            }
            fanOut([
                "t": "claude",
                "sub": "sessions",
                "sessions": listed,
            ])

        case .open(let sessionId, let cwd, let mode):
            // Joining the terminal's session rather than starting one.
            if sessionId == Self.liveSessionId {
                await claude.close()
                await channel.attach()
                fanOut([
                    "t": "claude",
                    "sub": "opened",
                    "sessionId": Self.liveSessionId,
                    "cwd": cwd ?? "",
                    "live": true,
                ])
                Log.info(.claude, "attached to the live terminal session over the channel")
                return
            }

            await channel.detach()
            let workingDirectory = cwd
                ?? ClaudeSessionIndex.recentSessions(cwd: nil, limit: 1).first?.cwd
                ?? FileManager.default.homeDirectoryForCurrentUser.path
            do {
                try await claude.open(.init(
                    sessionId: sessionId,
                    cwd: workingDirectory,
                    mode: mode,
                    model: nil
                ))
                // Confirm the spawn now. `claude --print` emits its `system`
                // init only once it has been given a prompt, so a phone that
                // waited for that saw nothing at all after picking a session.
                // The real init overwrites this with the authoritative values.
                // Report the id the bridge settled on, not the one asked for:
                // a new session is assigned one here, and the phone needs it to
                // show the session and to find it again later.
                let openedId = await claude.sessionId ?? sessionId ?? ""
                fanOut([
                    "t": "claude",
                    "sub": "opened",
                    "sessionId": openedId,
                    "cwd": workingDirectory,
                    "pending": true,
                ])
                Log.info(.claude, "session \(openedId) open in \(workingDirectory)")

                // Resuming restores the model's context but prints nothing, so
                // the panel would open blank on a conversation with a hundred
                // messages in it. The transcript on disk is the only copy.
                if let sessionId {
                    let turns = ClaudeSessionIndex.transcript(sessionId: sessionId)
                    if !turns.isEmpty {
                        fanOut([
                            "t": "claude",
                            "sub": "history",
                            "sessionId": sessionId,
                            "turns": turns.map(\.wire),
                        ])
                    }
                }

                // Whatever is already uncommitted in that project belongs on
                // the phone before Claude touches anything else.
                await claude.publishWorkingTree()
            } catch {
                fanOut(["t": "claude", "sub": "error", "message": "\(error)"])
            }

        case .send(let text):
            // Attached to the session running in a terminal, the message goes
            // there rather than into a private `--print` conversation the user
            // cannot see.
            if await channel.isAttached {
                if await !channel.send(text: text) {
                    fanOut([
                        "t": "claude",
                        "sub": "error",
                        "message": "The terminal session is no longer listening. Reopen it with the channel loaded.",
                    ])
                }
            } else {
                await claude.send(text: text)
            }

        case .interrupt:
            await claude.interrupt()

        case .permission(let requestId, let allow, let scope, let message):
            if await channel.isAttached {
                // Channel verdicts are allow/deny only: the terminal dialog is
                // open at the same time and there is no "always" to record.
                await channel.answerPermission(requestId: requestId, allow: allow)
            } else {
                await claude.respondToPermission(
                    requestId: requestId,
                    allow: allow,
                    scope: scope,
                    message: message
                )
            }

        case .diff(let path):
            await claude.watchDiff(path: path)

        case .close:
            await claude.close()
        }
    }

    // MARK: Devices and settings

    private func handleRevoke(deviceId: String?, all: Bool, socket: SocketConnection) async {
        do {
            if all {
                let removed = try await trust.revokeAll()
                server?.severSockets(deviceIds: Set(removed))
            } else if let deviceId {
                if try await trust.revoke(id: deviceId) {
                    server?.severSockets(deviceIds: [deviceId])
                }
            }
            await pushDevices(to: socket)
        } catch {
            socket.sendJSON(Outbound.error("revoke_failed", "\(error)"))
        }
    }

    private func applySetting(key: String, value: SettingValue) async {
        let updated = state.withLock { current -> HostSettings in
            switch (key, value) {
            case ("sensitivity", .int(let level)):
                current.settings.sensitivity = max(1, min(8, level))
            case ("naturalScrolling", .bool(let on)):
                current.settings.naturalScrolling = on
            case ("capOnCellular", .bool(let on)):
                current.settings.capOnCellular = on
            case ("cellularCeilingMbps", .double(let value)):
                current.settings.cellularCeilingMbps = value
            case ("cellularCeilingMbps", .int(let value)):
                current.settings.cellularCeilingMbps = Double(value)
            case ("requireBiometricEachSession", .bool(let on)):
                current.settings.requireBiometricEachSession = on
            case ("relayOverInternet", .bool(let on)):
                current.settings.relayOverInternet = on
            case ("quality", .string(let raw)):
                current.settings.quality = HostSettings.QualityLadder(rawValue: raw) ?? .auto
            default:
                Log.debug(.app, "ignoring unknown setting \(key)")
            }
            return current.settings
        }

        injector.update(
            sensitivity: updated.sensitivity,
            naturalScrolling: updated.naturalScrolling
        )
        Config.saveSettings(updated)

        // The relay toggle has a side effect beyond persistence.
        if updated.relayOverInternet {
            await transport.startCloudflareTunnel()
        } else {
            await transport.stopCloudflareTunnel()
        }

        await retuneStreams()
    }

    private func settingsPayload() -> [String: Any] {
        state.read { current in
            [
                "t": "settings",
                "quality": current.settings.quality.rawValue,
                "capOnCellular": current.settings.capOnCellular,
                "cellularCeilingMbps": current.settings.cellularCeilingMbps,
                "sensitivity": current.settings.sensitivity,
                "naturalScrolling": current.settings.naturalScrolling,
                "requireBiometricEachSession": current.settings.requireBiometricEachSession,
                "relayOverInternet": current.settings.relayOverInternet,
                "hostVersion": Config.hostVersion,
            ]
        }
    }

    // MARK: The dashboard's view of this router

    /// What the dashboard needs that nothing else on this Mac can answer.
    ///
    /// Everything here is read out of the same lock the streaming path uses, in
    /// one pass, so a snapshot cannot describe a stream that stopped halfway
    /// through building it. `nil` where nothing has been measured — the pane
    /// draws an em dash for those, and never a zero.
    struct Facts: Sendable {
        struct Stream: Sendable {
            var streamId: Int
            var displayId: UInt32
            var width: Int
            var height: Int
            var fps: Int
            var bitrate: Int
            var ladder: Int
            var measuredMbps: Double
            var framesEncoded: Int
            /// The encoder is configured with `MaxKeyFrameInterval = fps * 2`
            /// and a two-second ceiling, so both of these are read off the
            /// running configuration rather than assumed.
            var gop: Int { fps * 2 }
            var keyframeSeconds: Double { 2.0 }
        }

        var settings: HostSettings
        var streams: [Stream]
        var selectedDisplays: [UInt32]
        var attachedDeviceId: String?
        var attachedDeviceName: String?
        var attachedSince: Date?
        var attachedBytesSent: Int
        var attachedFramesDropped: Int
        var secondsSincePong: TimeInterval?
        var phoneOnExpensiveLink: Bool
        var lastKeyframeAgeSeconds: Int?
    }

    var facts: Facts {
        state.read { current in
            Facts(
                settings: current.settings,
                streams: current.streams
                    .sorted { $0.key < $1.key }
                    .map { streamId, stream in
                        let size = stream.currentSize
                        return Facts.Stream(
                            streamId: Int(streamId),
                            displayId: UInt32(stream.displayId),
                            width: size.width,
                            height: size.height,
                            fps: stream.currentQuality.fps,
                            bitrate: stream.currentQuality.bitrate,
                            ladder: stream.currentQuality.maxHeight,
                            measuredMbps: stream.measuredMbps,
                            framesEncoded: stream.framesEncoded
                        )
                    },
                selectedDisplays: current.selectedDisplays.map { UInt32($0) },
                attachedDeviceId: current.activeSocket?.deviceId,
                attachedDeviceName: current.activeSocket?.deviceName,
                attachedSince: current.activeSocket?.openedAt,
                attachedBytesSent: current.activeSocket?.traffic.bytesSent ?? 0,
                attachedFramesDropped: current.activeSocket?.traffic.framesDropped ?? 0,
                secondsSincePong: current.activeSocket?.secondsSincePong,
                phoneOnExpensiveLink: current.phoneOnExpensiveLink,
                lastKeyframeAgeSeconds: current.lastKeyframe
                    .map { Int(Date().timeIntervalSince($0.at)) }
            )
        }
    }

    /// The same setting path the phone uses, so a change made at the Mac and a
    /// change made on the phone cannot diverge. Both persist, both retune the
    /// encoder, and both tell the attached phone what the new value is.
    func dashboardApplySetting(key: String, value: SettingValue) async {
        await applySetting(key: key, value: value)
        state.read { $0.activeSocket }?.sendJSON(settingsPayload())
    }

    /// Revoke, from the Mac rather than from a phone.
    ///
    /// The severing is the point: PROTOCOL §1.1 promises a live socket dies
    /// within a second of the key being destroyed, and that promise is what
    /// makes revoking from this desk worth doing while the phone is still in
    /// someone's hand.
    func dashboardRevoke(deviceId: String?, all: Bool) async throws -> Int {
        if all {
            let removed = try await trust.revokeAll()
            server?.severSockets(deviceIds: Set(removed))
            return removed.count
        }
        guard let deviceId else { return 0 }
        guard try await trust.revoke(id: deviceId) else { return 0 }
        server?.severSockets(deviceIds: [deviceId])
        return 1
    }

    /// Closes the socket and keeps the key, which is the other half of the pair
    /// of verbs on the Devices pane. The phone reconnects on its own backoff —
    /// this is not a ban, it is a hang-up.
    func dashboardSever(deviceId: String) {
        server?.severSockets(deviceIds: [deviceId])
    }

    func dashboardRename(deviceId: String, to name: String) async throws -> Bool {
        let renamed = try await trust.rename(id: deviceId, to: name)
        if renamed, let socket = state.read({ $0.activeSocket }) {
            await pushDevices(to: socket)
        }
        return renamed
    }

    /// Which displays the phone is watching, chosen from the Mac.
    ///
    /// Selecting is not starting: with nothing attached there is no socket to
    /// send frames to, and this only records the choice and refocuses input.
    /// A live session picks the change up on its next retune.
    func dashboardSelectDisplays(_ ids: [UInt32], sideBySide: Bool) async {
        let displayIds = ids.map { CGDirectDisplayID($0) }
        let selection = state.withLock { current -> [CGDirectDisplayID] in
            current.selectedDisplays = sideBySide ? displayIds : Array(displayIds.prefix(1))
            return current.selectedDisplays
        }
        if let first = selection.first { injector.focus(display: first) }
        if let socket = state.read({ $0.activeSocket }) {
            await pushDisplays(to: socket)
            await startStreams(
                displays: selection,
                maxHeight: nil,
                fps: nil,
                socket: socket
            )
        }
    }

    /// STOP CAPTURE on the Displays pane. Ends every stream and says so to the
    /// phone, which is the same thing the phone's own ✕ does.
    func dashboardStopCapture() async {
        await stopAllStreams()
        state.read { $0.activeSocket }?.sendJSON(["t": "streamState", "state": "stopped"])
    }

    /// Claude, driven from the Mac. Identical to the phone's path — see
    /// `handleClaude` for why the replies go to both surfaces.
    func dashboardClaude(_ inbound: ClaudeInbound) async {
        await handleClaude(inbound)
    }

    // MARK: Pushes

    private func pushDisplays(to socket: SocketConnection) async {
        let displays = await catalog.refresh()
        let selection = state.read { $0.selectedDisplays }

        socket.sendJSON([
            "t": "displays",
            "displays": displays.map { display -> [String: Any] in
                var payload = display.wire
                payload["selected"] = selection.contains(display.id)
                if let index = selection.firstIndex(of: display.id) {
                    payload["streamId"] = index
                }
                return payload
            },
        ])
    }

    private func pushStatus(to socket: SocketConnection) async {
        let snapshot = await telemetry.snapshot()
        let power = system.powerState()
        let frontmost = system.frontmostApplication()

        var payload = snapshot.wire
        payload["t"] = "status"
        payload["awake"] = power.isAwake
        payload["displaysAsleep"] = power.displaysAsleep
        payload["onPower"] = power.isOnPower
        payload["lidOpen"] = power.lidOpen
        payload["frontmostApp"] = frontmost.name
        // This payload only ever travels down a live socket, so the Mac is
        // running and its panels are one local assertion away from coming back
        // on. `canWakeOverNetwork` answers a different question — whether a
        // *sleeping machine* could be reached by Wake-on-LAN — and answering it
        // here put "MAC IS ON BATTERY — MAY NOT ANSWER" under a button that
        // works perfectly well on battery. The Wake-on-LAN claim still travels,
        // on `hello`, as `wakeOnLan`.
        payload["canWake"] = true
        socket.sendJSON(payload)
    }

    private func pushTransport(to socket: SocketConnection) async {
        await transport.refresh()
        socket.sendJSON(await transport.status().wire)
    }

    private func pushDevices(to socket: SocketConnection) async {
        let devices = (try? await trust.all()) ?? []
        let connected = server?.connectedDeviceIds ?? []
        socket.sendJSON([
            "t": "devices",
            "devices": devices.map { device -> [String: Any] in
                var payload: [String: Any] = [
                    "id": device.id,
                    "name": device.name,
                    "kind": device.kind,
                    "pairedAt": ISO8601DateFormatter().string(from: device.pairedAt),
                    "connected": connected.contains(device.id),
                    "isThisDevice": device.id == socket.deviceId,
                ]
                if let lastSeen = device.lastSeenAt {
                    payload["lastSeenAt"] = ISO8601DateFormatter().string(from: lastSeen)
                }
                return payload
            },
        ])
    }

    /// Driven by the app's heartbeat timer.
    func tick() async {
        let (socket, live) = state.read { ($0.activeSocket, Array($0.streams.values)) }
        guard let socket else { return }

        // A WebSocket-level ping for liveness only. Loss and latency come
        // from the phone's numbered app-level pings, not from this.
        socket.ping()
        await telemetry.noteThroughput(mbps: live.reduce(0.0) { $0 + $1.measuredMbps })

        await pushStatus(to: socket)
        await pushTransport(to: socket)

        // Mirror a copy the user made on the Mac itself.
        if let clipboard = system.clipboardChangedSinceLastCheck() {
            socket.sendJSON(["t": "clipboard", "direction": "fromMac", "text": clipboard])
        }

        await retuneStreams()

        // Refresh the "TYPING INTO" banner while keyboard mode is open.
        let frontmost = system.frontmostApplication()
        socket.sendJSON([
            "t": "frontmost",
            "app": frontmost.name,
            "bundleId": frontmost.bundleId ?? "",
        ])

        // Nothing has answered a ping in a while: tell the phone before it
        // notices on its own, so 03D can start counting.
        if socket.secondsSincePong > 5 {
            socket.sendJSON([
                "t": "streamState",
                "state": "stalled",
                "stalledMs": Int(socket.secondsSincePong * 1000),
            ])
        }
    }
}
