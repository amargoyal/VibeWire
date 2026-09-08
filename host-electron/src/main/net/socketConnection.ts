import type { WebSocket } from 'ws'
import { Log } from '../core/log'
import type { Payload } from './wireProtocol'

/**
 * An upgraded, authenticated socket. Video frames are pushed from the capture
 * path while control messages come from the router; `ws` serialises the writes.
 */
export class SocketConnection {
  /** When this socket was upgraded, for the ATTACHED 1H 12M readout. Taken at
   *  construction, which is the moment authentication succeeded. */
  readonly openedAt = new Date()
  private closed = false
  private lastPongAt = Date.now()
  /**
   * Bytes handed to the transport on this socket, both framings. Counted here
   * rather than derived from the encoder's rate because this is what actually
   * left for this device — a dropped frame never reaches the wire, and the
   * dashboard says SENT, not ENCODED.
   */
  private bytesSentTotal = 0
  private framesDroppedTotal = 0

  /** Video is dropped rather than queued when the socket is congested. A stale
   *  frame is worthless; a growing queue is worse than worthless. */
  private readonly maxInFlightBinaryBytes = 4 * 1024 * 1024

  constructor(
    private readonly ws: WebSocket,
    readonly deviceId: string,
    readonly deviceName: string,
  ) {}

  sendJSON(object: Payload): void {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return
    const text = JSON.stringify(object)
    this.bytesSentTotal += Buffer.byteLength(text)
    this.ws.send(text, (error) => {
      if (error) Log.debug('net', `send failed: ${error.message}`)
    })
  }

  /** Returns false when the frame was dropped because the socket is behind. */
  sendBinary(payload: Uint8Array): boolean {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return false
    if (this.ws.bufferedAmount + payload.byteLength > this.maxInFlightBinaryBytes) {
      this.framesDroppedTotal += 1
      return false
    }
    this.bytesSentTotal += payload.byteLength
    this.ws.send(payload, { binary: true }, (error) => {
      if (error) Log.debug('net', `binary send failed: ${error.message}`)
    })
    return true
  }

  /** Total bytes sent, and frames dropped for congestion, since the upgrade. */
  get traffic(): { bytesSent: number; framesDropped: number } {
    return { bytesSent: this.bytesSentTotal, framesDropped: this.framesDroppedTotal }
  }

  /** A WebSocket-level ping for liveness only; loss and latency come from the
   *  phone's numbered app-level pings. */
  ping(): void {
    if (this.closed || this.ws.readyState !== this.ws.OPEN) return
    this.ws.ping()
  }

  notePong(): void {
    this.lastPongAt = Date.now()
  }

  get secondsSincePong(): number {
    return (Date.now() - this.lastPongAt) / 1000
  }

  close(code: number, reason: string): void {
    if (this.closed) return
    this.closed = true
    try {
      this.ws.close(code, reason)
    } catch (error) {
      Log.debug('net', `close failed: ${String(error)}`)
    }
    Log.info('net', `socket closed (${code}): ${reason}`)
  }

  /** Called by the server when the transport has gone away underneath. */
  markClosed(): void {
    this.closed = true
  }
}
