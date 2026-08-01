import Foundation
import os

/// Single logging surface for the host. Everything lands in the unified log
/// under the `com.vibewire.host` subsystem, and mirrors to stderr when the
/// process is attached to a terminal so `swift run` is useful.
enum Log {
    /// Mirror to stderr on a terminal, or whenever verbose logging is on —
    /// otherwise redirecting the host's output to a file yields nothing.
    private static let mirrorToStderr = isatty(STDERR_FILENO) == 1 || Config.verbose

    private static let net = Logger(subsystem: "com.vibewire.host", category: "net")
    private static let capture = Logger(subsystem: "com.vibewire.host", category: "capture")
    private static let input = Logger(subsystem: "com.vibewire.host", category: "input")
    private static let claude = Logger(subsystem: "com.vibewire.host", category: "claude")
    private static let transport = Logger(subsystem: "com.vibewire.host", category: "transport")
    private static let app = Logger(subsystem: "com.vibewire.host", category: "app")

    enum Area: String {
        case net, capture, input, claude, transport, app

        var logger: Logger {
            switch self {
            case .net: return Log.net
            case .capture: return Log.capture
            case .input: return Log.input
            case .claude: return Log.claude
            case .transport: return Log.transport
            case .app: return Log.app
            }
        }
    }

    static func info(_ area: Area, _ message: @autoclosure () -> String) {
        let text = message()
        area.logger.info("\(text, privacy: .public)")
        emit("INFO", area, text)
    }

    static func warn(_ area: Area, _ message: @autoclosure () -> String) {
        let text = message()
        area.logger.warning("\(text, privacy: .public)")
        emit("WARN", area, text)
    }

    static func error(_ area: Area, _ message: @autoclosure () -> String) {
        let text = message()
        area.logger.error("\(text, privacy: .public)")
        emit("ERROR", area, text)
    }

    static func debug(_ area: Area, _ message: @autoclosure () -> String) {
        guard Config.verbose else { return }
        let text = message()
        area.logger.debug("\(text, privacy: .public)")
        emit("DEBUG", area, text)
    }

    /// The one funnel. Three consumers now: the unified log above, stderr when
    /// something is watching it, and the in-memory ring the dashboard's Log pane
    /// reads. The ring is filled unconditionally — it is the only one of the
    /// three that answers "what happened while nobody was looking".
    private static func emit(_ level: String, _ area: Area, _ text: String) {
        EventLog.shared.record(level: level, area: area.rawValue, text: text)
        guard mirrorToStderr else { return }
        let stamp = Timestamps.wallClock()
        FileHandle.standardError.write(
            Data("\(stamp) \(level.padding(toLength: 5, withPad: " ", startingAt: 0)) [\(area.rawValue)] \(text)\n".utf8)
        )
    }
}

enum Timestamps {
    private static let formatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss.SSS"
        return f
    }()

    static func wallClock(_ date: Date = Date()) -> String {
        formatter.string(from: date)
    }

    /// Monotonic microseconds. Used for RTT and presentation timestamps so a
    /// clock adjustment mid-session cannot make latency read negative.
    static func monotonicMicros() -> UInt64 {
        var info = mach_timebase_info_data_t()
        mach_timebase_info(&info)
        let nanos = mach_absolute_time() &* UInt64(info.numer) / UInt64(info.denom)
        return nanos / 1_000
    }
}
