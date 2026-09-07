import { ladderMaxHeight, Config, type HostSettings } from '../core/config'
import { Log, describeError } from '../core/log'
import type { CaptureHost } from '../capture/captureHost'
import type { ClaudeService } from '../claude/claudeService'
import type { InputRouter } from '../input/inputRouter'
import type { HTTPServer, Router } from '../net/httpServer'
import { header, Response, type HTTPRequest, type HTTPResponse } from '../net/request'
import type { SocketConnection } from '../net/socketConnection'
import { WebAssets } from '../net/webAssets'
import {
  decodeInbound,
  Outbound,
  type ClaudeInbound,
  type HubAction,
  type Inbound,
  type Payload,
  type SettingValue,
} from '../net/wireProtocol'
import { strictBase64 } from '../pairing/ed25519'
import { PairError, PairingService } from '../pairing/pairingService'
import { TrustStore, type TrustedDevice } from '../pairing/trustStore'
import type { HostPlatform } from '../platform/hostPlatform'
import type { SystemServices } from '../system/systemServices'
import { Telemetry, telemetryWire } from '../system/telemetry'
import { TransportManager, transportWire } from '../transport/transportManager'

/** Something that answers `/dashboard/*` and `/v1/dashboard/*`, or declines. */
export interface DashboardRoutes {
  response(request: HTTPRequest): Promise<HTTPResponse | null>
}

export interface RouterDeps {
  platform: HostPlatform
  trust: TrustStore
  pairing: PairingService
  capture: CaptureHost
  input: InputRouter
  system: SystemServices
  telemetry: Telemetry
  claude: ClaudeService
  transport: TransportManager
  settings: HostSettings
}

/** Messages the phone's socket would have received, kept for the dashboard to
 *  collect on its next poll. A ring, not a queue: a dashboard nobody has open
 *  must not grow a backlog for the life of the process. */
class EventRing {
  static readonly capacity = 400
  messages: { sequence: number; payload: Payload }[] = []
  nextSequence = 1
}

/**
 * The seam between the network layer and everything the host can do. Owns
 * session state: which socket is active, what the link looks like, what the
 * phone said about its radio. Ported line for line from `HostRouter.swift`.
 */
export class HostRouter implements Router {
  private settings: HostSettings
  private activeSocket: SocketConnection | null = null
  private selectedDisplays: number[] = []
  /** Reported by the phone. The host cannot see the phone's radio, so the
   *  cellular cap is only honest if the phone says so. */
  private phoneOnExpensiveLink = false
  private readonly events = new EventRing()
  private readonly web: WebAssets | null
  private readonly trust: TrustStore
  private readonly pairing: PairingService
  private readonly capture: CaptureHost
  private readonly input: InputRouter
  private readonly system: SystemServices
  private readonly telemetry: Telemetry
  private readonly claude: ClaudeService
  private readonly transport: TransportManager
  private readonly platform: HostPlatform
  private model = ''

  server: HTTPServer | null = null
  dashboard: DashboardRoutes | null = null

  constructor(deps: RouterDeps) {
    this.platform = deps.platform
    this.trust = deps.trust
    this.pairing = deps.pairing
    this.capture = deps.capture
    this.input = deps.input
    this.system = deps.system
    this.telemetry = deps.telemetry
    this.claude = deps.claude
    this.transport = deps.transport
    this.settings = deps.settings
    this.web = WebAssets.open(Config.webRoot)
    if (this.web) Log.info('app', `serving web client from ${this.web.root}`)
    else Log.warn('app', 'no web client bundle found; the host serves only the protocol')
    this.input.update(this.settings.sensitivity, this.settings.naturalScrolling)
    this.claude.setEmitter((payload) => this.fanOut(payload))
    void this.platform.machine.model().then((model) => {
      this.model = model
    })
  }

  /** The bitrate ceiling to apply right now, or null for no cap. Honours the
   *  setting *and* the phone's actual radio. */
  private get cellularCap(): number | null {
    return this.settings.capOnCellular && this.phoneOnExpensiveLink ? this.settings.cellularCeilingMbps : null
  }

  get currentSettings(): HostSettings {
    return { ...this.settings }
  }

  get serving(): { clientAttached: boolean; streams: number } {
    return { clientAttached: this.activeSocket !== null, streams: this.capture.streams().length }
  }

  get attached(): SocketConnection | null {
    return this.activeSocket
  }

  get displaysSelected(): number[] {
    return [...this.selectedDisplays]
  }

