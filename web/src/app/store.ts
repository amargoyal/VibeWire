/**
 * One observable store drives every screen. Ported from
 * ios/VibeWire/Model/AppModel.swift.
 *
 * State transitions live here so the views stay declarative and the same
 * condition never gets computed two different ways in two different places.
 */

import { batch, computed, signal } from '@preact/signals'

import { HostClient, type ConnectionState, type ControlMessage } from '../net/hostClient'
import { Identity, type KeyStorage, type PairedHost } from '../net/identity'
import { LinkMonitor } from '../net/linkMonitor'
import {
  describe,
  normaliseOrigins,
  parseEndpoint,
  reachability,
  type Endpoint,
} from '../net/endpoint'
import { RendererPool, type VideoRenderer } from '../video/renderer'
import { conditionFrom, type Condition } from '../design/components'

// MARK: - Domain types

export interface DisplayEntry {
  id: number
  name: string
  width: number
  height: number
  refreshHz: number
  isBuiltIn: boolean
  selected: boolean
  streamId: number | null
}

export function resolutionLabel(display: DisplayEntry): string {
  return `${display.width} × ${display.height} · ${display.refreshHz} HZ`
}

export interface LinkStatus {
  awake: boolean
  onPower: boolean
  rttMillis: number | null
  jitterMillis: number | null
  lossPercent: number
  downMbps: number
  rttHistory: number[]
  frontmostApp: string
  canWake: boolean
}

export interface TransportStatus {
  path: 'direct' | 'relay' | 'none'
  tailscaleRunning: boolean
  tailscaleAddress: string | null
  relayName: string | null
  cloudflareRunning: boolean
  cloudflareHostname: string | null
  lanAddress: string | null
  /** Every origin the Mac believes it can be reached on, best first. The Mac is
   *  the only thing that knows all of them. */
  candidates: string[]
}

export type StreamState =
  | { kind: 'stopped' }
  | { kind: 'starting' }
  | { kind: 'live' }
  | { kind: 'stalled'; millis: number }
  | { kind: 'reconnecting'; attempt: number; nextRetryMs: number }
  | { kind: 'failed'; reason: string }

export interface VideoConfig {
  streamId: number
  displayId: number
  width: number
  height: number
  fps: number
  bitrate: number
  ladder: string
}

export function bitrateMbps(config: VideoConfig): number {
  return config.bitrate / 1_000_000
}

export interface PairedDeviceEntry {
  id: string
  name: string
  kind: string
  pairedAt: number
  lastSeenAt: number | null
  connected: boolean
  isThisDevice: boolean
}

export interface HostSettingsMirror {
  quality: string
  capOnCellular: boolean
  cellularCeilingMbps: number
  sensitivity: number
  naturalScrolling: boolean
  requireBiometricEachSession: boolean
  relayOverInternet: boolean
  hostVersion: string
}

// MARK: - Claude

export interface ClaudeSessionEntry {
  id: string
  summary: string
  cwd: string
  gitBranch: string | null
  modifiedAt: number
  messageCount: number
}

export interface ToolCall {
  id: string
  name: string
  target: string
  state: 'running' | 'ok' | 'error'
  milliseconds: number | null
  preview: string | null
}

export interface ClaudeTurn {
  id: number
  role: 'user' | 'assistant'
  text: string
  at: number
}

export interface PermissionRequest {
  id: string
  toolName: string
  command: string
  explanation: string
  arrivedAt: number
}

export interface ChangedFile {
  path: string
  status: string
  added: number
  removed: number
}

export type Route = 'pairing' | 'home' | 'remote'

/**
 * What is presented *over* the route. One value, because two stacked sheets over
 * a live picture is two things claiming the same dismiss gesture — a defect the
 * phone paid for once and fixed by making this exclusive.
 */
export type Presentation = 'settings' | 'claude'

export type RevokeTarget =
  | { kind: 'device'; device: PairedDeviceEntry }
  | { kind: 'everything'; count: number }

export type ClaudeMode = 'chat' | 'code'

// MARK: - Store

const APP_VERSION = '0.9.4'

/**
 * Pointer coalescing. A pointer device delivers up to 1000 samples a second on a
 * high-rate mouse; the Mac only needs one packet per displayed frame, and the
 * deltas add up losslessly.
 */
class PointerBudget {
  private pendingX = 0
  private pendingY = 0
  private lastSend = 0
  private readonly interval = 1000 / 120

  shouldSend(): boolean {
    return performance.now() - this.lastSend >= this.interval
  }

  accumulate(dx: number, dy: number): void {
    this.pendingX += dx
    this.pendingY += dy
  }

  drain(dx: number, dy: number): [number, number] {
    const totalX = this.pendingX + dx
    const totalY = this.pendingY + dy
    this.pendingX = 0
    this.pendingY = 0
    this.lastSend = performance.now()
    return [totalX, totalY]
  }
}

export interface Banner {
  text: string
  retriable?: boolean
}

let turnSequence = 0

/** Long enough to read a line and see which copy it was, short enough not to sit
 *  over the picture. */
const NOTE_MILLIS = 4200

const STREAM_SESSIONS_KEY = 'vibewire.streamSessions'

function readStreamSessions(): number {
  try {
    const stored = Number(localStorage.getItem(STREAM_SESSIONS_KEY))
    return Number.isFinite(stored) && stored >= 0 ? stored : 0
  } catch {
    // A browser with storage disabled still gets a working client; it just sees
    // the teaching legend every time, which is the behaviour everyone had before.
    return 0
  }
}

function writeStreamSessions(count: number): void {
  try {
    localStorage.setItem(STREAM_SESSIONS_KEY, String(count))
  } catch {
    /* storage refused; the count stays in memory for this tab */
  }
}

/**
 * The first line of a clipboard payload, short enough for a banner.
 *
 * A copied build error is forty lines and a banner is one. The first line says
 * *which* copy arrived without turning the banner into a document.
 */
function firstLine(text: string): string {
  const line = text.split('\n', 1)[0]?.trim() ?? text
  return line.length > 48 ? `${line.slice(0, 47)}…` : line
}

export class Store {
  // Navigation
  route = signal<Route>('pairing')
  presented = signal<Presentation | null>(null)
  showHub = signal(false)
  showKeyboard = signal(false)
  revokeTarget = signal<RevokeTarget | null>(null)
  /** The last screenshot the Mac sent, as a data URL. A browser cannot put an
   *  image on the clipboard unprompted, so it is shown rather than pocketed. */
  screenshot = signal<string | null>(null)
  showSessionPicker = signal(false)

  // Connection
  pairedHost = signal<PairedHost | null>(null)
  connection = signal<ConnectionState>({ kind: 'idle' })
  hostName = signal('Mac')
  hostModel = signal('')
  hostOS = signal('')
  capabilities = signal<Record<string, boolean>>({})
  keyStorage = signal<KeyStorage | null>(null)

