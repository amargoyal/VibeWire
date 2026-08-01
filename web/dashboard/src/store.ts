/**
 * What the dashboard knows, and how it finds out.
 *
 * Two loops. The state poll asks the host once a second for everything it
 * measures, which is exactly the cadence the host measures it at — its heartbeat
 * is a one-second timer, so a faster poll would return the same numbers twice.
 * The event poll runs at 500 ms and drains the same `claude` messages the phone's
 * socket receives, because Claude's output is the one thing here that genuinely
 * streams.
 *
 * Both loops guard against overlap. A poll that is still in flight when the next
 * tick fires is not joined by a second one: on a Mac busy enough to make a
 * screenshot slow, that is how a poller turns into a queue.
 */

import { signal } from '@preact/signals'
import { fetchEvents, fetchState, command, ApiError } from './api'

// MARK: - The shape the host sends

export interface Facts {
  at: string
  host: {
    name: string
    model: string
    os: string
    version: string
    protocol: number
    uptimeSeconds: number
    hostKey: string
    port: number
    pathWord: string
    awake: boolean
    onPower: boolean
    frontmostApp: string
    webBundle: { present: boolean; bytes: number }
    dashboardBundle: { present: boolean; bytes: number }
  }
  permissions: { screenRecording: boolean; accessibility: boolean; checkedAt: string }
  link: {
    attached: boolean
    rtt?: number
    jitter?: number
    loss?: number
    outMbps: number
    rttHistory: number[]
    samples: number
    stalledSeconds?: number
    onExpensiveLink: boolean
  }
  encoder: {
    capturing: boolean
    rateHistory: number[]
    ladderSetting: string
    ladder?: string
    fps?: number
    bitrate?: number
    gop?: number
    keyframeSeconds?: number
    framesEncoded?: number
    mbps?: number
    dropped: number
    sentBytes: number
  }
  displays: DisplayFact[]
  sideBySide: boolean
  devices: DeviceFact[]
  /** 'asking' before the keychain has answered once, then 'yes' or 'no'. */
  devicesReadable: 'asking' | 'yes' | 'no'
  transport: TransportFact
  addresses: {
    origin: string
    reach: string
    reachable: boolean
    host: string
    port: number
    listening: string
    publishedSite: string
    webBundlePresent: boolean
  }
  pairing: PairingFact
  settings?: SettingsFact
  log: { entries: LogEntry[]; dropped: number; areas: string[] }
}

export interface DisplayFact {
  id: number
  name: string
  width: number
  height: number
  hz: number
  isBuiltIn: boolean
  isMain: boolean
  selected: boolean
  stream?: {
    streamId: number
    sentWidth: number
    sentHeight: number
    fps: number
    ladder: string
    mbps: number
    frames: number
    gop: number
  }
}

export interface DeviceFact {
  id: string
  name: string
  kind: string
  pairedAt: string
  lastSeenAt?: string
  connected: boolean
  attached: boolean
  keyFingerprint: string
  session?: { since: string; bytesSent: number; framesDropped: number; watching: number[] }
}

export interface TransportFact {
  path: string
  tailscaleRunning: boolean
  tailscaleAddress?: string
  tailscaleDNSName?: string
  cloudflareRunning: boolean
  cloudflareHostname?: string
  lanAddress?: string
  relayName?: string
  peerLatencyMillis?: number
  lastContact?: string
}

export interface PairingFact {
  open: boolean
  code?: string
  secondsRemaining?: number
  rotateSeconds: number
  lockoutSeconds?: number
  reusable: boolean
  maxAttempts: number
  name?: string
  step: number
  deviceId?: string
  deviceName?: string
  /** Set only when the handshake stopped after the code was accepted. */
  failure?: string
}

export interface SettingsFact {
  quality: string
  capOnCellular: boolean
  cellularCeilingMbps: number
  sensitivity: number
  naturalScrolling: boolean
  requireBiometricEachSession: boolean
  relayOverInternet: boolean
  targetFps: number
  port: number
  webClientURL: string
}

export interface LogEntry {
  seq: number
  at: string
  level: string
  area: string
  text: string
}

// MARK: - Claude, assembled from the same messages the phone gets

export interface ToolCall {
  id: string
  name: string
  target: string
  state: 'running' | 'ok' | 'error'
  ms?: number
}

export interface Turn {
  role: 'user' | 'assistant'
  text: string
}

export interface ClaudeSession {
  id: string
  summary: string
  cwd: string
  gitBranch?: string
  modifiedAt?: string
}

