import SwiftUI
import Observation

// MARK: - Domain types

struct DisplayEntry: Identifiable, Equatable {
    let id: UInt32
    let name: String
    let width: Int
    let height: Int
    let refreshHz: Int
    let isBuiltIn: Bool
    var selected: Bool
    var streamId: Int?

    var resolutionLabel: String { "\(width) × \(height) · \(refreshHz) HZ" }
}

struct LinkStatus: Equatable {
    var awake = true
    var onPower = true
    var rttMillis: Double?
    var jitterMillis: Double?
    var lossPercent: Double = 0
    var downMbps: Double = 0
    var rttHistory: [Double] = []
    var frontmostApp = ""
    var canWake = true

    var condition: Condition {
        Condition.from(rttMillis: rttMillis, lossPercent: lossPercent, awake: awake)
    }

    /// 0…4 for the bar indicator, derived from the same numbers shown as text.
    var signalBars: Int {
        guard awake, let rtt = rttMillis else { return 0 }
        if rtt < 40 && lossPercent < 0.5 { return 4 }
        if rtt < 120 && lossPercent < 1 { return 3 }
        if rtt < 250 && lossPercent < 3 { return 2 }
        return 1
    }
}

struct TransportStatus: Equatable {
    enum Path: String { case direct, relay, none }
    var path: Path = .none
    var tailscaleRunning = false
    var tailscaleAddress: String?
    var relayName: String?
    var cloudflareRunning = false
    var cloudflareHostname: String?
    var lanAddress: String?
    /// Every origin this Mac believes it can be reached on, best first.
    var candidates: [String] = []
}

enum StreamState: Equatable {
    case stopped
    case starting
    case live
    case stalled(millis: Int)
    case reconnecting(attempt: Int, nextRetryMs: Int)
    case failed(String)
}

struct VideoConfig: Equatable {
    var streamId: Int
    var displayId: UInt32
    var width: Int
    var height: Int
    var fps: Int
    var bitrate: Int
    var ladder: String

    var bitrateMbps: Double { Double(bitrate) / 1_000_000 }
}

struct PairedDeviceEntry: Identifiable, Equatable {
    let id: String
    let name: String
    let kind: String
    let pairedAt: Date
    let lastSeenAt: Date?
    let connected: Bool
    let isThisDevice: Bool
}

struct HostSettingsMirror: Equatable {
    var quality = "auto"
    var capOnCellular = true
    var cellularCeilingMbps: Double = 3
    var sensitivity = 5
    var naturalScrolling = true
    var requireBiometricEachSession = true
    var relayOverInternet = false
    var hostVersion = "—"
    /// This app's version, from its own bundle. The footer used to print the
    /// host's version twice, labelling one of them as the phone's.
    let appVersion = (Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String) ?? "—"
}

// MARK: - Claude

struct ClaudeSessionEntry: Identifiable, Equatable {
    let id: String
    let summary: String
    let cwd: String
    let gitBranch: String?
    let modifiedAt: Date
    let messageCount: Int
}

struct ToolCall: Identifiable, Equatable {
    enum State: String { case running, ok, error }
    let id: String
    let name: String
    let target: String
    var state: State
    var milliseconds: Int?
    var preview: String?
}

struct ClaudeTurn: Identifiable, Equatable {
    enum Role: String { case user, assistant }
    let id = UUID()
    let role: Role
    var text: String
    let at: Date
}

struct PermissionRequest: Identifiable, Equatable {
    let id: String
    let toolName: String
    let command: String
    let explanation: String
    let arrivedAt: Date

    var waitedSeconds: Int { max(0, Int(Date().timeIntervalSince(arrivedAt))) }
}

struct ChangedFile: Identifiable, Equatable {
    var id: String { path }
    let path: String
    let status: String
    let added: Int
    let removed: Int
}

// MARK: - App model

/// One observable object drives every screen. State transitions live here so
/// the views stay declarative and the same condition never gets computed two
/// different ways in two different places.
@MainActor
@Observable
final class AppModel {
    /// Where the app *is*, which is only ever one of three places.
    ///
    /// Settings and the Claude panel used to live here too, which made them
    /// destinations the app replaced itself with — and a replaced screen
    /// inherits no way back, which is why the sole exit from Settings was one
    /// 44pt arrow that had already needed a hit-shape fix. They are sheets now,
    /// and a sheet is dismissed by the gesture every iOS user already has.
    enum Route: Equatable {
        case pairing
        case home
        case remote
    }

    /// What is presented *over* the route. One value, because SwiftUI honours
    /// only the first `.sheet` on a given view — two modifiers on the root
    /// would silently drop the second, which this codebase has already paid for
    /// once (see the diff sheet in `HANDOFF.md`).
    enum Presentation: String, Identifiable {
        case settings
        case claude
        var id: String { rawValue }
    }

    // Navigation
    var route: Route = .pairing
    var presented: Presentation?
    var showHub = false
    var showKeyboard = false
    /// The shot the Mac sent, on screen.
    ///
    /// The same shape as the two flags above and read in the same place — inside
    /// `RemoteView`'s ZStack — because a screenshot can only be asked for from
    /// the remote screen, and that is already where a panel over that screen is
    /// presented from.
    ///
    /// A second value beside `lastScreenshot` rather than `lastScreenshot != nil`
    /// doing both jobs: the image is the last shot this phone received and
    /// outlives the panel that showed it, and closing a sheet is not a reason to
    /// throw a picture away.
    var showScreenshot = false
    /// What the 07B confirm sheet is asking about. Revoking everything is the
    /// most destructive thing in the app and used to be the only revoke with no
    /// confirmation at all, because the sheet could only describe one device.
    enum RevokeTarget {
        case device(PairedDeviceEntry)
        case everything(count: Int)
    }