  // Condition
  link = signal<LinkStatus>({
    awake: true,
    onPower: true,
    rttMillis: null,
    jitterMillis: null,
    lossPercent: 0,
    downMbps: 0,
    rttHistory: [],
    frontmostApp: '',
    canWake: true,
  })
  transport = signal<TransportStatus>({
    path: 'none',
    tailscaleRunning: false,
    tailscaleAddress: null,
    relayName: null,
    cloudflareRunning: false,
    cloudflareHostname: null,
    lanAddress: null,
    candidates: [],
  })
  displays = signal<DisplayEntry[]>([])
  settings = signal<HostSettingsMirror>({
    quality: 'auto',
    capOnCellular: true,
    cellularCeilingMbps: 3,
    sensitivity: 5,
    naturalScrolling: true,
    requireBiometricEachSession: true,
    relayOverInternet: false,
    hostVersion: '—',
  })
  devices = signal<PairedDeviceEntry[]>([])
  readonly appVersion = APP_VERSION

  // Streaming
  streamState = signal<StreamState>({ kind: 'stopped' })
  videoConfigs = signal<Record<number, VideoConfig>>({})
  zoomScale = signal(1)
  zoomLocked = signal(false)
  sideBySide = signal(false)
  inputPane = signal(0)
  /** The age the host reported, at the moment it reported it. */
  lastFrameAgeSeconds = signal<number | null>(null)
  private lastFrameAgeAt = 0

  /**
   * That measurement, carried forward by this client's own clock.
   *
   * The raw value arrives once and then sits there, so the hero said LAST FRAME ·
   * 5S AGO and was still saying it ten minutes later. The host's number is the
   * measurement; the elapsed time since it landed is arithmetic, and stating the
   * sum is honest in a way that freezing the first half is not.
   */
  frameAge = computed<number | null>(() => {
    const base = this.lastFrameAgeSeconds.value
    if (base == null) return null
    // Read once a second so the readout advances rather than freezing.
    void this.tick.value
    return base + (performance.now() - this.lastFrameAgeAt) / 1000
  })

  // Input
  /** Everything the Mac is being told is down — tapped and physical together. */
  heldModifiers = signal<string[]>([])
  /** The subset a tap on a key cap is holding. Kept apart from the physical set so
   *  a ⌘ latched in the drawer survives the next keystroke on a real keyboard,
   *  which reports only the modifiers its own fingers are on. */
  private noteTimer: ReturnType<typeof setTimeout> | null = null
  private latchedModifiers: string[] = []
  private physicalModifiers: string[] = []
  /**
   * How many times a picture has gone live on this origin.
   *
   * Named for what it counts: it decides whether the remote view still shows its
   * teaching legend, and it has nothing to do with Claude, which read it as a
   * session count. Persisted, because it was in memory only — so every page load
   * put it back to zero and a legend documented as retiring after three sessions
   * was on screen for every session there had ever been.
   *
   * localStorage rather than the identity store: it is a count of sessions on
   * this origin, which is exactly the scope localStorage has, and losing it costs
   * nothing worse than reading a sentence again.
   */
  streamSessionCount = signal(readStreamSessions())

  // Clipboard
  /** Text the Mac sent that this browser refused to put on the clipboard. Held so
   *  it can be offered with a button, which is a gesture the browser accepts. */
  clipboardOffer = signal<string | null>(null)

  // Claude
  claudeMode = signal<ClaudeMode>('code')
  claudeSessions = signal<ClaudeSessionEntry[]>([])
  claudeTurns = signal<ClaudeTurn[]>([])
  toolCalls = signal<ToolCall[]>([])
  changedFiles = signal<ChangedFile[]>([])
  permission = signal<PermissionRequest | null>(null)
  claudeStreaming = signal(false)
  claudeTokensPerSecond = signal(0)
  claudeSessionId = signal<string | null>(null)
  claudeCwd = signal('')
  claudeBranch = signal<string | null>(null)
  /** The model the running session reports, from the CLI's own init message. */
  claudeModel = signal('')
  claudeUsingSubscription = signal<boolean | null>(null)
  claudeOpenedAt = signal<number | null>(null)
  /** Spawned, but the CLI has not spoken yet. */
  claudeOpening = signal(false)
  /** Attached to the Claude Code session running in a terminal, rather than to a
   *  `--print` conversation of our own. */
  claudeIsLive = signal(false)

  diffPath = signal<string | null>(null)
  diffPatch = signal('')
  claudeRateLimitNote = signal<string | null>(null)

  // Errors surfaced to the user
  /**
   * The one sentence the app says out of band, and whether anything can be done
   * about it.
   *
   * An object rather than a string because the channel carries two kinds of
   * message and used to make them look identical: a fault waits to be read, a
   * receipt clears itself (see `note`), and a fault the host has marked retriable
   * can offer the retry instead of leaving the reader to find it on another
   * screen. `retriable` comes off the wire — the host sets it per error code —
   * so this is reported rather than guessed.
   */
  banner = signal<Banner | null>(null)

  /** A one-second tick, so the handful of readouts that genuinely age — the retry
   *  countdown, the stall clock, how long a permission has waited — can follow it
   *  without each screen running a timer of its own. */
  tick = signal(0)

  readonly renderers = new RendererPool()
  readonly linkMonitor = new LinkMonitor()
  private readonly client = new HostClient()
  private readonly pointerBudget = new PointerBudget()

  condition = computed<Condition>(() => {
    const link = this.link.value
    return conditionFrom(link.rttMillis, link.lossPercent, link.awake)
  })

  /** 0…4 for the bar indicator, derived from the same numbers shown as text. */
  signalBars = computed(() => {
    const link = this.link.value
    if (!link.awake || link.rttMillis == null) return 0
    if (link.rttMillis < 40 && link.lossPercent < 0.5) return 4
    if (link.rttMillis < 120 && link.lossPercent < 1) return 3
    if (link.rttMillis < 250 && link.lossPercent < 3) return 2
    return 1
  })

  selectedDisplay = computed(() => this.displays.value.find((entry) => entry.selected) ?? null)

  queuedInputCount = signal(0)

  constructor() {
    this.client.setHandlers({
      control: (payload) => this.receive(payload),
      video: (frame) => {
        // Rendering is off the main thread inside WebCodecs; the header's stream
        // id picks the decoder — one per display.
        this.renderers.renderer(frame.streamId).enqueue(frame)
      },
      state: (state) => this.connectionChanged(state),
      // The client promotes whichever address carried a working socket and
      // learns new ones off the Mac's own report, both while the screen is
      // drawn from this record. Without this the Settings sheet keeps naming the
      // address that stopped answering an hour ago.
      hostRecord: (host) => {
        this.pairedHost.value = host
      },
    })

    // A radio change is the one event that says "everything you knew about how
    // to reach the Mac may have just become wrong", and it is the moment this
    // client used to sit out: the socket had already given up, and nothing asked
    // it to try again until the tab was hidden and shown. Walking out of the
    // house and back in is exactly this event, twice.
    addEventListener('online', () => {
      void this.connectIfPaired()
    })

    // Tell the host which radio we are on so the cellular cap applies only when
    // it should.
    this.linkMonitor.onChange = (expensive, constrained) => {
      this.send({ t: 'link', expensive, constrained })
    }
    this.linkMonitor.start()

    setInterval(() => {
      this.tick.value += 1
      const queued = this.client.queuedInputCount
      if (queued !== this.queuedInputCount.value) this.queuedInputCount.value = queued
    }, 1000)

    void Identity.keyStorage().then((storage) => {
      this.keyStorage.value = storage
    })
  }

