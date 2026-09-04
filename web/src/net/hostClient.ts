/**
 * Talks to the Mac: pairing over HTTP, then one authenticated WebSocket.
 * Ported from ios/VibeWire/Net/HostClient.swift.
 *
 * Reconnection policy matches what screen 03D promises the user: retry with
 * backoff, hold input rather than dropping it, and give up at 30 seconds.
 *
 * The one protocol difference from the phone, and the reason PROTOCOL.md §1.2
 * grew a second spelling: **a browser cannot set headers on a WebSocket
 * handshake.** `WebSocket` takes a URL and a subprotocol list, and nothing else —
 * so `X-VibeWire-Device`, `X-VibeWire-Nonce` and `X-VibeWire-Signature` are
 * unreachable from here. The same three values go in the query string instead,
 * percent-encoded, and the host accepts either spelling. This is not a weakening:
 * the nonce is single-use, expires in 30 seconds, and the signature is over the
 * nonce — a URL that leaks into a log is a URL that cannot be replayed.
 */

import { fromBase64, Identity, type PairedHost } from './identity'
import {
  dialable,
  lenientEndpoint,
  normaliseOrigins,
  socketOrigin,
  type Endpoint,
} from './endpoint'
import { parseVideoFrame, type VideoFrameHeader } from '../video/frame'

export type ConnectionState =
  | { kind: 'idle' }
  | { kind: 'connecting'; attempt: number }
  | { kind: 'connected' }
  | { kind: 'reconnecting'; attempt: number; nextRetryMs: number }
  | { kind: 'failed'; reason: string }
  /** The Mac rejected our identity. Only re-pairing clears this, so it is kept
   *  apart from `failed`, which is worth retrying. */
  | { kind: 'unauthorized' }

export type ControlMessage = Record<string, unknown>

export interface Handlers {
  control(message: ControlMessage): void
  video(frame: VideoFrameHeader): void
  state(state: ConnectionState): void
  /** Fired when the stored pairing changes underneath the app — a different
   *  address won, or the Mac named one this browser did not have. */
  hostRecord?(host: PairedHost): void
}

/** Monotonic microseconds, so a clock adjustment mid-session cannot make a
 *  measured round trip read negative. */
function micros(): number {
  return Math.round(performance.now() * 1000)
}

/**
 * A pairing attempt that did not produce a trusted host.
 *
 * `answered` is the difference between "wrong digits" and "wrong address", and
 * it decides whether the next candidate is tried. A refusal came *from the Mac*,
 * which means this address is the right one and the code is not; only a failure
 * to reach an address at all is a reason to move on to the next.
 */
export class PairFailure extends Error {
  readonly answered: boolean

  constructor(message: string, answered = true) {
    super(message)
    this.answered = answered
  }
}

const MAX_QUEUED_OUTBOUND = 64

/**
 * How long a connected socket may go without a pong before it is treated as
 * dead. Pings go out every second, so this is eight missed round trips — long
 * enough that a stalled tab or a slow relay hop is not mistaken for a lost
 * network, short enough that walking out of Wi-Fi range costs seconds rather
 * than a TCP timeout nobody waits through.
 */
const PONG_TIMEOUT_MS = 8000

export class HostClient {
  private socket: WebSocket | null = null
  private host: PairedHost | null = null
  private handlers: Handlers | null = null

  state: ConnectionState = { kind: 'idle' }

  /** Input generated while the socket is down. Capped so a long outage does not
   *  replay a minute of stale gestures when it comes back. */
  private queued: ControlMessage[] = []

  private pingSequence = 0
  private pendingPings = new Map<number, number>()
  lastRttMillis: number | null = null