    var showRevokeConfirm: RevokeTarget?

    // Connection
    var pairedHost: Identity.PairedHost?
    var connection: HostClient.State = .idle
    var hostName = "Mac"
    var hostModel = ""
    var hostOS = ""
    var capabilities: [String: Bool] = [:]

    // Condition
    var link = LinkStatus()
    var transport = TransportStatus()
    var displays: [DisplayEntry] = []
    var settings = HostSettingsMirror()
    var devices: [PairedDeviceEntry] = []

    // Streaming
    var streamState: StreamState = .stopped
    var videoConfigs: [Int: VideoConfig] = [:]

    /// Streams whose frames are arriving and cannot be turned into pictures,
    /// keyed by stream id, carrying the decoder's own reason.
    ///
    /// Deliberately *not* a case on `StreamState`. The host's stream state and
    /// this phone's decoder are two independent facts, and in this failure both
    /// are true at once: the Mac is sending, and VideoToolbox is refusing what
    /// it sends. Folded into one enum, the next `streamState: live` from the
    /// host — and it sends them — would erase a fault the host cannot see, and
    /// the strip would go back to saying LIVE over a frozen frame.
    ///
    /// It is also not a stall. A stall means frames stopped arriving; here they
    /// are arriving, nothing is queued, the round trip is real, and every key
    /// and tap is still landing on the Mac. Same frozen picture, opposite cause,
    /// different answer.
    var decodeFailures: [Int: String] = [:]
    var zoomScale: CGFloat = 1
    var zoomLocked = false
    var sideBySide = false
    var inputPane = 0
    var lastFrameAgeSeconds: Int?

    // Input
    var heldModifiers: Set<String> = []
    var sessionCount = 0

    // Clipboard / screenshot
    var clipboardFromMac = ""
    var lastScreenshot: UIImage?

    // Claude
    var claudeMode: ClaudeMode = .code
    var claudeSessions: [ClaudeSessionEntry] = []
    var claudeTurns: [ClaudeTurn] = []
    var toolCalls: [ToolCall] = []
    var changedFiles: [ChangedFile] = []
    var permission: PermissionRequest?
    var claudeStreaming = false
    var claudeTokensPerSecond = 0
    var claudeSessionId: String?
    var claudeCwd = ""
    var claudeBranch: String?
    var claudeUsingSubscription: Bool?
    var claudeOpenedAt: Date?
    /// Spawned, but the CLI has not spoken yet.
    var claudeOpening = false
    /// Attached to the Claude Code session running in a terminal, rather than
    /// to a `--print` conversation of our own.
    var claudeIsLive = false

    /// The file whose diff is on screen, and the patch itself. The host keeps
    /// re-sending the patch while this is open, so the view follows the edits.
    var diffPath: String?
    var diffPatch = ""
    var claudeRateLimitNote: String?

    // Errors surfaced to the user
    var banner: String?

    let renderers = RendererPool()
    let linkMonitor = LinkMonitor()
    private let client = HostClient()
    private var pointerBudget = PointerBudget()

    enum ClaudeMode: String { case chat, code }

    init() {
        pairedHost = Identity.loadPairedHost()
        route = pairedHost == nil ? .pairing : .home

        // Frames are decoded off the main actor by design, so the renderer's
        // verdict on them arrives off it too and hops here. This is the whole
        // route from a VideoToolbox error to something a view can read.
        renderers.onDecodeFailureChange = { [weak self] streamId, reason in
            Task { @MainActor in
                guard let self else { return }
                if let reason {
                    self.decodeFailures[streamId] = reason
                } else {
                    self.decodeFailures.removeValue(forKey: streamId)
                }
            }
        }

        Task { await installHandlers() }

        // Tell the host which radio we are on so the cellular cap applies
        // only when it should.
        linkMonitor.onChange = { [weak self] expensive, constrained in
            self?.send([
                "t": "link",
                "expensive": expensive,
                "constrained": constrained,
            ])
        }
        linkMonitor.start()
    }

    private func installHandlers() async {
        await client.setHandlers(
            control: { [weak self] payload in
                Task { @MainActor in self?.receive(payload) }
            },
            video: { [weak self] frame in
                // Rendering is thread-safe and must not wait on the main actor.
                // The header's stream id picks the decoder: one per display.
                self?.renderers.renderer(forStream: Int(frame.streamId)).enqueue(frame)
            },
            state: { [weak self] state in
                Task { @MainActor in self?.connectionChanged(state) }
            },
            hostRecord: { [weak self] record in
                Task { @MainActor in self?.pairedHost = record }
            }
        )
    }

    // MARK: Lifecycle

    func connectIfPaired() async {
        guard let pairedHost else { return }
        await client.connect(to: pairedHost)
        // Re-report on every connect; the host does not persist it.
        send([
            "t": "link",
            "expensive": linkMonitor.isExpensive,
            "constrained": linkMonitor.isConstrained,
        ])
    }

    func disconnect() async {
        await client.disconnect()
        renderers.resetAll()
        decodeFailures.removeAll()
        streamState = .stopped
    }