  // MARK: Lifecycle

  async load(): Promise<void> {
    const paired = await Identity.loadPairedHost().catch(() => null)
    batch(() => {
      this.pairedHost.value = paired
      this.route.value = paired ? 'home' : 'pairing'
      if (paired) this.hostName.value = paired.hostName
    })
    await this.connectIfPaired()
  }

  async connectIfPaired(): Promise<void> {
    const paired = this.pairedHost.value
    if (!paired) return
    await this.client.connect(paired)
    // Re-report on every connect; the host does not persist it.
    this.send({
      t: 'link',
      expensive: this.linkMonitor.isExpensive,
      constrained: this.linkMonitor.isConstrained,
    })
  }

  disconnect(): void {
    this.client.disconnect()
    this.renderers.resetAll()
    this.streamState.value = { kind: 'stopped' }
  }

  /**
   * `alternates` are the Mac's other addresses when the pairing link carried
   * them. They are kept with the pairing so this browser can find the same Mac
   * from a different network without trading keys again.
   */
  async completePairing(
    endpoint: Endpoint,
    code: string,
    alternates: string[] = [],
  ): Promise<string | null> {
    try {
      const paired = await this.client.pair(endpoint, code, alternates)
      batch(() => {
        this.pairedHost.value = paired
        this.hostName.value = paired.hostName
        this.route.value = 'home'
      })
      await this.client.connect(paired)
      return null
    } catch (error) {
      return (error as Error).message
    }
  }

  probe(endpoint: Endpoint): Promise<number | null> {
    return this.client.probe(endpoint)
  }

  /**
   * The Mac moved. Same Mac, same key, new address.
   *
   * Pairing binds a device id to a public key, and neither depends on where the Mac
   * is — so an address that stops answering is not a reason to trade keys again. The
   * phone has never had this and pays for it: `Identity.PairedHost` stores one
   * address, so a Mac that changes IP is unreachable until re-paired.
   *
   * A browser pays for it harder. A Cloudflare quick tunnel gets a fresh hostname on
   * every host restart, and the published copy of this client cannot read the Mac's
   * address off its own origin the way the host-served copy does — so it holds a
   * stored address that is dead by design, several times a day.
   *
   * Probes before committing: replacing a working address with a typo would be a
   * worse outcome than the problem being solved.
   */
  async repoint(endpoint: Endpoint): Promise<string | null> {
    const paired = this.pairedHost.value
    if (!paired) return 'Nothing is paired, so there is no address to change.'

    const blocked = describe(endpoint)
    if (reachability(endpoint) === 'blocked') return blocked

    if ((await this.client.probe(endpoint)) == null) {
      return `Nothing answered at ${endpoint.host}. The address is unchanged.`
    }

    // The addresses already known for this Mac are kept rather than discarded: a
    // Mac at a new tunnel hostname is still at the same LAN address when this
    // browser comes home.
    const moved: PairedHost = {
      ...paired,
      origin: endpoint.origin,
      host: endpoint.host,
      port: endpoint.port,
      alternates: normaliseOrigins([paired.origin, ...paired.alternates]).filter(
        (entry) => entry !== endpoint.origin,
      ),
    }
    await Identity.savePairedHost(moved)
    this.pairedHost.value = moved

    // Retire the old socket explicitly. Its backoff has usually given up by the time
    // anyone reaches for this, and `connect` declines to open a second socket for a
    // device that already has one.
    this.client.disconnect()
    this.banner.value = null
    await this.connectIfPaired()
    return null
  }

  /**
   * Pairing from this page's own URL.
   *
   * A browser cannot be the handler for `vibewire://`, so the Mac's second QR
   * encodes an ordinary `https://…/?code=482917` instead — which the phone's own
   * camera opens, in the browser, with no app and no scanner. This is what reads
   * it, and it is why scanning is one action rather than four.
   *
   * `host` is optional and usually absent. Left out, the address is this page's
   * own origin: the bundle was served by the Mac, so the Mac is already known,
   * and leaving it out keeps the QR small enough to scan from across a desk. It
   * is still honoured when present, so a link pointing at one Mac from a page
   * served by another keeps working.
   */
  async handlePairingParams(search: string, hash: string): Promise<void> {
    const parameters = new URLSearchParams(search || '')
    if (hash.startsWith('#')) {
      for (const [key, value] of new URLSearchParams(hash.slice(1))) {
        if (!parameters.has(key)) parameters.set(key, value)
      }
    }

    const code = parameters.get('code')
    if (!code) return
    if (code.length !== 6 || !/^\d{6}$/.test(code)) {
      this.banner.value = { text: 'That pairing link does not carry a six-digit code.' }
      return
    }

    const address = parameters.get('origin') ?? parameters.get('host') ?? location.origin
    let endpoint: Endpoint
    try {
      const port = Number(parameters.get('port') ?? 8787)
      endpoint = parseEndpoint(address, Number.isFinite(port) ? port : 8787)
    } catch (error) {
      this.banner.value = { text: (error as Error).message }
      return
    }

    // `alt` is the Mac's other addresses, comma-separated. Usually absent — the
    // QR stays small by leaving them out, and they arrive over the socket within
    // a second of connecting — but honoured when a link does carry them, so a
    // pairing that happens from cellular already knows the way home.
    const alternates = normaliseOrigins((parameters.get('alt') ?? '').split(','))

    const paired = this.pairedHost.value
    if (paired) {
      // Already paired. Two cases, and the difference matters.
      //
      // Same address: a stale link in history, or a reload. Ignore it — pairing again
      // would tear down a working session and burn a code that has since rotated.
      if (paired.origin === endpoint.origin) return

      // Different address: the Mac moved, and scanning the QR again is exactly what
      // anyone would do about it. Follow it rather than trading keys — the key and the
      // device id do not depend on where the Mac is, and this is the fix for a
      // Cloudflare quick tunnel whose hostname changes on every host restart.
      const problem = await this.repoint(endpoint)
      if (!problem && alternates.length > 0) this.client.learn(alternates)
      this.banner.value = problem ? { text: problem } : null
      return
    }

    const failure = await this.completePairing(endpoint, code, alternates)
    if (failure) this.banner.value = { text: failure }
  }