  get expensiveLink(): boolean {
    return this.phoneOnExpensiveLink
  }

  get hostModel(): string {
    return this.model
  }

  get inputAvailable(): boolean {
    return this.input.available
  }

  /** Claude, driven from the dashboard. Identical to the phone's path. */
  async dashboardClaude(inbound: ClaudeInbound): Promise<void> {
    await this.claude.handle(inbound)
  }

  /** One message to both surfaces: the attached phone, and the dashboard's next poll. */
  fanOut(payload: Payload): void {
    this.activeSocket?.sendJSON(payload)
    this.events.messages.push({ sequence: this.events.nextSequence, payload })
    this.events.nextSequence += 1
    if (this.events.messages.length > EventRing.capacity) {
      this.events.messages.splice(0, this.events.messages.length - EventRing.capacity)
    }
  }

  /** Everything emitted after `since`, and the sequence to ask from next. */
  drainEvents(since: number): { next: number; dropped: number; messages: Payload[] } {
    const fresh = this.events.messages.filter((entry) => entry.sequence > since)
    const oldestHeld = this.events.messages[0]?.sequence ?? this.events.nextSequence
    const dropped = since > 0 ? Math.max(0, oldestHeld - since - 1) : 0
    return { next: this.events.nextSequence, dropped, messages: fresh.map((entry) => entry.payload) }
  }

  // MARK: HTTP

  async handle(request: HTTPRequest): Promise<HTTPResponse> {
    const { method, path } = request
    if (method === 'GET' && path === '/v1/health') {
      // Deliberately says nothing about pairing state to an unauthenticated
      // caller; it exists so a tunnel can health-check the origin.
      return Response.json(200, { ok: true, protocol: Config.protocolVersion })
    }
    if (method === 'POST' && path === '/v1/pair') return this.handlePair(request)
    if (method === 'GET' && path === '/v1/challenge') {
      // The same shape whether or not the device id is known, so this cannot
      // be used to enumerate paired devices.
      return Response.json(200, { nonce: this.pairing.issueNonce(), expiresIn: 30 })
    }
    if (method === 'GET' && path === '/v1/verify') {
      // A browser cannot see the status line of a refused WebSocket upgrade —
      // a 401 and an unplugged cable both arrive as close code 1006 — so the
      // same challenge-response is offered over plain HTTP. It grants nothing.
      const device = await this.authenticateUpgrade(request)
      if (!device) return Response.error(401, 'unauthorized')
      return Response.json(200, { ok: true, deviceId: device.id })
    }
    if (method === 'OPTIONS') {
      return Response.empty(200, {
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-VibeWire-Device, X-VibeWire-Nonce, X-VibeWire-Signature',
      })
    }

    // The dashboard: its own bundle behind the launch key, and its own API
    // behind the same key, checked before the web client because `/dashboard/…`
    // must not fall through to the client's index.
    const dashboard = await this.dashboard?.response(request)
    if (dashboard) return dashboard

    // The web client, served from the same port so the browser sees one origin
    // for the page and the protocol both.
    if (method === 'GET' && this.web) {
      const served = this.web.response(path)
      if (served) return served
    }
    return Response.error(404, 'not_found')
  }

  private async handlePair(request: HTTPRequest): Promise<HTTPResponse> {
    // Every exit here is logged, so an empty log means "the phone never called".
    Log.info('net', `pair request received (${request.body.length} bytes)`)
    let body: Record<string, unknown>
    try {
      body = JSON.parse(request.body.toString('utf8'))
    } catch {
      body = {}
    }
    const code = typeof body.code === 'string' ? body.code : null
    const publicKey = typeof body.publicKey === 'string' ? strictBase64(body.publicKey) : null
    if (code === null || publicKey === null) {
      Log.info('net', 'pair rejected 400 malformed_request')
      return Response.error(400, 'malformed_request')
    }
    const deviceName = typeof body.deviceName === 'string' ? body.deviceName : 'iPhone'
    const deviceKind = typeof body.deviceKind === 'string' ? body.deviceKind : 'phone'

    try {
      const result = await this.pairing.pair(code, deviceName, deviceKind, publicKey)
      Log.info('net', `pair accepted: ${deviceName} (${deviceKind}) as ${result.device.id}`)
      return Response.json(200, {
        hostId: result.hostId,
        hostName: result.hostName,
        hostKey: result.hostPublicKey.toString('base64'),
        deviceId: result.device.id,
        pairedAt: result.device.pairedAt.toISOString(),
        protocol: Config.protocolVersion,
      })
    } catch (error) {
      if (error instanceof PairError) {
        switch (error.reason) {
          case 'lockedOut':
            Log.info('net', `pair rejected 429 too_many_attempts, retry in ${error.retryAfter}s`)
            return Response.error(429, 'too_many_attempts', { retryAfter: error.retryAfter })
          case 'codeExpired':
            Log.info('net', 'pair rejected 409 code_expired')
            return Response.error(409, 'code_expired')
          case 'notPairing':
            Log.info('net', 'pair rejected 409 not_pairing (pairing window is closed)')
            return Response.error(409, 'not_pairing')
          case 'badPublicKey':
            Log.info('net', 'pair rejected 400 bad_public_key')
            return Response.error(400, 'bad_public_key')
          case 'badCode':
            Log.info('net', 'pair rejected 401 bad_code')
            return Response.error(401, 'bad_code')
        }
      }
      // Everything left is the trust store failing to record the pairing, and
      // it is not a bad code. The digits were already accepted, so the honest
      // answer is that the host could not store the trust.
      Log.error('net', `pair failed after the code was accepted: ${describeError(error)}`)
      return Response.error(503, 'trust_unavailable', { detail: describeError(error) })
    }
  }