    /// Pairs against the addresses the QR offered, best first.
    ///
    /// `address` is whatever was typed or scanned — a bare IP, a host and port,
    /// or a full `https://` tunnel URL. `alternates` are the Mac's other
    /// addresses, which the phone keeps so it can find the same Mac from a
    /// different network without pairing again.
    func completePairing(
        address: String,
        port: Int,
        code: String,
        alternates: [String] = []
    ) async -> String? {
        let candidates: [Endpoint]
        do {
            let primary = try Endpoint.parse(address, fallbackPort: port)
            candidates = ([primary.origin] + alternates).compactMap(Endpoint.lenient)
                .reduce(into: [Endpoint]()) { unique, endpoint in
                    if !unique.contains(where: { $0.origin == endpoint.origin }) {
                        unique.append(endpoint)
                    }
                }
        } catch {
            return error.localizedDescription
        }

        do {
            let paired = try await client.pair(candidates: candidates, code: code)
            pairedHost = paired
            hostName = paired.hostName
            await client.connect(to: paired)
            route = .home
            return nil
        } catch {
            return error.localizedDescription
        }
    }

    func probe(address: String, port: Int) async -> Double? {
        guard let endpoint = try? Endpoint.parse(address, fallbackPort: port) else { return nil }
        return await client.probe(endpoint: endpoint)
    }

    /// The Mac moved. Same Mac, same key, new address.
    ///
    /// Pairing binds a device id to a public key, and neither of those depends on
    /// where the Mac is — so an address that stops answering is not a reason to
    /// trade keys again. `Identity.PairedHost` stores exactly one address, so
    /// until this existed a Mac that changed IP was unreachable from this phone
    /// until it was paired again: six digits off the menu bar, a new device row on
    /// the Mac, and the old one left behind. A Cloudflare quick tunnel takes a
    /// fresh hostname on every host restart, which is that price several times a
    /// day.
    ///
    /// Probes before committing, and leaves the stored address alone if nothing
    /// answers: replacing a working address with a typo is a worse outcome than
    /// the problem being solved.
    ///
    /// The addresses already known for this Mac are kept as alternates rather
    /// than discarded — a Mac at a new tunnel hostname is still at the same LAN
    /// address when the phone comes home.
    func repoint(host address: String, port: Int) async -> String? {
        guard var moved = pairedHost else {
            return "Nothing is paired, so there is no address to change."
        }

        let endpoint: Endpoint
        do {
            endpoint = try Endpoint.parse(address, fallbackPort: port)
        } catch {
            return error.localizedDescription
        }

        guard await client.probe(endpoint: endpoint) != nil else {
            return "No answer from \(endpoint.display). The address is unchanged."
        }

        moved.alternates = Endpoint.normalise([moved.origin] + moved.alternates)
            .filter { $0 != endpoint.origin }
        moved.origin = endpoint.origin
        do {
            try Identity.save(moved)
        } catch {
            return error.localizedDescription
        }
        pairedHost = moved

        // Retire the old socket explicitly. Its backoff has usually given up by
        // the time anyone reaches for this, and `connect` declines to open a
        // second socket for a device that already has one — so without this the
        // new address would be stored and never dialled.
        await client.disconnect()
        banner = nil
        await connectIfPaired()
        return nil
    }

    /// `vibewire://pair?origin=…&alt=…&host=…&port=…&code=…` — the payload behind
    /// the QR the Mac shows. Handled here rather than in the pairing view so it
    /// works from a cold launch as well as from the scanner.
    ///
    /// `origin` and `alt` are what a current host sends: full origins, tunnel
    /// first. `host` and `port` are still read, because a phone updated ahead of
    /// the Mac it talks to must still be able to pair with it.
    func handlePairingURL(_ url: URL) async {
        guard url.scheme == "vibewire", url.host == "pair",
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { return }

        let items = components.queryItems ?? []
        func value(_ name: String) -> String? {
            items.first { $0.name == name }?.value
        }

        let offered = PairingLink(
            origin: value("origin"),
            alternates: value("alt"),
            host: value("host"),
            port: value("port")
        )

        guard let address = offered.address, let code = value("code"), code.count == 6 else {
            banner = "That pairing link is missing an address or code."
            return
        }

        if let failure = await completePairing(
            address: address,
            port: offered.port,
            code: code,
            alternates: offered.alternates
        ) {
            banner = failure
        }
    }

    private func connectionChanged(_ state: HostClient.State) {
        connection = state
        switch state {
        case .connected:
            banner = nil
            if case .reconnecting = streamState { streamState = .live }
        case .reconnecting(let attempt, let nextRetryMs):
            streamState = .reconnecting(attempt: attempt, nextRetryMs: nextRetryMs)
        case .failed(let reason):
            streamState = .failed(reason)
            banner = "Lost the Mac. \(reason)"
        case .unauthorized:
            // Retrying cannot help: the Mac no longer holds this device's key.
            streamState = .failed("device revoked")
            banner = "This Mac no longer recognises this device. Pair again."
            unpairLocally()
        case .idle, .connecting:
            break
        }
    }

    var queuedInputCount: Int {
        get async { await client.queuedInputCount }
    }

    // MARK: Inbound