  /**
   * The socket is gone for good, so nothing Claude was doing is being reported
   * any more.
   *
   * `claudeStreaming` was left true by every path that lost a connection, so the
   * composer kept a red STOP on it and the header kept saying it was writing —
   * about a socket that had given up. And a pending permission carries a request
   * id on a dead connection: its two buttons send an answer into nothing, which
   * is worse than the question disappearing, because the reader believes they
   * answered it.
   */
  private claudeWentQuiet(): void {
    this.claudeStreaming.value = false
    this.claudeTokensPerSecond.value = 0
    this.permission.value = null
  }

  /**
   * A confirmation, which clears itself.
   *
   * The banner carries two different kinds of sentence through one signal. A
   * fault — the Mac was lost, Accessibility is off, the host refused something —
   * has to stay until it is read and dismissed. A confirmation that something
   * crossed over does not: it is the receipt for an act the reader just
   * performed, and leaving it on the glass makes every COPY cost a second tap.
   *
   * Faults keep writing `banner` directly. Only the receipts come through here,
   * and a later banner of either kind cancels this one's timer rather than being
   * wiped by it.
   */
  note(text: string): void {
    this.banner.value = { text }
    const mine = text
    if (this.noteTimer) clearTimeout(this.noteTimer)
    this.noteTimer = setTimeout(() => {
      this.noteTimer = null
      if (this.banner.value?.text === mine) this.banner.value = null
    }, NOTE_MILLIS)
  }

  private connectionChanged(state: ConnectionState): void {
    this.connection.value = state
    switch (state.kind) {
      case 'connected':
        this.banner.value = null
        if (this.streamState.value.kind === 'reconnecting') {
          this.streamState.value = { kind: 'live' }
        }
        break
      case 'reconnecting':
        this.streamState.value = {
          kind: 'reconnecting',
          attempt: state.attempt,
          nextRetryMs: state.nextRetryMs,
        }
        // The run itself is on the Mac and may well still be going, so this does
        // not stop being a stream — but nothing is measuring its rate while the
        // socket is down, and the panel already prints WORKING for a rate of
        // zero, which is the honest word for it.
        this.claudeTokensPerSecond.value = 0
        break
      case 'failed':
        this.streamState.value = { kind: 'failed', reason: state.reason }
        this.banner.value = { text: `Lost the Mac. ${state.reason}` }
        this.claudeWentQuiet()
        break
      case 'unauthorized':
        // Retrying cannot help: the Mac no longer holds this device's key.
        this.streamState.value = { kind: 'failed', reason: 'device revoked' }
        this.banner.value = { text: 'This Mac no longer recognises this browser. Pair again.' }
        this.claudeWentQuiet()
        this.unpairLocally()
        break
      default:
        break
    }
  }

  // MARK: Inbound

  private receive(payload: ControlMessage): void {
    const type = payload['t']
    if (typeof type !== 'string') return

    switch (type) {
      case 'hello':
        batch(() => {
          this.hostName.value = str(payload['hostName']) ?? 'Mac'
          this.hostModel.value = str(payload['model']) ?? ''
          this.hostOS.value = str(payload['os']) ?? ''
          this.capabilities.value = (payload['capabilities'] as Record<string, boolean>) ?? {}
          if (this.capabilities.value['screenRecording'] === false) {
            this.banner.value = {
                text: 'Screen Recording is off on the Mac. Grant it in System Settings.',
              }
          } else if (this.capabilities.value['accessibility'] === false) {
            this.banner.value = { text: 'Accessibility is off on the Mac. Input will not reach it.' }
          }
        })
        break

      case 'status':
        this.link.value = {
          awake: bool(payload['awake'], true),
          onPower: bool(payload['onPower'], true),
          rttMillis: num(payload['rttMillis']),
          jitterMillis: num(payload['jitterMillis']),
          lossPercent: num(payload['lossPercent']) ?? 0,
          downMbps: num(payload['downMbps']) ?? 0,
          rttHistory: (payload['rttHistory'] as number[]) ?? [],
          frontmostApp: str(payload['frontmostApp']) ?? '',
          canWake: bool(payload['canWake'], true),
        }
        break

      case 'displays': {
        const entries = ((payload['displays'] as Record<string, unknown>[]) ?? [])
          .map((entry): DisplayEntry | null => {
            const id = num(entry['id'])
            const name = str(entry['name'])
            if (id == null || name == null) return null
            return {
              id,
              name,
              width: num(entry['width']) ?? 0,
              height: num(entry['height']) ?? 0,
              refreshHz: num(entry['hz']) ?? 60,
              isBuiltIn: bool(entry['isBuiltIn'], false),
              selected: bool(entry['selected'], false),
              streamId: num(entry['streamId']),
            }
          })
          .filter((entry): entry is DisplayEntry => entry != null)

        this.displays.value = entries
        if (!entries.some((entry) => entry.selected) && entries[0]) {
          this.selectDisplay(entries[0].id)
        }
        // The host is the authority on what is selected. Without this the tabs
        // could read MON 1 while the host was streaming both, and the single
        // picture would be fed two streams at once.
        this.sideBySide.value = entries.filter((entry) => entry.selected).length > 1
        break
      }

      case 'transport': {
        const transport: TransportStatus = {
          path: (str(payload['path']) as TransportStatus['path']) ?? 'none',
          tailscaleRunning: bool(payload['tailscaleRunning'], false),
          tailscaleAddress: str(payload['tailscaleAddress']),
          relayName: str(payload['relayName']),
          cloudflareRunning: bool(payload['cloudflareRunning'], false),
          cloudflareHostname: str(payload['cloudflareHostname']),
          lanAddress: str(payload['lanAddress']),
          candidates: [],
        }
        transport.candidates = candidateOrigins(payload, transport, this.pairedHost.value)
        this.transport.value = transport
        // The Mac is the only thing that knows all of its own addresses, and a
        // Cloudflare quick tunnel's hostname exists nowhere else — it is minted
        // at host launch and never written down. Learning it here, over a socket
        // that is already up, is what lets this browser reach the same Mac from
        // cellular later without pairing again.
        this.client.learn(transport.candidates)
        break
      }

      case 'settings':
        this.settings.value = {
          quality: str(payload['quality']) ?? 'auto',
          capOnCellular: bool(payload['capOnCellular'], true),
          cellularCeilingMbps: num(payload['cellularCeilingMbps']) ?? 3,
          sensitivity: num(payload['sensitivity']) ?? 5,
          naturalScrolling: bool(payload['naturalScrolling'], true),
          requireBiometricEachSession: bool(payload['requireBiometricEachSession'], true),
          relayOverInternet: bool(payload['relayOverInternet'], false),
          hostVersion: str(payload['hostVersion']) ?? '—',
        }
        break

      case 'devices':
        this.devices.value = ((payload['devices'] as Record<string, unknown>[]) ?? [])
          .map((entry): PairedDeviceEntry | null => {
            const id = str(entry['id'])
            const name = str(entry['name'])
            if (!id || !name) return null
            return {
              id,
              name,
              kind: str(entry['kind']) ?? 'phone',
              pairedAt: date(entry['pairedAt']) ?? Date.now(),
              lastSeenAt: date(entry['lastSeenAt']),
              connected: bool(entry['connected'], false),
              isThisDevice: bool(entry['isThisDevice'], false),
            }
          })
          .filter((entry): entry is PairedDeviceEntry => entry != null)
        break

      case 'streamState':
        this.applyStreamState(payload)
        break

      case 'videoConfig': {
        const streamId = num(payload['streamId'])
        if (streamId == null) return
        this.videoConfigs.value = {
          ...this.videoConfigs.value,
          [streamId]: {
            streamId,
            displayId: num(payload['displayId']) ?? 0,
            width: num(payload['width']) ?? 0,
            height: num(payload['height']) ?? 0,
            fps: num(payload['fps']) ?? 60,
            bitrate: num(payload['bitrate']) ?? 0,
            ladder: str(payload['ladder']) ?? 'auto',
          },
        }
        this.renderers.keepOnly(
          new Set(Object.keys(this.videoConfigs.value).map((key) => Number(key))),
        )
        break
      }

      case 'clipboard': {
        if (str(payload['direction']) !== 'fromMac') return
        const text = str(payload['text'])
        if (!text) return
        // A clipboard write with no user gesture behind it is refused by most
        // browsers, and this one has none: the text arrived over a socket seconds
        // after the tap that asked for it. So the outcome is reported rather than
        // assumed. Refused, the text is shown with a button to copy it, which is a
        // gesture the browser does accept.
        // Not an optional chain on the whole call: `navigator.clipboard?.write…`
        // short-circuits to `undefined` where the API is absent, which takes both
        // handlers with it — and it is absent on the origin this app is most
        // often opened from, because the Mac serves the page over plain HTTP and
        // that is not a secure context. COPY then did nothing and said nothing,
        // which is the exact failure this branch exists to report.
        if (navigator.clipboard?.writeText) {
          void navigator.clipboard
            .writeText(text)
            .then(() => {
              this.note(`Copied from the Mac: ${firstLine(text)}`)
            })
            .catch(() => {
              this.clipboardOffer.value = text
            })
        } else {
          this.clipboardOffer.value = text
        }
        break
      }

      case 'screenshot': {
        const png = str(payload['png'])
        if (png) this.screenshot.value = `data:image/png;base64,${png}`
        break
      }

      case 'lastFrame':
        this.lastFrameAgeSeconds.value = num(payload['ageSeconds'])
        this.lastFrameAgeAt = performance.now()
        break

      case 'frontmost':
        this.link.value = {
          ...this.link.value,
          frontmostApp: str(payload['app']) ?? this.link.value.frontmostApp,
        }
        break

      case 'claude':
        this.receiveClaude(payload)
        break

      case 'error':
        this.banner.value = {
          text: str(payload['message']) ?? 'The Mac reported an error.',
          // The host marks its own errors: a capture that failed is worth trying
          // again, a refused request is not. Both used to read identically and
          // offer nothing.
          retriable: payload['retriable'] === true,
        }
        break

      default:
        break
    }
  }