  // MARK: Socket lifecycle

  /**
   * Two spellings of the same challenge-response. The phone sends the three
   * values as headers; a browser cannot set headers on a WebSocket handshake,
   * so the query string is accepted too. Headers win where both are present.
   * Possession of the key is the check, which is why no `Origin` is validated.
   */
  async authenticateUpgrade(request: HTTPRequest): Promise<TrustedDevice | null> {
    const deviceId = header(request, 'x-vibewire-device') ?? request.query.device
    const nonce = header(request, 'x-vibewire-nonce') ?? request.query.nonce
    const signatureBase64 = header(request, 'x-vibewire-signature') ?? request.query.sig
    if (!deviceId || !nonce || !signatureBase64) return null
    const signature = strictBase64(signatureBase64)
    if (!signature) return null
    return this.pairing.verify(deviceId, nonce, signature)
  }

  async socketOpened(socket: SocketConnection, device: TrustedDevice): Promise<void> {
    // There is one active socket, and Claude's output is emitted to it. A
    // second socket silently takes that slot; that is worth saying out loud.
    if (this.activeSocket) {
      Log.warn('net', `second socket for ${device.name} replaced the active one — the phone should hold exactly one`)
    }
    this.activeSocket = socket
    this.capture.setSocket(socket)
    this.telemetry.reset()
    this.transport.noteContact()
    this.system.preventSleep(true)
    this.pairing.noteSocketOpened(device.id)

    let hostId = ''
    try {
      hostId = await this.trust.hostId()
    } catch (error) {
      Log.error('net', `host identity unreadable: ${describeError(error)}`)
    }
    socket.sendJSON(
      Outbound.hello({
        hostId,
        hostName: this.platform.machine.hostName(),
        model: this.model,
        os: this.platform.machine.osVersion(),
        osBuild: this.platform.machine.osBuild(),
        platform: this.platform.name,
        version: Config.hostVersion,
        protocol: Config.protocolVersion,
        capabilities: {
          // No TCC on Windows: capture and input need no grant. The named
          // conditions below carry what can actually stop them.
          screenRecording: true,
          accessibility: this.input.available,
          claude: this.claude.available && process.env.VIBEWIRE_DISABLE_CLAUDE !== '1',
          wakeOnLan: this.system.canWakeOverNetwork(),
        },
        conditions: this.platform.conditions(),
      }),
    )

    await this.pushDisplays(socket)
    this.pushStatus(socket)
    await this.pushTransport(socket)
    socket.sendJSON(this.settingsPayload())
    await this.pushDevices(socket)
  }

  async socketClosed(socket: SocketConnection): Promise<void> {
    if (this.activeSocket !== socket) return
    this.activeSocket = null
    this.capture.setSocket(null)
    // "Nothing is left running on the host" — the promise at the end of 07.
    await this.capture.stopAll()
    await this.claude.close()
    this.input.releaseAllModifiers()
    this.system.preventSleep(false)
    Log.info('net', 'session ended, host idle')
  }

  // MARK: Socket messages

