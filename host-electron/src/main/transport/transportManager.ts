import { Log, describeError } from '../core/log'
import type { HostPlatform } from '../platform/hostPlatform'
import {
  cloudflaredBinary,
  downloadCloudflared,
  quickTunnelHostname,
  removeStaleDownload,
  startQuickTunnel,
  stopTunnel,
  type TunnelHandle,
} from './cloudflared'
import { primaryLANAddress } from './lanAddress'
import { tailscaleBinary, tailscaleStatus } from './tailscale'

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
  /** Windows: what the active network is categorised as, when known. */
  networkProfile: string | null
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
  if (status.networkProfile) payload.networkProfile = status.networkProfile
  return payload
}

export class TransportManager {
  private cached: TransportStatus
  private lastRefresh = 0
  private refreshing: Promise<void> | null = null
  private tunnel: TunnelHandle | null = null
  private tunnelHostname: string | null = null
  private starting: Promise<void> | null = null
  /** Read fresh each refresh, so a tunnel that died is restarted only while
   *  the setting still says it should be up. */
  private relayWanted: () => boolean = () => false

  constructor(
    private readonly port: number,
    private readonly platform: HostPlatform,
  ) {
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
      networkProfile: null,
    }
  }

  bindRelaySetting(relayWanted: () => boolean): void {
    this.relayWanted = relayWanted
  }

  status(): TransportStatus {
    return { ...this.cached }
  }

  noteContact(): void {
    this.cached.lastContact = new Date()
  }

  get tailscaleInstalled(): boolean {
    return tailscaleBinary(this.platform.paths.tailscaleCandidates) !== null
  }

  /** Once per 10 s at most, driven from the heartbeat, so an idle host still
   *  has current addresses for the QR. */
  async refreshIfStale(): Promise<void> {
    if (Date.now() - this.lastRefresh < 10_000) return
    await this.refresh()
  }

  async refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing
    this.refreshing = this.doRefresh().finally(() => {
      this.refreshing = null
    })
    return this.refreshing
  }

  private async doRefresh(): Promise<void> {
    const next = { ...this.cached, port: this.port }
    const lan = primaryLANAddress()
    if (lan !== this.cached.lanAddress) Log.info('transport', `LAN address ${lan ?? 'none'}`)
    next.lanAddress = lan
    next.networkProfile = await this.platform.network.networkProfile()

    const binary = tailscaleBinary(this.platform.paths.tailscaleCandidates)
    const tailscale = binary ? await tailscaleStatus(binary) : null
    if (tailscale) {
      next.tailscaleRunning = tailscale.running
      next.tailscaleAddress = tailscale.address
      next.tailscaleDNSName = tailscale.dnsName
      next.path =
        tailscale.activePeerIsDirect === null
          ? tailscale.running
            ? 'direct'
            : 'none'
          : tailscale.activePeerIsDirect
            ? 'direct'
            : 'relay'
      next.relayName = tailscale.relay
      next.peerLatencyMillis = tailscale.latencyMillis
    } else {
      next.tailscaleRunning = false
      next.tailscaleAddress = null
      next.tailscaleDNSName = null
      next.path = next.cloudflareRunning ? 'relay' : 'none'
    }

    // A tunnel that died stays dead otherwise, and nothing says so.
    if (this.tunnel && this.tunnel.process.exitCode !== null) {
      Log.warn('transport', 'cloudflare tunnel exited; restarting')
      this.tunnel = null
      this.tunnelHostname = null
      if (this.relayWanted()) await this.startCloudflareTunnel()
    }
    next.cloudflareRunning = this.tunnel !== null && this.tunnel.process.exitCode === null
    // Asked of cloudflared rather than remembered from its output, so a tunnel
    // that reconnects under a new name is advertised under the new name.
    if (next.cloudflareRunning && this.tunnel) {
      const live = await quickTunnelHostname(this.tunnel)
      if (live && live !== this.tunnelHostname) {
        Log.info('transport', `cloudflare tunnel serving ${live}`)
        this.tunnelHostname = live
      }
    }
    if (!next.cloudflareRunning) this.tunnelHostname = null
    next.cloudflareHostname = this.tunnelHostname
    if (!tailscale) next.path = next.cloudflareRunning ? 'relay' : 'none'

    this.cached = next
    this.lastRefresh = Date.now()
  }

  // MARK: Cloudflare Tunnel

  async startCloudflareTunnel(): Promise<void> {
    if (this.tunnel) return
    if (this.starting) return this.starting
    this.starting = (async () => {
      let binary = cloudflaredBinary(this.platform.paths.cloudflaredCandidates)
      if (!binary) {
        const destination = this.platform.paths.cloudflaredDownload
        if (!destination) {
          Log.warn('transport', 'cloudflared not installed; relay unavailable')
          return
        }
        try {
          removeStaleDownload(destination)
          await downloadCloudflared(destination)
          binary = destination
        } catch (error) {
          Log.error('transport', `relay unavailable: ${describeError(error)}`)
          return
        }
      }
      try {
        this.tunnel = await startQuickTunnel(binary, this.port, this.port + 2, (hostname) => {
          if (hostname === this.tunnelHostname) return
          this.tunnelHostname = hostname
          this.cached.cloudflareHostname = hostname
          this.cached.cloudflareRunning = true
          Log.info('transport', `cloudflare tunnel live at ${hostname}`)
        })
      } catch (error) {
        Log.error('transport', `failed to start cloudflared: ${describeError(error)}`)
      }
    })().finally(() => {
      this.starting = null
    })
    return this.starting
  }

  async stopCloudflareTunnel(): Promise<void> {
    if (!this.tunnel) return
    stopTunnel(this.tunnel)
    this.tunnel = null
    this.tunnelHostname = null
    this.cached.cloudflareRunning = false
    this.cached.cloudflareHostname = null
    Log.info('transport', 'cloudflare tunnel stopped')
  }

  /** Synchronously, on the way out: a quit that awaited would leave the
   *  tunnel alive with a public hostname pointing at a port nobody serves. */
  terminateTunnelNow(): void {
    stopTunnel(this.tunnel)
    this.tunnel = null
  }
}