  private applyStreamState(payload: ControlMessage): void {
    switch (str(payload['state'])) {
      case 'starting':
        this.streamState.value = { kind: 'starting' }
        break
      case 'live':
        batch(() => {
          this.streamState.value = { kind: 'live' }
          this.streamSessionCount.value += 1
          writeStreamSessions(this.streamSessionCount.value)
        })
        break
      case 'stalled':
        this.streamState.value = { kind: 'stalled', millis: num(payload['stalledMs']) ?? 0 }
        break
      case 'stopped':
        this.streamState.value = { kind: 'stopped' }
        this.renderers.resetAll()
        break
      default:
        break
    }
  }

  private receiveClaude(payload: ControlMessage): void {
    const sub = str(payload['sub'])
    if (!sub) return

    switch (sub) {
      case 'sessions':
        this.claudeSessions.value = ((payload['sessions'] as Record<string, unknown>[]) ?? [])
          .map((entry): ClaudeSessionEntry | null => {
            const id = str(entry['id'])
            if (!id) return null
            return {
              id,
              summary: str(entry['summary']) ?? 'Untitled',
              cwd: str(entry['cwd']) ?? '',
              gitBranch: str(entry['gitBranch']),
              modifiedAt: date(entry['modifiedAt']) ?? Date.now(),
              messageCount: num(entry['messages']) ?? 0,
            }
          })
          .filter((entry): entry is ClaudeSessionEntry => entry != null)
        break

      case 'opened': {
        const incoming = str(payload['sessionId'])
        batch(() => {
          if (incoming) this.claudeSessionId.value = incoming
          this.claudeCwd.value = str(payload['cwd']) ?? this.claudeCwd.value
          // Attached to the session running in a terminal rather than to a private
          // one of our own. Worth holding onto: re-opening would silently drop
          // back to a separate conversation the user cannot see.
          this.claudeIsLive.value = bool(payload['live'], false)
          if (this.claudeIsLive.value) this.claudeOpening.value = false
        })

        // The host acks the spawn before the CLI has said anything. That ack
        // carries no model, no tools and no auth source, so it must not overwrite
        // them — it only proves something is running.
        if (payload['pending'] === true) return

        batch(() => {
          this.claudeOpening.value = false
          // Which model is answering. The host has sent this since the bridge was
          // written and nothing has ever read it — on a panel whose subheading
          // already carries the auth source, because that is the fact worth
          // stating about a session, and the model is the other one.
          this.claudeModel.value = str(payload['model']) ?? ''
          this.claudeUsingSubscription.value =
            typeof payload['usingSubscription'] === 'boolean'
              ? (payload['usingSubscription'] as boolean)
              : null
          this.claudeOpenedAt.value = Date.now()
          this.toolCalls.value = []
          this.changedFiles.value = []
          if (this.claudeUsingSubscription.value === false) {
            this.banner.value = { text: 'Claude is billing through an API key, not your subscription.' }
          }
        })
        break
      }

      case 'diff':
        if (str(payload['path']) !== this.diffPath.value) return
        this.diffPatch.value = str(payload['patch']) ?? ''
        break

      case 'history':
        // Sent once, right after a resume. Replaces rather than appends: the
        // transcript on disk is the authority on what was said before this
        // connection existed.
        this.claudeTurns.value = ((payload['turns'] as Record<string, unknown>[]) ?? [])
          .map((entry): ClaudeTurn | null => {
            const role = str(entry['role'])
            const text = str(entry['text'])
            if (!role || text == null) return null
            turnSequence += 1
            return {
              id: turnSequence,
              role: role === 'user' ? 'user' : 'assistant',
              text,
              at: date(entry['at']) ?? Date.now(),
            }
          })
          .filter((entry): entry is ClaudeTurn => entry != null)
        break

      case 'delta': {
        // A session that is answering has plainly started. `claudeOpening` was
        // only ever cleared by an `opened` message, which a brand new session need
        // not send, so the header sat on "STARTING · SEND A MESSAGE TO BEGIN" with
        // the reply printed directly beneath it.
        const text = str(payload['text'])
        batch(() => {
          this.claudeOpening.value = false
          this.claudeStreaming.value = true
          const tps = num(payload['tokensPerSecond'])
          if (tps != null) this.claudeTokensPerSecond.value = tps
          if (text == null) return
          this.appendAssistantText(text)
        })
        break
      }

      case 'message': {
        const blocks = (payload['blocks'] as Record<string, unknown>[]) ?? []
        const text = blocks
          .filter((block) => block['type'] === 'text')
          .map((block) => str(block['text']) ?? '')
          .join('\n')

        batch(() => {
          this.claudeOpening.value = false
          this.claudeStreaming.value = false
        })
        if (!text) return

        // `role` was ignored here once, and the CLI runs with
        // `--replay-user-messages`, so the user's own prompt came back as a
        // `message` and was written *over* the assistant's turn — the reply was
        // replaced by the question that prompted it.
        if (str(payload['role']) === 'user') {
          const turns = this.claudeTurns.value
          const last = turns[turns.length - 1]
          const alreadyShown = last?.role === 'user' && last.text === text
          if (!alreadyShown) this.appendTurn('user', text)
          return
        }

        const turns = this.claudeTurns.value
        const last = turns[turns.length - 1]
        if (last?.role === 'assistant' && last.text.length > 0) {
          // The streamed deltas already built this turn; replace with the
          // authoritative final text rather than appending a duplicate.
          this.claudeTurns.value = [...turns.slice(0, -1), { ...last, text }]
        } else {
          this.appendTurn('assistant', text)
        }
        break
      }

      case 'tool': {
        const id = str(payload['id'])
        if (!id) return
        const call: ToolCall = {
          id,
          name: str(payload['name']) ?? '',
          target: str(payload['target']) ?? '',
          state: (str(payload['state']) as ToolCall['state']) ?? 'running',
          milliseconds: num(payload['ms']),
          preview: str(payload['preview']),
        }
        batch(() => {
          this.claudeOpening.value = false
          const existing = this.toolCalls.value
          const index = existing.findIndex((entry) => entry.id === id)
          this.toolCalls.value =
            index >= 0
              ? existing.map((entry, at) => (at === index ? call : entry))
              : [...existing, call]
        })
        break
      }

      case 'files':
        this.changedFiles.value = ((payload['files'] as Record<string, unknown>[]) ?? [])
          .map((entry): ChangedFile | null => {
            const path = str(entry['path'])
            if (!path) return null
            return {
              path,
              status: str(entry['status']) ?? 'M',
              added: num(entry['added']) ?? 0,
              removed: num(entry['removed']) ?? 0,
            }
          })
          .filter((entry): entry is ChangedFile => entry != null)
        break

      case 'permission': {
        const id = str(payload['requestId'])
        if (!id) return
        this.permission.value = {
          id,
          toolName: str(payload['toolName']) ?? '',
          command: str(payload['command']) ?? '',
          explanation: str(payload['explanation']) ?? '',
          arrivedAt: Date.now(),
        }
        break
      }

      case 'usage':
        this.claudeStreaming.value = false
        break

      case 'rateLimit': {
        const status = str(payload['status'])
        this.claudeRateLimitNote.value =
          status && status !== 'allowed' ? `Rate limited (${status})` : null
        break
      }

      case 'ended':
        batch(() => {
          this.claudeStreaming.value = false
          this.claudeSessionId.value = null
        })
        break

      case 'error':
        this.banner.value = { text: str(payload['message']) ?? 'Claude reported an error.' }
        break

      default:
        break
    }
  }