  async socketReceived(socket: SocketConnection, text: string): Promise<void> {
    let decoded: { id: string | null; message: Inbound }
    try {
      decoded = decodeInbound(text)
    } catch (error) {
      Log.debug('net', `inbound decode failed: ${describeError(error)}`)
      socket.sendJSON(Outbound.error('bad_message', describeError(error)))
      return
    }
    try {
      await this.dispatch(decoded.message, socket)
    } catch (error) {
      Log.error('net', `dispatch of ${decoded.message.t} threw: ${describeError(error)}`)
      socket.sendJSON(Outbound.error('internal', describeError(error), false, decoded.id))
      return
    }
    if (decoded.id) socket.sendJSON(Outbound.ack(decoded.id))
  }

  private async dispatch(message: Inbound, socket: SocketConnection): Promise<void> {
    switch (message.t) {
      case 'ping':
        socket.sendJSON(Outbound.pong(message.tMicros))
        this.telemetry.notePing(message.sequence, message.rttMillis)
        this.transport.noteContact()
        break

      case 'link': {
        const changed = this.phoneOnExpensiveLink !== message.expensive
        this.phoneOnExpensiveLink = message.expensive
        if (changed) {
          Log.info('net', `phone link is now ${message.expensive ? 'cellular/expensive' : 'unmetered'}`)
          await this.capture.retune(true)
        }
        break
      }

      case 'selectDisplay':
        this.selectedDisplays = message.sideBySide ? message.displayIds : message.displayIds.slice(0, 1)
        if (this.selectedDisplays.length) this.input.focus(this.selectedDisplays[0])
        await this.pushDisplays(socket)
        break

      case 'startStream': {
        let ids = message.displayIds
        if (!ids.length) {
          const main = (await this.capture.displays()).find((display) => display.isMain)
          ids = main ? [main.id] : []
        }
        this.selectedDisplays = ids
        await this.capture.startStreams(ids, message.maxHeight, message.targetFps, socket)
        if (ids.length) this.input.focus(ids[0])
        break
      }

      case 'stopStream':
        await this.capture.stopAll()
        socket.sendJSON({ t: 'streamState', state: 'stopped' })
        break

      case 'setQuality':
        this.settings.quality = message.ladder
        if (message.cellularCapMbps !== null) this.settings.cellularCeilingMbps = message.cellularCapMbps
        Config.saveSettings(this.settings)
        await this.capture.retune()
        socket.sendJSON(this.settingsPayload())
        break

      case 'pointer':
        if (message.event.sensitivity !== null) this.input.update(message.event.sensitivity, null)
        this.input.movePointer(message.event.dx, message.event.dy, message.event.display)
        break
      case 'click':
        this.input.click(message.button, message.count, message.display)
        break
      case 'drag':
        this.input.drag(message.phase, message.dx, message.dy, message.count)
        break
      case 'scroll':
        this.input.scroll(message.dx, message.dy, message.momentum)
        break
      case 'zoom':
        this.input.zoom(message.scale, message.locked)
        break
      case 'modifiers':
        this.input.setModifiers(message.held)
        break
      case 'key':
        this.input.key(message.code, message.chars, message.down)
        break
      case 'combo':
        this.input.combo(message.keys)
        break
      case 'text':
        this.input.type(message.value)
        break

      case 'hubAction':
        await this.performHubAction(message.action, socket)
        break

      case 'clipboardPush':
        await this.system.writeClipboard(message.text)
        socket.sendJSON({ t: 'clipboard', direction: 'toMac', ok: true })
        break

      case 'wake': {
        // The host is by definition awake if it answered, so this nudges the
        // display awake rather than the machine.
        const woke = this.system.wakeDisplays()
        const onScreen = await this.system.waitForDisplaysAwake()
        await this.capture.displays(true)
        await this.pushDisplays(socket)
        this.pushStatus(socket)
        // A stream that ran through the sleep has been sending nothing, and
        // the phone is holding the frame from before. An IDR replaces it.
        this.capture.requestKeyframes()
        socket.sendJSON({ t: 'wake', ok: woke && onScreen })
        break
      }

      case 'retry':
        await this.capture.retune()
        this.capture.requestKeyframes()
        break

      case 'lastFrame': {
        const snapshot = this.capture.lastKeyframe()
        if (snapshot) {
          socket.sendJSON({ t: 'lastFrame', ageSeconds: Math.floor((Date.now() - snapshot.at) / 1000) })
          socket.sendBinary(snapshot.data)
        } else {
          socket.sendJSON(Outbound.error('no_last_frame', 'no frame captured yet'))
        }
        break
      }

      case 'claude':
        await this.claude.handle(message.claude)
        break

      case 'revoke':
        await this.handleRevoke(message.deviceId, message.all, socket)
        break

      case 'setting':
        await this.applySetting(message.key, message.value)
        socket.sendJSON(this.settingsPayload())
        break
    }
  }

