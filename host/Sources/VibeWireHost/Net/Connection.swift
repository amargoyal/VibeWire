import Foundation
import Network

/// Routes HTTP requests and owns what happens after a socket upgrade.
/// Implemented by `HostRouter`; kept as a protocol so the networking layer has
/// no opinion about pairing, capture, or Claude.
protocol Router: AnyObject, Sendable {
    func handle(_ request: HTTPRequest) async -> HTTPResponse
    /// Returns the authenticated device, or nil to reject the upgrade.
    func authenticateUpgrade(_ request: HTTPRequest) async -> TrustedDevice?
    func socketOpened(_ socket: SocketConnection, device: TrustedDevice) async
    func socketClosed(_ socket: SocketConnection) async
    func socketReceived(_ socket: SocketConnection, text: Data) async
}

/// One TCP connection. Starts speaking HTTP; may become a WebSocket.
final class ClientConnection: @unchecked Sendable {
    private enum Mode {
        case http
        case webSocket
    }

    private let connection: NWConnection
    private let router: Router
    private var mode: Mode = .http
    private var buffer = Data()
    private var socket: SocketConnection?
    private let onSocketOpened: (SocketConnection) -> Void
    private let onSocketClosed: (SocketConnection) -> Void
    /// Set by the server so it can drop its strong reference once this
    /// connection is done.
    var onFinished: ((ClientConnection) -> Void)?

    init(
        connection: NWConnection,
        router: Router,
        onSocketOpened: @escaping (SocketConnection) -> Void,
        onSocketClosed: @escaping (SocketConnection) -> Void
    ) {
        self.connection = connection
        self.router = router
        self.onSocketOpened = onSocketOpened
        self.onSocketClosed = onSocketClosed
    }

    func start(on queue: DispatchQueue) {
        connection.stateUpdateHandler = { [weak self] state in
            guard let self else { return }
            switch state {
            case .failed(let error):
                Log.debug(.net, "connection failed: \(error)")
                teardown()
            case .cancelled:
                teardown()
            default:
                break
            }
        }
        connection.start(queue: queue)
        receive()
    }

    private var didTeardown = false

    private func teardown() {
        guard !didTeardown else { return }
        didTeardown = true
        if let socket {
            onSocketClosed(socket)
            Task { await router.socketClosed(socket) }
            self.socket = nil
        }
        onFinished?(self)
    }

    private func receive() {
        connection.receive(minimumIncompleteLength: 1, maximumLength: 64 * 1024) {
            [weak self] data, _, isComplete, error in
            guard let self else { return }

            if let data, !data.isEmpty {
                buffer.append(data)
                pump()
            }

            if isComplete || error != nil {
                if let error { Log.debug(.net, "receive ended: \(error)") }
                connection.cancel()
                teardown()
                return
            }
            receive()
        }
    }

    private func pump() {
        switch mode {
        case .http:
            pumpHTTP()
        case .webSocket:
            pumpWebSocket()
        }
    }

    // MARK: HTTP

    private func pumpHTTP() {
        while let (request, consumed) = HTTPRequest.parse(buffer) {
            buffer.removeFirst(consumed)

            if request.path == "/v1/socket", request.wantsWebSocketUpgrade {
                handleUpgrade(request)
                return
            }

            Task { [weak self] in
                guard let self else { return }
                let response = await router.handle(request)
                send(response.serialize())
            }
        }
    }

    private func handleUpgrade(_ request: HTTPRequest) {
        guard let key = request.header("sec-websocket-key") else {
            send(HTTPResponse.error(400, "missing_websocket_key").serialize())
            return
        }

        Task { [weak self] in
            guard let self else { return }

            guard let device = await router.authenticateUpgrade(request) else {
                // Fail closed, and do not hint at which part was wrong.
                // Close only once the response has actually gone out, otherwise
                // the phone sees a dropped connection instead of a 401 and
                // cannot tell "not trusted" from "host unreachable".
                sendThenClose(HTTPResponse.error(401, "unauthorized").serialize())
                return
            }

            let accept = WebSocketCodec.acceptKey(for: key)
            let handshake = """
            HTTP/1.1 101 Switching Protocols\r
            Upgrade: websocket\r
            Connection: Upgrade\r
            Sec-WebSocket-Accept: \(accept)\r
            \r

            """
            send(Data(handshake.utf8))

            let socket = SocketConnection(
                connection: connection,
                deviceId: device.id,
                deviceName: device.name
            )
            self.socket = socket
            mode = .webSocket
            onSocketOpened(socket)
            await router.socketOpened(socket, device: device)
            Log.info(.net, "socket open: \(device.name)")

            // Bytes that arrived in the same TCP segment as the upgrade.
            pumpWebSocket()
        }
    }

    // MARK: WebSocket