export interface PendingPermission {
  requestId: string
  toolName: string
  command: string
  explanation?: string
  waitingMs: number
  /** Ticked locally so the card counts up between polls rather than in jumps. */
  arrivedAt: number
}

export interface ClaudeView {
  sessions: ClaudeSession[]
  openSessionId?: string
  cwd?: string
  pending: boolean
  turns: Turn[]
  streaming: string
  tools: ToolCall[]
  files: { path: string; status: string; added: number; removed: number }[]
  permission?: PendingPermission
  usage?: { inputTokens: number; outputTokens: number; durationMs: number; tokensPerSecond: number }
  rateLimit?: { status: string; resetsAt?: string; type?: string }
  ended?: string
  error?: string
}

const emptyClaude: ClaudeView = {
  sessions: [],
  pending: false,
  turns: [],
  streaming: '',
  tools: [],
  files: [],
}

// MARK: - Signals

export type PaneId =
  | 'overview'
  | 'devices'
  | 'displays'
  | 'claude'
  | 'transport'
  | 'log'
  | 'settings'

export const facts = signal<Facts | null>(null)
export const claude = signal<ClaudeView>(emptyClaude)
export const pane = signal<PaneId>('overview')
export const pairOpen = signal(false)
export const selectedDeviceId = signal<string | null>(null)
export const selectedSessionId = signal<string | null>(null)
export const logFilter = signal<string>('all')

/**
 * Whether the host is answering, as measured rather than assumed.
 *
 * `starting` is the state before the first answer, and it is not the same as
 * `lost`: a window that has never had a reply must not draw the same thing as
 * one whose host stopped replying. `unauthorized` is its own state too — a key
 * the host will not accept is a different problem from a host that is down, and
 * they have different answers.
 */
export type Reachability = 'starting' | 'live' | 'lost' | 'unauthorized'
export const reachability = signal<Reachability>('starting')
/** A one-line failure from the last command, shown until the next one lands. */
export const notice = signal<string | null>(null)

/** Ticks once a second so anything counting locally has something to depend on. */
export const clock = signal(0)

// MARK: - Commands

/**
 * Sends a command and refreshes immediately rather than waiting for the poll.
 *
 * A revoke that took a second to show up on screen would read as a revoke that
 * did not work, and the second click is the one that revokes the wrong device.
 */
export async function send(body: Record<string, unknown>): Promise<boolean> {
  try {
    await command(body)
    notice.value = null
    await pollState()
    return true
  } catch (error) {
    notice.value =
      error instanceof ApiError
        ? `${String(body.do ?? 'command')} refused: ${error.code}`
        : `${String(body.do ?? 'command')} did not reach the host`
    return false
  }
}

// MARK: - Polling

let statePolling = false
/** The last `pairing.open` the host reported, so only changes move the sheet. */
let hostPairingWasLive = false
let eventPolling = false
let cursor = 0

async function pollState(): Promise<void> {
  if (statePolling) return
  statePolling = true
  try {
    const next = await fetchState<Facts>()
    facts.value = next
    reachability.value = 'live'
    // The sheet follows the host's pairing window on its *edges*, not on its
    // level.
    //
    // Both directions have to work. A live code must appear wherever it was
    // started from — the menu bar, `--pair`, or this window — because a host
    // holding a code that nothing displays is a code nobody can use; and a code
    // the host has finished with must stop being displayed, spent or lapsed.
    //
    // But the sheet is also where a code is *configured* before one exists: the
    // name and the one-time/reusable choice are made with `pairing.open` still
    // false. Driving the sheet from that level closed it a second after every
    // press of Create pair — the poll asserted "no code, so no sheet" over a
    // sheet whose whole job at that moment was to start one. Only transitions
    // move it; in between, it stays where the person put it.
    const livePairing = next.pairing.open || next.pairing.step > 0
    if (livePairing !== hostPairingWasLive) {
      hostPairingWasLive = livePairing
      pairOpen.value = livePairing
    }
  } catch (error) {
    reachability.value = error instanceof ApiError && error.status === 401 ? 'unauthorized' : 'lost'
  } finally {
    statePolling = false
  }
}

interface EventsReply {
  next: number
  dropped: number
  messages: Record<string, unknown>[]
}

async function pollEvents(): Promise<void> {
  if (eventPolling) return
  eventPolling = true
  try {
    const reply = await fetchEvents<EventsReply>(cursor)
    cursor = reply.next
    if (reply.messages.length > 0) {
      claude.value = reply.messages.reduce(reduceClaude, claude.value)
    }
  } catch {
    // The state poll is the one that decides whether the host is answering; a
    // failed event drain on its own says nothing new and must not flip the
    // whole window to "lost".
  } finally {
    eventPolling = false
  }
}