  // MARK: Hub actions

  private async performHubAction(action: HubAction, socket: SocketConnection): Promise<void> {
    switch (action) {
      case 'copy':
        socket.sendJSON({ t: 'clipboard', direction: 'fromMac', text: (await this.system.readClipboard()) ?? '' })
        break
      case 'paste':
        // The phone pushes text first, then asks for the paste keystroke.
        this.input.combo(['cmd', 'v'])
        socket.sendJSON({ t: 'clipboard', direction: 'toMac', ok: true })
        break
      case 'shot': {
        const png = await this.system.screenshot(this.selectedDisplays[0] ?? null)
        if (png) socket.sendJSON({ t: 'screenshot', png: png.toString('base64'), bytes: png.length })
        else socket.sendJSON(Outbound.error('screenshot_failed', 'could not capture display'))
        break
      }
      case 'lock':
        socket.sendJSON({ t: 'locked', ok: this.system.lockScreen() })
        break
      case 'keys':
      case 'mods':
        // Presentation-only on the phone; nothing to do here.
        break
    }
  }

  // MARK: Devices and settings

  private async handleRevoke(deviceId: string | null, all: boolean, socket: SocketConnection): Promise<void> {
    try {
      if (all) {
        const removed = await this.trust.revokeAll()
        this.server?.severSockets(new Set(removed))
      } else if (deviceId) {
        if (await this.trust.revoke(deviceId)) this.server?.severSockets(new Set([deviceId]))
      }
      await this.pushDevices(socket)
    } catch (error) {
      socket.sendJSON(Outbound.error('revoke_failed', describeError(error)))
    }
  }

  async applySetting(key: string, value: SettingValue): Promise<void> {
    const s = this.settings
    if (key === 'sensitivity' && value.kind === 'int') s.sensitivity = Math.max(1, Math.min(8, value.value))
    else if (key === 'naturalScrolling' && value.kind === 'bool') s.naturalScrolling = value.value
    else if (key === 'capOnCellular' && value.kind === 'bool') s.capOnCellular = value.value
    else if (key === 'cellularCeilingMbps' && (value.kind === 'double' || value.kind === 'int')) s.cellularCeilingMbps = value.value
    else if (key === 'requireBiometricEachSession' && value.kind === 'bool') s.requireBiometricEachSession = value.value
    else if (key === 'relayOverInternet' && value.kind === 'bool') s.relayOverInternet = value.value
    else if (key === 'quality' && value.kind === 'string') s.quality = value.value === '1080' || value.value === '720' || value.value === '540' ? value.value : 'auto'
    else Log.debug('app', `ignoring unknown setting ${key}`)

    this.input.update(s.sensitivity, s.naturalScrolling)
    Config.saveSettings(s)

    // The relay toggle has a side effect beyond persistence.
    if (s.relayOverInternet) await this.transport.startCloudflareTunnel()
    else await this.transport.stopCloudflareTunnel()

    await this.capture.retune()
  }

  settingsPayload(): Payload {
    return {
      t: 'settings',
      quality: this.settings.quality,
      capOnCellular: this.settings.capOnCellular,
      cellularCeilingMbps: this.settings.cellularCeilingMbps,
      sensitivity: this.settings.sensitivity,
      naturalScrolling: this.settings.naturalScrolling,
      requireBiometricEachSession: this.settings.requireBiometricEachSession,
      relayOverInternet: this.settings.relayOverInternet,
      hostVersion: Config.hostVersion,
    }
  }

  /** What the ladder needs from the settings, read in one place. */
  get ladder(): { maxHeight: number | null; capMbps: number | null } {
    return { maxHeight: ladderMaxHeight(this.settings.quality), capMbps: this.cellularCap }
  }

  // MARK: The dashboard's view of this router

  async dashboardApplySetting(key: string, value: SettingValue): Promise<void> {
    await this.applySetting(key, value)
    this.activeSocket?.sendJSON(this.settingsPayload())
  }

  async dashboardRevoke(deviceId: string | null, all: boolean): Promise<number> {
    if (all) {
      const removed = await this.trust.revokeAll()
      this.server?.severSockets(new Set(removed))
      return removed.length
    }
    if (!deviceId) return 0
    if (!(await this.trust.revoke(deviceId))) return 0
    this.server?.severSockets(new Set([deviceId]))
    return 1
  }

