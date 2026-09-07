import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import QRCode from 'qrcode'
import { PAIR_CODE_LIFETIME_S, MAX_PAIR_ATTEMPTS } from '../../../../shared/protocol'
import type { HostRouter } from '../app/hostRouter'
import type { CaptureHost } from '../capture/captureHost'
import { Config } from '../core/config'
import { eventLog, Log, describeError } from '../core/log'
import { PairingService, progressWire } from '../pairing/pairingService'
import { TrustStore, type TrustedDevice } from '../pairing/trustStore'
import type { HostPlatform } from '../platform/hostPlatform'
import type { SystemServices } from '../system/systemServices'
import { Telemetry } from '../system/telemetry'
import { candidates, preferredOrigin, TransportManager, transportWire, type TransportStatus } from '../transport/transportManager'
import { header, Response, type HTTPRequest, type HTTPResponse } from './request'
import { WebAssets } from './webAssets'
import type { ClaudeInbound, SettingValue } from './wireProtocol'

/**
 * The host's own window onto itself: `/dashboard/<key>` and `/v1/dashboard/…`.
 *
 * This is the whole control surface of the host — pairing, revoking, capture,
 * settings, the log — so the first thing it does with any request is check the
 * launch key, and the second is refuse everything else. The port is reachable
 * over the tailnet by design and the host speaks plain HTTP by design, so
 * "only this machine can reach it" is not a claim this file is allowed to make.
 *
 * Polled rather than socketed: the heartbeat that produces these readings runs
 * at 1 Hz, and the one thing that genuinely streams — Claude — arrives through
 * `events`, a cursor over the same messages the phone's socket receives.
 */
export class DashboardService {
  private readonly assets: WebAssets | null
  private webBundleBytes: number | null = null
  private dashboardBundleBytes: number | null = null
  /** Three states: never asked, asked and refused, asked and answered. */
  private lastDevices: { ok: true; devices: TrustedDevice[] } | { ok: false } | null = null
  private devicesRefresh: Promise<void> | null = null
  private hostIdCache: string | null = null
  private readonly launchedAt = Date.now()

  constructor(
    private readonly router: HostRouter,
    private readonly trust: TrustStore,
    private readonly pairing: PairingService,
    private readonly capture: CaptureHost,
    private readonly transport: TransportManager,
    private readonly telemetry: Telemetry,
    private readonly system: SystemServices,
    private readonly platform: HostPlatform,
  ) {
    this.assets = WebAssets.open(Config.dashboardRoot)
    if (this.assets) Log.info('app', `serving dashboard from ${this.assets.root}`)
  }

  // MARK: Routing

  /** The response for anything the dashboard owns, or null to let the request
   *  fall through to the web client. */
  async response(request: HTTPRequest): Promise<HTTPResponse | null> {
    if (request.path.startsWith('/v1/dashboard/')) {
      if (!this.authorised(request)) return Response.error(401, 'unauthorized')
      return this.api(request)
    }
    if (request.path === '/dashboard' || request.path.startsWith('/dashboard/')) return this.bundle(request)
    return null
  }

  /** Constant-time, because the key is a secret compared on every request. */
  private authorised(request: HTTPRequest): boolean {
    const presented = header(request, 'x-vibewire-dashboard') ?? request.query.k
    if (!presented) return false
    const a = Buffer.from(presented, 'utf8')
    const b = Buffer.from(Config.dashboardKey, 'utf8')
    return a.length === b.length && timingSafeEqual(a, b)
  }

  // MARK: The bundle

  /** A wrong key gets 404 rather than 403: 403 would confirm the path exists. */
  private bundle(request: HTTPRequest): HTTPResponse {
    if (request.method !== 'GET') return Response.error(404, 'not_found')
    const prefix = `/dashboard/${Config.dashboardKey}`
    if (request.path !== prefix && !request.path.startsWith(prefix + '/')) return Response.error(404, 'not_found')
    // The trailing slash is load-bearing: the bundle's asset references are
    // relative, and at `/dashboard/<key>` they would resolve a directory up
    // and lose the key.
    if (request.path === prefix) return Response.empty(308, { Location: prefix + '/' })
    if (!this.assets) {
      return { status: 503, headers: { 'Content-Type': 'text/html; charset=utf-8' }, body: Buffer.from(NO_BUNDLE_PAGE, 'utf8') }
    }
    let remainder = request.path.slice(prefix.length)
    if (!remainder) remainder = '/'
    return this.assets.response(remainder) ?? Response.error(404, 'not_found')
  }