  private appendTurn(role: ClaudeTurn['role'], text: string): void {
    turnSequence += 1
    this.claudeTurns.value = [
      ...this.claudeTurns.value,
      { id: turnSequence, role, text, at: Date.now() },
    ]
  }

  private appendAssistantText(text: string): void {
    const turns = this.claudeTurns.value
    const last = turns[turns.length - 1]
    if (last?.role === 'assistant') {
      this.claudeTurns.value = [...turns.slice(0, -1), { ...last, text: last.text + text }]
    } else {
      this.appendTurn('assistant', text)
    }
  }

  // MARK: Outbound

  private send(message: ControlMessage): void {
    this.client.send(message)
  }

  private sendTransient(message: ControlMessage): void {
    this.client.sendTransient(message)
  }

  selectDisplay(id: number): void {
    // The host numbers streams by position within the selection, so a single
    // display is always stream 0 and an unselected one has no stream at all.
    // Leaving the previous value here is what left the picture black on the way
    // back from side by side: display 2 kept claiming stream 1, the window before
    // `videoConfig` arrives resolved the picture to renderer 1, and every frame of
    // the new single stream was arriving on renderer 0.
    batch(() => {
      this.displays.value = this.displays.value.map((entry) => ({
        ...entry,
        selected: entry.id === id,
        streamId: entry.id === id ? 0 : null,
      }))
      this.sideBySide.value = false
    })
    this.send({ t: 'selectDisplay', displayIds: [id], mode: 'single' })
  }

  selectBothDisplays(): void {
    // Same numbering the host uses, over the same order sent below.
    batch(() => {
      this.displays.value = this.displays.value.map((entry, index) => ({
        ...entry,
        selected: true,
        streamId: index,
      }))
      this.sideBySide.value = true
    })
    this.send({
      t: 'selectDisplay',
      displayIds: this.displays.value.map((entry) => entry.id),
      mode: 'sideBySide',
    })
  }

  /** The decoder carrying a given display. One per stream — see RendererPool. */
  renderer(displayId: number): VideoRenderer {
    const configs = Object.values(this.videoConfigs.value)
    const config = configs.find((entry) => entry.displayId === displayId)
    if (config) return this.renderers.renderer(config.streamId)

    const declared = this.displays.value.find((entry) => entry.id === displayId)?.streamId
    if (declared != null) return this.renderers.renderer(declared)

    // Falling back to stream 0 for *every* display made both side-by-side panes
    // resolve to the same renderer in the window before `videoConfig` arrives —
    // one canvas, two panes, and the second took it. The host assigns stream ids
    // in the order of the selected displays, so that order is the right guess to
    // make meanwhile, and it never collides.
    const selected = this.displays.value.filter((entry) => entry.selected)
    const index = selected.findIndex((entry) => entry.id === displayId)
    return this.renderers.renderer(index >= 0 ? index : 0)
  }

  selectedRenderer(): VideoRenderer {
    const display = this.selectedDisplay.value
    return display ? this.renderer(display.id) : this.renderers.renderer(0)
  }

