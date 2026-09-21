import Foundation

/// Runs a command and hands back what it printed, or nothing.
///
/// Every command this host shells out to is a question about the machine it is
/// running on — which addresses route, whether Tailscale is up, whether the
/// firewall would let a phone in — and every one of them can hang. A hung
/// answer must not wedge the caller, so the timeout is part of the call rather
/// than something each caller is trusted to remember.
enum Shell {
    static func capture(
        _ path: String,
        _ arguments: [String],
        timeout: TimeInterval
    ) async -> Data? {
        guard FileManager.default.isExecutableFile(atPath: path) else { return nil }

        return await withCheckedContinuation { continuation in
            let process = Process()
            process.executableURL = URL(fileURLWithPath: path)
            process.arguments = arguments
            let pipe = Pipe()
            process.standardOutput = pipe
            process.standardError = FileHandle.nullDevice

            let timer = DispatchSource.makeTimerSource(queue: .global())
            timer.schedule(deadline: .now() + timeout)

            // Both the timeout and the termination handler race to finish this
            // continuation; resuming twice would trap, so the first one wins.
            let resumed = Guarded(false)
            let finish: @Sendable (Data?) -> Void = { data in
                let alreadyResumed = resumed.withLock { state -> Bool in
                    defer { state = true }
                    return state
                }
                guard !alreadyResumed else { return }
                timer.cancel()
                continuation.resume(returning: data)
            }

            timer.setEventHandler {
                if process.isRunning { process.terminate() }
                finish(nil)
            }
            timer.resume()

            process.terminationHandler = { _ in
                finish(try? pipe.fileHandleForReading.readToEnd() ?? Data())
            }

            do {
                try process.run()
            } catch {
                finish(nil)
            }
        }
    }

    /// The same call, as text.
    static func captureText(
        _ path: String,
        _ arguments: [String],
        timeout: TimeInterval
    ) async -> String? {
        guard let data = await capture(path, arguments, timeout: timeout) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
