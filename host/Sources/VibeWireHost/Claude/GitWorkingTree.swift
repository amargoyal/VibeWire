import Foundation

/// What Claude has actually changed on disk, read straight from git.
///
/// The alternative — believing the tool calls — drifts the moment a `Bash` step
/// writes a file, a build regenerates something, or an edit gets reverted. Git
/// already tracks exactly this and is the same thing the user would check, so
/// the phone shows the working tree rather than a guess assembled from the
/// transcript.
enum GitWorkingTree {
    struct FileChange: Sendable {
        let path: String        // relative to the repository root
        let status: String      // "A" | "M" | "D"
        let added: Int
        let removed: Int

        var wire: [String: Any] {
            ["path": path, "status": status, "added": added, "removed": removed]
        }
    }

    /// Build output and caches. A repository without a .gitignore reports
    /// thousands of untracked files — this one answered with 2857, nearly all
    /// of them object files — and none of them are a change anyone made.
    private static let ignoredComponents: Set<String> = [
        ".build", ".git", "DerivedData", "node_modules", ".venv",
        "__pycache__", ".next", "dist", "build", ".DS_Store",
    ]

    /// More than this and the list has stopped being a list of what changed.
    private static let fileLimit = 200

    /// Every uncommitted change in the working tree, staged or not, including
    /// files git has never seen.
    ///
    /// Returns the changes and the total before truncation, so the phone can
    /// say so rather than quietly showing a prefix.
    static func changes(cwd: String) -> (files: [FileChange], total: Int) {
        let all = allChanges(cwd: cwd)
        return (Array(all.prefix(fileLimit)), all.count)
    }

    private static func allChanges(cwd: String) -> [FileChange] {
        guard let root = repositoryRoot(cwd: cwd) else { return [] }

        // --numstat covers tracked edits; untracked files have no diff to read
        // and are counted by hand below.
        var counts: [String: (added: Int, removed: Int)] = [:]
        for line in run(["diff", "HEAD", "--numstat"], in: root).split(separator: "\n") {
            let fields = line.split(separator: "\t", maxSplits: 2).map(String.init)
            guard fields.count == 3 else { continue }
            // "-" in place of a count means binary.
            counts[fields[2]] = (Int(fields[0]) ?? 0, Int(fields[1]) ?? 0)
        }

        var changes: [FileChange] = []
        // Individual files, not collapsed directories: `host/` is not something
        // anyone can open a diff on. The noise that made `all` unusable here —
        // 2857 entries, nearly all of them build output — is dropped by the
        // component filter below, which leaves the 48 files that are real.
        for line in run(["status", "--porcelain=v1", "--untracked-files=all"], in: root)
            .split(separator: "\n") {
            guard line.count > 3 else { continue }
            let code = String(line.prefix(2))
            var path = String(line.dropFirst(3))
            // Renames arrive as "old -> new"; the new name is what changed.
            if let arrow = path.range(of: " -> ") { path = String(path[arrow.upperBound...]) }
            path = path.trimmingCharacters(in: CharacterSet(charactersIn: "\""))

            let components = path.split(separator: "/").map(String.init)
            guard !components.contains(where: ignoredComponents.contains) else { continue }

            let status: String
            if code.contains("D") {
                status = "D"
            } else if code.contains("?") || code.contains("A") {
                status = "A"
            } else {
                status = "M"
            }

            let count = counts[path] ?? (status == "A" ? (lineCount(root: root, path: path), 0) : (0, 0))
            changes.append(FileChange(
                path: path,
                status: status,
                added: count.added,
                removed: count.removed
            ))
        }

        return changes.sorted { $0.path < $1.path }
    }

    /// A unified diff for one path, as git would print it.
    ///
    /// Untracked files have nothing to diff against, so they are compared to
    /// /dev/null — which is how the whole file shows up as additions instead of
    /// as an empty patch.
    static func diff(cwd: String, path: String) -> String {
        guard let root = repositoryRoot(cwd: cwd) else { return "" }

        let tracked = run(["ls-files", "--error-unmatch", path], in: root, quiet: true)
        if tracked.isEmpty {
            return run(["diff", "--no-index", "--", "/dev/null", path], in: root)
        }

        let patch = run(["diff", "HEAD", "--", path], in: root)
        return patch
    }

    static func repositoryRoot(cwd: String) -> String? {
        let root = run(["rev-parse", "--show-toplevel"], in: cwd, quiet: true)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return root.isEmpty ? nil : root
    }

    private static func lineCount(root: String, path: String) -> Int {
        guard let contents = try? String(
            contentsOf: URL(fileURLWithPath: root).appendingPathComponent(path),
            encoding: .utf8
        ) else { return 0 }
        return contents.split(separator: "\n", omittingEmptySubsequences: false).count
    }

    /// `git` with a fixed working directory. Failures come back as an empty
    /// string: a missing repository is a normal state here, not an error worth
    /// interrupting a Claude session for.
    @discardableResult
    private static func run(_ arguments: [String], in directory: String, quiet: Bool = false) -> String {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = ["git", "-C", directory] + arguments

        let output = Pipe()
        process.standardOutput = output
        process.standardError = quiet ? Pipe() : FileHandle.nullDevice

        do {
            try process.run()
        } catch {
            return ""
        }

        // Read before waiting: a large diff can fill the pipe buffer and
        // deadlock a process that is waited on first.
        let data = output.fileHandleForReading.readDataToEndOfFile()
        process.waitUntilExit()
        return String(data: data, encoding: .utf8) ?? ""
    }
}
