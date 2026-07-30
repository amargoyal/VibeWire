/**
 * Watches what this browser is actually connected over. Ported from
 * ios/VibeWire/Net/LinkMonitor.swift.
 *
 * The Mac cannot see this machine's radio, so "Cap on cellular" is only honest if
 * the client says which one it is on. Without it the cap throttles LAN sessions
 * too, which is the opposite of what the setting promises.
 *
 * `NWPathMonitor` gave the phone a definite answer. The Network Information API
 * gives a partial one: Chromium exposes `effectiveType` everywhere and `type`
 * only on Android, Safari and Firefox expose nothing at all. So where the phone
 * reported two booleans it had measured, this reports what it can and says
 * `UNKNOWN LINK` when it cannot — never "WI-FI", which would be a claim about a
 * radio nothing here can see, and the cellular cap would then be silently wrong
 * in the one direction that costs money.
 */

interface NetworkInformation extends EventTarget {
  readonly type?: string
  readonly effectiveType?: string
  readonly saveData?: boolean
}

function connection(): NetworkInformation | null {
  const candidate = (
    navigator as Navigator & {
      connection?: NetworkInformation
      mozConnection?: NetworkInformation
      webkitConnection?: NetworkInformation
    }
  )
  return candidate.connection ?? candidate.mozConnection ?? candidate.webkitConnection ?? null
}

export class LinkMonitor {
  isExpensive = false
  isConstrained = false
  /** False when the browser exposes no network information at all. */
  measured = false

  onChange: ((expensive: boolean, constrained: boolean) => void) | null = null

  private started = false
  private hasReported = false
  private listener: (() => void) | null = null

  start(): void {
    if (this.started) return
    this.started = true

    const info = connection()
    if (!info) {
      // Nothing to watch. Report once anyway so the host learns the state rather
      // than holding a default it was never told about.
      this.publish()
      return
    }

    this.listener = () => this.publish()
    info.addEventListener('change', this.listener)
    this.publish()
  }

  stop(): void {
    const info = connection()
    if (info && this.listener) info.removeEventListener('change', this.listener)
    this.listener = null
    this.started = false
  }

  private publish(): void {
    const info = connection()
    const expensive = info?.type === 'cellular'
    // Data Saver is the browser's own "this link is precious", which is the same
    // thing Low Data Mode says on the phone.
    const constrained = info?.saveData === true || info?.effectiveType === '2g'

    const changed = expensive !== this.isExpensive || constrained !== this.isConstrained
    this.isExpensive = expensive
    this.isConstrained = constrained
    this.measured = info != null

    if (changed || !this.hasReported) {
      this.hasReported = true
      this.onChange?.(expensive, constrained)
    }
  }

  /** Shown on the home screen so the transport line is specific rather than a
   *  vague "connected". */
  get description(): string {
    if (this.isExpensive) return 'CELLULAR'
    if (this.isConstrained) return 'LOW DATA'
    const info = connection()
    if (info?.type === 'wifi' || info?.type === 'ethernet') {
      return info.type === 'ethernet' ? 'ETHERNET' : 'WI-FI'
    }
    return 'UNKNOWN LINK'
  }
}
