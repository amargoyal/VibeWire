import Foundation

/// Talks to the VibeWire channel MCP server, which Claude Code spawns inside a
/// session that is already running.
///
/// This is the difference between starting a conversation from the phone and
/// joining the one open in a terminal. `ClaudeBridge` drives its own
/// `claude --print` process, which is a separate conversation by construction —
/// two `claude` processes cannot share one. A channel is the supported way in:
/// Claude Code owns the subprocess, and what this server emits is injected
/// straight into the live session.
///
/// The channel listens on loopback and is gated on a token, so this is the only
/// thing on the machine that can reach it.
actor ChannelBridge {
    typealias Emit = @Sendable ([String: Any]) -> Void

    private let port: Int
    private let session: URLSession
    private var emit: Emit?
    private var streamTask: Task<Void, Never>?
    private(set) var isAttached = false

    /// The id of the last message sent, so Claude's reply can be matched to it.
    private var lastChatId: String?

    init(port: Int = 8790) {
        self.port = port
        let configuration = URLSessionConfiguration.default
        // The event stream is deliberately open-ended.
        configuration.timeoutIntervalForRequest = 3600
        self.session = URLSession(configuration: configuration)
    }

    private var token: String? {
        let path = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".config/vibewire/channel.token")
        return (try? String(contentsOf: path, encoding: .utf8))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func request(_ path: String, method: String = "GET") -> URLRequest? {
        guard let token, let url = URL(string: "http://127.0.0.1:\(port)\(path)") else { return nil }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(token, forHTTPHeaderField: "X-VibeWire-Channel")
        return request
    }

    /// Whether a session on this Mac currently has the channel loaded. The
    /// server only exists while Claude Code is running it, so this doubles as
    /// "is there a live session to join".
    func isAvailable() async -> Bool {
        guard var request = request("/health") else { return false }
        request.timeoutInterval = 1
        guard let (_, response) = try? await session.data(for: request) else { return false }
        return (response as? HTTPURLResponse)?.statusCode == 200
    }

    func setEmitter(_ emit: @escaping Emit) {
        self.emit = emit
    }

    /// Sends the phone's message into the live session.
    func send(text: String) async -> Bool {
        guard var request = request("/message", method: "POST") else { return false }
        request.httpBody = Data(text.utf8)
        guard let (data, response) = try? await session.data(for: request),
              (response as? HTTPURLResponse)?.statusCode == 200
        else {
            Log.warn(.claude, "channel send failed — is a session running with the channel loaded?")
            return false
        }
        if let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let chatId = body["chatId"] as? String {
            lastChatId = chatId
        }
        Log.info(.claude, "sent \(text.count) chars into the live session via the channel")
        return true
    }

    /// Answers a permission prompt the session raised. The terminal dialog stays
    /// open too, and Claude Code applies whichever verdict lands first.
    func answerPermission(requestId: String, allow: Bool) async {
        guard var request = request("/permission", method: "POST") else { return }
        request.httpBody = try? JSONSerialization.data(
            withJSONObject: ["requestId": requestId, "allow": allow]
        )
        _ = try? await session.data(for: request)
    }

    func attach() {
        guard streamTask == nil else { return }
        isAttached = true
        streamTask = Task { [weak self] in await self?.readEvents() }
    }

    func detach() {
        streamTask?.cancel()
        streamTask = nil
        isAttached = false
    }

    /// Reads the server-sent event stream: Claude's replies, and permission
    /// prompts raised by the live session.
    private func readEvents() async {
        guard let request = request("/events") else { return }
        do {
            let (stream, response) = try await session.bytes(for: request)
            guard (response as? HTTPURLResponse)?.statusCode == 200 else {
                Log.warn(.claude, "channel event stream refused")
                return
            }
            Log.info(.claude, "attached to the live session's channel")
            for try await line in stream.lines {
                guard !Task.isCancelled else { return }
                guard line.hasPrefix("data: ") else { continue }
                let payload = String(line.dropFirst(6))
                guard let data = payload.data(using: .utf8),
                      let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                else { continue }
                handle(event)
            }
        } catch {
            guard !Task.isCancelled else { return }
            Log.warn(.claude, "channel event stream ended: \(error)")
        }
        isAttached = false
    }

    private func handle(_ event: [String: Any]) {
        switch event["kind"] as? String {
        case "reply":
            let text = event["text"] as? String ?? ""
            emit?([
                "t": "claude",
                "sub": "message",
                "role": "assistant",
                "blocks": [["type": "text", "text": text]],
            ])

        case "permission":
            emit?([
                "t": "claude",
                "sub": "permission",
                "requestId": event["requestId"] as? String ?? "",
                "toolName": event["toolName"] as? String ?? "",
                "command": event["inputPreview"] as? String ?? "",
                "explanation": event["description"] as? String ?? "",
                "waitingMs": 0,
            ])

        default:
            break
        }
    }
}
