import Foundation

/// Drives the real `claude` CLI and translates its stream-json protocol into
/// the VibeWire messages that screens 06A/06B/06C render.
///
/// Authentication is the whole point of doing it this way. The CLI uses the
/// credentials from `claude login`, which is the Max subscription — the init
/// message reports `apiKeySource: "none"`. Two consequences the code has to
/// respect:
///
///  1. `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` are stripped from the child
///     environment. If either is set, Claude Code prefers it and silently moves
///     the session onto API billing.
///  2. `--bare` is never passed. That flag forces API-key auth and refuses to
///     read the OAuth credentials.
actor ClaudeBridge {
    struct OpenOptions {
        var sessionId: String?
        var cwd: String
        var mode: ClaudeMode
        var model: String?
    }

    /// Emitted upward to the socket. Kept as loose dictionaries to match the
    /// rest of the wire protocol.
    typealias Emit = @Sendable ([String: Any]) -> Void

    private var process: Process?
    private var stdinPipe: Pipe?
    private var stdoutBuffer = Data()
    private var emit: Emit?

    private(set) var sessionId: String?
    private(set) var cwd: String = FileManager.default.homeDirectoryForCurrentUser.path
    private(set) var isRunning = false
    private var startedAt: Date?
    /// Bumped on every launch so a superseded process's exit callback can be
    /// told apart from the live one's. See `handleTermination`.
    private var generation = 0

    /// Permission requests waiting on the phone, keyed by the CLI's request id.
    /// 06C shows how long one has been waiting, so the arrival time is kept.
    private var pendingPermissions: [String: (toolName: String, at: Date)] = [:]

    /// Tools the user chose "ALWAYS HERE" for. Scoped to this bridge instance,
    /// i.e. this project and this session — which is what "here" means on 06C.
    private var alwaysAllowedTools: Set<String> = []

    /// Tool calls in flight, so a result can be matched back to its row.
    private var runningTools: [String: (name: String, target: String, at: Date)] = [:]

    private var assistantTextBuffer = ""
    private var outputTokenCount = 0
    private var turnStartedAt: Date?

    /// The file whose diff the phone currently has open, so edits to it can be
    /// pushed as they land rather than waiting for a pull.
    private var watchedDiffPath: String?

    func setEmitter(_ emit: @escaping Emit) {
        self.emit = emit
    }

    // MARK: Lifecycle

    /// Locates the CLI. Prefers whatever is on PATH so a user who upgrades
    /// Claude Code gets the new binary without touching VibeWire.
    private static func claudeExecutable() -> URL? {
        let candidates = [
            ProcessInfo.processInfo.environment["VIBEWIRE_CLAUDE_PATH"],
            "\(NSHomeDirectory())/.local/bin/claude",
            "/opt/homebrew/bin/claude",
            "/usr/local/bin/claude",
        ].compactMap { $0 }

        for path in candidates where FileManager.default.isExecutableFile(atPath: path) {
            return URL(fileURLWithPath: path)
        }

        // Fall back to a PATH lookup via the login shell.
        let which = Process()
        which.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        which.arguments = ["which", "claude"]
        let pipe = Pipe()
        which.standardOutput = pipe
        which.standardError = FileHandle.nullDevice
        try? which.run()
        which.waitUntilExit()
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let path = String(decoding: data, as: UTF8.self).trimmingCharacters(in: .whitespacesAndNewlines)
        return path.isEmpty ? nil : URL(fileURLWithPath: path)
    }

    func open(_ options: OpenOptions) async throws {
        await close()

        guard let executable = Self.claudeExecutable() else {
            throw ClaudeError.cliNotFound
        }

        cwd = options.cwd
        // A new session is given an id up front rather than letting the CLI
        // keep one to itself. Without `--session-id`, a `--print` session left
        // nothing in ~/.claude/projects: the conversation existed only in the
        // pipe, so it could never be resumed — not from the phone's picker, and
        // not with `claude --resume` in a terminal. With an id it is journaled
        // like any other session, and `--resume` appends to that same file.
        sessionId = options.sessionId ?? UUID().uuidString.lowercased()

        var arguments = [
            "--print",
            "--input-format", "stream-json",
            "--output-format", "stream-json",
            "--include-partial-messages",
            "--replay-user-messages",
            "--verbose",
            // Manual means the CLI asks us before running a tool, which is what
            // makes screen 06C possible at all.
            "--permission-mode", "manual",
        ]

        if let resuming = options.sessionId {
            arguments += ["--resume", resuming]
        } else if let fresh = sessionId {
            arguments += ["--session-id", fresh]
        }
        if let model = options.model {
            arguments += ["--model", model]
        }
        if options.mode == .chat {
            // Chat mode answers questions about the Mac; it should not be able
            // to edit the filesystem out from under the user.
            arguments += ["--tools", "Bash,Read,Glob,Grep,WebSearch,WebFetch"]
        }

        let process = Process()
        process.executableURL = executable
        process.arguments = arguments
        process.currentDirectoryURL = URL(fileURLWithPath: cwd)

        var environment = ProcessInfo.processInfo.environment
        // The two lines that keep this on the subscription.
        environment.removeValue(forKey: "ANTHROPIC_API_KEY")
        environment.removeValue(forKey: "ANTHROPIC_AUTH_TOKEN")
        // Claude Code writes control characters when it thinks it owns a TTY.
        environment["TERM"] = "dumb"
        environment["NO_COLOR"] = "1"
        process.environment = environment

        let stdin = Pipe()
        let stdout = Pipe()
        let stderr = Pipe()
        process.standardInput = stdin
        process.standardOutput = stdout
        process.standardError = stderr

        stdout.fileHandleForReading.readabilityHandler = { [weak self] handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else { return }
            Task { await self?.ingest(chunk) }
        }

        stderr.fileHandleForReading.readabilityHandler = { handle in
            let chunk = handle.availableData
            guard !chunk.isEmpty else { return }
            let text = String(decoding: chunk, as: UTF8.self)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            if !text.isEmpty { Log.warn(.claude, "cli stderr: \(text)") }
        }

        generation &+= 1
        let launchGeneration = generation
        process.terminationHandler = { [weak self] finished in
            Task {
                await self?.handleTermination(
                    generation: launchGeneration,
                    status: finished.terminationStatus
                )
            }
        }

        try process.run()

        self.process = process
        self.stdinPipe = stdin
        self.isRunning = true
        self.startedAt = Date()

        Log.info(.claude, "claude started (pid \(process.processIdentifier)) in \(cwd)")
    }

    func close() async {
        guard let process else { return }
        stdinPipe?.fileHandleForWriting.closeFile()
        if process.isRunning {
            process.terminate()
        }
        self.process = nil
        self.stdinPipe = nil
        self.isRunning = false
        pendingPermissions.removeAll()
        runningTools.removeAll()
        stdoutBuffer.removeAll()
    }

    /// `generation` identifies which process a termination callback belongs to.
    ///
    /// `terminationHandler` fires on a private queue and hops back here through
    /// a `Task`, so it lands *after* whatever ran next. Reopening a session
    /// terminates the old process and starts a new one, and the old process's
    /// callback would then arrive and clear `isRunning` out from under the new
    /// one — leaving a live CLI that every `send` refused with "no active
    /// session" while the panel still showed the transcript.
    private func handleTermination(generation: Int, status: Int32) {
        guard generation == self.generation else {
            Log.debug(.claude, "ignoring exit \(status) from superseded claude (gen \(generation))")
            return
        }

        isRunning = false
        let duration = startedAt.map { Date().timeIntervalSince($0) } ?? 0
        emit?([
            "t": "claude",
            "sub": "ended",
            "reason": status == 0 ? "completed" : "exited(\(status))",
            "durationMs": Int(duration * 1000),
        ])
        Log.info(.claude, "claude exited with status \(status)")
    }

    // MARK: Sending

    func send(text: String) {
        guard isRunning, let stdin = stdinPipe else {
            Log.warn(.claude, "send refused: no running CLI (\(text.count) chars dropped)")
            emit?(["t": "claude", "sub": "error", "message": "no active session"])
            return
        }
        Log.info(.claude, "sending \(text.count) chars to claude")
        turnStartedAt = Date()
        outputTokenCount = 0

        let message: [String: Any] = [
            "type": "user",
            "message": [
                "role": "user",
                "content": [["type": "text", "text": text]],
            ],
        ]
        write(message, to: stdin)
    }

    /// The red STOP target on 06B. Runaway agents are the reason the phone is
    /// out in the first place, so this is a first-class control, not a kill.
    func interrupt() {
        guard isRunning, let stdin = stdinPipe else { return }
        let request: [String: Any] = [
            "type": "control_request",
            "request_id": UUID().uuidString,
            "request": ["subtype": "interrupt"],
        ]
        write(request, to: stdin)
        Log.info(.claude, "interrupt sent")
    }

    /// Answers a `can_use_tool` control request. The CLI's contract is
    /// `{behavior: "allow"}` or `{behavior: "deny", message: String}`.
    func respondToPermission(requestId: String, allow: Bool, scope: PermissionScope, message: String?) {
        guard let stdin = stdinPipe else { return }
        guard let pending = pendingPermissions.removeValue(forKey: requestId) else {
            Log.warn(.claude, "no pending permission for \(requestId)")
            return
        }

        if allow, scope == .always {
            alwaysAllowedTools.insert(pending.toolName)
        }

        let response: [String: Any] = allow
            ? ["behavior": "allow"]
            : ["behavior": "deny", "message": message ?? "Denied from phone"]

        let envelope: [String: Any] = [
            "type": "control_response",
            "response": [
                "subtype": "success",
                "request_id": requestId,
                "response": response,
            ],
        ]
        write(envelope, to: stdin)
        Log.info(.claude, "permission \(allow ? "allowed" : "denied") for \(pending.toolName)")
    }

    private func write(_ object: [String: Any], to pipe: Pipe) {
        guard var data = try? JSONSerialization.data(withJSONObject: object) else { return }
        data.append(0x0A)
        do {
            try pipe.fileHandleForWriting.write(contentsOf: data)
        } catch {
            Log.error(.claude, "failed writing to claude stdin: \(error)")
        }
    }

    // MARK: Receiving

    private func ingest(_ chunk: Data) {
        stdoutBuffer.append(chunk)

        while let newline = stdoutBuffer.firstIndex(of: 0x0A) {
            let line = stdoutBuffer[stdoutBuffer.startIndex..<newline]
            stdoutBuffer.removeSubrange(stdoutBuffer.startIndex...newline)
            guard !line.isEmpty else { continue }
            guard let object = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any]
            else {
                Log.debug(.claude, "unparsable line from claude")
                continue
            }
            route(object)
        }
    }

    // swiftlint:disable:next cyclomatic_complexity
    private func route(_ object: [String: Any]) {
        guard let type = object["type"] as? String else { return }

        if let id = object["session_id"] as? String { sessionId = id }

        switch type {
        case "system":
            handleSystem(object)

        case "assistant":
            handleAssistant(object)

        case "user":
            handleUserEcho(object)

        case "stream_event":
            handlePartial(object)

        case "control_request":
            handleControlRequest(object)

        case "rate_limit_event":
            if let info = object["rate_limit_info"] as? [String: Any] {
                emit?([
                    "t": "claude", "sub": "rateLimit",
                    "status": info["status"] as? String ?? "unknown",
                    "resetsAt": info["resetsAt"] as? Int ?? 0,
                    "type": info["rateLimitType"] as? String ?? "",
                ])
            }

        case "result":
            handleResult(object)

        default:
            Log.debug(.claude, "unhandled message type \(type)")
        }
    }

    private func handleSystem(_ object: [String: Any]) {
        guard (object["subtype"] as? String) == "init" else { return }

        let apiKeySource = object["apiKeySource"] as? String ?? "unknown"
        if apiKeySource != "none" {
            // Loud, because it means the user is being billed per token when
            // they asked specifically not to be.
            Log.warn(.claude, "claude authenticated via \(apiKeySource), not the subscription")
        }

        emit?([
            "t": "claude",
            "sub": "opened",
            "sessionId": sessionId ?? "",
            "cwd": object["cwd"] as? String ?? cwd,
            "model": object["model"] as? String ?? "",
            "tools": object["tools"] as? [String] ?? [],
            "permissionMode": object["permissionMode"] as? String ?? "",
            "apiKeySource": apiKeySource,
            "usingSubscription": apiKeySource == "none",
            "version": object["claude_code_version"] as? String ?? "",
        ])
    }

    private func handlePartial(_ object: [String: Any]) {
        // Token-level deltas drive the "STREAMING · 31 TOK/S" readout on 06A.
        guard let event = object["event"] as? [String: Any],
              (event["type"] as? String) == "content_block_delta",
              let delta = event["delta"] as? [String: Any],
              let text = delta["text"] as? String
        else { return }

        assistantTextBuffer += text
        outputTokenCount += 1

        var payload: [String: Any] = ["t": "claude", "sub": "delta", "text": text]
        if let turnStartedAt {
            let elapsed = Date().timeIntervalSince(turnStartedAt)
            if elapsed > 0.5 {
                payload["tokensPerSecond"] = Int(Double(outputTokenCount) / elapsed)
            }
        }
        emit?(payload)
    }

    private func handleAssistant(_ object: [String: Any]) {
        guard let message = object["message"] as? [String: Any],
              let content = message["content"] as? [[String: Any]]
        else { return }

        var blocks: [[String: Any]] = []

        for block in content {
            let kind = block["type"] as? String ?? ""
            switch kind {
            case "text":
                if let text = block["text"] as? String, !text.isEmpty {
                    blocks.append(["type": "text", "text": text])
                }

            case "thinking":
                if let text = block["thinking"] as? String, !text.isEmpty {
                    blocks.append(["type": "thinking", "text": text])
                }

            case "tool_use":
                guard let id = block["id"] as? String,
                      let name = block["name"] as? String else { continue }
                let input = block["input"] as? [String: Any] ?? [:]
                let target = Self.describeTarget(tool: name, input: input)
                runningTools[id] = (name, target, Date())
                emit?([
                    "t": "claude", "sub": "tool",
                    "id": id, "name": name, "target": target,
                    "state": "running",
                ])

            default:
                break
            }
        }

        assistantTextBuffer = ""

        if !blocks.isEmpty {
            emit?(["t": "claude", "sub": "message", "role": "assistant", "blocks": blocks])
        }
    }

    private func handleUserEcho(_ object: [String: Any]) {
        guard let message = object["message"] as? [String: Any],
              let content = message["content"] as? [[String: Any]]
        else { return }

        for block in content where (block["type"] as? String) == "tool_result" {
            guard let id = block["tool_use_id"] as? String else { continue }
            let isError = block["is_error"] as? Bool ?? false
            let started = runningTools.removeValue(forKey: id)
            let elapsed = started.map { Date().timeIntervalSince($0.at) } ?? 0

            emit?([
                "t": "claude", "sub": "tool",
                "id": id,
                "name": started?.name ?? "",
                "target": started?.target ?? "",
                "state": isError ? "error" : "ok",
                "ms": Int(elapsed * 1000),
                "preview": Self.previewText(block["content"]),
            ])
        }

        // A tool just finished; the working tree may have moved under us. Read
        // it from git rather than inferring it from which tool ran — Bash edits
        // files too, and an edit that gets reverted should stop being listed.
        publishWorkingTree()
    }

    // MARK: Working tree

    /// Pushes the changed-file list, and the open diff along with it.
    func publishWorkingTree() {
        let (changes, total) = GitWorkingTree.changes(cwd: cwd)
        emit?([
            "t": "claude", "sub": "files",
            "files": changes.map(\.wire),
            "total": total,
        ])

        if let watchedDiffPath {
            emitDiff(path: watchedDiffPath)
        }
    }

    /// Opens (or with nil, closes) the live diff for one path. While a path is
    /// watched, every tool result re-sends its patch, so the phone sees the
    /// file change as Claude edits it.
    func watchDiff(path: String?) {
        watchedDiffPath = path
        guard let path else { return }
        emitDiff(path: path)
    }

    private func emitDiff(path: String) {
        emit?([
            "t": "claude", "sub": "diff",
            "path": path,
            "patch": GitWorkingTree.diff(cwd: cwd, path: path),
        ])
    }

    private func handleControlRequest(_ object: [String: Any]) {
        guard let requestId = object["request_id"] as? String,
              let request = object["request"] as? [String: Any],
              let subtype = request["subtype"] as? String
        else { return }

        switch subtype {
        case "can_use_tool":
            let toolName = request["tool_name"] as? String ?? "unknown"
            let input = request["input"] as? [String: Any] ?? [:]

            // "ALWAYS HERE" from a previous prompt: answer immediately without
            // waking the phone again.
            if alwaysAllowedTools.contains(toolName) {
                pendingPermissions[requestId] = (toolName, Date())
                respondToPermission(requestId: requestId, allow: true, scope: .once, message: nil)
                return
            }

            pendingPermissions[requestId] = (toolName, Date())
            emit?([
                "t": "claude", "sub": "permission",
                "requestId": requestId,
                "toolName": toolName,
                "command": Self.describeCommand(tool: toolName, input: input),
                "explanation": Self.explain(tool: toolName, input: input),
                "waitingMs": 0,
            ])
            Log.info(.claude, "permission requested for \(toolName)")

        default:
            Log.debug(.claude, "unhandled control request \(subtype)")
        }
    }

    private func handleResult(_ object: [String: Any]) {
        var payload: [String: Any] = [
            "t": "claude", "sub": "usage",
            "durationMs": object["duration_ms"] as? Int ?? 0,
            "turns": object["num_turns"] as? Int ?? 0,
            "stopReason": object["stop_reason"] as? String ?? "",
        ]
        if let usage = object["usage"] as? [String: Any] {
            payload["inputTokens"] = usage["input_tokens"] as? Int ?? 0
            payload["outputTokens"] = usage["output_tokens"] as? Int ?? 0
        }
        emit?(payload)
    }

    /// Long-pending permissions get a refreshed age so 06C's "PAUSED 12S"
    /// counts up truthfully even if the phone reconnects mid-wait.
    func pendingPermissionSnapshot() -> [[String: Any]] {
        pendingPermissions.map { requestId, pending in
            [
                "requestId": requestId,
                "toolName": pending.toolName,
                "waitingMs": Int(Date().timeIntervalSince(pending.at) * 1000),
            ]
        }
    }

    // MARK: Presentation helpers

    /// "Grep \"queue\" · 14 hits" style targets for the 06B ledger.
    private static func describeTarget(tool: String, input: [String: Any]) -> String {
        switch tool {
        case "Bash":
            return (input["command"] as? String) ?? ""
        case "Read", "Write", "Edit":
            let path = (input["file_path"] as? String) ?? ""
            return URL(fileURLWithPath: path).lastPathComponent
        case "Grep":
            let pattern = (input["pattern"] as? String) ?? ""
            return "\"\(pattern)\""
        case "Glob":
            return (input["pattern"] as? String) ?? ""
        case "WebFetch":
            return (input["url"] as? String) ?? ""
        case "WebSearch":
            return (input["query"] as? String) ?? ""
        default:
            return ""
        }
    }

    /// 06C states the command verbatim — that is the whole promise of the
    /// screen, so it is never summarised or truncated here.
    private static func describeCommand(tool: String, input: [String: Any]) -> String {
        if tool == "Bash", let command = input["command"] as? String { return command }
        if let path = input["file_path"] as? String { return "\(tool) \(path)" }
        if let data = try? JSONSerialization.data(withJSONObject: input, options: [.sortedKeys]),
           let text = String(data: data, encoding: .utf8) {
            return "\(tool) \(text)"
        }
        return tool
    }

    /// The plain-units sentence under the command on 06C.
    private static func explain(tool: String, input: [String: Any]) -> String {
        switch tool {
        case "Bash":
            let command = (input["command"] as? String) ?? ""
            if command.contains("rm ") || command.contains("rm -rf") {
                return "Deletes files. Nothing tracked by git is restored automatically."
            }
            return input["description"] as? String ?? "Runs a shell command on the Mac."
        case "Write":
            return "Creates or overwrites a file on the Mac."
        case "Edit":
            return "Modifies a file on the Mac."
        default:
            return "Runs the \(tool) tool."
        }
    }

    private static func previewText(_ content: Any?) -> String {
        var text = ""
        if let string = content as? String {
            text = string
        } else if let blocks = content as? [[String: Any]] {
            text = blocks.compactMap { $0["text"] as? String }.joined(separator: "\n")
        }
        // 06B shows only the running tool's output, and only a few lines of it.
        let lines = text.split(separator: "\n", omittingEmptySubsequences: false).prefix(3)
        return lines.joined(separator: "\n")
    }
}

enum ClaudeError: Error, CustomStringConvertible {
    case cliNotFound

    var description: String {
        switch self {
        case .cliNotFound:
            return "claude CLI not found. Install Claude Code and run `claude login`."
        }
    }
}
