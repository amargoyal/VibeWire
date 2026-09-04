import Foundation

/// Talks to the Mac: pairing over HTTP, then one authenticated WebSocket.
///
/// Reconnection policy matches what screen 03D promises the user: retry with
/// backoff, hold input rather than dropping it, and give up at 30 seconds.
actor HostClient {
    enum State: Equatable {
        case idle
        case connecting(attempt: Int)
        case connected
        case reconnecting(attempt: Int, nextRetryMs: Int)
        case failed(String)
        /// The Mac rejected our identity. Only re-pairing clears this, so it is
        /// kept apart from `failed`, which is worth retrying.
        case unauthorized
    }

    /// Text control messages, already parsed into a dictionary.
    typealias ControlHandler = @Sendable ([String: Any]) -> Void
    /// A decoded binary video frame.
    typealias VideoHandler = @Sendable (VideoFrame) -> Void
    typealias StateHandler = @Sendable (State) -> Void

    private var task: URLSessionWebSocketTask?
    private var session: URLSession
    private var host: Identity.PairedHost?
    private(set) var state: State = .idle

    private var onControl: ControlHandler?
    private var onVideo: VideoHandler?
    private var onState: StateHandler?
    /// Fired when the stored pairing record changes underneath the app — a new
    /// address won, or the Mac told us about one we did not have.
    private var onHostRecord: (@Sendable (Identity.PairedHost) -> Void)?

    /// Which of the Mac's addresses this client is dialling.
    ///
    /// A Mac has up to three and only one of them answers from where the phone
    /// happens to be: the tunnel from cellular, the tailnet address wherever
    /// Tailscale is up, the LAN address at home. Rather than ask the user which
    /// network they are on, a failed attempt moves to the next address and the
    /// backoff carries on as before — so walking out of the house costs one
    /// reconnect, not a re-pair.
    private var dialIndex = 0
    /// The origin the live socket was opened against, so a socket that proves
    /// itself can promote the address that carried it.
    private var dialledOrigin: String?

    /// Input generated while the socket is down. Capped so a long outage does
    /// not replay a minute of stale gestures when it comes back.
    private var queuedOutbound: [[String: Any]] = []
    private let maxQueuedOutbound = 64

    /// Ping sequence, so the host can measure one-way loss on a single
    /// stream instead of inferring it from two.
    private var pingSequence: UInt64 = 0
    private var pendingPings: [UInt64: UInt64] = [:]
    private(set) var lastRttMillis: Double?
    private var reconnectAttempt = 0
    private var reconnectStartedAt: Date?
    private var shouldReconnect = true
    private var pingTask: Task<Void, Never>?
    /// Whether the current socket has delivered a frame. Until it has, the
    /// upgrade may still be refused.
    private var handshakeConfirmed = false
    /// True for the whole of `openSocket`, including its awaits, so two callers
    /// cannot each open a socket.
    private var isOpening = false
    /// Identifies the live socket, so a deliberately retired one can be told
    /// apart from one that failed.
    private var socketGeneration = 0

    init() {
        let configuration = URLSessionConfiguration.default
        configuration.timeoutIntervalForRequest = 10
        configuration.waitsForConnectivity = false
        // Video is latency-sensitive; do not let the system batch it.
        configuration.networkServiceType = .responsiveData
        self.session = URLSession(configuration: configuration)
    }

    func setHandlers(
        control: @escaping ControlHandler,
        video: @escaping VideoHandler,
        state: @escaping StateHandler,
        hostRecord: (@Sendable (Identity.PairedHost) -> Void)? = nil
    ) {
        onControl = control
        onVideo = video
        onState = state
        onHostRecord = hostRecord
    }

    var queuedInputCount: Int { queuedOutbound.count }

    // MARK: Pairing

    struct PairResponse: Decodable {
        let hostId: String
        let hostName: String
        let hostKey: String
        let deviceId: String
    }

    enum PairFailure: Error, LocalizedError {
        case unreachable
        /// A `URLSession` failure, reported verbatim. Collapsing these into
        /// `.unreachable` hid the one fact that identifies the cause: iOS
        /// refusing the request locally and the request going out and getting
        /// no answer look identical from the banner otherwise.
        case transport(domain: String, code: Int, detail: String, elapsedMs: Int)
        case badAddress(String)
        case badResponse
        case badCode
        case codeExpired
        case notPairing
        case lockedOut(retryAfter: Int)
        case protocolMismatch

        var errorDescription: String? {
            switch self {
            case .unreachable: return "No answer from that address."
            case .transport(let domain, let code, let detail, let elapsedMs):
                return "\(domain) \(code) after \(elapsedMs)ms — \(detail)"
            case .badAddress(let address): return "Not a usable address: \(address)"
            case .badResponse: return "The Mac answered, but not with HTTP."
            case .badCode: return "That code did not match."
            case .codeExpired: return "The code rotated. Read the new one."
            case .notPairing: return "The Mac is not showing a code right now."
            case .lockedOut(let retryAfter): return "Too many tries. Wait \(retryAfter)s."
            case .protocolMismatch: return "The Mac is running a different VibeWire version."
            }
        }
    }

    /// Unwraps a `URLSession` error into the innermost concrete cause. The
    /// `NSURLErrorDomain` code is a category (`-1004 could not connect`); the
    /// underlying `NSPOSIXErrorDomain` errno underneath it is the actual
    /// verdict — `EHOSTUNREACH` (65) and `ECONNREFUSED` (61) both surface as
    /// -1004 but mean opposite things about whether a packet left the phone.
    private static func describe(_ error: Error, elapsedMs: Int) -> PairFailure {
        let outer = error as NSError
        var detail = outer.localizedDescription
        var underlying = outer.userInfo[NSUnderlyingErrorKey] as? NSError
        while let inner = underlying {
            detail += " [\(inner.domain) \(inner.code)]"
            underlying = inner.userInfo[NSUnderlyingErrorKey] as? NSError
        }
        return .transport(
            domain: outer.domain,
            code: outer.code,
            detail: detail,
            elapsedMs: elapsedMs
        )
    }

    /// Pairs against the first of the Mac's addresses that answers.
    ///
    /// The QR carries every address the Mac believes it can be reached on, and
    /// which of them works depends on where the phone is standing — so trying
    /// them in order is the difference between pairing and reading an IP address
    /// off a failure banner. The order comes from the host and is respected.
    ///
    /// A refusal is not a reason to keep going. `code did not match` came from
    /// the Mac, which means this address is the right one and the digits are
    /// wrong; only a failure to *reach* an address moves on to the next.
    func pair(candidates: [Endpoint], code: String) async throws -> Identity.PairedHost {
        guard !candidates.isEmpty else { throw PairFailure.unreachable }
        let alternates = candidates.map(\.origin)
        var lastFailure: Error = PairFailure.unreachable

        // Probed together, dialled in order. Sequential 8-second timeouts across
        // three addresses can spend most of the code's sixty-second life finding
        // out which one is even there, and the code rotating mid-handshake is
        // the failure this is here to avoid.
        let responding = await Self.reachable(among: candidates)
        let ordered = responding.isEmpty ? candidates : responding

        for endpoint in ordered {
            do {
                return try await pairOnce(endpoint: endpoint, code: code, alternates: alternates)
            } catch let failure as PairFailure {
                switch failure {
                case .unreachable, .transport, .badAddress, .badResponse:
                    lastFailure = failure
                    continue
                default:
                    throw failure
                }
            }
        }
        throw lastFailure
    }

    /// One-shot handshake against a host that is showing a code.
    private func pairOnce(
        endpoint: Endpoint,
        code: String,
        alternates: [String]
    ) async throws -> Identity.PairedHost {
        guard let url = endpoint.baseURL?.appendingPathComponent("/v1/pair") else {
            throw PairFailure.badAddress(endpoint.origin)
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.timeoutInterval = 8
        request.httpBody = try JSONSerialization.data(withJSONObject: [
            "code": code,
            "deviceName": Identity.deviceName,
            "deviceKind": Identity.deviceKind,
            "publicKey": try Identity.publicKeyBase64(),
        ])

        let (data, response): (Data, URLResponse)
        let started = MonotonicClock.micros()
        do {
            (data, response) = try await session.data(for: request)
        } catch {
            let elapsedMs = Int((MonotonicClock.micros() - started) / 1000)
            let failure = Self.describe(error, elapsedMs: elapsedMs)
            print("[VibeWire] pair \(url) failed: \(failure.localizedDescription)")
            throw failure
        }

        guard let http = response as? HTTPURLResponse else { throw PairFailure.badResponse }

        if http.statusCode != 200 {
            let body = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            switch body?["error"] as? String {
            case "code_expired": throw PairFailure.codeExpired
            case "not_pairing": throw PairFailure.notPairing
            case "too_many_attempts":
                throw PairFailure.lockedOut(retryAfter: (body?["retryAfter"] as? Int) ?? 60)
            default: throw PairFailure.badCode
            }
        }

        let decoded = try JSONDecoder().decode(PairResponse.self, from: data)
        // A new pairing is a new identity. Nothing queued against the old one
        // may be replayed against it.
        queuedOutbound.removeAll()
        let paired = Identity.PairedHost(
            hostId: decoded.hostId,
            hostName: decoded.hostName,
            hostKey: decoded.hostKey,
            deviceId: decoded.deviceId,
            origin: endpoint.origin,
            // The address that answered leads; the rest are kept so the phone
            // can find this Mac again from a different network.
            alternates: Endpoint.normalise(alternates.filter { $0 != endpoint.origin }),
            pairedAt: Date()
        )
        try Identity.save(paired)
        self.host = paired
        dialIndex = 0
        return paired
    }

    /// Which of these addresses answer, asked all at once, reported in the order
    /// they were given rather than the order they replied.
    ///
    /// Order is the Mac's judgement about which path is worth preferring — the
    /// tailnet before the relay, because one of those is a direct route and the
    /// other is a trip through Cloudflare — and a race would replace it with
    /// whichever happened to be quickest to answer a health check.
    private static func reachable(among candidates: [Endpoint]) async -> [Endpoint] {
        await withTaskGroup(of: (Int, Bool).self) { group in
            for (index, endpoint) in candidates.enumerated() {
                group.addTask {
                    guard let url = endpoint.baseURL?.appendingPathComponent("/v1/health") else {
                        return (index, false)
                    }
                    var request = URLRequest(url: url)
                    request.timeoutInterval = 3
                    let answered = (try? await URLSession.shared.data(for: request))
                        .map { ($0.1 as? HTTPURLResponse)?.statusCode == 200 } ?? false
                    return (index, answered)
                }
            }

            var alive: Set<Int> = []
            for await (index, answered) in group where answered { alive.insert(index) }
            return candidates.enumerated()
                .filter { alive.contains($0.offset) }
                .map(\.element)
        }
    }

    /// Best-effort probe so pairing can say "MACBOOK PRO FOUND · 4 MS" before
    /// the user commits to typing six digits into a void.
    func probe(endpoint: Endpoint) async -> Double? {
        guard let url = endpoint.baseURL?.appendingPathComponent("/v1/health") else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        let started = Date()
        guard let (_, response) = try? await session.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200
        else { return nil }
        return Date().timeIntervalSince(started) * 1000
    }

    // MARK: Connection

    func connect(to host: Identity.PairedHost) async {
        // Launch calls this twice — once from the root view's `.task` and again
        // when the scene turns active — and a second call while the first
        // socket is still live opened a *second* socket to the Mac. The host
        // keeps one active socket and points Claude's output at whichever
        // registered last, so replies went to one socket while the app read the
        // other: Claude sat on "WORKING" forever with the answer delivered
        // somewhere the app was not listening.
        if self.host?.deviceId == host.deviceId, task != nil {
            switch state {
            case .connected, .connecting:
                return
            default:
                break
            }
        }

        self.host = host
        shouldReconnect = true
        reconnectAttempt = 0
        reconnectStartedAt = nil
        // A fresh session starts from the address that worked last, not from
        // wherever the previous session's rotation happened to stop.
        dialIndex = 0
        await openSocket()
    }

    /// Records addresses the Mac has told us about over the socket.
    ///
    /// The host reports its own transport once a second, and that report is the
    /// only place a Cloudflare quick tunnel's hostname exists — it is minted on
    /// every host launch. Learning it while connected over Wi-Fi is what makes
    /// the phone able to reach the same Mac from cellular later, without anyone
    /// typing a hostname or scanning anything again.
    func learn(alternates offered: [String]) {
        guard var host else { return }
        let merged = Endpoint.normalise([host.origin] + offered + host.alternates)
        let updated = merged.filter { $0 != host.origin }
        guard updated != host.alternates else { return }
        host.alternates = updated
        self.host = host
        try? Identity.save(host)
        onHostRecord?(host)
    }

    /// The origin currently being dialled, wrapping round the candidate list.
    private func currentEndpoint() -> Endpoint? {
        guard let host else { return nil }
        let candidates = host.candidates
        guard !candidates.isEmpty else { return Endpoint.lenient(host.origin) }
        return Endpoint.lenient(candidates[dialIndex % candidates.count])
    }

    func disconnect() {
        shouldReconnect = false
        pingTask?.cancel()
        pingTask = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        // The queue exists to cover a brief reconnect inside one session, not
        // to outlive the session itself. Carrying it across an unpair meant a
        // "revoke every device" tapped while the Mac was down sat in the queue
        // and fired 60ms after the *next* pairing, destroying the device that
        // had just been created.
        queuedOutbound.removeAll()
        transition(to: .idle)
    }

    /// Control messages that must never be replayed later.
    ///
    /// Anything scoped to the current pairing — revoking a device above all —
    /// is meaningless or destructive once the identity behind it has changed.
    /// These are sent if the socket is up and dropped if it is not, rather than
    /// being held.
    func sendUnqueued(_ message: [String: Any]) -> Bool {
        guard case .connected = state, let task else { return false }
        guard let data = try? JSONSerialization.data(withJSONObject: message),
              let text = String(data: data, encoding: .utf8)
        else { return false }
        task.send(.string(text)) { _ in }
        return true
    }

    private func openSocket() async {
        guard let host, let endpoint = currentEndpoint() else { return }

        // Opening is not instantaneous: fetching the nonce is an await, and the
        // actor is free during it, so a second caller arriving in that window
        // saw `task == nil`, decided nothing was in flight, and opened a second
        // socket. The flag covers the whole operation, not just its result.
        guard !isOpening else { return }
        isOpening = true

        // Any socket already established is deliberately retired here, and the
        // generation bump tells its receive loop that its death is expected —
        // otherwise it would schedule a reconnect and open yet another one.
        socketGeneration &+= 1
        let generation = socketGeneration
        if let existing = task {
            existing.cancel(with: .goingAway, reason: nil)
            task = nil
        }

        transition(to: reconnectAttempt == 0
            ? .connecting(attempt: 1)
            : .reconnecting(attempt: reconnectAttempt + 1, nextRetryMs: backoffMillis()))

        // Cleared here rather than after the nonce comes back, because the nonce
        // is the first thing a dead address kills. Set later, an attempt that
        // threw on the challenge left this reading `true` from the socket that
        // worked ten seconds ago — and the reconnect below only moves to the
        // next address when the current one has *not* proven itself. The phone
        // then retried a dead address until it gave up, with the Mac answering
        // on the other two the whole time.
        handshakeConfirmed = false
        dialledOrigin = endpoint.origin
        print("[VibeWire] dialing \(endpoint.origin)")

        do {
            let nonce = try await fetchNonce(endpoint: endpoint, deviceId: host.deviceId)
            let signature = try Identity.sign(nonce: Data(base64Encoded: nonce) ?? Data())

            guard let url = endpoint.socketURL else { throw PairFailure.unreachable }
            var request = URLRequest(url: url)
            request.setValue(host.deviceId, forHTTPHeaderField: "X-VibeWire-Device")
            request.setValue(nonce, forHTTPHeaderField: "X-VibeWire-Nonce")
            request.setValue(signature.base64EncodedString(), forHTTPHeaderField: "X-VibeWire-Signature")

            let task = session.webSocketTask(with: request)
            self.task = task
            task.resume()

            // `resume()` only *starts* the HTTP upgrade — it says nothing about
            // whether the Mac accepted it. Declaring success here reset the
            // backoff and the give-up clock on every failed attempt, so a
            // device the Mac had revoked retried twice a second indefinitely
            // instead of stopping at 30s. Success is now the first frame that
            // actually arrives; see `noteHandshakeConfirmed`.
            isOpening = false
            receiveLoop(task, generation: generation)
        } catch {
            // Cleared before retrying, or the reconnect would find an open in
            // flight and quietly do nothing.
            isOpening = false
            await scheduleReconnect(reason: "\(error)", task: nil)
        }
    }

    /// The socket has proven itself by delivering a frame. Only now is it safe
    /// to clear the backoff, release queued input, and start pinging.
    private func noteHandshakeConfirmed() {
        guard !handshakeConfirmed else { return }
        handshakeConfirmed = true
        reconnectAttempt = 0
        reconnectStartedAt = nil
        promoteDialledOrigin()
        transition(to: .connected)
        flushQueue()
        startPinging()
    }

    /// The address that carried a working socket becomes the one this phone
    /// tries first next time.
    ///
    /// Only after the socket has proven itself, never on `resume()`: an address
    /// that merely accepted a TCP connection has not shown it can reach the Mac,
    /// and promoting it would make a captive portal the phone's idea of home.
    private func promoteDialledOrigin() {
        print("[VibeWire] connected on \(dialledOrigin ?? "?")")
        guard var host, let winner = dialledOrigin, winner != host.origin else { return }
        host.alternates = Endpoint.normalise([host.origin] + host.alternates)
            .filter { $0 != winner }
        host.origin = winner
        self.host = host
        dialIndex = 0
        try? Identity.save(host)
        onHostRecord?(host)
    }

    private func fetchNonce(endpoint: Endpoint, deviceId: String) async throws -> String {
        guard let base = endpoint.baseURL,
              var components = URLComponents(
                  url: base.appendingPathComponent("/v1/challenge"),
                  resolvingAgainstBaseURL: false
              )
        else { throw PairFailure.unreachable }

        components.queryItems = [URLQueryItem(name: "deviceId", value: deviceId)]
        guard let url = components.url else { throw PairFailure.unreachable }

        var request = URLRequest(url: url)
        request.timeoutInterval = 6
        let (data, response) = try await session.data(for: request)
        guard (response as? HTTPURLResponse)?.statusCode == 200,
              let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let nonce = body["nonce"] as? String
        else { throw PairFailure.unreachable }
        return nonce
    }

    private func receiveLoop(_ task: URLSessionWebSocketTask, generation: Int) {
        Task { [weak self] in
            while true {
                do {
                    let message = try await task.receive()
                    guard let self else { return }
                    guard await self.isCurrent(generation) else { return }
                    await self.handle(message)
                } catch {
                    guard let self else { return }
                    // A socket this client retired on purpose must not drag the
                    // client into a reconnect: that is how cancelling one socket
                    // produced a third.
                    guard await self.isCurrent(generation) else { return }
                    await self.scheduleReconnect(reason: "\(error)", task: task)
                    return
                }
            }
        }
    }

    private func isCurrent(_ generation: Int) -> Bool {
        generation == socketGeneration
    }

    private func handle(_ message: URLSessionWebSocketTask.Message) {
        noteHandshakeConfirmed()
        switch message {
        case .string(let text):
            guard let data = text.data(using: .utf8),
                  let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
            else { return }
            if object["t"] as? String == "pong",
               let echoed = (object["tMicros"] as? NSNumber)?.uint64Value {
                notePong(echoedMicros: echoed)
            }
            onControl?(object)

        case .data(let data):
            guard let frame = VideoFrame(data) else { return }
            onVideo?(frame)

        @unknown default:
            break
        }
    }

    // MARK: Sending

    /// Control messages are queued while disconnected rather than dropped —
    /// "Keys and taps are being held, not dropped" on screen 03D.
    func send(_ message: [String: Any]) {
        guard case .connected = state, let task else {
            enqueue(message)
            return
        }
        guard let data = try? JSONSerialization.data(withJSONObject: message),
              let text = String(data: data, encoding: .utf8)
        else { return }

        task.send(.string(text)) { [weak self] error in
            guard error != nil, let self else { return }
            Task { await self.enqueue(message) }
        }
    }

    /// Pointer moves are the exception: a stale delta is worse than no delta,
    /// so they are dropped rather than queued.
    func sendTransient(_ message: [String: Any]) {
        guard case .connected = state, let task else { return }
        guard let data = try? JSONSerialization.data(withJSONObject: message),
              let text = String(data: data, encoding: .utf8)
        else { return }
        task.send(.string(text)) { _ in }
    }

    private func enqueue(_ message: [String: Any]) {
        queuedOutbound.append(message)
        if queuedOutbound.count > maxQueuedOutbound {
            queuedOutbound.removeFirst(queuedOutbound.count - maxQueuedOutbound)
        }
    }

    private func flushQueue() {
        let pending = queuedOutbound
        queuedOutbound.removeAll()
        for message in pending { send(message) }
    }

    // MARK: Keepalive

    private func startPinging() {
        pingTask?.cancel()
        pingTask = Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1))
                guard let self else { return }
                await self.sendPing()
            }
        }
    }

    private func sendPing() {
        pingSequence += 1
        let stamp = MonotonicClock.micros()
        pendingPings[pingSequence] = stamp
        // Anything older than a few seconds is never coming back.
        if pendingPings.count > 30 {
            for key in pendingPings.keys.sorted().prefix(pendingPings.count - 30) {
                pendingPings.removeValue(forKey: key)
            }
        }

        var message: [String: Any] = [
            "t": "ping",
            "tMicros": stamp,
            "seq": pingSequence,
        ]
        // The round trip is measured here, on one clock, and reported to
        // the host — the two devices' monotonic clocks share no origin, so
        // the Mac cannot compute this itself.
        if let lastRttMillis { message["rttMillis"] = lastRttMillis }
        sendTransient(message)
    }

    /// Called when a pong arrives, closing the loop on one ping.
    func notePong(echoedMicros: UInt64) {
        let now = MonotonicClock.micros()
        guard now > echoedMicros else { return }
        lastRttMillis = Double(now - echoedMicros) / 1000.0
    }

    // MARK: Reconnect

    private func scheduleReconnect(reason: String, task failed: URLSessionWebSocketTask?) async {
        pingTask?.cancel()
        pingTask = nil
        task = nil

        guard shouldReconnect else {
            transition(to: .idle)
            return
        }

        // A 401 on the upgrade means the Mac does not know this device any
        // more — it was revoked, or the host's trust store was reset. Retrying
        // cannot fix that, and retrying is what produced the endless
        // "auth rejected: unknown device" storm in the host log. Stop, and say
        // the one thing that does fix it.
        if let status = (failed?.response as? HTTPURLResponse)?.statusCode,
           status == 401 || status == 403 {
            shouldReconnect = false
            transition(to: .unauthorized)
            return
        }

        if reconnectStartedAt == nil { reconnectStartedAt = Date() }

        // The socket never proved itself, so the address it was opened against
        // is a suspect. Move to the next one the Mac gave us — this is what
        // turns "the phone works on the Wi-Fi it was paired on" into "the phone
        // works", since the LAN address and the tunnel fail in exactly this way
        // from the other side of the front door.
        if let host, host.candidates.count > 1 {
            dialIndex = (dialIndex + 1) % host.candidates.count
        }
        print("[VibeWire] socket failed on \(dialledOrigin ?? "?"): \(reason)")

        // 03D: "GIVING UP AT 30S" — thirty seconds per address, not thirty
        // shared between them. A phone holding three addresses that split one
        // budget gives each ten seconds and reports a Mac unreachable that was
        // answering on the third.
        if let started = reconnectStartedAt,
           Date().timeIntervalSince(started) > giveUpSeconds {
            transition(to: .failed(reason))
            shouldReconnect = false
            return
        }

        reconnectAttempt += 1
        let delay = backoffMillis()
        transition(to: .reconnecting(attempt: reconnectAttempt, nextRetryMs: delay))

        try? await Task.sleep(for: .milliseconds(delay))
        guard shouldReconnect else { return }
        await openSocket()
    }

    /// How long an outage runs before this client stops retrying: 30 seconds
    /// for each address the Mac gave it.
    var giveUpSeconds: TimeInterval {
        30 * Double(max(1, host?.candidates.count ?? 1))
    }

    /// 0.5 s doubling to a 8 s ceiling.
    private func backoffMillis() -> Int {
        min(8000, Int(500 * pow(2, Double(max(0, reconnectAttempt - 1)))))
    }

    private func transition(to newState: State) {
        guard newState != state else { return }
        state = newState
        onState?(newState)
    }
}

/// Monotonic microseconds, so a clock adjustment mid-session cannot make a
/// measured round trip read negative.
enum MonotonicClock {
    static func micros() -> UInt64 {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        let nanos = mach_absolute_time() &* UInt64(info.numer) / UInt64(info.denom)
        return nanos / 1_000
    }
}
