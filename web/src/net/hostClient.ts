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
import { parseEndpoint, socketOrigin, type Endpoint } from './endpoint'
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
}

/** Monotonic microseconds, so a clock adjustment mid-session cannot make a
 *  measured round trip read negative. */
function micros(): number {
  return Math.round(performance.now() * 1000)
}

export class PairFailure extends Error {}

const MAX_QUEUED_OUTBOUND = 64

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

  /** One-shot handshake against a host that is showing a code. */
  async pair(endpoint: Endpoint, code: string): Promise<PairedHost> {
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
      throw new PairFailure(`No answer from ${endpoint.host} — ${detail}.`)
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
      pairedAt: new Date().toISOString(),
    }
    await Identity.savePairedHost(paired)
    this.host = paired
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
    await this.openSocket()
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
    if (!host) return

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

    try {
      const nonce = await this.fetchNonce(host)
      const signature = await Identity.sign(fromBase64(nonce))
      const endpoint = parseEndpoint(host.origin)
      const url =
        `${socketOrigin(endpoint)}/v1/socket` +
        `?device=${encodeURIComponent(host.deviceId)}` +
        `&nonce=${encodeURIComponent(nonce)}` +
        `&sig=${encodeURIComponent(base64Url(signature))}`

      const socket = new WebSocket(url)
      socket.binaryType = 'arraybuffer'
      this.socket = socket
      this.handshakeConfirmed = false

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
    this.transition({ kind: 'connected' })
    this.flushQueue()
    this.startPinging()
  }

  private async fetchNonce(host: PairedHost): Promise<string> {
    const response = await fetch(
      `${host.origin}/v1/challenge?deviceId=${encodeURIComponent(host.deviceId)}`,
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
  private async verifyIdentity(host: PairedHost): Promise<'trusted' | 'revoked' | 'unknown'> {
    try {
      const nonce = await this.fetchNonce(host)
      const signature = await Identity.sign(fromBase64(nonce))
      const response = await fetch(
        `${host.origin}/v1/verify` +
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
    if (!this.handshakeConfirmed && this.reconnectAttempt === 0 && this.host) {
      if ((await this.verifyIdentity(this.host)) === 'revoked') {
        this.shouldReconnect = false
        this.transition({ kind: 'unauthorized' })
        return
      }
    }

    this.reconnectStartedAt ??= performance.now()

    // 03D: "GIVING UP AT 30S".
    if (performance.now() - this.reconnectStartedAt > 30_000) {
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
