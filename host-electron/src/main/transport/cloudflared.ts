import { spawn, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { dirname } from 'node:path'
import { Log, describeError } from '../core/log'

/**
 * A Cloudflare quick tunnel: `cloudflared tunnel --url http://127.0.0.1:<port>`
 * gives this host an `https://<random>.trycloudflare.com` origin with no
 * account and no configuration. Started only when "Relay over internet" is on,
 * because it does create a publicly reachable endpoint; the device handshake
 * is what defends it.
 */

/** The one build this host will fetch when nothing is installed, and the hash
 *  it must have. Updating means bumping both, on purpose. */
export const PINNED_CLOUDFLARED = {
  version: '2026.8.3',
  windowsAmd64: {
    url: 'https://github.com/cloudflare/cloudflared/releases/download/2026.8.3/cloudflared-windows-amd64.exe',
    sha256: '83e726ed18ea78c5ad5213c4c3a3a27051393950d2bc8ed4de69bec12d14eaae',
  },
}

export function cloudflaredBinary(candidates: string[]): string | null {
  return candidates.find((path) => existsSync(path)) ?? null
}

/** Downloads the pinned Windows build to `destination`, refusing anything
 *  whose hash is not the pinned one. */
export async function downloadCloudflared(destination: string): Promise<void> {
  const { url, sha256 } = PINNED_CLOUDFLARED.windowsAmd64
  Log.info('transport', `fetching cloudflared ${PINNED_CLOUDFLARED.version}`)
  const response = await fetch(url, { redirect: 'follow' })
  if (!response.ok) throw new Error(`download failed: ${response.status}`)
  const bytes = Buffer.from(await response.arrayBuffer())
  const digest = createHash('sha256').update(bytes).digest('hex')
  if (digest !== sha256) throw new Error(`cloudflared download failed verification (sha256 ${digest})`)
  mkdirSync(dirname(destination), { recursive: true })
  const temp = `${destination}.download`
  writeFileSync(temp, bytes)
  try {
    chmodSync(temp, 0o755)
  } catch {
    // Windows has no mode bits worth setting
  }
  renameSync(temp, destination)
  Log.info('transport', `cloudflared ${PINNED_CLOUDFLARED.version} installed at ${destination}`)
}

export interface TunnelHandle {
  process: ChildProcess
  /** True when this host pinned cloudflared's metrics port, so `/quicktunnel`
   *  on it is authoritative for the hostname. */
  metricsOwned: boolean
  metricsPort: number
}

/** True when nothing holds `port` on loopback right now. Asked by binding it,
 *  because that is the only answer that is not a guess. */
export function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.listen({ host: '127.0.0.1', port }, () => probe.close(() => resolve(true)))
  })
}

export async function startQuickTunnel(
  binary: string,
  originPort: number,
  metricsPort: number,
  onHostname: (hostname: string) => void,
): Promise<TunnelHandle> {
  // Whoever is already on that port is not ours, and the hostname it would
  // report is not ours either — an orphan from a host that was killed rather
  // than quit. Then the startup banner is the only source.
  const metricsOwned = await portIsFree(metricsPort)
  if (!metricsOwned) {
    Log.warn(
      'transport',
      `metrics port ${metricsPort} is taken — probably an orphaned cloudflared; reading the tunnel hostname from its output instead`,
    )
  }
  const args = ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${originPort}`]
  if (metricsOwned) args.push('--metrics', `127.0.0.1:${metricsPort}`)

  const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const scan = (chunk: Buffer) => {
    // cloudflared announces the hostname in a banner line.
    const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(chunk.toString('utf8'))
    if (match) onHostname(match[0])
  }
  child.stdout?.on('data', scan)
  child.stderr?.on('data', scan)
  child.on('error', (error) => Log.error('transport', `cloudflared failed: ${describeError(error)}`))
  Log.info('transport', 'cloudflare tunnel starting')
  return { process: child, metricsOwned, metricsPort }
}

/** The hostname cloudflared says it is serving, from its metrics server. */
export async function quickTunnelHostname(handle: TunnelHandle): Promise<string | null> {
  if (!handle.metricsOwned) return null
  try {
    const response = await fetch(`http://127.0.0.1:${handle.metricsPort}/quicktunnel`, { signal: AbortSignal.timeout(2000) })
    if (!response.ok) return null
    const body = (await response.json()) as { hostname?: unknown }
    const hostname = typeof body.hostname === 'string' ? body.hostname : ''
    if (!hostname) return null
    return hostname.includes('://') ? hostname : `https://${hostname}`
  } catch {
    return null
  }
}

export function stopTunnel(handle: TunnelHandle | null): void {
  if (!handle) return
  if (handle.process.exitCode === null) {
    try {
      handle.process.kill()
    } catch {
      // gone already
    }
  }
}

export function removeStaleDownload(path: string): void {
  try {
    if (existsSync(`${path}.download`)) unlinkSync(`${path}.download`)
  } catch {
    // best effort
  }
}
