import { Log } from '../core/log'
import { primaryLANAddress } from './lanAddress'

/**
 * Knows how the phone is reaching this host, and keeps the fallback path
 * alive. Tailscale is primary, the Cloudflare tunnel secondary, and the LAN
 * address is what a phone on the same Wi-Fi dials with nothing installed.
 *
 * The real value here is honesty: 02D lists each transport with its own
 * verdict rather than one vague "offline", and this is where those come from.
 */
export type TransportPath = 'direct' | 'relay' | 'none'

export interface TransportStatus {
  tailscaleRunning: boolean
  tailscaleAddress: string | null
  tailscaleDNSName: string | null
  path: TransportPath
  relayName: string | null
  peerLatencyMillis: number | null
  cloudflareRunning: boolean
  cloudflareHostname: string | null
  lanAddress: string | null
  lastContact: Date | null
  /** So a client can build an origin out of the addresses without being told separately. */
  port: number
}

function trimSlash(origin: string): string {
  return origin.endsWith('/') ? origin.slice(0, -1) : origin
}

/**
 * Every origin this host can be reached on, in the order a phone should try
 * them: the tailnet (direct where possible, DERP otherwise), the LAN (fastest
 * at home, dead elsewhere), then the tunnel (a round trip through Cloudflare,
 * but the one that answers from a phone with no Tailscale and no Wi-Fi).
 */
export function candidates(status: TransportStatus): string[] {
  const origins: string[] = []
  if (status.tailscaleAddress) origins.push(`http://${status.tailscaleAddress}:${status.port}`)
  if (status.lanAddress) origins.push(`http://${status.lanAddress}:${status.port}`)
  if (status.cloudflareRunning && status.cloudflareHostname) origins.push(trimSlash(status.cloudflareHostname))
  return origins
}

/**
 * The address to hand out when only one can be given. The tunnel wins here
 * even though it is last in `candidates`: a client that holds a list should
 * prefer the fast path and fall back, while a client that gets one address
 * should get the one that works from anywhere — and a browser opened from an
 * `https` page cannot open an `http` address at all.
 */
export function preferredOrigin(status: TransportStatus): string | null {
  if (status.cloudflareRunning && status.cloudflareHostname) return trimSlash(status.cloudflareHostname)
  return candidates(status)[0] ?? null
}

export function transportWire(status: TransportStatus): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    t: 'transport',
    path: status.path,
    tailscaleRunning: status.tailscaleRunning,
    cloudflareRunning: status.cloudflareRunning,
    port: status.port,
    candidates: candidates(status),
  }
  if (status.tailscaleAddress) payload.tailscaleAddress = status.tailscaleAddress
  if (status.tailscaleDNSName) payload.tailscaleDNSName = status.tailscaleDNSName
  if (status.relayName) payload.relayName = status.relayName
  if (status.peerLatencyMillis !== null) payload.peerLatencyMillis = Math.round(status.peerLatencyMillis * 10) / 10
  if (status.cloudflareHostname) payload.cloudflareHostname = status.cloudflareHostname
  if (status.lanAddress) payload.lanAddress = status.lanAddress
  if (status.lastContact) payload.lastContact = status.lastContact.toISOString()
  return payload
}

export class TransportManager {
  private cached: TransportStatus
  private lastRefresh = 0
  private refreshing: Promise<void> | null = null

  constructor(port: number) {
    this.cached = {
      tailscaleRunning: false,
      tailscaleAddress: null,
      tailscaleDNSName: null,
      path: 'none',
      relayName: null,
      peerLatencyMillis: null,
      cloudflareRunning: false,
      cloudflareHostname: null,
      lanAddress: null,
      lastContact: null,
      port,
    }
  }

  status(): TransportStatus {
    return { ...this.cached }
  }

  noteContact(): void {
    this.cached.lastContact = new Date()
  }

  /** Once per 10 s at most, driven from the heartbeat, so an idle host still
   *  has current addresses for the QR. */
  async refreshIfStale(): Promise<void> {
    if (Date.now() - this.lastRefresh < 10_000) return
    await this.refresh()
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing
    this.refreshing = (async () => {
      const lan = primaryLANAddress()
      if (lan !== this.cached.lanAddress) Log.info('transport', `LAN address ${lan ?? 'none'}`)
      this.cached.lanAddress = lan
      this.cached.path = this.cached.tailscaleRunning ? 'direct' : this.cached.cloudflareRunning ? 'relay' : 'none'
      this.lastRefresh = Date.now()
    })().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  async startCloudflareTunnel(): Promise<void> {
    Log.warn('transport', 'relay requested, but the tunnel is not part of this host yet')
  }

  async stopCloudflareTunnel(): Promise<void> {}

  terminateTunnelNow(): void {}
}