  dashboardSever(deviceId: string): void {
    this.server?.severSockets(new Set([deviceId]))
  }

  async dashboardRename(deviceId: string, name: string): Promise<boolean> {
    const renamed = await this.trust.rename(deviceId, name)
    if (renamed && this.activeSocket) await this.pushDevices(this.activeSocket)
    return renamed
  }

  async dashboardSelectDisplays(ids: number[], sideBySide: boolean): Promise<void> {
    this.selectedDisplays = sideBySide ? ids : ids.slice(0, 1)
    if (this.selectedDisplays.length) this.input.focus(this.selectedDisplays[0])
    if (this.activeSocket) {
      await this.pushDisplays(this.activeSocket)
      await this.capture.startStreams(this.selectedDisplays, null, null, this.activeSocket)
    }
  }

  async dashboardStopCapture(): Promise<void> {
    await this.capture.stopAll()
    this.activeSocket?.sendJSON({ t: 'streamState', state: 'stopped' })
  }

  // MARK: Pushes

  private async pushDisplays(socket: SocketConnection): Promise<void> {
    const displays = await this.capture.displays()
    socket.sendJSON({
      t: 'displays',
      displays: displays.map((display) => {
        const payload: Payload = { ...display }
        payload.selected = this.selectedDisplays.includes(display.id)
        const index = this.selectedDisplays.indexOf(display.id)
        if (index >= 0) payload.streamId = index
        return payload
      }),
    })
  }

  private pushStatus(socket: SocketConnection): void {
    const power = this.system.powerState()
    const frontmost = this.system.frontmostApplication()
    const payload: Payload = telemetryWire(this.telemetry.snapshot())
    payload.t = 'status'
    payload.awake = power.isAwake
    payload.displaysAsleep = power.displaysAsleep
    payload.onPower = power.isOnPower
    payload.lidOpen = power.lidOpen
    payload.frontmostApp = frontmost.name
    // This payload only travels down a live socket, so the host is running and
    // its panels are one local call away from coming back on.
    payload.canWake = true
    payload.conditions = this.platform.conditions()
    socket.sendJSON(payload)
  }

  private async pushTransport(socket: SocketConnection): Promise<void> {
    await this.transport.refresh()
    socket.sendJSON(transportWire(this.transport.status()))
  }

  private async pushDevices(socket: SocketConnection): Promise<void> {
    let devices: TrustedDevice[] = []
    try {
      devices = await this.trust.all()
    } catch (error) {
      Log.error('net', `device list unreadable: ${describeError(error)}`)
    }
    const connected = this.server?.connectedDeviceIds ?? new Set<string>()
    socket.sendJSON({
      t: 'devices',
      devices: devices.map((device) => {
        const payload: Payload = {
          id: device.id,
          name: device.name,
          kind: device.kind,
          pairedAt: device.pairedAt.toISOString(),
          connected: connected.has(device.id),
          isThisDevice: device.id === socket.deviceId,
        }
        if (device.lastSeenAt) payload.lastSeenAt = device.lastSeenAt.toISOString()
        return payload
      }),
    })
  }

  /** Driven by the app's heartbeat timer. */
  async tick(): Promise<void> {
    const socket = this.activeSocket
    if (!socket) return

    socket.ping()
    this.telemetry.noteThroughput(this.capture.measuredMbps())

    this.pushStatus(socket)
    await this.pushTransport(socket)

    // Mirror a copy the user made on the host itself.
    const clipboard = await this.system.clipboardChangedSinceLastCheck()
    if (clipboard !== null) socket.sendJSON({ t: 'clipboard', direction: 'fromMac', text: clipboard })

    await this.capture.retune()

    // Refresh the "TYPING INTO" banner while keyboard mode is open.
    const frontmost = this.system.frontmostApplication()
    socket.sendJSON({ t: 'frontmost', app: frontmost.name, bundleId: frontmost.bundleId ?? '', title: frontmost.title, elevated: frontmost.elevated })

    // Nothing has answered a ping in a while: tell the phone before it notices
    // on its own, so 03D can start counting.
    if (socket.secondsSincePong > 5) {
      socket.sendJSON({ t: 'streamState', state: 'stalled', stalledMs: Math.round(socket.secondsSincePong * 1000) })
    } else {
      const stalled = this.capture.captureStalledMs()
      if (stalled !== null) {
        socket.sendJSON({ t: 'streamState', state: 'stalled', stalledMs: stalled, reason: 'captureStalled' })
      }
    }
  }
}
