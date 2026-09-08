import { wallClock } from './clock'

/**
 * Single logging surface for the host: stderr when something is watching it,
 * and always the in-memory ring the dashboard's Log pane reads.
 *
 * The area is the one taxonomy. Six names, and the dashboard filters on exactly
 * these — inventing a second set for the pane would mean deciding, per line,
 * which of two names it goes under.
 */
export type Area = 'net' | 'capture' | 'input' | 'claude' | 'transport' | 'app'
export type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR'

export interface LogEntry {
  seq: number
  at: Date
  level: Level
  area: Area
  text: string
}

/**
 * The last few hundred things this host said about itself, kept in memory.
 * Nothing is written to disk and nothing survives a restart; the pane says so
 * out loud rather than reading like a host that has done nothing for six days.
 */
class EventLog {
  private readonly capacity = 600
  private entries: LogEntry[] = []
  private nextSequence = 1
  /** Counted rather than derived from `entries`, which is trimmed. */
  private droppedCount = 0

  record(level: Level, area: Area, text: string): void {
    this.entries.push({ seq: this.nextSequence, at: new Date(), level, area, text })
    this.nextSequence += 1
    if (this.entries.length > this.capacity) {
      const excess = this.entries.length - this.capacity
      this.entries.splice(0, excess)
      this.droppedCount += excess
    }
  }

  /** Newest first, filtered by area before the limit is applied. */
  recent(area: Area | null = null, limit = 200): LogEntry[] {
    const matching = area ? this.entries.filter((entry) => entry.area === area) : this.entries
    return matching.slice(-limit).reverse()
  }

  get dropped(): number {
    return this.droppedCount
  }
}

export const eventLog = new EventLog()

let verbose = process.env.VIBEWIRE_VERBOSE === '1'
let mirrorToStderr = Boolean(process.stderr.isTTY) || verbose

function emit(level: Level, area: Area, text: string): void {
  eventLog.record(level, area, text)
  if (!mirrorToStderr) return
  process.stderr.write(`${wallClock()} ${level.padEnd(5)} [${area}] ${text}\n`)
}

export const Log = {
  info(area: Area, text: string): void {
    emit('INFO', area, text)
  },
  warn(area: Area, text: string): void {
    emit('WARN', area, text)
  },
  error(area: Area, text: string): void {
    emit('ERROR', area, text)
  },
  debug(area: Area, text: string): void {
    if (!verbose) return
    emit('DEBUG', area, text)
  },
  setVerbose(on: boolean): void {
    verbose = on
    mirrorToStderr = Boolean(process.stderr.isTTY) || on
  },
  get verbose(): boolean {
    return verbose
  },
}

/** `Error` or anything else thrown, as one line. */
export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}
