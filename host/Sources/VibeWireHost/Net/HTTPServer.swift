import Foundation
import Network

// MARK: - Request

struct HTTPRequest {
    let method: String
    let path: String
    let query: [String: String]
    let headers: [String: String]   // lowercased keys
    let body: Data

    func header(_ name: String) -> String? { headers[name.lowercased()] }

    var wantsWebSocketUpgrade: Bool {
        header("upgrade")?.lowercased() == "websocket"
            && (header("connection")?.lowercased().contains("upgrade") ?? false)
    }

    /// Parses a complete request, or returns nil if more bytes are needed.
    /// Returns the number of bytes consumed alongside the request.
    static func parse(_ buffer: Data) -> (request: HTTPRequest, consumed: Int)? {
        let separator = Data("\r\n\r\n".utf8)
        guard let headerEnd = buffer.range(of: separator) else { return nil }

        let headerData = buffer[buffer.startIndex..<headerEnd.lowerBound]
        guard let headerText = String(data: headerData, encoding: .utf8) else { return nil }

        var lines = headerText.components(separatedBy: "\r\n")
        guard !lines.isEmpty else { return nil }

        let requestLine = lines.removeFirst().split(separator: " ", omittingEmptySubsequences: true)
        guard requestLine.count >= 2 else { return nil }

        let method = String(requestLine[0])
        let target = String(requestLine[1])

        var path = target
        var query: [String: String] = [:]
        if let questionMark = target.firstIndex(of: "?") {
            path = String(target[target.startIndex..<questionMark])
            let rawQuery = String(target[target.index(after: questionMark)...])
            for pair in rawQuery.split(separator: "&") {
                let parts = pair.split(separator: "=", maxSplits: 1)
                guard let key = parts.first?.removingPercentEncoding else { continue }
                let value = parts.count > 1 ? (parts[1].removingPercentEncoding ?? "") : ""
                query[String(key)] = value
            }
        }

        var headers: [String: String] = [:]
        for line in lines where !line.isEmpty {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let key = line[line.startIndex..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            headers[key] = value
        }

        let bodyStart = headerEnd.upperBound
        let contentLength = Int(headers["content-length"] ?? "0") ?? 0

        // Cap request bodies. Pairing payloads are a few hundred bytes.
        guard contentLength <= 64 * 1024 else { return nil }

        let available = buffer.distance(from: bodyStart, to: buffer.endIndex)
        guard available >= contentLength else { return nil }

        let bodyEnd = buffer.index(bodyStart, offsetBy: contentLength)
        let body = Data(buffer[bodyStart..<bodyEnd])
        let consumed = buffer.distance(from: buffer.startIndex, to: bodyEnd)

        return (
            HTTPRequest(method: method, path: path, query: query, headers: headers, body: body),
            consumed
        )
    }
}

// MARK: - Response

struct HTTPResponse {
    var status: Int
    var headers: [String: String]
    var body: Data

    static func json(_ status: Int, _ object: [String: Any]) -> HTTPResponse {
        let body = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{}".utf8)
        return HTTPResponse(
            status: status,
            headers: ["Content-Type": "application/json"],
            body: body
        )
    }

    static func error(_ status: Int, _ code: String, extra: [String: Any] = [:]) -> HTTPResponse {
        var payload: [String: Any] = ["error": code]
        payload.merge(extra) { current, _ in current }
        return .json(status, payload)
    }

    func serialize() -> Data {
        var text = "HTTP/1.1 \(status) \(Self.reason(status))\r\n"
        var allHeaders = headers
        allHeaders["Content-Length"] = String(body.count)
        allHeaders["Connection"] = "keep-alive"
        // The phone is a native app, but a browser hitting the pairing endpoint
        // during debugging shouldn't be silently blocked.
        allHeaders["Access-Control-Allow-Origin"] = "*"
        for (key, value) in allHeaders.sorted(by: { $0.key < $1.key }) {
            text += "\(key): \(value)\r\n"
        }
        text += "\r\n"
        var out = Data(text.utf8)
        out.append(body)
        return out
    }

    private static func reason(_ status: Int) -> String {
        switch status {
        case 200: return "OK"
        case 101: return "Switching Protocols"
        case 400: return "Bad Request"
        case 401: return "Unauthorized"
        case 403: return "Forbidden"
        case 404: return "Not Found"
        case 409: return "Conflict"
        case 429: return "Too Many Requests"
        case 500: return "Internal Server Error"
        default: return "Status"
        }
    }
}

// MARK: - Server

/// Serves HTTP and WebSocket on one port so a single Cloudflare Tunnel origin
/// covers the whole protocol.
final class HTTPServer: @unchecked Sendable {
    private var listener: NWListener?
    private let queue = DispatchQueue(label: "com.vibewire.host.listener")
    private let port: UInt16
    private let router: Router

    /// The `NWListener` binds loopback only; `SocketForwarder` owns the real
    /// port on every interface and splices connections in. See SocketForwarder
    /// for why — Network.framework listeners never see Tailscale traffic.
    private var forwarder: SocketForwarder?
    private var internalPort: UInt16 { port &+ 1 }

