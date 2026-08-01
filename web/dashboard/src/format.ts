/**
 * Turning measured values into the strings the instrument prints.
 *
 * One rule runs through all of it: a value nobody measured prints as an em dash,
 * never as a zero. `0 MS` is a claim about a round trip; `—` is the absence of
 * one, and the difference is the whole of PRODUCT.md's first principle.
 */

export const DASH = '—'

/** `undefined`/`null` become the dash; everything else goes through `format`. */
export function measured<T>(value: T | null | undefined, format: (value: T) => string): string {
  return value === null || value === undefined ? DASH : format(value)
}

/** `6D 04H`, `04H 12M`, `12M 30S`. The two largest units that are non-zero. */
export function duration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds))
  const days = Math.floor(total / 86400)
  const hours = Math.floor((total % 86400) / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const rest = total % 60
  if (days > 0) return `${days}D ${String(hours).padStart(2, '0')}H`
  if (hours > 0) return `${hours}H ${String(minutes).padStart(2, '0')}M`
  if (minutes > 0) return `${minutes}M ${String(rest).padStart(2, '0')}S`
  return `${rest}S`
}

/** `2H AGO`, `4 DAYS AGO`, `JUST NOW`. Coarse on purpose — this is a last-seen. */
export function ago(iso: string | undefined, now: number = Date.now()): string {
  if (!iso) return DASH
  const then = Date.parse(iso)
  if (Number.isNaN(then)) return DASH
  const seconds = Math.max(0, Math.round((now - then) / 1000))
  if (seconds < 10) return 'JUST NOW'
  if (seconds < 60) return `${seconds}S AGO`
  if (seconds < 3600) return `${Math.floor(seconds / 60)}M AGO`
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}H AGO`
  const days = Math.floor(seconds / 86400)
  return `${days} ${days === 1 ? 'DAY' : 'DAYS'} AGO`
}

/** `14:02:11` in the reader's own zone, matching the host's log stamps. */
export function clockTime(iso: string | undefined): string {
  if (!iso) return DASH
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return DASH
  return date.toLocaleTimeString([], { hour12: false })
}

/**
 * `1.2 GB`, `214 MB`, `50 KB`.
 *
 * Decimal rather than binary, because these are transfer figures and every other
 * number beside them — MB/s, the cellular ceiling — is decimal too.
 */
export function bytes(count: number): string {
  if (count < 1000) return `${count} B`
  if (count < 1_000_000) return `${Math.round(count / 1000)} KB`
  if (count < 1_000_000_000) return `${(count / 1_000_000).toFixed(count < 10_000_000 ? 1 : 0)} MB`
  return `${(count / 1_000_000_000).toFixed(1)} GB`
}

/** `3456 × 2234`, with the multiplication sign rather than a letter x. */
export function resolution(width: number, height: number): string {
  return `${width} × ${height}`
}

/** A key or id, short enough to compare by eye but long enough to be one. */
export function fingerprint(value: string): string {
  if (!value) return DASH
  if (value.length <= 9) return value
  return `${value.slice(0, 4)}…${value.slice(-4)}`
}

/**
 * Bars for a series, scaled against a floor so a quiet link does not draw a
 * full-height trace of noise.
 *
 * The last sample is the one at full opacity: this is a trace with a now in it,
 * not a histogram.
 */
export function bars(
  series: number[],
  floor: number,
  height: number,
): { h: number; now: boolean }[] {
  if (series.length === 0) return []
  const top = Math.max(floor, ...series)
  return series.map((value, index) => ({
    h: Math.max(2, Math.round((value / top) * height)),
    now: index === series.length - 1,
  }))
}

/** The ladder step a setting names, or what the encoder actually settled on. */
export function ladderLabel(setting: string, actual: string | undefined): string {
  if (setting === 'auto') return actual ? `AUTO → ${actual}P` : 'AUTO'
  return `${setting}P`
}