/**
 * Folds one wire message into the Claude view.
 *
 * These are the same messages `PROTOCOL.md` §5 defines for the phone, arriving
 * through the host's fan-out rather than a socket. Anything that is not a
 * `claude` message is ignored here rather than guessed at.
 */
// eslint-disable-next-line complexity
function reduceClaude(view: ClaudeView, raw: Record<string, unknown>): ClaudeView {
  if (raw.t !== 'claude') return view
  const sub = raw.sub as string

  switch (sub) {
    case 'sessions':
      return { ...view, sessions: (raw.sessions as ClaudeSession[]) ?? [] }

    case 'opened':
      return {
        ...emptyClaude,
        sessions: view.sessions,
        openSessionId: raw.sessionId as string,
        cwd: raw.cwd as string,
        pending: raw.pending === true,
      }

    case 'history': {
      const turns = ((raw.turns as { role: string; text: string }[]) ?? []).map((turn) => ({
        role: turn.role === 'user' ? ('user' as const) : ('assistant' as const),
        text: turn.text ?? '',
      }))
      return { ...view, turns, pending: false }
    }

    case 'delta':
      return { ...view, pending: false, streaming: view.streaming + ((raw.text as string) ?? '') }

    case 'message': {
      const blocks = (raw.blocks as { type?: string; text?: string }[]) ?? []
      const text = blocks
        .filter((block) => typeof block.text === 'string')
        .map((block) => block.text as string)
        .join('')
      const role = raw.role === 'user' ? ('user' as const) : ('assistant' as const)
      // The streamed copy and the completed one are the same turn. Keeping both
      // would print every answer twice.
      return {
        ...view,
        pending: false,
        streaming: '',
        turns: text ? [...view.turns, { role, text }] : view.turns,
      }
    }

    case 'tool': {
      const id = raw.id as string
      const call: ToolCall = {
        id,
        name: (raw.name as string) ?? '',
        target: (raw.target as string) ?? '',
        state: (raw.state as ToolCall['state']) ?? 'running',
        ms: raw.ms as number | undefined,
      }
      const existing = view.tools.findIndex((tool) => tool.id === id)
      const tools =
        existing >= 0
          ? view.tools.map((tool, index) => (index === existing ? call : tool))
          : [...view.tools, call]
      // The timeline is a tail, not a transcript: it shows what is happening
      // now and what just happened.
      return { ...view, tools: tools.slice(-12) }
    }

    case 'files':
      return {
        ...view,
        files: (raw.files as ClaudeView['files']) ?? [],
      }

    case 'permission':
      return {
        ...view,
        permission: {
          requestId: raw.requestId as string,
          toolName: (raw.toolName as string) ?? '',
          command: (raw.command as string) ?? '',
          explanation: raw.explanation as string | undefined,
          waitingMs: (raw.waitingMs as number) ?? 0,
          arrivedAt: Date.now(),
        },
      }

    case 'usage':
      return { ...view, usage: raw as unknown as ClaudeView['usage'] }

    case 'rateLimit':
      return { ...view, rateLimit: raw as unknown as ClaudeView['rateLimit'] }

    case 'ended':
      return {
        ...view,
        streaming: '',
        pending: false,
        ended: (raw.reason as string) ?? 'ended',
        permission: undefined,
      }

    case 'error':
      return { ...view, pending: false, error: (raw.message as string) ?? 'unknown' }

    default:
      return view
  }
}

/** Answering a permission clears the card here rather than waiting for a poll. */
export async function answerPermission(
  requestId: string,
  behavior: 'allow' | 'deny',
  scope: 'once' | 'always',
): Promise<void> {
  claude.value = { ...claude.value, permission: undefined }
  await send({
    do: 'claude',
    sub: 'permission',
    requestId,
    behavior,
    scope,
    message: behavior === 'deny' ? 'Denied from the Mac dashboard.' : undefined,
  })
}

export function start(): void {
  void pollState()
  void pollEvents()
  // Sessions are not pushed; the host answers a list when asked. Asking once at
  // start-up is what fills the Claude pane's picker before it is opened.
  void send({ do: 'claude', sub: 'listSessions' })

  setInterval(() => void pollState(), 1000)
  setInterval(() => void pollEvents(), 500)
  setInterval(() => {
    clock.value = clock.value + 1
  }, 1000)
}

export { pollState }