  startStream(): void {
    // Stream ids are reassigned per start; keeping the old configs would point a
    // pane at a decoder the host is no longer filling. Resetting the renderers is
    // not enough for the same reason — a reset renderer is still the object stream
    // 1 resolved to a moment ago, and a view that already adopted its canvas would
    // hold a decoder nothing feeds. Drop them, so the next resolution builds a
    // renderer for the new numbering.
    batch(() => {
      this.videoConfigs.value = {}
      this.renderers.removeAll()
      this.streamState.value = { kind: 'starting' }
      this.route.value = 'remote'
    })
    this.send({
      t: 'startStream',
      displayIds: this.displays.value.filter((entry) => entry.selected).map((entry) => entry.id),
    })
  }

  stopStream(): void {
    this.send({ t: 'stopStream' })
    this.renderers.resetAll()
    batch(() => {
      this.streamState.value = { kind: 'stopped' }
      this.showHub.value = false
      this.showKeyboard.value = false
      this.route.value = 'home'
    })
    this.releaseModifiers()
  }

  // MARK: Input

  movePointer(dx: number, dy: number): void {
    // Coalesce to the display refresh; sending every sample would flood the socket
    // without moving the cursor any more accurately.
    if (!this.pointerBudget.shouldSend()) {
      this.pointerBudget.accumulate(dx, dy)
      return
    }
    const [totalX, totalY] = this.pointerBudget.drain(dx, dy)
    const display = this.selectedDisplay.value
    if (!display) return
    this.sendTransient({
      t: 'pointer',
      phase: 'move',
      dx: totalX,
      dy: totalY,
      display: display.id,
      sensitivity: this.settings.value.sensitivity,
    })
  }

  click(count = 1, button = 'left'): void {
    const display = this.selectedDisplay.value
    const message: ControlMessage = { t: 'click', button, count }
    if (display) message['display'] = display.id
    this.send(message)
  }

  /** `count` is the click the button goes down on: 2 is a double-tap that held on
   *  and is now dragging, which is how a word is selected and then stretched. */
  drag(phase: 'begin' | 'move' | 'end', dx = 0, dy = 0, count = 1): void {
    this.send({ t: 'drag', phase, dx, dy, count })
  }

  scroll(dx: number, dy: number, momentum = false): void {
    this.sendTransient({ t: 'scroll', dx, dy, momentum })
  }

  zoom(scale: number): void {
    const clamped = Math.min(Math.max(scale, 1), 6)
    const delta = clamped / Math.max(this.zoomScale.value, 0.01)
    this.zoomScale.value = clamped
    this.sendTransient({ t: 'zoom', scale: delta, locked: this.zoomLocked.value })
  }

  resetZoom(): void {
    this.zoomScale.value = 1
    this.sendTransient({ t: 'zoom', scale: 0.01, locked: false })
  }

  toggleModifier(name: string): void {
    const latched = this.latchedModifiers
    this.latchedModifiers = latched.includes(name)
      ? latched.filter((entry) => entry !== name)
      : [...latched, name]
    this.publishModifiers(true)
  }

  /** What a physical keyboard reports as down right now. */
  setModifiers(names: string[]): void {
    this.physicalModifiers = names
    this.publishModifiers(false)
  }

  private publishModifiers(latched: boolean): void {
    const next = [...new Set([...this.latchedModifiers, ...this.physicalModifiers])].sort()
    if (next.join() === [...this.heldModifiers.value].sort().join()) return
    this.heldModifiers.value = next
    this.send({ t: 'modifiers', held: next, latched })
  }

  releaseModifiers(): void {
    this.latchedModifiers = []
    this.physicalModifiers = []
    if (!this.heldModifiers.value.length) return
    this.heldModifiers.value = []
    this.send({ t: 'modifiers', held: [], latched: false })
  }

  key(code: string, chars?: string): void {
    const down: ControlMessage = { t: 'key', code, down: true }
    const up: ControlMessage = { t: 'key', code, down: false }
    if (chars != null) {
      down['chars'] = chars
      up['chars'] = chars
    }
    this.send(down)
    this.send(up)
    // A modifier tapped before a letter fires once and releases, which is the
    // behaviour the key-row detail panel describes.
    if (this.heldModifiers.value.length) this.releaseModifiers()
  }

  /** Held down and released separately — what a real keyboard does, and the only
   *  way key repeat can work. */
  keyDown(code: string, chars?: string): void {
    const message: ControlMessage = { t: 'key', code, down: true }
    if (chars != null) message['chars'] = chars
    this.send(message)
  }

  keyUp(code: string, chars?: string): void {
    const message: ControlMessage = { t: 'key', code, down: false }
    if (chars != null) message['chars'] = chars
    this.send(message)
  }

  combo(keys: string[]): void {
    this.send({ t: 'combo', keys })
  }

  type(text: string): void {
    if (!text) return
    this.send({ t: 'text', value: text })
  }

  async hub(action: string): Promise<void> {
    if (action === 'paste') {
      // Push this machine's clipboard first, then ask for the keystroke. The read
      // needs a user gesture, which a tap on the spoke is — but it can still be
      // refused outright, and that has to be said rather than silently pasting
      // whatever the Mac already had.
      try {
        const text = await navigator.clipboard.readText()
        if (text) this.send({ t: 'clipboardPush', text })
      } catch {
        this.banner.value = {
            text: 'The browser would not let this page read the clipboard, so nothing was pushed to the Mac.',
          }
        return
      }
    }
    this.send({ t: 'hubAction', action })
    // Every action that reaches here closes the drawer. `keys` and `mods` never
    // do: the drawer handles both itself, synchronously, because iOS only opens
    // the system keyboard from inside the tap that asks for it.
    this.showHub.value = false
  }

  requestLastFrame(): void {
    this.send({ t: 'lastFrame' })
  }

  retry(): void {
    this.send({ t: 'retry' })
    void this.connectIfPaired()
  }

  wake(): void {
    this.send({ t: 'wake' })
  }

  // MARK: Settings

  setSetting(key: string, value: boolean | number | string): void {
    this.send({ t: 'setting', key, value })
  }

  setQuality(ladder: string): void {
    this.settings.value = { ...this.settings.value, quality: ladder }
    this.send({ t: 'setQuality', ladder })
  }

  /**
   * Revokes go out only if the socket is up. Queuing one would hold it until the
   * next connection — which, after an unpair, is a different device entirely, and
   * it would be revoked the instant it finished pairing.
   */
  revoke(device: PairedDeviceEntry): void {
    this.revokeTarget.value = null
    if (!this.client.sendUnqueued({ t: 'revoke', deviceId: device.id })) {
      this.banner.value = { text: 'Not connected to the Mac, so nothing was revoked.' }
      return
    }
    if (device.isThisDevice) this.unpairLocally()
  }

  revokeAll(): void {
    this.revokeTarget.value = null
    if (!this.client.sendUnqueued({ t: 'revoke', all: true })) {
      this.banner.value = { text: 'Not connected to the Mac, so nothing was revoked.' }
      return
    }
    this.unpairLocally()
  }