  // MARK: The API

  private async api(request: HTTPRequest): Promise<HTTPResponse> {
    const { method, path } = request
    if (method === 'GET' && path === '/v1/dashboard/state') return Response.json(200, await this.state())
    if (method === 'GET' && path === '/v1/dashboard/events') {
      const since = Number(request.query.since) || 0
      const drained = this.router.drainEvents(since)
      return Response.json(200, { next: drained.next, dropped: drained.dropped, messages: drained.messages })
    }
    if (method === 'GET' && path === '/v1/dashboard/snapshot') return this.snapshot(request)
    if (method === 'GET' && path === '/v1/dashboard/qr') return this.qr(request)
    if (method === 'POST' && path === '/v1/dashboard/command') return this.command(request)
    return Response.error(404, 'not_found')
  }

  // MARK: State

  private async state(): Promise<Record<string, unknown>> {
    const settings = this.router.currentSettings
    const displays = await this.capture.displays()
    const status = this.transport.status()
    const link = this.telemetry.snapshot()
    const progress = this.pairing.currentProgress()
    const code = this.pairing.currentCode()
    const streams = this.capture.streams()
    const attached = this.router.attached
    const selected = this.router.displaysSelected

    this.refreshTrustInBackground()
    let devices = this.lastDevices?.ok ? this.lastDevices.devices : null
    // A device that has just paired is in the store but not yet in this cache:
    // pairing arrives on `/v1/pair`, not through a dashboard command.
    if (progress.deviceId && devices && !devices.some((device) => device.id === progress.deviceId)) {
      await this.refreshTrustNow()
      devices = this.lastDevices?.ok ? this.lastDevices.devices : null
    }
    const connected = this.router.server?.connectedDeviceIds ?? new Set<string>()
    const power = this.system.powerState()
    const conditions = this.platform.conditions()

    const streamsByDisplay = new Map(streams.map((stream) => [stream.displayId, stream]))
    const now = new Date().toISOString()
    const payload: Record<string, unknown> = { t: 'dashboardState', at: now }

    payload.host = {
      name: this.platform.machine.hostName(),
      model: this.router.hostModel,
      os: this.platform.machine.osVersion(),
      osBuild: this.platform.machine.osBuild() ?? '',
      platform: this.platform.name,
      version: Config.hostVersion,
      protocol: Config.protocolVersion,
      uptimeSeconds: Math.floor((Date.now() - this.launchedAt) / 1000),
      hostKey: this.hostIdCache ?? '',
      port: settings.port,
      pathWord: pathWord(status),
      awake: power.isAwake,
      onPower: power.isOnPower,
      frontmostApp: this.system.frontmostApplication().name,
      webBundle: this.webBundle(),
      dashboardBundle: this.dashboardBundle(),
    }

    // No TCC on Windows: both are true by construction, and what can actually
    // stop capture or input rides in `conditions` instead.
    payload.permissions = {
      screenRecording: !conditions.screenRecordingDenied,
      accessibility: this.router.inputAvailable,
      checkedAt: now,
    }
    payload.conditions = conditions

    const linkPayload: Record<string, unknown> = {
      attached: attached !== null,
      rttHistory: link.rttHistory.map((value) => Math.round(value)),
      samples: link.sampleCount,
      outMbps: Math.round(link.downMbps * 10) / 10,
      onExpensiveLink: this.router.expensiveLink,
    }
    if (link.rttMillis !== null) linkPayload.rtt = Math.round(link.rttMillis)
    if (link.jitterMillis !== null) linkPayload.jitter = Math.round(link.jitterMillis)
    // Loss is only a number once enough pings have arrived to divide by.
    if (link.sampleCount >= 2) linkPayload.loss = Math.round(link.lossPercent * 10) / 10
    if (attached) linkPayload.stalledSeconds = Math.floor(attached.secondsSincePong)
    payload.link = linkPayload

    const encoder: Record<string, unknown> = {
      capturing: streams.length > 0,
      rateHistory: link.mbpsHistory.map((value) => Math.round(value * 10) / 10),
      ladderSetting: settings.quality,
      dropped: attached?.traffic.framesDropped ?? 0,
      sentBytes: attached?.traffic.bytesSent ?? 0,
    }
    const first = streams[0]
    if (first) {
      encoder.ladder = String(first.ladder)
      encoder.fps = first.fps
      encoder.bitrate = first.bitrate
      encoder.gop = first.fps * 2
      encoder.keyframeSeconds = 2
      encoder.framesEncoded = streams.reduce((sum, stream) => sum + stream.framesEncoded, 0)
      encoder.mbps = Math.round(streams.reduce((sum, stream) => sum + stream.measuredMbps, 0) * 10) / 10
      encoder.hardware = streams.every((stream) => stream.hardware)
    }
    payload.encoder = encoder

    payload.displays = displays.map((display) => {
      const entry: Record<string, unknown> = { ...display, selected: selected.includes(display.id) }
      const stream = streamsByDisplay.get(display.id)
      if (stream) {
        entry.stream = {
          streamId: stream.streamId,
          sentWidth: stream.width,
          sentHeight: stream.height,
          fps: stream.fps,
          ladder: String(stream.ladder),
          mbps: Math.round(stream.measuredMbps * 10) / 10,
          frames: stream.framesEncoded,
          gop: stream.fps * 2,
        }
      }
      return entry
    })
    payload.sideBySide = selected.length > 1

    payload.devices = (devices ?? []).map((device) => {
      const isAttached = device.id === attached?.deviceId
      const entry: Record<string, unknown> = {
        id: device.id,
        name: device.name,
        kind: device.kind,
        pairedAt: device.pairedAt.toISOString(),
        connected: connected.has(device.id),
        attached: isAttached,
        keyFingerprint: fingerprint(device.publicKey),
      }
      if (device.lastSeenAt) entry.lastSeenAt = device.lastSeenAt.toISOString()
      // Session figures belong to the socket, and there is one.
      if (isAttached && attached) {
        entry.session = {
          since: attached.openedAt.toISOString(),
          bytesSent: attached.traffic.bytesSent,
          framesDropped: attached.traffic.framesDropped,
          watching: streams.map((stream) => stream.streamId),
        }
      }
      return entry
    })
    payload.devicesReadable = this.lastDevices === null ? 'asking' : this.lastDevices.ok ? 'yes' : 'no'

    payload.transport = transportWire(status)
    payload.addresses = addresses(status, settings.port)

    const pairingPayload: Record<string, unknown> = {
      open: code !== null,
      rotateSeconds: PAIR_CODE_LIFETIME_S,
      reusable: this.pairing.isReusable,
      maxAttempts: MAX_PAIR_ATTEMPTS,
      ...progressWire(progress),
    }
    if (code) {
      pairingPayload.code = code.value
      pairingPayload.secondsRemaining = this.pairing.secondsRemaining(code)
    }
    const lockout = this.pairing.lockoutRemaining
    if (lockout !== null) pairingPayload.lockoutSeconds = lockout
    if (this.pairing.pendingName) pairingPayload.name = this.pairing.pendingName
    payload.pairing = pairingPayload

    payload.settings = {
      quality: settings.quality,
      capOnCellular: settings.capOnCellular,
      cellularCeilingMbps: settings.cellularCeilingMbps,
      sensitivity: settings.sensitivity,
      naturalScrolling: settings.naturalScrolling,
      requireBiometricEachSession: settings.requireBiometricEachSession,
      relayOverInternet: settings.relayOverInternet,
      targetFps: settings.targetFps,
      port: settings.port,
      webClientURL: settings.webClientURL ?? '',
    }

    payload.log = {
      entries: eventLog.recent(null, 240).map((entry) => ({
        seq: entry.seq,
        at: wallClock(entry.at),
        level: entry.level,
        area: entry.area,
        text: entry.text,
      })),
      dropped: eventLog.dropped,
      areas: ['net', 'capture', 'input', 'claude', 'transport', 'app'],
    }
    return payload
  }