    /// Called when the listener dies after a successful `start()`. Without it a
    /// failed listener left the process running and looking healthy while
    /// nothing was on the port — the single most expensive bug of the day to
    /// diagnose, because every symptom pointed at the network instead.
    var onFatal: (@Sendable (String) -> Void)?

    /// Live upgraded sockets, keyed by connection identity, so the server can
    /// broadcast and can sever a revoked device.
    private var sockets: [ObjectIdentifier: SocketConnection] = [:]
    private var clients: [ObjectIdentifier: ClientConnection] = [:]
    private let socketsLock = NSLock()

    init(port: UInt16, router: Router) {
        self.port = port
        self.router = router
    }

    func start() throws {
        let parameters = NWParameters.tcp
        parameters.allowLocalEndpointReuse = true
        // Low latency matters more than throughput for input events.
        if let tcp = parameters.defaultProtocolStack.internetProtocol as? NWProtocolTCP.Options {
            tcp.noDelay = true
            tcp.connectionTimeout = 10
            tcp.enableKeepalive = true
            tcp.keepaliveIdle = 15
        }

        guard let nwPort = NWEndpoint.Port(rawValue: internalPort) else {
            throw HostError.invalidPort(internalPort)
        }
        parameters.requiredLocalEndpoint = .hostPort(host: .ipv4(.loopback), port: nwPort)

        let listener = try NWListener(using: parameters)
        listener.newConnectionHandler = { [weak self] connection in
            self?.accept(connection)
        }
        let boundPort = internalPort
        listener.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                Log.debug(.net, "internal listener ready on 127.0.0.1:\(boundPort)")
            case .failed(let error):
                // Fatal, and said so. This used to be a log line the process
                // outlived.
                Log.error(.net, "listener failed: \(error)")
                self?.onFatal?("\(error)")
            case .cancelled:
                Log.info(.net, "listener cancelled")
            default:
                break
            }
        }
        listener.start(queue: queue)
        self.listener = listener

        // Bind the public port last: if it is taken, this throws before the
        // host claims to be up.
        let forwarder = SocketForwarder(listenPort: port, targetPort: internalPort)
        do {
            try forwarder.start()
        } catch {
            Log.error(.net, "front door failed: \(error)")
            listener.cancel()
            self.listener = nil
            throw error
        }
        self.forwarder = forwarder
        Log.info(.net, "listening on port \(port)")
    }

    func stop() {
        forwarder?.stop()
        forwarder = nil
        listener?.cancel()
        listener = nil
        socketsLock.lock()
        let live = Array(sockets.values)
        sockets.removeAll()
        clients.removeAll()
        socketsLock.unlock()
        for socket in live { socket.close(code: 1001, reason: "host shutting down") }
    }

    private func accept(_ connection: NWConnection) {
        let client = ClientConnection(connection: connection, router: router) { [weak self] socket in
            guard let self else { return }
            socketsLock.lock()
            sockets[ObjectIdentifier(socket)] = socket
            socketsLock.unlock()
        } onSocketClosed: { [weak self] socket in
            guard let self else { return }
            socketsLock.lock()
            sockets.removeValue(forKey: ObjectIdentifier(socket))
            socketsLock.unlock()
        }

        // The server owns the connection for its lifetime.
        socketsLock.lock()
        clients[ObjectIdentifier(client)] = client
        socketsLock.unlock()

        client.onFinished = { [weak self] finished in
            guard let self else { return }
            socketsLock.lock()
            clients.removeValue(forKey: ObjectIdentifier(finished))
            socketsLock.unlock()
        }

        client.start(on: queue)
    }

    // MARK: Broadcast helpers

    func broadcast(_ message: [String: Any]) {
        socketsLock.lock()
        let live = Array(sockets.values)
        socketsLock.unlock()
        for socket in live { socket.sendJSON(message) }
    }

    func broadcastBinary(_ data: Data) {
        socketsLock.lock()
        let live = Array(sockets.values)
        socketsLock.unlock()
        for socket in live { socket.sendBinary(data) }
    }

    /// Used by revoke (07B): "Any live session from that iPad ends inside 1s."
    func severSockets(deviceIds: Set<String>) {
        socketsLock.lock()
        let live = Array(sockets.values)
        socketsLock.unlock()
        for socket in live where socket.deviceId.map(deviceIds.contains) == true {
            socket.close(code: 4003, reason: "device revoked")
        }
    }

    var connectedDeviceIds: Set<String> {
        socketsLock.lock()
        defer { socketsLock.unlock() }
        return Set(sockets.values.compactMap(\.deviceId))
    }
}

enum HostError: Error, CustomStringConvertible {
    case invalidPort(UInt16)
    case forwarderFailed(String)
    case listenerFailed(String)

    var description: String {
        switch self {
        case .invalidPort(let port): return "invalid port \(port)"
        case .forwarderFailed(let detail): return "could not open the port: \(detail)"
        case .listenerFailed(let detail): return "listener failed: \(detail)"
        }
    }
}
