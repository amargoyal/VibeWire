import Foundation

/// Reads Claude Code's on-disk session history so the phone can list and resume
/// real past conversations — the "connect to my Claude Code chats" requirement.
///
/// Claude Code stores one JSONL transcript per session under
/// `~/.claude/projects/<slugified-cwd>/<session-uuid>.jsonl`. Nothing here
/// writes; resuming is done by handing the session id to the CLI.
struct ClaudeSessionSummary: Sendable {
    let id: String
    let summary: String
    let cwd: String
    let gitBranch: String?
    let modifiedAt: Date
    let messageCount: Int

    var wire: [String: Any] {
        var payload: [String: Any] = [
            "id": id,
            "summary": summary,
            "cwd": cwd,
            "modifiedAt": ISO8601DateFormatter().string(from: modifiedAt),
            "messages": messageCount,
        ]
        payload["gitBranch"] = gitBranch
        return payload
    }
}

enum ClaudeSessionIndex {
    static var projectsDirectory: URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".claude/projects", isDirectory: true)
    }

    /// Claude Code slugifies the working directory by replacing path separators
    /// and dots with dashes. Matching that lets us scope the list to one repo.
    static func slug(for path: String) -> String {
        var slug = ""
        for character in path {
            if character.isLetter || character.isNumber {
                slug.append(character)
            } else {
                slug.append("-")
            }
        }
        return slug
    }

    /// Most recent sessions first. `cwd` scopes to one project; nil lists all.
    static func recentSessions(cwd: String?, limit: Int = 25) -> [ClaudeSessionSummary] {
        let fileManager = FileManager.default
        let root = projectsDirectory

        var projectDirectories: [URL] = []
        if let cwd {
            let directory = root.appendingPathComponent(slug(for: cwd), isDirectory: true)
            if fileManager.fileExists(atPath: directory.path) {
                projectDirectories = [directory]
            }
        } else {
            projectDirectories = (try? fileManager.contentsOfDirectory(
                at: root,
                includingPropertiesForKeys: [.isDirectoryKey],
                options: [.skipsHiddenFiles]
            )) ?? []
        }

        var summaries: [ClaudeSessionSummary] = []
        for directory in projectDirectories {
            let files = (try? fileManager.contentsOfDirectory(
                at: directory,
                includingPropertiesForKeys: [.contentModificationDateKey],
                options: [.skipsHiddenFiles]
            )) ?? []

            for file in files where file.pathExtension == "jsonl" {
                guard let summary = parseTranscript(file) else { continue }
                summaries.append(summary)
            }
        }

        return summaries
            .sorted { $0.modifiedAt > $1.modifiedAt }
            .prefix(limit)
            .map { $0 }
    }

    /// One past message, for repopulating the panel when a session is resumed.
    struct Turn: Sendable {
        let role: String        // "user" | "assistant"
        let text: String
        let at: Date?

        var wire: [String: Any] {
            var payload: [String: Any] = ["role": role, "text": text]
            if let at { payload["at"] = ISO8601DateFormatter().string(from: at) }
            return payload
        }
    }

    /// The conversation so far.
    ///
    /// `claude --resume` under `--print` restores the context for the model but
    /// prints nothing, so a resumed session arrives on the phone as an empty
    /// panel. The transcript on disk is the only copy of what was already said,
    /// and reading it is what makes resume look like resume.
    ///
    /// Returns the last `limit` turns; long messages are clipped because this
    /// goes over the wire to a phone.
    static func transcript(sessionId: String, limit: Int = 40) -> [Turn] {
        guard let url = transcriptURL(for: sessionId),
              let contents = try? String(contentsOf: url, encoding: .utf8)
        else { return [] }

        let formatter = ISO8601DateFormatter()
        var turns: [Turn] = []

        for line in contents.split(separator: "\n") {
            guard let object = try? JSONSerialization.jsonObject(
                with: Data(line.utf8)
            ) as? [String: Any] else { continue }

            let type = object["type"] as? String
            guard type == "user" || type == "assistant" else { continue }
            // Injected context, not something either party said.
            guard (object["isMeta"] as? Bool) != true else { continue }
            guard let message = object["message"] as? [String: Any],
                  let text = extractText(from: message["content"]),
                  !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            else { continue }

            // Tool plumbing and harness scaffolding are not conversation.
            let lowered = text.lowercased()
            guard !lowered.hasPrefix("<command"),
                  !lowered.hasPrefix("caveat:"),
                  !lowered.hasPrefix("<local-command"),
                  !lowered.contains("</system-reminder>")
            else { continue }

            turns.append(Turn(
                role: type == "user" ? "user" : "assistant",
                text: String(text.prefix(4000)),
                at: (object["timestamp"] as? String).flatMap(formatter.date(from:))
            ))
        }

        return Array(turns.suffix(limit))
    }

    /// Transcripts are filed under a slug of the working directory, and the
    /// caller resuming by id does not necessarily know which one — so search.
    private static func transcriptURL(for sessionId: String) -> URL? {
        let fileManager = FileManager.default
        let directories = (try? fileManager.contentsOfDirectory(
            at: projectsDirectory,
            includingPropertiesForKeys: nil,
            options: [.skipsHiddenFiles]
        )) ?? []

        for directory in directories {
            let candidate = directory.appendingPathComponent("\(sessionId).jsonl")
            if fileManager.fileExists(atPath: candidate.path) { return candidate }
        }
        return nil
    }

    /// Pulls just enough out of a transcript to render a list row: the first
    /// user message as a title, plus cwd and branch from the session metadata.
    ///
    /// Transcripts can be megabytes. Reading the whole file to show a one-line
    /// summary would make the list sluggish, so this reads the head for
    /// metadata and counts lines without materialising the parsed objects.
    private static func parseTranscript(_ url: URL) -> ClaudeSessionSummary? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }

        let attributes = try? FileManager.default.attributesOfItem(atPath: url.path)
        let modifiedAt = (attributes?[.modificationDate] as? Date) ?? Date.distantPast

        // 256 KB is plenty for the first several messages.
        let head = (try? handle.read(upToCount: 256 * 1024)) ?? Data()
        guard !head.isEmpty else { return nil }

        var cwd = ""
        var gitBranch: String?
        var title: String?

        let lines = head.split(separator: UInt8(ascii: "\n"))
        for line in lines {
            guard let object = try? JSONSerialization.jsonObject(with: Data(line)) as? [String: Any]
            else { continue }

            if cwd.isEmpty, let value = object["cwd"] as? String { cwd = value }
            if gitBranch == nil, let value = object["gitBranch"] as? String, !value.isEmpty {
                gitBranch = value
            }

            if title == nil,
               (object["type"] as? String) == "user",
               let message = object["message"] as? [String: Any],
               let candidate = extractText(from: message["content"]),
               let cleaned = summaryText(from: candidate) {
                title = cleaned
            }

            if title != nil && !cwd.isEmpty && gitBranch != nil { break }
        }

        // Line count over the whole file, streamed.
        var messageCount = 0
        if let counter = try? FileHandle(forReadingFrom: url) {
            defer { try? counter.close() }
            while let chunk = try? counter.read(upToCount: 1 << 20), !chunk.isEmpty {
                messageCount += chunk.reduce(into: 0) { total, byte in
                    if byte == UInt8(ascii: "\n") { total += 1 }
                }
            }
        }

        let id = url.deletingPathExtension().lastPathComponent
        let summary = (title?.isEmpty == false ? title! : "Untitled session")
            .replacingOccurrences(of: "\n", with: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        return ClaudeSessionSummary(
            id: id,
            summary: String(summary.prefix(120)),
            cwd: cwd.isEmpty ? url.deletingLastPathComponent().lastPathComponent : cwd,
            gitBranch: gitBranch,
            modifiedAt: modifiedAt,
            messageCount: messageCount
        )
    }

    /// Transcripts often open with tooling scaffolding — command wrappers,
    /// caveat banners, injected reminders — none of which describe what the
    /// session was about. Strip those and take the first line that reads
    /// like something a person typed.
    private static func summaryText(from raw: String) -> String? {
        var text = raw

        // Drop any XML-ish wrapper blocks and their contents.
        while let open = text.range(of: "<"),
              let closeTag = text.range(of: ">", range: open.upperBound..<text.endIndex) {
            let tag = String(text[open.upperBound..<closeTag.lowerBound])
                .split(separator: " ").first.map(String.init) ?? ""
            guard !tag.isEmpty, !tag.hasPrefix("/") else { break }
            if let end = text.range(of: "</\(tag)>") {
                text.removeSubrange(open.lowerBound..<end.upperBound)
            } else {
                text.removeSubrange(open.lowerBound..<closeTag.upperBound)
            }
        }

        let ignored = ["caveat:", "system-reminder", "<command", "local-command"]
        for line in text.split(separator: "\n") {
            let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
            guard trimmed.count > 3 else { continue }
            let lowered = trimmed.lowercased()
            guard !ignored.contains(where: lowered.hasPrefix) else { continue }
            return trimmed
        }
        return nil
    }

    /// Message content is either a plain string or an array of typed blocks.
    private static func extractText(from content: Any?) -> String? {
        if let text = content as? String { return text }
        guard let blocks = content as? [[String: Any]] else { return nil }
        for block in blocks where (block["type"] as? String) == "text" {
            if let text = block["text"] as? String, !text.isEmpty { return text }
        }
        return nil
    }
}
