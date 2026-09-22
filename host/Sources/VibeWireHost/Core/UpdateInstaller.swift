import AppKit
import CryptoKit
import Foundation

/// Installs the release `UpdateCheck` found, in place, and restarts into it.
///
/// What the reader used to do by hand, in order: open the release page, find
/// the disk image among four files, download it, mount it, drag the app onto
/// Applications, agree to replace, eject, quit the old copy, open the new one.
/// Nine steps, at least four of which are a chance to end up running a build
/// they did not mean to run. This does the same nine and refuses to guess at
/// any of them.
///
/// The old code declined to do this, and the reason it gave was real: an
/// application signed with a development certificate and never notarized
/// cannot lean on Gatekeeper to say the download is what it claims. So the
/// trust comes from two places instead, and both must hold:
///
///  - **The checksum published with the release.** `SHA256SUMS.txt` is fetched
///    over TLS from the same release as the image, and the image's digest must
///    match the line naming it. A mirror that serves a different file fails
///    here.
///  - **The signature already on this machine.** The application inside the
///    image must carry the same code-signing identity, team, and bundle
///    identifier as the copy that is running. Anyone able to satisfy that
///    holds the signing key, and a reader holding a compromised signing key
///    was never protected by being sent to a web page instead.
///
/// Nothing is replaced until both checks pass and the new bundle has been
/// copied, whole, to the same volume as the old one. The swap itself is two
/// renames performed by a small script that outlives this process, because a
/// process cannot delete the bundle it is executing from and still be running
/// to put the new one in place.
actor UpdateInstaller {
    /// Where the install has got to. Every case is a fact about work that has
    /// actually happened, not a step in an animation.
    enum Stage: Sendable, Equatable {
        case idle
        /// 0...1 where the server declared a length, nil where it did not.
        case downloading(Double?)
        case verifying
        case staging
        /// The swap script is armed and this process is about to quit.
        case restarting
        case failed(String)

        var name: String {
            switch self {
            case .idle: return "idle"
            case .downloading: return "downloading"
            case .verifying: return "verifying"
            case .staging: return "staging"
            case .restarting: return "restarting"
            case .failed: return "failed"
            }
        }

        /// Built here rather than on the actor: a dictionary of `Any` cannot
        /// leave an actor, and the stage itself is the only thing the window
        /// needs to have crossed.
        var wire: [String: Any] {
            var payload: [String: Any] = ["stage": name]
            if case .downloading(let fraction) = self, let fraction { payload["progress"] = fraction }
            if case .failed(let reason) = self { payload["problem"] = reason }
            return payload
        }
    }

    static let shared = UpdateInstaller()

    private var stage: Stage = .idle

    func currentStage() -> Stage { stage }

    /// Whether this build can replace itself at all.
    ///
    /// A host run from `swift run`, from a build directory, or from a
    /// read-only volume is not one this should touch. The window asks before
    /// it draws the button, for the same reason it draws no control anywhere
    /// else that cannot work.
    static var canInstallInPlace: Bool {
        guard let bundle = installedBundleURL() else { return false }
        return FileManager.default.isWritableFile(atPath: bundle.deletingLastPathComponent().path)
    }

    private static func installedBundleURL() -> URL? {
        let url = Bundle.main.bundleURL
        guard url.pathExtension == "app" else { return nil }
        return url
    }

    // MARK: The install

    func install() async {
        switch stage {
        case .downloading, .verifying, .staging, .restarting:
            // Already going. A second press is not a second install.
            return
        case .idle, .failed:
            break
        }

        do {
            try await run()
        } catch {
            let reason = (error as? Failure)?.errorDescription ?? error.localizedDescription
            Log.error(.app, "update install failed: \(reason)")
            stage = .failed(reason)
        }
    }

    private func run() async throws {
        let verdict = await UpdateCheck.shared.verdict()
        guard verdict.available, let latest = verdict.latest else { throw Failure.nothingToDo }
        guard let imageURL = verdict.downloadURL.flatMap(URL.init(string:)),
              let sumsURL = verdict.checksumsURL.flatMap(URL.init(string:))
        else { throw Failure.noAssets }
        guard let target = Self.installedBundleURL() else { throw Failure.notAnApp }
        guard FileManager.default.isWritableFile(atPath: target.deletingLastPathComponent().path)
        else { throw Failure.notWritable(target.deletingLastPathComponent().path) }

        let scratch = try Self.makeScratchDirectory()
        defer { try? FileManager.default.removeItem(at: scratch) }

        // 1. The checksum first, so a release that published an image without
        //    one is refused before anything large is fetched.
        let expected = try await expectedDigest(
            from: sumsURL,
            for: imageURL.lastPathComponent
        )

        // 2. The image.
        stage = .downloading(nil)
        let image = scratch.appendingPathComponent(imageURL.lastPathComponent)
        try await download(imageURL, to: image)

        // 3. What arrived, against what the release said would arrive.
        stage = .verifying
        let actual = try Self.digest(of: image)
        guard actual == expected else { throw Failure.digestMismatch(expected: expected, actual: actual) }

        // 4. Mount it, take what is needed, unmount it. The unmount is not a
        //    `defer` with a detached task in it: this function ends by
        //    terminating the process, and a task started on the way out never
        //    runs, which left a disk image mounted after every single update.
        let mount = try await Self.attach(image)
        let staged: (app: URL, directory: URL, version: String)
        do {
            staged = try await stageCopy(from: mount, target: target, latest: latest)
        } catch {
            await Self.detach(mount)
            throw error
        }
        await Self.detach(mount)

        // 5. Arm the swap and go.
        let candidateVersion = staged.version
        stage = .restarting
        try Self.armSwap(target: target, staged: staged.app, staging: staged.directory)
        Log.info(.app, "update \(candidateVersion) staged; restarting")
        await MainActor.run { NSApp.terminate(nil) }
    }

    /// Everything that needs the image mounted, in one place so the unmount
    /// has exactly one caller on the way out and one on the way to a throw.
    ///
    /// Returns the copy already sitting on the destination volume, so what is
    /// left afterwards is two renames that cannot half-finish, rather than a
    /// copy across volumes that can.
    private func stageCopy(
        from mount: URL,
        target: URL,
        latest: String
    ) async throws -> (app: URL, directory: URL, version: String) {
        let candidate = mount.appendingPathComponent(target.lastPathComponent)
        guard FileManager.default.fileExists(atPath: candidate.path) else {
            throw Failure.noAppInImage(target.lastPathComponent)
        }

        try await Self.verifySignature(of: candidate, matching: target)
        let version = Self.version(of: candidate) ?? latest
        guard UpdateCheck.isNewer(version, than: Config.hostVersion) else {
            throw Failure.notNewer(version)
        }

        stage = .staging
        let directory = target
            .deletingLastPathComponent()
            .appendingPathComponent(".VibeWire-update-\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let app = directory.appendingPathComponent(target.lastPathComponent)
        try await Self.ditto(from: candidate, to: app)
        // Again on the copy: `ditto` preserves a signature, and a copy whose
        // signature stopped verifying is a copy that must not be installed.
        try await Self.verifySignature(of: app, matching: target)
        return (app, directory, version)
    }
}

// MARK: - The pieces

extension UpdateInstaller {
    enum Failure: Error, LocalizedError {
        case nothingToDo
        case noAssets
        case notAnApp
        case notWritable(String)
        case http(Int, String)
        case noChecksumLine(String)
        case digestMismatch(expected: String, actual: String)
        case mountFailed
        case noAppInImage(String)
        case unsigned(String)
        case differentSigner(String)
        case notNewer(String)
        case copyFailed(String)

        var errorDescription: String? {
            switch self {
            case .nothingToDo:
                return "There is no newer release to install."
            case .noAssets:
                return "That release published no disk image and checksum file, so there is nothing to install from."
            case .notAnApp:
                return "This host is not running from an application bundle, so it cannot replace itself."
            case .notWritable(let path):
                return "\(path) is not writable by this user, so the new copy cannot be put there."
            case .http(let code, let what):
                return "Downloading \(what) failed: the server answered \(code)."
            case .noChecksumLine(let name):
                return "The release's checksum file does not list \(name)."
            case .digestMismatch(let expected, let actual):
                return "The download does not match the checksum in the release. Expected \(expected.prefix(16))…, got \(actual.prefix(16))…. Nothing was installed."
            case .mountFailed:
                return "The disk image would not mount."
            case .noAppInImage(let name):
                return "The disk image does not contain \(name)."
            case .unsigned(let detail):
                return "The downloaded application's signature did not verify: \(detail). Nothing was installed."
            case .differentSigner(let detail):
                return "The downloaded application is signed by a different identity than the one running: \(detail). Nothing was installed."
            case .notNewer(let version):
                return "The disk image holds version \(version), which is not newer than \(Config.hostVersion)."
            case .copyFailed(let detail):
                return "Copying the new application failed: \(detail)."
            }
        }
    }

    static func makeScratchDirectory() throws -> URL {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("vibewire-update-\(UUID().uuidString.prefix(8))")
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }

    /// The digest the release says the image should have.
    ///
    /// `SHA256SUMS.txt` is `<hex>  <filename>` per line, the format
    /// `shasum -a 256` writes, and the name is matched exactly rather than by
    /// prefix: a release carrying both an arm64 and a universal image must not
    /// have one checked against the other's line.
    func expectedDigest(from url: URL, for filename: String) async throws -> String {
        let (data, response) = try await URLSession.shared.data(from: url)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw Failure.http((response as? HTTPURLResponse)?.statusCode ?? 0, "the checksum file")
        }
        let text = String(decoding: data, as: UTF8.self)
        for line in text.split(separator: "\n") {
            let fields = line.split(separator: " ", omittingEmptySubsequences: true)
            guard fields.count >= 2, String(fields[fields.count - 1]) == filename else { continue }
            return String(fields[0]).lowercased()
        }
        throw Failure.noChecksumLine(filename)
    }

    /// Streams the image to disk, reporting progress where the server declared
    /// a length. Held in memory it would be a hundred megabytes on a host that
    /// is also encoding video.
    func download(_ url: URL, to destination: URL) async throws {
        var request = URLRequest(url: url)
        request.setValue("VibeWire/\(Config.hostVersion)", forHTTPHeaderField: "User-Agent")
        request.timeoutInterval = 60

        let (bytes, response) = try await URLSession.shared.bytes(for: request)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            throw Failure.http((response as? HTTPURLResponse)?.statusCode ?? 0, "the disk image")
        }
        let total = http.expectedContentLength > 0 ? Double(http.expectedContentLength) : nil

        FileManager.default.createFile(atPath: destination.path, contents: nil)
        let handle = try FileHandle(forWritingTo: destination)
        defer { try? handle.close() }

        var buffer = Data()
        buffer.reserveCapacity(1 << 16)
        var written = 0.0
        var lastReported = 0.0

        for try await byte in bytes {
            buffer.append(byte)
            if buffer.count >= 1 << 16 {
                try handle.write(contentsOf: buffer)
                written += Double(buffer.count)
                buffer.removeAll(keepingCapacity: true)
                // A stage change per 64KB would be a hundred messages a second
                // on the dashboard's poll. Every percent is enough to watch.
                if let total, written - lastReported > total / 100 {
                    lastReported = written
                    stage = .downloading(min(1, written / total))
                }
            }
        }
        if !buffer.isEmpty { try handle.write(contentsOf: buffer) }
    }

    /// SHA-256 of a file, read in chunks for the same reason.
    static func digest(of url: URL) throws -> String {
        let handle = try FileHandle(forReadingFrom: url)
        defer { try? handle.close() }
        var hasher = SHA256()
        while let chunk = try handle.read(upToCount: 1 << 20), !chunk.isEmpty {
            hasher.update(data: chunk)
        }
        return hasher.finalize().map { String(format: "%02x", $0) }.joined()
    }
}

