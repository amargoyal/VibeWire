import Foundation

/// Link quality, measured rather than guessed.
///
/// Screen 02A promises numbers over adjectives — "Weak" is always accompanied
/// by 340 ms and 4.2% loss — so every value here comes from an actual sample,
/// and anything not yet measured reports as nil so the phone can draw a dash
/// instead of inventing a zero.
actor Telemetry {
    struct Sample: Sendable {
        let rttMillis: Double
        let at: Date
    }

    struct Snapshot: Sendable {
        var rttMillis: Double?
        var jitterMillis: Double?
        var lossPercent: Double
        var downMbps: Double
        /// Last 60 s of RTT, one value per second, for the sparkline on 02A.
        var rttHistory: [Double]
        var sampleCount: Int

        var wire: [String: Any] {
            var payload: [String: Any] = [
                "lossPercent": (lossPercent * 10).rounded() / 10,
                "downMbps": (downMbps * 10).rounded() / 10,
                "rttHistory": rttHistory.map { ($0).rounded() },
                "samples": sampleCount,
            ]
            // nil stays nil on the wire; the phone renders "—".
            payload["rttMillis"] = rttMillis.map { $0.rounded() }
            payload["jitterMillis"] = jitterMillis.map { $0.rounded() }
            return payload
        }
    }

    private var samples: [Sample] = []
    /// Highest ping sequence the phone has sent, and how many actually
    /// arrived. Loss is the gap between them — a single stream, measured
    /// one way, with no clock or cadence assumptions.
    private var firstSequence: UInt64?
    private var highestSequence: UInt64 = 0
    private var pingsReceived = 0
    private var history: [Double] = []
    private var lastHistoryTick = Date()
    private var currentMbps: Double = 0

    private let windowSeconds: TimeInterval = 60

    /// Called for each ping the phone sends. `sequence` is the phone's own
    /// counter, so a gap means a message genuinely did not arrive.
    ///
    /// RTT is *not* measured here — the phone stamps `tMicros` on its own
    /// monotonic clock, which is not comparable to the Mac's. The phone
    /// measures the round trip when the pong comes back and reports it.
    func notePing(sequence: UInt64, reportedRttMillis: Double?) {
        pingsReceived += 1
        if firstSequence == nil { firstSequence = sequence }
        highestSequence = max(highestSequence, sequence)

        if let rtt = reportedRttMillis, rtt >= 0 {
            samples.append(Sample(rttMillis: rtt, at: Date()))
            prune()
            tickHistory(rtt)
        }
    }

    func noteThroughput(mbps: Double) {
        currentMbps = mbps
    }

    func snapshot() -> Snapshot {
        prune()

        let values = samples.map(\.rttMillis)
        let rtt = values.isEmpty ? nil : values.reduce(0, +) / Double(values.count)

        // Jitter as mean absolute deviation between consecutive samples, which
        // is what a user perceives as "spiky" on the 02B trace.
        var jitter: Double?
        if values.count >= 2 {
            var total = 0.0
            for index in 1..<values.count {
                total += abs(values[index] - values[index - 1])
            }
            jitter = total / Double(values.count - 1)
        }

        // Expected count is derived from the phone's own sequence numbers,
        // so the two sides of the ratio always describe the same stream.
        var loss = 0.0
        if let first = firstSequence {
            let expected = Int(highestSequence - first) + 1
            if expected > 1 {
                loss = max(0, Double(expected - pingsReceived) / Double(expected) * 100)
            }
        }

        return Snapshot(
            rttMillis: rtt,
            jitterMillis: jitter,
            lossPercent: loss,
            downMbps: currentMbps,
            rttHistory: history,
            sampleCount: samples.count
        )
    }

    /// Drives the quality ladder. Returns nil when there is not enough data to
    /// judge, so the encoder holds its current setting rather than thrashing.
    func linkVerdict() -> (rtt: Double, loss: Double)? {
        let snapshot = snapshot()
        guard let rtt = snapshot.rttMillis, snapshot.sampleCount >= 3 else { return nil }
        return (rtt, snapshot.lossPercent)
    }

    func reset() {
        samples.removeAll()
        history.removeAll()
        firstSequence = nil
        highestSequence = 0
        pingsReceived = 0
        currentMbps = 0
    }

    private func prune() {
        let cutoff = Date().addingTimeInterval(-windowSeconds)
        samples.removeAll { $0.at < cutoff }
    }

    private func tickHistory(_ rtt: Double) {
        guard Date().timeIntervalSince(lastHistoryTick) >= 1 else { return }
        lastHistoryTick = Date()
        history.append(rtt)
        if history.count > 60 { history.removeFirst(history.count - 60) }
    }
}