    // swiftlint:disable:next cyclomatic_complexity
    private func receive(_ payload: [String: Any]) {
        guard let type = payload["t"] as? String else { return }

        switch type {
        case "hello":
            hostName = payload["hostName"] as? String ?? "Mac"
            hostModel = payload["model"] as? String ?? ""
            hostOS = payload["os"] as? String ?? ""
            capabilities = payload["capabilities"] as? [String: Bool] ?? [:]
            if capabilities["screenRecording"] == false {
                banner = "Screen Recording is off on the Mac. Grant it in System Settings."
            } else if capabilities["accessibility"] == false {
                banner = "Accessibility is off on the Mac. Input will not reach it."
            }

        case "status":
            link.awake = payload["awake"] as? Bool ?? true
            link.onPower = payload["onPower"] as? Bool ?? true
            link.rttMillis = payload["rttMillis"] as? Double
            link.jitterMillis = payload["jitterMillis"] as? Double
            link.lossPercent = payload["lossPercent"] as? Double ?? 0
            link.downMbps = payload["downMbps"] as? Double ?? 0
            link.rttHistory = payload["rttHistory"] as? [Double] ?? []
            link.frontmostApp = payload["frontmostApp"] as? String ?? ""
            link.canWake = payload["canWake"] as? Bool ?? true

        case "displays":
            displays = (payload["displays"] as? [[String: Any]] ?? []).compactMap { entry in
                guard let id = entry["id"] as? Int,
                      let name = entry["name"] as? String else { return nil }
                return DisplayEntry(
                    id: UInt32(id),
                    name: name,
                    width: entry["width"] as? Int ?? 0,
                    height: entry["height"] as? Int ?? 0,
                    refreshHz: entry["hz"] as? Int ?? 60,
                    isBuiltIn: entry["isBuiltIn"] as? Bool ?? false,
                    selected: entry["selected"] as? Bool ?? false,
                    streamId: entry["streamId"] as? Int
                )
            }
            if !displays.contains(where: \.selected), let first = displays.first {
                selectDisplay(first.id)
            }
            // The host is the authority on what is selected. Without this the
            // tabs could read MON 1 while the host was streaming both, and the
            // single picture would be fed two streams at once.
            sideBySide = displays.filter(\.selected).count > 1

        case "transport":
            transport.path = TransportStatus.Path(
                rawValue: payload["path"] as? String ?? "none"
            ) ?? .none
            transport.tailscaleRunning = payload["tailscaleRunning"] as? Bool ?? false
            transport.tailscaleAddress = payload["tailscaleAddress"] as? String
            transport.relayName = payload["relayName"] as? String
            transport.cloudflareRunning = payload["cloudflareRunning"] as? Bool ?? false
            transport.cloudflareHostname = payload["cloudflareHostname"] as? String
            transport.lanAddress = payload["lanAddress"] as? String
            // The Mac is the only thing that knows all of its own addresses, and
            // a Cloudflare quick tunnel's hostname exists nowhere else — it is
            // minted at host launch and never written down. Learning it here,
            // over a socket that is already up, is what lets this phone reach
            // the same Mac from cellular later without pairing again.
            transport.candidates = (payload["candidates"] as? [String]) ?? []
            let learned = transport.candidates
            if !learned.isEmpty {
                Task { await client.learn(alternates: learned) }
            }

        case "settings":
            settings.quality = payload["quality"] as? String ?? "auto"
            settings.capOnCellular = payload["capOnCellular"] as? Bool ?? true
            settings.cellularCeilingMbps = payload["cellularCeilingMbps"] as? Double ?? 3
            settings.sensitivity = payload["sensitivity"] as? Int ?? 5
            settings.naturalScrolling = payload["naturalScrolling"] as? Bool ?? true
            settings.requireBiometricEachSession =
                payload["requireBiometricEachSession"] as? Bool ?? true
            settings.relayOverInternet = payload["relayOverInternet"] as? Bool ?? false
            settings.hostVersion = payload["hostVersion"] as? String ?? "—"

        case "devices":
            let formatter = ISO8601DateFormatter()
            devices = (payload["devices"] as? [[String: Any]] ?? []).compactMap { entry in
                guard let id = entry["id"] as? String,
                      let name = entry["name"] as? String else { return nil }
                return PairedDeviceEntry(
                    id: id,
                    name: name,
                    kind: entry["kind"] as? String ?? "phone",
                    pairedAt: (entry["pairedAt"] as? String).flatMap(formatter.date(from:)) ?? Date(),
                    lastSeenAt: (entry["lastSeenAt"] as? String).flatMap(formatter.date(from:)),
                    connected: entry["connected"] as? Bool ?? false,
                    isThisDevice: entry["isThisDevice"] as? Bool ?? false
                )
            }

        case "streamState":
            applyStreamState(payload)

        case "videoConfig":
            guard let streamId = payload["streamId"] as? Int else { return }
            videoConfigs[streamId] = VideoConfig(
                streamId: streamId,
                displayId: UInt32(payload["displayId"] as? Int ?? 0),
                width: payload["width"] as? Int ?? 0,
                height: payload["height"] as? Int ?? 0,
                fps: payload["fps"] as? Int ?? 60,
                bitrate: payload["bitrate"] as? Int ?? 0,
                ladder: payload["ladder"] as? String ?? "auto"
            )
            renderers.keepOnly(streamIds: Set(videoConfigs.keys))

        case "clipboard":
            if payload["direction"] as? String == "fromMac",
               let text = payload["text"] as? String, !text.isEmpty {
                clipboardFromMac = text
                UIPasteboard.general.string = text
                // COPY put the Mac's clipboard on this phone and said nothing at
                // all, so the tile and a tile that had failed looked identical.
                // The first line of what arrived is the proof it arrived.
                banner = "Copied from the Mac: \(firstLine(of: text))"
            }

        case "screenshot":
            if let base64 = payload["png"] as? String,
               let data = Data(base64Encoded: base64),
               let image = UIImage(data: data) {
                lastScreenshot = image
                UIPasteboard.general.image = image
                // The banner that used to be the whole of this tile's result is
                // gone with the panel arriving. It said the shot was on the
                // clipboard — true, and now stated inside the panel next to the
                // two things that can be done with it — and said nothing at all
                // about the picture, which nothing rendered. It would also come
                // up at the bottom edge, directly over the two actions.
                withAnimation(NS.Motion.stateChange) { showScreenshot = true }
            }

        case "lastFrame":
            lastFrameAgeSeconds = payload["ageSeconds"] as? Int

        case "frontmost":
            link.frontmostApp = payload["app"] as? String ?? link.frontmostApp

        case "claude":
            receiveClaude(payload)

        case "error":
            banner = payload["message"] as? String

        default:
            break
        }
    }