  /** Asks the trust store for a fresh answer, at most one ask at a time. */
  private refreshTrustInBackground(): void {
    if (!this.devicesRefresh) {
      this.devicesRefresh = this.refreshTrustNow().finally(() => {
        this.devicesRefresh = null
      })
    }
    if (this.hostIdCache === null) {
      void this.trust.hostId().then(
        (id) => {
          this.hostIdCache = id
        },
        () => {},
      )
    }
  }

  private async refreshTrustNow(): Promise<void> {
    try {
      this.lastDevices = { ok: true, devices: await this.trust.all() }
    } catch {
      this.lastDevices = { ok: false }
    }
  }

  private webBundle(): Record<string, unknown> {
    if (this.webBundleBytes === null) this.webBundleBytes = directorySize(Config.webRoot)
    return { present: Config.webRoot !== null, bytes: this.webBundleBytes }
  }

  private dashboardBundle(): Record<string, unknown> {
    if (this.dashboardBundleBytes === null) this.dashboardBundleBytes = directorySize(Config.dashboardRoot)
    return { present: Config.dashboardRoot !== null, bytes: this.dashboardBundleBytes }
  }

  // MARK: Snapshot

  /** One frame of a display, as a PNG, for the Overview hero. A screenshot,
   *  not the stream, and the pane labels it as one. */
  private async snapshot(request: HTTPRequest): Promise<HTTPResponse> {
    const displayId = Number(request.query.display) || null
    const width = Math.min(1600, Math.max(160, Number(request.query.width) || 900))
    const png = await this.system.screenshot(displayId, width)
    if (!png) return Response.error(503, 'capture_failed')
    return { status: 200, headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' }, body: png }
  }

  // MARK: QR

  /** The two ways in, as images. */
  private async qr(request: HTTPRequest): Promise<HTTPResponse> {
    const code = this.pairing.currentCode()
    if (!code) return Response.error(409, 'not_pairing')
    // Someone standing at the host with a phone in their hand is the moment
    // the address has to be right.
    await this.transport.refresh()
    const status = this.transport.status()
    const port = this.router.currentSettings.port
    const address = addresses(status, port)
    const origin = address.origin
    const host = address.host

    let payload: string
    if (request.query.kind === 'app') {
      // A custom scheme, which only the iOS app can open. Two addresses at
      // most: `host`/`port` carry the local address, `origin` is added only
      // when it is the tunnel — every address costs modules.
      const local = `http://${host}:${port}`
      const preferred = preferredOrigin(status)
      payload = `vibewire://pair?host=${host}&port=${port}&code=${code.value}`
      if (preferred && preferred !== local) payload += `&origin=${preferred}`
    } else {
      // A published client on `https` cannot open an `http` address. When
      // there is no `https` origin to give it, the QR sends the phone to the
      // copy this host serves instead, which is same-origin with the protocol.
      const published = Config.webClientURL
      const publishable = published && !(published.startsWith('https://') && !origin.startsWith('https://')) ? null : published
      if (!publishable && published) {
        Log.info('net', `browser QR points at this host: ${origin} is not https, and the published client is`)
      }
      if (publishable) {
        let built: URL
        try {
          built = new URL(publishable.replace(/\/$/, ''))
        } catch {
          return Response.error(422, 'web_client_url_not_a_url')
        }
        built.search = ''
        built.searchParams.set('host', origin)
        built.searchParams.set('code', code.value)
        payload = built.toString()
      } else {
        if (Config.webRoot === null) return Response.error(409, 'no_web_bundle')
        // Only the code: the page comes from this host, so it reads the
        // address off its own origin and the QR stays small.
        payload = `${origin}/?code=${code.value}`
      }
    }

    let png: Buffer
    try {
      // L, not M: this code is drawn on a screen a foot from the camera, and
      // error correction costs modules, the one thing it cannot spare once a
      // tunnel hostname is in the payload.
      png = await QRCode.toBuffer(payload, { errorCorrectionLevel: 'L', scale: 10, margin: 2 })
    } catch (error) {
      Log.error('net', `qr failed: ${describeError(error)}`)
      return Response.error(500, 'qr_failed')
    }
    return {
      status: 200,
      headers: { 'Content-Type': 'image/png', 'Cache-Control': 'no-store', 'X-VibeWire-Payload': payload },
      body: png,
    }
  }

  // MARK: Commands

  private async command(request: HTTPRequest): Promise<HTTPResponse> {
    let body: Record<string, unknown>
    try {
      body = JSON.parse(request.body.toString('utf8'))
    } catch {
      return Response.error(400, 'malformed_request')
    }
    const verb = body.do
    if (typeof verb !== 'string') return Response.error(400, 'malformed_request')
    const str = (key: string) => (typeof body[key] === 'string' ? (body[key] as string) : null)
    const bool = (key: string) => (typeof body[key] === 'boolean' ? (body[key] as boolean) : null)

    switch (verb) {
      case 'pair.begin': {
        const code = this.pairing.beginPairing(str('name'), bool('reusable') ?? false)
        return Response.json(200, { ok: true, code: code.value })
      }
      case 'pair.end':
        this.pairing.endPairing()
        return Response.json(200, { ok: true })
      case 'device.revoke':
        try {
          const removed = await this.router.dashboardRevoke(str('deviceId'), bool('all') ?? false)
          await this.refreshTrustNow()
          return Response.json(200, { ok: true, revoked: removed })
        } catch (error) {
          return Response.error(500, 'revoke_failed', { detail: describeError(error) })
        }
      case 'device.sever': {
        const deviceId = str('deviceId')
        if (!deviceId) return Response.error(400, 'missing_device')
        this.router.dashboardSever(deviceId)
        return Response.json(200, { ok: true })
      }
      case 'device.rename': {
        const deviceId = str('deviceId')
        const name = str('name')
        if (!deviceId || name === null) return Response.error(400, 'missing_device')
        try {
          const renamed = await this.router.dashboardRename(deviceId, name)
          if (renamed) await this.refreshTrustNow()
          return renamed ? Response.json(200, { ok: true }) : Response.error(404, 'no_such_device')
        } catch (error) {
          return Response.error(500, 'rename_failed', { detail: describeError(error) })
        }
      }
      case 'display.select': {
        const ids = Array.isArray(body.displayIds) ? body.displayIds.filter((id): id is number => typeof id === 'number') : []
        await this.router.dashboardSelectDisplays(ids, bool('sideBySide') ?? false)
        return Response.json(200, { ok: true })
      }
      case 'capture.stop':
        await this.router.dashboardStopCapture()
        return Response.json(200, { ok: true })
      case 'setting.set': {
        const key = str('key')
        const value = settingValue(body.value)
        if (!key || !value) return Response.error(400, 'malformed_setting')
        await this.router.dashboardApplySetting(key, value)
        return Response.json(200, { ok: true })
      }
      case 'transport.tunnel':
        // Routed through the setting, so the Transport pane's toggle and the
        // Settings pane's cannot disagree about whether the relay is meant on.
        await this.router.dashboardApplySetting('relayOverInternet', { kind: 'bool', value: bool('on') ?? false })
        return Response.json(200, { ok: true })
      case 'transport.refresh':
        await this.transport.refresh()
        return Response.json(200, { ok: true })
      case 'permission.request':
        // No grant to ask for on Windows; the Mac product is the Swift host.
        return Response.json(200, { ok: true })
      case 'claude': {
        const inbound = claudeInbound(body)
        if (!inbound) return Response.error(400, 'malformed_claude_command')
        await this.router.dashboardClaude(inbound)
        return Response.json(200, { ok: true })
      }
      case 'log.clear':
        // Not offered. The log is what happened.
        return Response.error(405, 'not_offered')
      default:
        return Response.error(400, 'unknown_command', { verb })
    }
  }
}

function settingValue(raw: unknown): SettingValue | null {
  if (typeof raw === 'boolean') return { kind: 'bool', value: raw }
  if (typeof raw === 'number' && Number.isFinite(raw)) return Number.isInteger(raw) ? { kind: 'int', value: raw } : { kind: 'double', value: raw }
  if (typeof raw === 'string') return { kind: 'string', value: raw }
  return null
}

function claudeInbound(body: Record<string, unknown>): ClaudeInbound | null {
  const str = (key: string) => (typeof body[key] === 'string' ? (body[key] as string) : null)
  switch (body.sub) {
    case 'listSessions':
      return { sub: 'listSessions', cwd: str('cwd') }
    case 'open':
      return { sub: 'open', sessionId: str('sessionId'), cwd: str('cwd'), mode: body.mode === 'chat' ? 'chat' : 'code' }
    case 'send': {
      const text = str('text')
      return text === null ? null : { sub: 'send', text }
    }
    case 'interrupt':
      return { sub: 'interrupt' }
    case 'permission': {
      const requestId = str('requestId')
      const behavior = str('behavior')
      if (!requestId || !behavior) return null
      return { sub: 'permission', requestId, allow: behavior === 'allow', scope: body.scope === 'always' ? 'always' : 'once', message: str('message') }
    }
    case 'diff':
      return { sub: 'diff', path: str('path') }
    case 'close':
      return { sub: 'close' }
    default:
      return null
  }
}

function pathWord(status: TransportStatus): string {
  if (status.cloudflareRunning && status.cloudflareHostname) return 'TUNNEL'
  if (status.tailscaleRunning) return 'DIRECT'
  if (status.lanAddress) return 'LAN'
  return 'NONE'
}

/** A device's public key, short enough to compare by eye. */
function fingerprint(key: Buffer): string {
  const hex = key.toString('hex')
  return hex.length > 8 ? `${hex.slice(0, 4)}…${hex.slice(-4)}` : hex
}

/** Every address this host can be reached on, and what each one is worth. */
export function addresses(status: TransportStatus, port: number): Record<string, unknown> & { origin: string; host: string } {
  const reachable = status.tailscaleAddress ?? status.lanAddress ?? status.tailscaleDNSName
  const host = reachable ?? '127.0.0.1'
  const preferred = preferredOrigin(status)
  let origin: string
  let reach: string
  if (preferred && preferred.startsWith('https://')) {
    origin = preferred
    reach = 'Works on cellular.'
  } else {
    origin = `http://${host}:${port}`
    reach = reachable === null ? 'No address to reach it on.' : status.tailscaleAddress === null ? 'Same network only.' : 'On the tailnet.'
  }
  return {
    origin,
    reach,
    reachable: reachable !== null,
    host,
    port,
    candidates: candidates(status),
    listening: [
      `LISTENING ON :${port}`,
      reachable === null ? 'NO ADDRESS BUT LOOPBACK' : null,
      status.tailscaleRunning ? 'TAILSCALE UP' : 'TAILSCALE DOWN',
      status.cloudflareRunning ? 'TUNNEL ON' : 'TUNNEL OFF',
      status.networkProfile === 'Public' ? 'PUBLIC NETWORK' : null,
    ]
      .filter((part): part is string => part !== null)
      .join(' · '),
    publishedSite: Config.webClientURL ?? '',
    webBundlePresent: Config.webRoot !== null,
  }
}

function directorySize(root: string | null): number {
  if (!root) return 0
  let total = 0
  const walk = (directory: string) => {
    let entries: import('node:fs').Dirent[]
    try {
      entries = readdirSync(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else {
        try {
          total += statSync(path).size
        } catch {
          // skip
        }
      }
    }
  }
  walk(root)
  return total
}

function wallClock(date: Date): string {
  const pad = (n: number, width = 2) => String(n).padStart(width, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

/** What a host with no dashboard build says, in the one place it can. */
const NO_BUNDLE_PAGE = `<!doctype html><meta charset="utf-8"><title>VibeWire</title>
<style>
  body { margin:0; display:grid; place-items:center; min-height:100vh;
         background:#0F1114; color:#F2F3F6; font:15px/1.5 system-ui, sans-serif }
  div { max-width:34rem; padding:2rem }
  code { font:13px ui-monospace, Menlo, Consolas, monospace; color:#96ADFF }
  p { color:#A5A9B1 }
</style>
<div>
  <h1>No dashboard build on this host</h1>
  <p>The host is serving normally &mdash; pairing, the socket and the web client are
  unaffected. This window has nothing to draw because <code>web/dist-dashboard</code>
  does not exist yet.</p>
  <p>Build it with <code>npm ci &amp;&amp; npm run build:dashboard</code> in <code>web/</code>,
  then reopen this window. No restart is needed.</p>
</div>`