  /**
   * This browser forgets the Mac, and nothing else happens.
   *
   * Deliberately not a revoke. Revoking deletes keys on the Mac and takes every
   * other device with it; this drops only what this browser holds, so the Mac
   * keeps its row for this device and the next pairing reuses it rather than
   * adding a second. Two different acts with two different costs, and the sheet
   * says which is which.
   */
  logOut(): void {
    this.unpairLocally()
  }

  private unpairLocally(): void {
    // Everything below used to sit behind `await Identity.forgetHost()`. That is
    // an IndexedDB round trip, and a browser can leave one pending indefinitely —
    // a blocked upgrade, a storage prompt, an origin under pressure. When it did,
    // nothing after it ran: revoking every device sent the message to the Mac,
    // the sheet closed, and the screen stayed exactly where it was, still showing
    // a paired session for keys that had just been deleted on the other end.
    //
    // The in-memory state is what the screen is drawn from, so it goes first and
    // unconditionally. Forgetting the stored record is the durable half and can
    // take as long as it likes; a reload before it lands finds the record and
    // fails to connect, which is the state the Mac is already in.
    batch(() => {
      this.pairedHost.value = null
      this.route.value = 'pairing'
      // Revoking every device is triggered from inside the Settings sheet, so
      // without this the sheet stays up over the pairing screen — settings for a
      // host this browser no longer has a key to.
      this.presented.value = null
      this.revokeTarget.value = null
      // The two sheets that are not presentations and so were not covered by the
      // line above: both render whatever the route is, and both hold something
      // the Mac sent. A revoke that leaves a picture of the Mac's screen — or the
      // text off its clipboard — sitting over the pairing screen has severed the
      // key and left the contents on the glass.
      this.screenshot.value = null
      this.clipboardOffer.value = null
      // Controls for a machine this browser no longer has a key to.
      this.showHub.value = false
      this.showKeyboard.value = false
      this.claudeWentQuiet()
    })
    this.disconnect()
    void Identity.forgetHost().catch(() => undefined)
  }

  // MARK: Claude

  openClaude(mode: ClaudeMode, sessionId?: string, cwd?: string): void {
    batch(() => {
      this.claudeMode.value = mode
      this.claudeTurns.value = []
      this.toolCalls.value = []
      this.changedFiles.value = []
      this.permission.value = null

      // Show the picked session straight away. The CLI does not say a word until
      // it has been given something to do, so waiting for its `init` left the
      // panel reading NO SESSION with a live process behind it — which looks
      // exactly like the tap having done nothing.
      if (sessionId) this.claudeSessionId.value = sessionId
      if (cwd) this.claudeCwd.value = cwd
      // The branch comes with the session list and nowhere else, so nothing ever
      // set this and the panel's branch chip could not render at all — while the
      // picker two taps away had been showing the branch for every session in it.
      this.claudeBranch.value =
        this.claudeSessions.value.find((entry) => entry.id === sessionId)?.gitBranch ?? null
      this.claudeUsingSubscription.value = null
      this.claudeOpenedAt.value = Date.now()
      this.claudeOpening.value = true
    })

    const message: ControlMessage = { t: 'claude', sub: 'open', mode }
    if (sessionId) message['sessionId'] = sessionId
    if (cwd) message['cwd'] = cwd
    this.send(message)
  }

  /**
   * Opens the live diff for a file. The host pushes a fresh patch after every tool
   * result until it is closed, so an edit lands on screen as it happens rather
   * than when something is refreshed.
   */
  openDiff(path: string): void {
    batch(() => {
      this.diffPath.value = path
      this.diffPatch.value = ''
    })
    this.send({ t: 'claude', sub: 'diff', path })
  }

  closeDiff(): void {
    batch(() => {
      this.diffPath.value = null
      this.diffPatch.value = ''
    })
    // No path means stop watching; without it the host keeps computing a diff for
    // a screen nobody is looking at.
    this.send({ t: 'claude', sub: 'diff' })
  }

  listClaudeSessions(): void {
    this.send({ t: 'claude', sub: 'listSessions' })
  }

  sendToClaude(text: string): void {
    if (!text.trim()) return
    this.appendTurn('user', text)
    this.claudeStreaming.value = true
    this.send({ t: 'claude', sub: 'send', text })
  }

  interruptClaude(): void {
    this.send({ t: 'claude', sub: 'interrupt' })
    this.claudeStreaming.value = false
  }

  answerPermission(allow: boolean, scope: 'once' | 'always', message?: string): void {
    const permission = this.permission.value
    if (!permission) return
    const payload: ControlMessage = {
      t: 'claude',
      sub: 'permission',
      requestId: permission.id,
      behavior: allow ? 'allow' : 'deny',
      scope,
    }
    if (message != null) payload['message'] = message
    this.send(payload)
    this.permission.value = null
  }
}

// MARK: - Payload coercion
//
// The wire is JSON and the host is Swift, so `nil` arrives as `null` on some
// fields and is simply absent on others. These four keep every read site from
// spelling that out again.

/**
 * Every address this Mac can be reached on, best first.
 *
 * A current host works this out itself and sends the list; that answer is taken
 * whole, because the order in it is the Mac's judgement about which path is
 * worth preferring and this page is in no position to second-guess it.
 *
 * A host built before that field existed sends the same facts spread across
 * three keys, so the list is assembled from those instead. The order is the
 * Mac's: the tailnet address first, since it is a direct route where a direct
 * route exists and falls back to DERP rather than to nothing; the LAN address
 * next, which answers only at home but answers fastest there; the Cloudflare
 * tunnel last, because it is a round trip through Cloudflare — and it is on the
 * list at all because it is the one address that answers from a browser with no
 * Wi-Fi and no Tailscale.
 *
 * The port is not on the wire in that older shape either. The paired origin's
 * port is the right guess: it is the port this browser is already talking to
 * this Mac on.
 */
function candidateOrigins(
  payload: Record<string, unknown>,
  transport: TransportStatus,
  paired: PairedHost | null,
): string[] {
  const reported = payload['candidates']
  if (Array.isArray(reported)) {
    const origins = reported.filter((entry): entry is string => typeof entry === 'string')
    if (origins.length > 0) return normaliseOrigins(origins)
  }

  const port = num(payload['port']) ?? paired?.port ?? 8787
  const local: string[] = []
  if (transport.tailscaleAddress) local.push(`http://${transport.tailscaleAddress}:${port}`)
  if (transport.lanAddress) local.push(`http://${transport.lanAddress}:${port}`)

  const tunnel =
    transport.cloudflareRunning && transport.cloudflareHostname
      ? transport.cloudflareHostname.replace(/\/+$/, '')
      : null

  return normaliseOrigins(tunnel ? [...local, tunnel] : local)
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback
}

function date(value: unknown): number | null {
  if (typeof value !== 'string') return null
  const parsed = Date.parse(value)
  return Number.isNaN(parsed) ? null : parsed
}

export const store = new Store()