    private func applyStreamState(_ payload: [String: Any]) {
        switch payload["state"] as? String {
        case "starting": streamState = .starting
        case "live":
            streamState = .live
            sessionCount += 1
        case "stalled":
            streamState = .stalled(millis: payload["stalledMs"] as? Int ?? 0)
        case "stopped":
            streamState = .stopped
            renderers.resetAll()
            decodeFailures.removeAll()
        default: break
        }
    }

    // swiftlint:disable:next cyclomatic_complexity
    private func receiveClaude(_ payload: [String: Any]) {
        guard let sub = payload["sub"] as? String else { return }

        switch sub {
        case "sessions":
            let formatter = ISO8601DateFormatter()
            claudeSessions = (payload["sessions"] as? [[String: Any]] ?? []).compactMap { entry in
                guard let id = entry["id"] as? String else { return nil }
                return ClaudeSessionEntry(
                    id: id,
                    summary: entry["summary"] as? String ?? "Untitled",
                    cwd: entry["cwd"] as? String ?? "",
                    gitBranch: entry["gitBranch"] as? String,
                    modifiedAt: (entry["modifiedAt"] as? String)
                        .flatMap(formatter.date(from:)) ?? Date(),
                    messageCount: entry["messages"] as? Int ?? 0
                )
            }

        case "opened":
            let incomingId = payload["sessionId"] as? String
            if let incomingId, !incomingId.isEmpty { claudeSessionId = incomingId }
            claudeCwd = payload["cwd"] as? String ?? claudeCwd
            // Attached to the session running in a terminal rather than to a
            // private one of our own. Worth holding onto: re-opening would
            // silently drop back to a separate conversation the user cannot see.
            claudeIsLive = payload["live"] as? Bool ?? false
            if claudeIsLive { claudeOpening = false }

            // The host acks the spawn before the CLI has said anything. That
            // ack carries no model, no tools and no auth source, so it must not
            // overwrite them — it only proves something is running.
            if payload["pending"] as? Bool == true { return }

            claudeOpening = false
            claudeUsingSubscription = payload["usingSubscription"] as? Bool
            claudeOpenedAt = Date()
            toolCalls.removeAll()
            changedFiles.removeAll()
            if claudeUsingSubscription == false {
                banner = "Claude is billing through an API key, not your subscription."
            }

        case "diff":
            guard payload["path"] as? String == diffPath else { return }
            diffPatch = payload["patch"] as? String ?? ""

        case "history":
            // Sent once, right after a resume. Replaces rather than appends:
            // the transcript on disk is the authority on what was said before
            // this connection existed.
            let formatter = ISO8601DateFormatter()
            claudeTurns = (payload["turns"] as? [[String: Any]] ?? []).compactMap { entry in
                guard let role = entry["role"] as? String,
                      let text = entry["text"] as? String
                else { return nil }
                return ClaudeTurn(
                    role: role == "user" ? .user : .assistant,
                    text: text,
                    at: (entry["at"] as? String).flatMap(formatter.date(from:)) ?? Date()
                )
            }

        case "delta":
            // A session that is answering has plainly started. `claudeOpening`
            // was only ever cleared by an `opened` message, which a brand new
            // session need not send, so the header sat on "STARTING · SEND A
            // MESSAGE TO BEGIN" with the reply printed directly beneath it.
            claudeOpening = false
            claudeStreaming = true
            if let tps = payload["tokensPerSecond"] as? Int { claudeTokensPerSecond = tps }
            guard let text = payload["text"] as? String else { return }
            if var last = claudeTurns.last, last.role == .assistant {
                last.text += text
                claudeTurns[claudeTurns.count - 1] = last
            } else {
                claudeTurns.append(ClaudeTurn(role: .assistant, text: text, at: Date()))
            }

        case "message":
            claudeOpening = false
            claudeStreaming = false
            let blocks = payload["blocks"] as? [[String: Any]] ?? []
            let text = blocks
                .filter { ($0["type"] as? String) == "text" }
                .compactMap { $0["text"] as? String }
                .joined(separator: "\n")
            guard !text.isEmpty else { return }

            // `role` was ignored here, and the CLI runs with
            // `--replay-user-messages`, so the user's own prompt came back as a
            // `message` and was written *over* the assistant's turn — the reply
            // was replaced by the question that prompted it.
            if (payload["role"] as? String) == "user" {
                // Already shown optimistically when it was sent. Appended only
                // if it is not the turn we just added, so a prompt sent from
                // another device still appears.
                let alreadyShown = claudeTurns.last.map { $0.role == .user && $0.text == text } ?? false
                if !alreadyShown {
                    claudeTurns.append(ClaudeTurn(role: .user, text: text, at: Date()))
                }
                return
            }

            if var last = claudeTurns.last, last.role == .assistant, last.text.isEmpty == false {
                // The streamed deltas already built this turn; replace with the
                // authoritative final text rather than appending a duplicate.
                last.text = text
                claudeTurns[claudeTurns.count - 1] = last
            } else {
                claudeTurns.append(ClaudeTurn(role: .assistant, text: text, at: Date()))
            }

        case "tool":
            claudeOpening = false
            guard let id = payload["id"] as? String else { return }
            let call = ToolCall(
                id: id,
                name: payload["name"] as? String ?? "",
                target: payload["target"] as? String ?? "",
                state: ToolCall.State(rawValue: payload["state"] as? String ?? "running") ?? .running,
                milliseconds: payload["ms"] as? Int,
                preview: payload["preview"] as? String
            )
            if let index = toolCalls.firstIndex(where: { $0.id == id }) {
                toolCalls[index] = call
            } else {
                toolCalls.append(call)
            }

        case "files":
            changedFiles = (payload["files"] as? [[String: Any]] ?? []).compactMap { entry in
                guard let path = entry["path"] as? String else { return nil }
                return ChangedFile(
                    path: path,
                    status: entry["status"] as? String ?? "M",
                    added: entry["added"] as? Int ?? 0,
                    removed: entry["removed"] as? Int ?? 0
                )
            }

        case "permission":
            guard let id = payload["requestId"] as? String else { return }
            permission = PermissionRequest(
                id: id,
                toolName: payload["toolName"] as? String ?? "",
                command: payload["command"] as? String ?? "",
                explanation: payload["explanation"] as? String ?? "",
                arrivedAt: Date()
            )

        case "usage":
            claudeStreaming = false

        case "rateLimit":
            if let status = payload["status"] as? String, status != "allowed" {
                claudeRateLimitNote = "Rate limited (\(status))"
            } else {
                claudeRateLimitNote = nil
            }

        case "ended":
            claudeStreaming = false
            claudeSessionId = nil

        case "error":
            banner = payload["message"] as? String

        default:
            break
        }
    }