// MARK: - The disk image, the signature, and the swap

extension UpdateInstaller {
    /// Runs a tool and hands back everything about how it went.
    ///
    /// `Shell.capture` is the wrong tool here: it throws away the exit status
    /// and the standard error, and both of those are the whole answer when the
    /// question is "did codesign accept this".
    static func run(
        _ path: String,
        _ arguments: [String],
        timeout: TimeInterval = 120
    ) async -> (status: Int32, out: String, error: String) {
        // Checked before a pipe exists. A `Process` that fails to start leaves
        // its pipes with no writer that will ever close, and the readers below
        // then wait on an EOF that cannot arrive: the first version of this
        // hung the whole install on a tool whose path was one directory out.
        guard FileManager.default.isExecutableFile(atPath: path) else {
            return (-1, "", "\(path) is not an executable on this machine")
        }

        return await withCheckedContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: path)
            process.arguments = arguments
            let out = Pipe()
            let err = Pipe()
            process.standardOutput = out
            process.standardError = err

            // Read both pipes on their own queues. A tool that fills the 64KB
            // pipe buffer while this waits for it to exit deadlocks otherwise,
            // and `hdiutil attach -plist` on a large image will.
            let outData = Guarded(Data())
            let errData = Guarded(Data())
            let group = DispatchGroup()
            for (pipe, sink) in [(out, outData), (err, errData)] {
                group.enter()
                DispatchQueue.global().async {
                    let data = pipe.fileHandleForReading.readDataToEndOfFile()
                    sink.withLock { $0 = data }
                    group.leave()
                }
            }