  /**
   * Which of the Mac's addresses this client is dialling.
   *
   * A Mac has up to three and only one of them answers from where this browser
   * happens to be: the tunnel from cellular, the tailnet address wherever
   * Tailscale is up, the LAN address at home. Rather than ask which network the
   * user is on, a failed attempt moves to the next address and the backoff
   * carries on as before — so leaving the house costs one reconnect, not a
   * re-pair.
   */
  private dialIndex = 0
  /** The origin the live socket was opened against, so a socket that proves
   *  itself can promote the address that carried it. */
  private dialledOrigin: string | null = null
  /** When the last pong came back. A network that changes under a live socket
   *  does not always close it, and a socket nobody can hear is worse than a
   *  closed one — it holds the rotation on an address that is already dead. */
  private lastPongAt = 0
  /** Set when a socket that *had* worked went quiet. The address is suspect even
   *  though the handshake succeeded on it, so the next attempt moves along the
   *  list — but the identity behind it is not in question, and re-asking the Mac
   *  about a key it accepted a minute ago would spend two timeouts against a
   *  dead address before trying the live one. */
  private addressSuspect = false

  private reconnectAttempt = 0
  private reconnectStartedAt: number | null = null
  private shouldReconnect = true
  private pingTimer: ReturnType<typeof setInterval> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  /** Whether the current socket has delivered a frame. Until it has, the upgrade
   *  may still be refused. */
  private handshakeConfirmed = false
  private opening = false
  /** Identifies the live socket, so a deliberately retired one can be told apart
   *  from one that failed. */
  private generation = 0

  setHandlers(handlers: Handlers): void {
    this.handlers = handlers
  }

  get queuedInputCount(): number {
    return this.queued.length
  }

  // MARK: Pairing

  /**
   * Pairs against the first of the Mac's addresses that answers.
   *
   * `endpoint` is the address that was scanned, typed, or read off this page's
   * own origin; `alternates` are the Mac's other addresses when the link carried
   * them. Which of them works depends on where this browser is standing, so they
   * are tried in the order the Mac gave — that order is its judgement about
   * which path is worth preferring, and a race would replace it with whichever
   * happened to answer a health check first.
   *
   * Addresses this page is forbidden to open are dropped before anything is
   * dialled: a `http://` candidate from an `https` page is not a slow address,
   * it is a `SecurityError` thrown before a packet leaves, and spending one of
   * the code's sixty seconds on it buys nothing.
   */
  async pair(endpoint: Endpoint, code: string, alternates: string[] = []): Promise<PairedHost> {
    const offered = normaliseOrigins([endpoint.origin, ...alternates])
    const usable = offered.filter(dialable)
    const candidates = (usable.length > 0 ? usable : offered)
      .map(lenientEndpoint)
      .filter((entry): entry is Endpoint => entry != null)

    if (candidates.length === 0) throw new PairFailure(`Not a usable address: ${endpoint.origin}`)
    if (candidates.length === 1) return this.pairOnce(candidates[0]!, code, offered)

    // Probed together, dialled in order. Sequential eight-second timeouts across
    // three addresses can spend most of a code's life finding out which one is
    // even there, and a code that rotates mid-handshake is the failure this is
    // here to avoid.
    const responding = await HostClient.reachable(candidates)
    const ordered = responding.length > 0 ? responding : candidates

    let last: Error = new PairFailure('No answer from the Mac.', false)
    for (const candidate of ordered) {
      try {
        return await this.pairOnce(candidate, code, offered)
      } catch (error) {
        // A refusal came from the Mac: this address is right and the digits are
        // not, so the next address would only burn another attempt against the
        // same rate limiter.
        if (error instanceof PairFailure && error.answered) throw error
        last = error as Error
      }
    }
    throw last
  }

  /**
   * Which of these addresses answer, asked all at once, reported in the order
   * they were given rather than the order they replied.
   */
  private static async reachable(candidates: Endpoint[]): Promise<Endpoint[]> {
    const answered = await Promise.all(
      candidates.map(async (candidate) => {
        try {
          const response = await fetch(`${candidate.origin}/v1/health`, {
            signal: AbortSignal.timeout(3000),
            cache: 'no-store',
          })
          return response.ok
        } catch {
          return false
        }
      }),
    )
    return candidates.filter((_, index) => answered[index])
  }

