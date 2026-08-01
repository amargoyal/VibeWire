import Foundation

/// The last few hundred things this host said about itself, kept in memory.
///
/// `Log` already funnels every line through one place, so this taps that funnel
/// rather than asking every call site to report twice. The dashboard's Log pane
/// reads it.
///
/// Nothing is written to disk and nothing survives a restart. That is a
/// statement the pane makes out loud — "SINCE LAUNCH · NOT PERSISTED" — because
/// a log that silently begins at the last launch reads like a Mac that has done
/// nothing for six days.
///
/// The area is the one `Log` already carries. Inventing a second taxonomy for
/// the dashboard would mean deciding, per line, which of two names it goes
/// under; the filters on that pane are these six and nothing else.
final class EventLog: @unchecked Sendable {
    struct Entry: Sendable {
        let sequence: Int
        let at: Date
        let level: String
        let area: String
        let text: String

        var wire: [String: Any] {
            [
                "seq": sequence,
                "at": Timestamps.wallClock(at),
                "level": level,
                "area": area,
                "text": text,
            ]
        }
    }

    static let shared = EventLog()

    /// Enough to cover a session's worth of pairing, capture and link events
    /// without holding a process's whole history in memory.
    private let capacity = 600

    private struct State {
        var entries: [Entry] = []
        var nextSequence = 1
        /// Counted rather than derived from `entries`, which is trimmed.
        var dropped = 0
    }

    private let state = Guarded(State())

    func record(level: String, area: String, text: String) {
        state.withLock { current in
            let entry = Entry(
                sequence: current.nextSequence,
                at: Date(),
                level: level,
                area: area,
                text: text
            )
            current.nextSequence += 1
            current.entries.append(entry)
            if current.entries.count > capacity {
                let excess = current.entries.count - capacity
                current.entries.removeFirst(excess)
                current.dropped += excess
            }
        }
    }

    /// Newest first, which is the order the pane draws.
    ///
    /// `area` filters to one of `Log.Area`'s cases; nil is everything. The limit
    /// is applied after filtering, so asking for 60 PAIRING lines does not
    /// return 60 lines of which four are pairing.
    func recent(area: String? = nil, limit: Int = 200) -> [Entry] {
        state.read { current in
            var matching = current.entries
            if let area {
                matching = matching.filter { $0.area == area }
            }
            return matching.suffix(limit).reversed()
        }
    }

    /// How many lines fell off the end, so the pane can say the log is trimmed
    /// rather than implying it holds everything since launch.
    var dropped: Int { state.read { $0.dropped } }
}