    private func pumpWebSocket() {
        guard let socket else { return }
        while true {
            let frame: WebSocketFrame?
            do {
                frame = try WebSocketCodec.next(from: &buffer)
            } catch {
                Log.warn(.net, "websocket protocol error: \(error)")
                socket.close(code: 1002, reason: "protocol error")
                return
            }
            guard let frame else { return }

            switch frame.opcode {
            case .text:
                Task { [weak self] in
                    guard let self else { return }
                    await router.socketReceived(socket, text: frame.payload)
                }
            case .binary:
                // The phone has no reason to send binary; ignore rather than
                // drop the connection, so a future protocol addition is additive.
                Log.debug(.net, "ignoring unexpected binary frame")
            case .ping:
                socket.sendRaw(WebSocketCodec.encode(
                    WebSocketFrame(opcode: .pong, payload: frame.payload, isFinal: true)
                ))
            case .pong:
                socket.notePong()
            case .close:
                socket.close(code: 1000, reason: "peer closed")
                return
            case .continuation:
                Log.debug(.net, "ignoring continuation frame")
            }
        }
    }

    private func send(_ data: Data) {
        connection.send(content: data, completion: .contentProcessed { error in
            if let error { Log.debug(.net, "send failed: \(error)") }
        })
    }

    private func sendThenClose(_ data: Data) {
        connection.send(content: data, completion: .contentProcessed { [weak self] error in
            if let error { Log.debug(.net, "send failed: \(error)") }
            self?.connection.cancel()
        })
    }
}

/// An upgraded, authenticated socket. Thread-safe: video frames are pushed from
/// the capture queue while control messages come from the connection queue.
final class SocketConnection: @unchecked Sendable {
    let deviceId: String?
    let deviceName: String
    /// When this socket was upgraded, for the ATTACHED 1H 12M readout. Taken at
    /// construction, which is the moment authentication succeeded.
    let openedAt = Date()
    private let connection: NWConnection
    private let sendLock = NSLock()
    private var isClosed = false
    private var lastPongAt = Date()
    /// Bytes handed to the transport on this socket, both framings.
    ///
    /// Counted here rather than derived from the encoder's rate because this is
    /// what actually left for this device — a dropped frame never reaches the
    /// wire, and the dashboard says SENT, not ENCODED.
    private var bytesSentTotal = 0
    private var framesDroppedTotal = 0

    /// Video is dropped rather than queued when the socket is congested.
    /// A stale frame is worthless; a growing queue is worse than worthless.
    private var inFlightBinaryBytes = 0
    private let maxInFlightBinaryBytes = 4 * 1024 * 1024

    init(connection: NWConnection, deviceId: String?, deviceName: String) {
        self.connection = connection
        self.deviceId = deviceId
        self.deviceName = deviceName
    }

    func sendJSON(_ object: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: object) else {
            Log.warn(.net, "failed to encode outbound message")
            return
        }
        sendRaw(WebSocketCodec.encode(
            WebSocketFrame(opcode: .text, payload: data, isFinal: true)
        ))
    }

    /// Returns false when the frame was dropped because the socket is behind.
    @discardableResult
    func sendBinary(_ payload: Data) -> Bool {
        sendLock.lock()
        let congested = inFlightBinaryBytes + payload.count > maxInFlightBinaryBytes
        if congested {
            framesDroppedTotal += 1
            sendLock.unlock()
            return false
        }
        inFlightBinaryBytes += payload.count
        bytesSentTotal += payload.count
        sendLock.unlock()

        let framed = WebSocketCodec.encode(
            WebSocketFrame(opcode: .binary, payload: payload, isFinal: true)
        )
        let size = payload.count
        connection.send(content: framed, completion: .contentProcessed { [weak self] error in
            guard let self else { return }
            sendLock.lock()
            inFlightBinaryBytes = max(0, inFlightBinaryBytes - size)
            sendLock.unlock()
            if let error { Log.debug(.net, "binary send failed: \(error)") }
        })
        return true
    }

    /// Total bytes sent, and frames dropped for congestion, since the upgrade.
    var traffic: (bytesSent: Int, framesDropped: Int) {
        sendLock.lock()
        defer { sendLock.unlock() }
        return (bytesSentTotal, framesDroppedTotal)
    }

    func sendRaw(_ data: Data) {
        sendLock.lock()
        let closed = isClosed
        if !closed { bytesSentTotal += data.count }
        sendLock.unlock()
        guard !closed else { return }
        connection.send(content: data, completion: .contentProcessed { error in
            if let error { Log.debug(.net, "send failed: \(error)") }
        })
    }

    func ping() {
        sendRaw(WebSocketCodec.encode(
            WebSocketFrame(opcode: .ping, payload: Data(), isFinal: true)
        ))
    }

    func notePong() {
        sendLock.lock()
        lastPongAt = Date()
        sendLock.unlock()
    }

    var secondsSincePong: TimeInterval {
        sendLock.lock()
        defer { sendLock.unlock() }
        return Date().timeIntervalSince(lastPongAt)
    }

    func close(code: UInt16, reason: String) {
        sendLock.lock()
        if isClosed {
            sendLock.unlock()
            return
        }
        isClosed = true
        sendLock.unlock()

        var payload = Data()
        payload.appendBigEndian(code)
        payload.append(Data(reason.utf8))
        connection.send(
            content: WebSocketCodec.encode(
                WebSocketFrame(opcode: .close, payload: payload, isFinal: true)
            ),
            completion: .contentProcessed { [weak self] _ in
                self?.connection.cancel()
            }
        )
        Log.info(.net, "socket closed (\(code)): \(reason)")
    }
}
