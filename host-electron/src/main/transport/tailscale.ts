import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

/** What `tailscale status --json` says about this machine and the phone. */
export interface TailscaleInfo {
  running: boolean
  address: string | null
  dnsName: string | null
  relay: string | null
  latencyMillis: number | null
  /** null when no peer is actively connected. */
  activePeerIsDirect: boolean | null
}

export function tailscaleBinary(candidates: string[]): string | null {
  return candidates.find((path) => existsSync(path)) ?? null
}

/** Forks the CLI with a 3 s watchdog; a hung `tailscale status` must not
 *  wedge the status poller. Null when Tailscale is absent or silent. */
export function tailscaleStatus(binary: string): Promise<TailscaleInfo | null> {
  return new Promise((resolve) => {
    execFile(binary, ['status', '--json'], { timeout: 3000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error || !stdout) {
        resolve(null)
        return
      }
      try {
        resolve(parse(JSON.parse(stdout)))
      } catch {
        resolve(null)
      }
    })
  })
}

type Json = Record<string, unknown>

function parse(root: Json): TailscaleInfo {
  const running = root.BackendState === 'Running'
  const info: TailscaleInfo = { running, address: null, dnsName: null, relay: null, latencyMillis: null, activePeerIsDirect: null }

  const self = root.Self as Json | undefined
  if (self) {
    const ips = self.TailscaleIPs
    if (Array.isArray(ips) && typeof ips[0] === 'string') info.address = ips[0]
    // DNSName arrives fully qualified with a trailing dot.
    if (typeof self.DNSName === 'string') info.dnsName = self.DNSName.replace(/\.+$/, '') || null
  }

  // The most recently active peer is the phone, when it is connected, and it
  // carries the direct-vs-relay answer.
  const peers = root.Peer as Record<string, Json> | undefined
  if (peers) {
    let best: { active: boolean; lastSeen: number; peer: Json } | null = null
    for (const peer of Object.values(peers)) {
      const active = peer.Active === true
      const lastSeen = typeof peer.LastSeen === 'string' ? Date.parse(peer.LastSeen) || 0 : 0
      if (!best || (active && !best.active) || (active === best.active && lastSeen > best.lastSeen)) {
        best = { active, lastSeen, peer }
      }
    }
    if (best?.active) {
      // CurAddr is populated only on a direct connection. When it is empty and
      // Relay names a DERP region, traffic is relayed.
      const currentAddress = typeof best.peer.CurAddr === 'string' ? best.peer.CurAddr : ''
      const relay = typeof best.peer.Relay === 'string' ? best.peer.Relay : ''
      info.activePeerIsDirect = currentAddress !== ''
      info.relay = relay || null
    }
  }
  return info
}