  /** One handshake against one address. */
  private async pairOnce(
    endpoint: Endpoint,
    code: string,
    offered: string[],
  ): Promise<PairedHost> {
    const body = JSON.stringify({
      code,
      deviceName: Identity.deviceName(),
      deviceKind: Identity.deviceKind(),
      publicKey: await Identity.publicKeyBase64(),
    })

    const started = performance.now()
    let response: Response
    try {
      response = await fetch(`${endpoint.origin}/v1/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(8000),
        cache: 'no-store',
      })
    } catch (error) {
      // `fetch` collapses every network-layer cause into one opaque `TypeError`,
      // so this is the honest limit of what a browser can report: how long it
      // waited, and whatever the engine chose to say. A blocked mixed-content
      // request is named separately, before we ever get here — see
      // `endpoint.describe`.
      const elapsed = Math.round(performance.now() - started)
      const detail =
        error instanceof DOMException && error.name === 'TimeoutError'
          ? `nothing answered in ${elapsed}ms`
          : (error as Error).message || 'the request did not complete'
      throw new PairFailure(`No answer from ${endpoint.host} — ${detail}.`, false)
    }

    if (!response.ok) {
      const failure = (await response.json().catch(() => ({}))) as {
        error?: string
        retryAfter?: number
      }
      switch (failure.error) {
        case 'code_expired':
          throw new PairFailure('The code rotated. Read the new one.')
        case 'not_pairing':
          throw new PairFailure('The Mac is not showing a code right now.')
        case 'too_many_attempts':
          throw new PairFailure(`Too many tries. Wait ${failure.retryAfter ?? 60}s.`)
        case 'bad_public_key':
          throw new PairFailure('The Mac refused this browser’s key.')
        default:
          throw new PairFailure('That code did not match.')
      }
    }

    const decoded = (await response.json()) as {
      hostId: string
      hostName: string
      hostKey: string
      deviceId: string
      protocol?: number
    }

    if (decoded.protocol != null && decoded.protocol !== 1) {
      throw new PairFailure('The Mac is running a different VibeWire version.')
    }

    // A new pairing is a new identity. Nothing queued against the old one may be
    // replayed against it.
    this.queued = []

    const paired: PairedHost = {
      hostId: decoded.hostId,
      hostName: decoded.hostName,
      hostKey: decoded.hostKey,
      deviceId: decoded.deviceId,
      origin: endpoint.origin,
      host: endpoint.host,
      port: endpoint.port,
      // The address that answered leads; the rest are kept so this browser can
      // find the same Mac from a different network without pairing again.
      alternates: offered.filter((entry) => entry !== endpoint.origin),
      pairedAt: new Date().toISOString(),
    }
    await Identity.savePairedHost(paired)
    this.host = paired
    this.dialIndex = 0
    return paired
  }

  /**
   * Best-effort probe so pairing can say "HOST FOUND · 4 MS" before the user
   * commits to typing six digits into a void.
   */
  async probe(endpoint: Endpoint): Promise<number | null> {
    const started = performance.now()
    try {
      const response = await fetch(`${endpoint.origin}/v1/health`, {
        signal: AbortSignal.timeout(2000),
        cache: 'no-store',
      })
      if (!response.ok) return null
      await response.arrayBuffer()
      return performance.now() - started
    } catch {
      return null
    }
  }

  // MARK: Connection

  async connect(host: PairedHost): Promise<void> {
    // A cold load calls this once and the visibility handler calls it again the
    // moment the tab is foregrounded, and a second call while the first socket is
    // still live would open a *second* socket to the Mac. The host keeps one
    // active socket and points Claude's output at whichever registered last, so
    // replies went to one socket while the app read the other.
    if (
      this.host?.deviceId === host.deviceId &&
      this.socket &&
      (this.state.kind === 'connected' || this.state.kind === 'connecting')
    ) {
      return
    }

    this.host = host
    this.shouldReconnect = true
    this.reconnectAttempt = 0
    this.reconnectStartedAt = null
    // A fresh session starts from the address that worked last, not from
    // wherever the previous session's rotation happened to stop.
    this.dialIndex = 0
    await this.openSocket()
  }

  /**
   * Every origin worth dialling for this Mac, best first.
   *
   * Blocked ones are dropped rather than dialled and failed — but never all of
   * them: a list that filters down to nothing leaves the stored origin in place,
   * so the failure the user is shown is about the address they chose rather than
   * about an empty list they never saw.
   */
  private candidates(): string[] {
    const host = this.host
    if (!host) return []
    const all = normaliseOrigins([host.origin, ...host.alternates])
    const usable = all.filter(dialable)
    return usable.length > 0 ? usable : all.length > 0 ? all : [host.origin]
  }

  /** The origin currently being dialled, wrapping round the candidate list. */
  private currentEndpoint(): Endpoint | null {
    const candidates = this.candidates()
    if (candidates.length === 0) return null
    return lenientEndpoint(candidates[this.dialIndex % candidates.length]!)
  }

  /**
   * Records addresses the Mac has told us about over the socket.
   *
   * The host reports its own transport once a second, and that report is the
   * only place a Cloudflare quick tunnel's hostname exists — it is minted on
   * every host launch and written down nowhere. Learning it while connected over
   * Wi-Fi is what lets this browser reach the same Mac from cellular later,
   * without anyone typing a hostname or scanning anything again.
   */
  learn(offered: string[]): void {
    const host = this.host
    if (!host || offered.length === 0) return
    const merged = normaliseOrigins([host.origin, ...offered, ...host.alternates])
    const alternates = merged.filter((entry) => entry !== host.origin)
    if (sameOrigins(alternates, host.alternates)) return

    const updated: PairedHost = { ...host, alternates }
    this.host = updated
    void Identity.savePairedHost(updated).catch(() => undefined)
    this.handlers?.hostRecord?.(updated)
  }

  /**
   * The address that carried a working socket becomes the one this browser
   * dials first next time.
   *
   * Only after the socket has proven itself, never when it merely opened: an
   * address that accepted a TCP connection has not shown it can reach the Mac,
   * and promoting it would make a captive portal this browser's idea of home.
   */
  private promoteDialledOrigin(): void {
    const host = this.host
    const winner = this.dialledOrigin
    if (!host || !winner || winner === host.origin) return

    const endpoint = lenientEndpoint(winner)
    if (!endpoint) return

    const updated: PairedHost = {
      ...host,
      origin: endpoint.origin,
      host: endpoint.host,
      port: endpoint.port,
      alternates: normaliseOrigins([host.origin, ...host.alternates]).filter(
        (entry) => entry !== endpoint.origin,
      ),
    }
    this.host = updated
    this.dialIndex = 0
    void Identity.savePairedHost(updated).catch(() => undefined)
    this.handlers?.hostRecord?.(updated)
  }

  disconnect(): void {
    this.shouldReconnect = false
    this.stopPinging()
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.generation += 1
    this.closeSocket()
    // The queue exists to cover a brief reconnect inside one session, not to
    // outlive the session itself. Carrying it across an unpair meant a "revoke
    // every device" tapped while the Mac was down sat in the queue and fired
    // 60ms after the *next* pairing, destroying the device that had just been
    // created.
    this.queued = []
    this.dialledOrigin = null
    this.lastPongAt = 0
    this.addressSuspect = false
    this.transition({ kind: 'idle' })
  }

  private closeSocket(): void {
    const socket = this.socket
    this.socket = null
    if (!socket) return
    socket.onopen = null
    socket.onmessage = null
    socket.onerror = null
    socket.onclose = null
    try {
      socket.close(1000, 'going away')
    } catch {
      /* already closing */
    }
  }

  private async openSocket(): Promise<void> {
    const host = this.host
    const endpoint = this.currentEndpoint()
    if (!host || !endpoint) return

    // Opening is not instantaneous: fetching the nonce is an await, and a second
    // caller arriving in that window saw no socket, decided nothing was in
    // flight, and opened a second one. The flag covers the whole operation, not
    // just its result.
    if (this.opening) return
    this.opening = true

    // Any socket already established is deliberately retired here, and the
    // generation bump tells its handlers that its death is expected — otherwise
    // it would schedule a reconnect and open yet another one.
    this.generation += 1
    const generation = this.generation
    this.closeSocket()

    this.transition(
      this.reconnectAttempt === 0
        ? { kind: 'connecting', attempt: 1 }
        : {
            kind: 'reconnecting',
            attempt: this.reconnectAttempt + 1,
            nextRetryMs: this.backoffMillis(),
          },
    )

    // Cleared here rather than after the nonce comes back, because the nonce is
    // the first thing a dead address kills. Set later, an attempt that threw on
    // the challenge left this reading `true` from the socket that worked ten
    // seconds ago — and the reconnect below only moves to the next address when
    // the current one has *not* proven itself. The page then retried a dead
    // address until it gave up, with the Mac answering on the other two the
    // whole time.
    this.handshakeConfirmed = false
    this.dialledOrigin = endpoint.origin

    try {
      const nonce = await this.fetchNonce(endpoint, host.deviceId)
      const signature = await Identity.sign(fromBase64(nonce))
      const url =
        `${socketOrigin(endpoint)}/v1/socket` +
        `?device=${encodeURIComponent(host.deviceId)}` +
        `&nonce=${encodeURIComponent(nonce)}` +
        `&sig=${encodeURIComponent(base64Url(signature))}`

      const socket = new WebSocket(url)
      socket.binaryType = 'arraybuffer'
      this.socket = socket

      socket.onopen = () => {
        if (generation !== this.generation) return
        // `onopen` means the Mac returned 101 and accepted the signature: a
        // refused upgrade never opens. Unlike the phone, which had to wait for a
        // first frame to be sure, this is the definitive moment.
        this.noteHandshakeConfirmed()
      }
      socket.onmessage = (event) => {
        if (generation !== this.generation) return
        this.handle(event.data)
      }
      socket.onclose = (event) => {
        if (generation !== this.generation) return
        void this.scheduleReconnect(
          event.reason || `socket closed (${event.code})`,
          event.code,
        )
      }
      socket.onerror = () => {
        // Always followed by `onclose`, which carries the code. Nothing to do
        // here but keep the console quiet.
      }

      this.opening = false
    } catch (error) {
      // Cleared before retrying, or the reconnect would find an open in flight
      // and quietly do nothing.
      this.opening = false
      await this.scheduleReconnect((error as Error).message, null)
    }
  }

  /** The socket has proven itself. Only now is it safe to clear the backoff,
   *  release queued input, and start pinging. */
  private noteHandshakeConfirmed(): void {
    if (this.handshakeConfirmed) return
    this.handshakeConfirmed = true
    this.reconnectAttempt = 0
    this.reconnectStartedAt = null
    this.lastPongAt = performance.now()
    this.promoteDialledOrigin()
    this.transition({ kind: 'connected' })
    this.flushQueue()
    this.startPinging()
  }

  private async fetchNonce(endpoint: Endpoint, deviceId: string): Promise<string> {
    const response = await fetch(
      `${endpoint.origin}/v1/challenge?deviceId=${encodeURIComponent(deviceId)}`,
      { signal: AbortSignal.timeout(6000), cache: 'no-store' },
    )
    if (!response.ok) throw new Error(`challenge refused (${response.status})`)
    const body = (await response.json()) as { nonce?: string }
    if (!body.nonce) throw new Error('challenge carried no nonce')
    return body.nonce
  }

  /**
   * Asks the host, in as many words, whether it still holds this device's key.
   *
   * A browser cannot see the status line of a refused WebSocket upgrade: an HTTP
   * 401 and an unplugged cable both surface as close code 1006. Without this the
   * client would retry a revoked device for the full 30 seconds and then report
   * "unreachable" about a Mac that was answering perfectly — which is exactly the
   * collapsed-failure defect this product has already paid for once. One extra
   * round trip, taken only after a socket has failed, buys the true verdict.
   */
  private async verifyIdentity(
    endpoint: Endpoint,
    host: PairedHost,
  ): Promise<'trusted' | 'revoked' | 'unknown'> {
    try {
      const nonce = await this.fetchNonce(endpoint, host.deviceId)
      const signature = await Identity.sign(fromBase64(nonce))
      const response = await fetch(
        `${endpoint.origin}/v1/verify` +
          `?device=${encodeURIComponent(host.deviceId)}` +
          `&nonce=${encodeURIComponent(nonce)}` +
          `&sig=${encodeURIComponent(base64Url(signature))}`,
        { signal: AbortSignal.timeout(6000), cache: 'no-store' },
      )
      if (response.status === 401 || response.status === 403) return 'revoked'
      if (response.ok) return 'trusted'
      // A 404 is an older host that predates this endpoint. Saying nothing is
      // right: it cannot answer the question, and guessing would be worse.
      return 'unknown'
    } catch {
      return 'unknown'
    }
  }

  private handle(data: unknown): void {
    if (data instanceof ArrayBuffer) {
      const frame = parseVideoFrame(data)
      if (frame) this.handlers?.video(frame)
      return
    }
    if (typeof data !== 'string') return

    let message: ControlMessage
    try {
      message = JSON.parse(data) as ControlMessage
    } catch {
      return
    }
    if (message['t'] === 'pong' && typeof message['tMicros'] === 'number') {
      this.notePong(message['tMicros'])
    }
    this.handlers?.control(message)
  }

  // MARK: Sending

  /** Control messages are queued while disconnected rather than dropped —
   *  "Keys and taps are being held, not dropped" on screen 03D. */
  send(message: ControlMessage): void {
    if (this.state.kind !== 'connected' || this.socket?.readyState !== WebSocket.OPEN) {
      this.enqueue(message)
      return
    }
    try {
      this.socket.send(JSON.stringify(message))
    } catch {
      this.enqueue(message)
    }
  }

  /** Pointer moves are the exception: a stale delta is worse than no delta, so
   *  they are dropped rather than queued. */
  sendTransient(message: ControlMessage): void {
    if (this.state.kind !== 'connected' || this.socket?.readyState !== WebSocket.OPEN) return
    try {
      this.socket.send(JSON.stringify(message))
    } catch {
      /* a dropped pointer delta is the correct outcome */
    }
  }

  /**
   * Control messages that must never be replayed later.
   *
   * Anything scoped to the current pairing — revoking a device above all — is
   * meaningless or destructive once the identity behind it has changed. These are
   * sent if the socket is up and dropped if it is not, rather than being held.
   */
  sendUnqueued(message: ControlMessage): boolean {
    if (this.state.kind !== 'connected' || this.socket?.readyState !== WebSocket.OPEN) {
      return false
    }
    try {
      this.socket.send(JSON.stringify(message))
      return true
    } catch {
      return false
    }
  }

  private enqueue(message: ControlMessage): void {
    this.queued.push(message)
    if (this.queued.length > MAX_QUEUED_OUTBOUND) {
      this.queued.splice(0, this.queued.length - MAX_QUEUED_OUTBOUND)
    }
  }

  private flushQueue(): void {
    const pending = this.queued
    this.queued = []
    for (const message of pending) this.send(message)
  }

  // MARK: Keepalive

  private startPinging(): void {
    this.stopPinging()
    this.pingTimer = setInterval(() => this.sendPing(), 1000)
  }

  private stopPinging(): void {
    if (this.pingTimer) clearInterval(this.pingTimer)
    this.pingTimer = null
  }

  private sendPing(): void {
    // A network that changes under a live socket does not always close it. The
    // radio switches, the old route stops carrying anything, and `onclose` waits
    // on a TCP timeout that can outlast anyone's patience — so the client reads
    // "connected" while nothing has come back for half a minute. Pongs are the
    // proof, they arrive every second, and their absence is what says to stop
    // waiting and dial the next address.
    if (
      this.state.kind === 'connected' &&
      this.lastPongAt > 0 &&
      performance.now() - this.lastPongAt > PONG_TIMEOUT_MS
    ) {
      this.addressSuspect = true
      void this.scheduleReconnect('nothing came back from the Mac', null)
      return
    }

    this.pingSequence += 1
    const stamp = micros()
    this.pendingPings.set(this.pingSequence, stamp)
    // Anything older than a few seconds is never coming back.
    if (this.pendingPings.size > 30) {
      const keys = [...this.pendingPings.keys()].sort((a, b) => a - b)
      for (const key of keys.slice(0, this.pendingPings.size - 30)) {
        this.pendingPings.delete(key)
      }
    }

    const message: ControlMessage = {
      t: 'ping',
      tMicros: stamp,
      seq: this.pingSequence,
    }
    // The round trip is measured here, on one clock, and reported to the host —
    // the two machines' monotonic clocks share no origin, so the Mac cannot
    // compute this itself.
    if (this.lastRttMillis != null) message['rttMillis'] = this.lastRttMillis
    this.sendTransient(message)
  }

  private notePong(echoedMicros: number): void {
    const now = micros()
    if (now <= echoedMicros) return
    this.lastRttMillis = (now - echoedMicros) / 1000
    this.lastPongAt = performance.now()
    this.pendingPings.delete(echoedMicros)
  }

  // MARK: Reconnect

  private async scheduleReconnect(reason: string, closeCode: number | null): Promise<void> {
    this.stopPinging()
    this.closeSocket()

    if (!this.shouldReconnect) {
      this.transition({ kind: 'idle' })
      return
    }

    // 4003 is the host's own code for "device revoked" on a socket it had already
    // accepted, so it needs no second opinion.
    if (closeCode === 4003) {
      this.shouldReconnect = false
      this.transition({ kind: 'unauthorized' })
      return
    }

    // A socket that never opened may have been refused rather than unreachable,
    // and only the host can say which. Asked once, on the first failure of a
    // spell, so a genuinely offline Mac costs one extra request and not one per
    // retry.
    const dialled = this.dialledOrigin ? lenientEndpoint(this.dialledOrigin) : null
    if (!this.handshakeConfirmed && this.reconnectAttempt === 0 && this.host && dialled) {
      if ((await this.verifyIdentity(dialled, this.host)) === 'revoked') {
        this.shouldReconnect = false
        this.transition({ kind: 'unauthorized' })
        return
      }
    }

    // The socket never proved itself, so the address it was opened against is a
    // suspect. Move to the next one the Mac gave us — this is what turns "this
    // browser works on the Wi-Fi it was paired on" into "this browser works",
    // since the LAN address fails in exactly this way from the other side of the
    // front door and the tunnel is what answers there.
    const candidates = this.candidates()
    if ((!this.handshakeConfirmed || this.addressSuspect) && candidates.length > 1) {
      this.dialIndex = (this.dialIndex + 1) % candidates.length
    }
    this.addressSuspect = false

    this.reconnectStartedAt ??= performance.now()

    // 03D: "GIVING UP AT 30S" — thirty seconds per address, not thirty shared
    // between them. A client holding three addresses that split one budget gives
    // each ten seconds and reports a Mac unreachable that was answering on the
    // third.
    if (performance.now() - this.reconnectStartedAt > 30_000 * Math.max(1, candidates.length)) {
      this.shouldReconnect = false
      this.transition({ kind: 'failed', reason })
      return
    }

    this.reconnectAttempt += 1
    const delay = this.backoffMillis()
    this.transition({
      kind: 'reconnecting',
      attempt: this.reconnectAttempt,
      nextRetryMs: delay,
    })

    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (!this.shouldReconnect) return
      void this.openSocket()
    }, delay)
  }

  /** 0.5 s doubling to an 8 s ceiling. */
  private backoffMillis(): number {
    return Math.min(8000, 500 * 2 ** Math.max(0, this.reconnectAttempt - 1))
  }

  private transition(next: ConnectionState): void {
    if (sameState(this.state, next)) return
    this.state = next
    this.handlers?.state(next)
  }
}

function sameState(a: ConnectionState, b: ConnectionState): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'connecting' && b.kind === 'connecting') return a.attempt === b.attempt
  if (a.kind === 'reconnecting' && b.kind === 'reconnecting') {
    return a.attempt === b.attempt && a.nextRetryMs === b.nextRetryMs
  }
  if (a.kind === 'failed' && b.kind === 'failed') return a.reason === b.reason
  return true
}

/**
 * Standard base64, which is what the host decodes with.
 *
 * The name is a caution, not a claim: the value goes in a query string, so it is
 * percent-encoded by the caller rather than switched to the URL-safe alphabet.
 * `Data(base64Encoded:)` on the host rejects `-` and `_`, so the alphabet cannot
 * change without changing both sides.
 */
function base64Url(bytes: Uint8Array): string {
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text)
}

/** Whether two candidate lists say the same thing, in the same order. */
function sameOrigins(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((entry, index) => entry === b[index])
}