            let resumed = Guarded(false)
            let finish: @Sendable (Int32) -> Void = { status in
                let already = resumed.withLock { state -> Bool in
                    defer { state = true }
                    return state
                }
                guard !already else { return }
                // Bounded, for the same reason. A reader that cannot reach EOF
                // must cost this call a few seconds, never the whole install.
                _ = group.wait(timeout: .now() + 5)
                continuation.resume(returning: (
                    status,
                    String(decoding: outData.read { $0 }, as: UTF8.self),
                    String(decoding: errData.read { $0 }, as: UTF8.self)
                ))
            }

            let timer = DispatchSource.makeTimerSource(queue: .global())
            timer.schedule(deadline: .now() + timeout)
            timer.setEventHandler {
                if process.isRunning { process.terminate() }
                finish(-1)
            }
            timer.resume()

            process.terminationHandler = { finished in
                timer.cancel()
                finish(finished.terminationStatus)
            }

            do {
                try process.run()
            } catch {
                timer.cancel()
                finish(-1)
            }
        }
    }

    /// Mounts the image without putting it in the Finder sidebar, and hands
    /// back where it landed.
    static func attach(_ image: URL) async throws -> URL {
        let result = await run("/usr/bin/hdiutil", [
            "attach", image.path,
            "-nobrowse", "-readonly", "-noverify", "-noautoopen",
            "-plist",
        ])
        guard result.status == 0, let data = result.out.data(using: .utf8) else {
            throw Failure.mountFailed
        }
        guard
            let plist = try? PropertyListSerialization.propertyList(
                from: data, format: nil
            ) as? [String: Any],
            let entities = plist["system-entities"] as? [[String: Any]],
            let point = entities.compactMap({ $0["mount-point"] as? String }).first
        else { throw Failure.mountFailed }
        return URL(fileURLWithPath: point)
    }

    static func detach(_ mount: URL) async {
        // Force, because the reader may have a Finder window on it by the time
        // this runs, and leaving a mounted image behind is its own small mess.
        _ = await run("/usr/bin/hdiutil", ["detach", mount.path, "-force"], timeout: 30)
    }

    static func ditto(from source: URL, to destination: URL) async throws {
        let result = await run("/usr/bin/ditto", [source.path, destination.path])
        guard result.status == 0 else {
            throw Failure.copyFailed(result.error.isEmpty ? "ditto exited \(result.status)" : result.error)
        }
    }

    static func version(of app: URL) -> String? {
        let plist = app.appendingPathComponent("Contents/Info.plist")
        guard let data = try? Data(contentsOf: plist),
              let root = try? PropertyListSerialization.propertyList(from: data, format: nil)
                as? [String: Any]
        else { return nil }
        return root["CFBundleShortVersionString"] as? String
    }

    /// The two questions worth asking of a downloaded application: is the
    /// signature intact, and is it the same signer as the copy already here.
    ///
    /// The first alone is close to worthless, because anybody can sign
    /// anything. The pair is what makes a swapped download useless to an
    /// attacker who does not hold this project's key.
    static func verifySignature(of candidate: URL, matching installed: URL) async throws {
        let verified = await run("/usr/bin/codesign", [
            "--verify", "--strict", "--deep", candidate.path,
        ])
        guard verified.status == 0 else {
            throw Failure.unsigned(verified.error.trimmingCharacters(in: .whitespacesAndNewlines))
        }

        let mine = await identity(of: installed)
        let theirs = await identity(of: candidate)
        guard let mine, let theirs else {
            throw Failure.unsigned("the signing identity could not be read")
        }
        guard mine == theirs else {
            throw Failure.differentSigner("expected \(mine.describe), found \(theirs.describe)")
        }
    }

    struct SigningIdentity: Equatable, Sendable {
        var authority: String
        var team: String
        var bundleIdentifier: String

        var describe: String { "\(bundleIdentifier) signed by \(authority) (team \(team))" }
    }

    /// `codesign -dv` writes its report to standard error, one `key=value` per
    /// line, with the leaf certificate first among the authorities.
    static func identity(of app: URL) async -> SigningIdentity? {
        let result = await run("/usr/bin/codesign", ["-dv", "--verbose=4", app.path], timeout: 30)
        guard result.status == 0 else { return nil }
        var authority: String?
        var team: String?
        var identifier: String?
        for line in result.error.split(separator: "\n") {
            if authority == nil, line.hasPrefix("Authority=") {
                authority = String(line.dropFirst("Authority=".count))
            } else if line.hasPrefix("TeamIdentifier=") {
                team = String(line.dropFirst("TeamIdentifier=".count))
            } else if line.hasPrefix("Identifier=") {
                identifier = String(line.dropFirst("Identifier=".count))
            }
        }
        guard let authority, let team, let identifier, team != "not set" else { return nil }
        return SigningIdentity(authority: authority, team: team, bundleIdentifier: identifier)
    }
}