    // MARK: Outbound

    private func send(_ message: [String: Any]) {
        Task { await client.send(message) }
    }

    private func sendTransient(_ message: [String: Any]) {
        Task { await client.sendTransient(message) }
    }

    func selectDisplay(_ id: UInt32) {
        for index in displays.indices {
            displays[index].selected = displays[index].id == id
            // The host numbers streams by position within the selection, so a
            // single display is always stream 0 and an unselected one has no
            // stream at all. Leaving the previous value here is what left the
            // picture black on the way back from side by side: display 2 kept
            // claiming stream 1, the window before `videoConfig` arrives
            // resolved the picture to renderer 1, and every frame of the new
            // single stream was arriving on renderer 0.
            displays[index].streamId = displays[index].id == id ? 0 : nil
        }
        sideBySide = false
        send(["t": "selectDisplay", "displayIds": [Int(id)], "mode": "single"])
    }

    func selectBothDisplays() {
        // Same numbering the host uses, over the same order sent below.
        for index in displays.indices {
            displays[index].selected = true
            displays[index].streamId = index
        }
        sideBySide = true
        send([
            "t": "selectDisplay",
            "displayIds": displays.map { Int($0.id) },
            "mode": "sideBySide",
        ])
    }

    /// The decoder carrying a given display. One per stream — see RendererPool.
    func renderer(forDisplay id: UInt32) -> VideoRenderer {
        if let config = videoConfigs.values.first(where: { $0.displayId == id }) {
            return renderers.renderer(forStream: config.streamId)
        }
        if let streamId = displays.first(where: { $0.id == id })?.streamId {
            return renderers.renderer(forStream: streamId)
        }
        // Falling back to stream 0 for *every* display made both side-by-side
        // panes resolve to the same renderer in the window before `videoConfig`
        // arrives. A layer has exactly one superlayer, so the second pane took
        // it and the first stayed black — "it takes some time for one of them
        // to load", and sometimes it never did. The host assigns stream ids in
        // the order of the selected displays, so that order is the right guess
        // to make meanwhile, and it never collides.
        let selected = displays.filter(\.selected)
        if let index = selected.firstIndex(where: { $0.id == id }) {
            return renderers.renderer(forStream: index)
        }
        return renderers.renderer(forStream: 0)
    }

    var selectedRenderer: VideoRenderer {
        guard let display = displays.first(where: \.selected) else {
            return renderers.renderer(forStream: 0)
        }
        return renderer(forDisplay: display.id)
    }

    /// Why a given display's picture cannot be decoded, if it cannot. Resolved
    /// through the same stream id the picture is drawn from, so a failure on the
    /// monitor that is not on screen cannot claim the one that is.
    func decodeFailure(forDisplay id: UInt32) -> String? {
        if let config = videoConfigs.values.first(where: { $0.displayId == id }) {
            return decodeFailures[config.streamId]
        }
        if let streamId = displays.first(where: { $0.id == id })?.streamId {
            return decodeFailures[streamId]
        }
        return nil
    }

