/**
 * Link quality, measured rather than guessed.
 *
 * Screen 02A promises numbers over adjectives — "Weak" is always accompanied
 * by 340 ms and 4.2% loss — so every value here comes from an actual sample,
 * and anything not yet measured reports as null so the phone can draw a dash
 * instead of inventing a zero.
 */
export interface TelemetrySnapshot {
  rttMillis: number | null
  jitterMillis: number | null
  lossPercent: number
  downMbps: number
  /** Last 60 s of RTT, one value per second, for the sparkline on 02A. */
  rttHistory: number[]
  /** Last 60 s of measured outbound rate, one per second, for the dashboard. */
  mbpsHistory: number[]
  sampleCount: number
}

export function telemetryWire(snapshot: TelemetrySnapshot): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    lossPercent: Math.round(snapshot.lossPercent * 10) / 10,
    downMbps: Math.round(snapshot.downMbps * 10) / 10,
    rttHistory: snapshot.rttHistory.map((value) => Math.round(value)),
    samples: snapshot.sampleCount,
  }
  // null stays absent on the wire; the phone renders "—".
  if (snapshot.rttMillis !== null) payload.rttMillis = Math.round(snapshot.rttMillis)
  if (snapshot.jitterMillis !== null) payload.jitterMillis = Math.round(snapshot.jitterMillis)
  return payload
}

interface Sample {
  rttMillis: number
  at: number
}

export class Telemetry {
  private samples: Sample[] = []
  /** Highest ping sequence the phone has sent, and how many actually arrived.
   *  Loss is the gap between them — one stream, measured one way. */
  private firstSequence: number | null = null
  private highestSequence = 0
  private pingsReceived = 0
  private history: number[] = []
  private lastHistoryTick = Date.now()
  private currentMbps = 0
  private mbpsHistory: number[] = []
  private readonly windowMillis = 60_000

  /** RTT is *not* measured here — the phone stamps `tMicros` on its own clock,
   *  measures the round trip when the pong comes back, and reports it. */
  notePing(sequence: number, reportedRttMillis: number | null): void {
    this.pingsReceived += 1
    if (this.firstSequence === null) this.firstSequence = sequence
    this.highestSequence = Math.max(this.highestSequence, sequence)
    if (reportedRttMillis !== null && reportedRttMillis >= 0) {
      this.samples.push({ rttMillis: reportedRttMillis, at: Date.now() })
      this.prune()
      this.tickHistory(reportedRttMillis)
    }
  }

  /** Once a second from the heartbeat, which is what makes the history a
   *  per-second series rather than a series of however often somebody asked. */
  noteThroughput(mbps: number): void {
    this.currentMbps = mbps
    this.mbpsHistory.push(mbps)
    if (this.mbpsHistory.length > 60) this.mbpsHistory.splice(0, this.mbpsHistory.length - 60)
  }

  snapshot(): TelemetrySnapshot {
    this.prune()
    const values = this.samples.map((sample) => sample.rttMillis)
    const rtt = values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null

    // Jitter as mean absolute deviation between consecutive samples, which is
    // what a user perceives as "spiky" on the 02B trace.
    let jitter: number | null = null
    if (values.length >= 2) {
      let total = 0
      for (let index = 1; index < values.length; index += 1) total += Math.abs(values[index] - values[index - 1])
      jitter = total / (values.length - 1)
    }

    // Expected count is derived from the phone's own sequence numbers, so the
    // two sides of the ratio always describe the same stream.
    let loss = 0
    if (this.firstSequence !== null) {
      const expected = this.highestSequence - this.firstSequence + 1
      if (expected > 1) loss = Math.max(0, ((expected - this.pingsReceived) / expected) * 100)
    }

    return {
      rttMillis: rtt,
      jitterMillis: jitter,
      lossPercent: loss,
      downMbps: this.currentMbps,
      rttHistory: [...this.history],
      mbpsHistory: [...this.mbpsHistory],
      sampleCount: this.samples.length,
    }
  }

  /** Drives the quality ladder. Null when there is not enough data to judge,
   *  so the encoder holds its current setting rather than thrashing. */
  linkVerdict(): { rtt: number; loss: number } | null {
    const snapshot = this.snapshot()
    if (snapshot.rttMillis === null || snapshot.sampleCount < 3) return null
    return { rtt: snapshot.rttMillis, loss: snapshot.lossPercent }
  }

  reset(): void {
    this.samples = []
    this.history = []
    this.firstSequence = null
    this.highestSequence = 0
    this.pingsReceived = 0
    this.currentMbps = 0
    this.mbpsHistory = []
  }

  private prune(): void {
    const cutoff = Date.now() - this.windowMillis
    this.samples = this.samples.filter((sample) => sample.at >= cutoff)
  }

  private tickHistory(rtt: number): void {
    if (Date.now() - this.lastHistoryTick < 1000) return
    this.lastHistoryTick = Date.now()
    this.history.push(rtt)
    if (this.history.length > 60) this.history.splice(0, this.history.length - 60)
  }
}