// MARK: - The handover

extension UpdateInstaller {
    /// Starts the script that finishes the job after this process is gone.
    ///
    /// A process cannot delete the bundle it is running from and then still be
    /// around to move the replacement into place, so the last two renames
    /// belong to something that outlives it. The script waits for this pid to
    /// disappear, moves the old bundle aside, moves the new one in, reopens
    /// the app, and only then deletes the old one. If the second rename fails
    /// the first is undone, so the worst case is the version that was already
    /// installed, still installed.
    ///
    /// Arguments are passed as arguments rather than interpolated into the
    /// text, so a path with a space or a quote in it is a path and not a
    /// second command.
    static func armSwap(target: URL, staged: URL, staging: URL) throws {
        let script = staging.appendingPathComponent("swap.sh")
        let body = """
        #!/bin/bash
        set -u
        pid="$1"; target="$2"; staged="$3"; staging="$4"

        # Up to twenty seconds for the old copy to go. It was asked to quit
        # before this ran; a host in the middle of writing its settings file
        # gets to finish.
        for _ in $(seq 1 200); do
          kill -0 "$pid" 2>/dev/null || break
          sleep 0.1
        done
        if kill -0 "$pid" 2>/dev/null; then
          echo "old process $pid is still running; nothing was changed" >&2
          exit 1
        fi

        backup="$staging/previous.app"
        rm -rf "$backup"
        if ! mv "$target" "$backup"; then
          echo "could not move the installed app aside" >&2
          exit 1
        fi
        if ! mv "$staged" "$target"; then
          echo "could not move the new app into place; putting the old one back" >&2
          mv "$backup" "$target"
          exit 1
        fi

        open "$target"
        rm -rf "$staging"
        """
        try body.write(to: script, atomically: true, encoding: .utf8)

        let log = FileManager.default.temporaryDirectory
            .appendingPathComponent("vibewire-update-swap.log")
        FileManager.default.createFile(atPath: log.path, contents: nil)

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/bin/bash")
        process.arguments = [
            script.path,
            String(ProcessInfo.processInfo.processIdentifier),
            target.path,
            staged.path,
            staging.path,
        ]
        // Detached from this process's session, so quitting the app does not
        // take the script with it.
        process.standardInput = FileHandle.nullDevice
        if let handle = try? FileHandle(forWritingTo: log) {
            process.standardOutput = handle
            process.standardError = handle
        }
        try process.run()
        Log.info(.app, "swap armed; its output goes to \(log.path)")
    }
}