    var selectedDecodeFailure: String? {
        guard let display = displays.first(where: \.selected) else {
            return decodeFailures[0]
        }
        return decodeFailure(forDisplay: display.id)
    }

    func startStream() {
        // Stream ids are reassigned per start; keeping the old configs would
        // point a pane at a decoder the host is no longer filling. Resetting
        // the renderers is not enough for the same reason — a reset renderer is
        // still the object stream 1 resolved to a moment ago, and a view that
        // already adopted its layer would hold a decoder nothing feeds. Drop
        // them, so the next resolution builds a renderer for the new numbering.
        videoConfigs.removeAll()
        renderers.removeAll()
        // The renderers report their own clearing, but that hops back through
        // the main actor and this has to be true before the remote screen is
        // first drawn — a card describing the stream that just ended has no
        // business on the one that is starting.
        decodeFailures.removeAll()
        // The same reason the decode failures go: a panel describing the
        // session that just ended has no business on the one that is starting.
        // `stopStream` clears this too, but a revoke or a dropped socket leaves
        // the remote screen without passing through it.
        showScreenshot = false
        streamState = .starting
        route = .remote
        send([
            "t": "startStream",
            "displayIds": displays.filter(\.selected).map { Int($0.id) },
        ])
    }

    func stopStream() {
        send(["t": "stopStream"])
        renderers.resetAll()
        decodeFailures.removeAll()
        streamState = .stopped
        showHub = false
        showKeyboard = false
        // A shot that is still in flight when the stream is stopped would
        // otherwise raise its panel over Home, or wait there and open itself
        // over the next session's picture.
        showScreenshot = false
        releaseModifiers()
        route = .home
    }

    // MARK: Input

    func movePointer(dx: CGFloat, dy: CGFloat) {
        // Coalesce to the display refresh; sending every touch sample would
        // flood the socket without moving the cursor any more accurately.
        guard pointerBudget.shouldSend() else {
            pointerBudget.accumulate(dx: dx, dy: dy)
            return
        }
        let (totalX, totalY) = pointerBudget.drain(dx: dx, dy: dy)
        guard let display = displays.first(where: \.selected) else { return }
        sendTransient([
            "t": "pointer",
            "phase": "move",
            "dx": totalX,
            "dy": totalY,
            "display": Int(display.id),
            "sensitivity": settings.sensitivity,
        ])
    }

    func click(count: Int = 1, button: String = "left") {
        let display = displays.first(where: \.selected)
        send([
            "t": "click",
            "button": button,
            "count": count,
            "display": display.map { Int($0.id) } as Any,
        ])
    }

    /// `count` is the click the button goes down on: 2 is a double tap that held
    /// on and is now dragging, which is how a word is selected and stretched.
    func drag(_ phase: String, dx: CGFloat = 0, dy: CGFloat = 0, count: Int = 1) {
        send(["t": "drag", "phase": phase, "dx": dx, "dy": dy, "count": count])
    }

    func scroll(dx: CGFloat, dy: CGFloat, momentum: Bool = false) {
        sendTransient(["t": "scroll", "dx": dx, "dy": dy, "momentum": momentum])
    }

    func zoom(to scale: CGFloat) {
        let clamped = min(max(scale, 1), 6)
        let delta = clamped / max(zoomScale, 0.01)
        zoomScale = clamped
        sendTransient(["t": "zoom", "scale": delta, "locked": zoomLocked])
    }

    func resetZoom() {
        zoomScale = 1
        sendTransient(["t": "zoom", "scale": 0.01, "locked": false])
    }

    func toggleModifier(_ name: String) {
        if heldModifiers.contains(name) {
            heldModifiers.remove(name)
        } else {
            heldModifiers.insert(name)
        }
        send(["t": "modifiers", "held": Array(heldModifiers), "latched": true])
    }

    func releaseModifiers() {
        heldModifiers.removeAll()
        send(["t": "modifiers", "held": [], "latched": false])
    }

    func key(_ code: String, chars: String? = nil) {
        send(["t": "key", "code": code, "chars": chars as Any, "down": true])
        send(["t": "key", "code": code, "chars": chars as Any, "down": false])
        // A modifier tapped before a letter fires once and releases, which is
        // the behaviour the key-row detail panel describes.
        if !heldModifiers.isEmpty { releaseModifiers() }
    }

    func combo(_ keys: [String]) {
        send(["t": "combo", "keys": keys])
    }

    func type(_ text: String) {
        guard !text.isEmpty else { return }
        send(["t": "text", "value": text])
    }

    func hub(_ action: String) {
        if action == "paste" {
            // Push the phone's clipboard first, then ask for the keystroke.
            if let text = UIPasteboard.general.string {
                send(["t": "clipboardPush", "text": text])
            }
        }
        send(["t": "hubAction", "action": action])
        if action != "keys" && action != "mods" { showHub = false }
    }

    func requestLastFrame() {
        send(["t": "lastFrame"])
    }

    func retry() {
        send(["t": "retry"])
        Task { await connectIfPaired() }
    }

    func wake() {
        send(["t": "wake"])
    }

    // MARK: Settings

    func setSetting(_ key: String, _ value: Any) {
        send(["t": "setting", "key": key, "value": value])
    }

    func setQuality(_ ladder: String) {
        settings.quality = ladder
        send(["t": "setQuality", "ladder": ladder])
    }

