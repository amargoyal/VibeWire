/** Monotonic microseconds, for RTT and presentation stamps: a wall-clock
 *  adjustment mid-session must not make latency read negative. */
export function monotonicMicros(): number {
  return Math.round(performance.now() * 1000)
}

/** `HH:mm:ss.SSS`, for log lines. */
export function wallClock(date: Date = new Date()): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}