    /// Revokes go out only if the socket is up. Queuing one would hold it until
    /// the next connection — which, after an unpair, is a different device
    /// entirely, and it would be revoked the instant it finished pairing.
    func revoke(_ device: PairedDeviceEntry) {
        showRevokeConfirm = nil
        Task {
            let delivered = await client.sendUnqueued(["t": "revoke", "deviceId": device.id])
            if !delivered {
                banner = "Not connected to the Mac, so nothing was revoked."
                return
            }
            if device.isThisDevice { unpairLocally() }
        }
    }

    func revokeAll() {
        showRevokeConfirm = nil
        Task {
            let delivered = await client.sendUnqueued(["t": "revoke", "all": true])
            if !delivered {
                banner = "Not connected to the Mac, so nothing was revoked."
                return
            }
            unpairLocally()
        }
    }

    /// This phone forgets the Mac, and nothing else happens.
    ///
    /// Deliberately not a revoke. Revoking deletes keys on the Mac and takes
    /// every other device with it; this drops only what this phone holds, so the
    /// Mac keeps its row for this device and the next pairing reuses it rather
    /// than adding a second. Two different acts with two different costs, and
    /// the screen says which is which.
    ///
    /// No confirmation, because there is nothing to confirm: the cost of a
    /// mistaken tap is six digits off the menu bar, and the socket it drops was
    /// going to be dropped by the next lock screen anyway.
    func logOut() {
        unpairLocally()
    }

    private func unpairLocally() {
        Identity.forgetHost()
        pairedHost = nil
        route = .pairing
        // Revoking every device is triggered from inside the Settings sheet, so
        // without this the sheet stays up over the pairing screen — settings
        // for a host this phone no longer has a key to.
        presented = nil
        showRevokeConfirm = nil
        Task { await disconnect() }
    }

    // MARK: Claude

    func openClaude(mode: ClaudeMode, sessionId: String? = nil, cwd: String? = nil) {
        claudeMode = mode
        claudeTurns.removeAll()
        toolCalls.removeAll()
        changedFiles.removeAll()
        permission = nil

        // Show the picked session straight away. The CLI does not say a word
        // until it has been given something to do, so waiting for its `init`
        // left the panel reading NO SESSION with a live process behind it —
        // which looks exactly like the tap having done nothing.
        if let sessionId { claudeSessionId = sessionId }
        if let cwd { claudeCwd = cwd }
        claudeUsingSubscription = nil
        claudeOpenedAt = Date()
        claudeOpening = true
        var message: [String: Any] = ["t": "claude", "sub": "open", "mode": mode.rawValue]
        if let sessionId { message["sessionId"] = sessionId }
        if let cwd { message["cwd"] = cwd }
        send(message)
    }

    /// Opens the live diff for a file. The host pushes a fresh patch after
    /// every tool result until it is closed, so an edit lands on screen as it
    /// happens rather than when something is refreshed.
    func openDiff(path: String) {
        diffPath = path
        diffPatch = ""
        send(["t": "claude", "sub": "diff", "path": path])
    }

    func closeDiff() {
        diffPath = nil
        diffPatch = ""
        // Nil path means stop watching; without it the host keeps computing a
        // diff for a screen nobody is looking at.
        send(["t": "claude", "sub": "diff"])
    }

    func listClaudeSessions() {
        send(["t": "claude", "sub": "listSessions"])
    }

    func sendToClaude(_ text: String) {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        claudeTurns.append(ClaudeTurn(role: .user, text: text, at: Date()))
        claudeStreaming = true
        send(["t": "claude", "sub": "send", "text": text])
    }

    func interruptClaude() {
        send(["t": "claude", "sub": "interrupt"])
        claudeStreaming = false
    }

    func answerPermission(allow: Bool, scope: String, message: String? = nil) {
        guard let permission else { return }
        send([
            "t": "claude",
            "sub": "permission",
            "requestId": permission.id,
            "behavior": allow ? "allow" : "deny",
            "scope": scope,
            "message": message as Any,
        ])
        self.permission = nil
    }
}

/// The first line of a clipboard payload, short enough for a banner.
///
/// A copied build error is forty lines; a banner is one. Naming the first line is
/// enough to say *which* copy arrived without turning the banner into a document.
private func firstLine(of text: String) -> String {
    let line = text.split(separator: "\n", maxSplits: 1).first.map(String.init) ?? text
    let trimmed = line.trimmingCharacters(in: .whitespaces)
    return trimmed.count > 48 ? String(trimmed.prefix(47)) + "…" : trimmed
}

/// Pointer coalescing. Touch delivers up to 120 samples a second; the Mac only
/// needs one packet per displayed frame, and the deltas add up losslessly.
private struct PointerBudget {
    private var pendingX: CGFloat = 0
    private var pendingY: CGFloat = 0
    private var lastSend = Date.distantPast
    private let interval: TimeInterval = 1.0 / 120.0

    mutating func shouldSend() -> Bool {
        Date().timeIntervalSince(lastSend) >= interval
    }

    mutating func accumulate(dx: CGFloat, dy: CGFloat) {
        pendingX += dx
        pendingY += dy
    }

    mutating func drain(dx: CGFloat, dy: CGFloat) -> (CGFloat, CGFloat) {
        let totalX = pendingX + dx
        let totalY = pendingY + dy
        pendingX = 0
        pendingY = 0
        lastSend = Date()
        return (totalX, totalY)
    }
}
