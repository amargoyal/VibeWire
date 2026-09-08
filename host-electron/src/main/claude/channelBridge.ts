import { readFileSync } from 'node:fs'
import { Log, describeError } from '../core/log'
import type { Payload } from '../net/wireProtocol'

/**
 * Talks to the VibeWire channel MCP server, which Claude Code spawns inside a
 * session that is already running. This is the difference between starting a
 * conversation from the phone and joining the one open in a terminal.
 *
 * The channel listens on loopback and is gated on a token, so this is the only
 * thing on the machine that can reach it.
 */
export class ChannelBridge {
  private emit: ((payload: Payload) => void) | null = null
  private abort: AbortController | null = null
  private attached = false

  constructor(
    private readonly tokenPath: string,
    private readonly port = 8790,
  ) {}

  private get token(): string | null {
    try {
      const token = readFileSync(this.tokenPath, 'utf8').trim()
      return token || null
    } catch {
      return null
    }
  }

  private headers(): Record<string, string> | null {
    const token = this.token
    return token ? { 'X-VibeWire-Channel': token } : null
  }

  private url(path: string): string {
    return `http://127.0.0.1:${this.port}${path}`
  }

  get isAttached(): boolean {
    return this.attached
  }

  setEmitter(emit: (payload: Payload) => void): void {
    this.emit = emit
  }

  /** Whether a session on this machine currently has the channel loaded. The
   *  server only exists while Claude Code is running it. */
  async isAvailable(): Promise<boolean> {
    const headers = this.headers()
    if (!headers) return false
    try {
      const response = await fetch(this.url('/health'), { headers, signal: AbortSignal.timeout(1000) })
      return response.status === 200
    } catch {
      return false
    }
  }

  /** Sends the phone's message into the live session. */
  async send(text: string): Promise<boolean> {
    const headers = this.headers()
    if (!headers) return false
    try {
      const response = await fetch(this.url('/message'), { method: 'POST', headers, body: text, signal: AbortSignal.timeout(10_000) })
      if (response.status !== 200) throw new Error(`status ${response.status}`)
      Log.info('claude', `sent ${text.length} chars into the live session via the channel`)
      return true
    } catch (error) {
      Log.warn('claude', `channel send failed — is a session running with the channel loaded? (${describeError(error)})`)
      return false
    }
  }

  /** Answers a permission prompt the session raised. The terminal dialog stays
   *  open too, and Claude Code applies whichever verdict lands first. */
  async answerPermission(requestId: string, allow: boolean): Promise<void> {
    const headers = this.headers()
    if (!headers) return
    try {
      await fetch(this.url('/permission'), {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ requestId, allow }),
        signal: AbortSignal.timeout(5000),
      })
    } catch (error) {
      Log.warn('claude', `channel permission answer failed: ${describeError(error)}`)
    }
  }

  attach(): void {
    if (this.abort) return
    this.attached = true
    this.abort = new AbortController()
    void this.readEvents(this.abort.signal)
  }

  detach(): void {
    this.abort?.abort()
    this.abort = null
    this.attached = false
  }

  /** Reads the server-sent event stream: Claude's replies, and permission
   *  prompts raised by the live session. */
  private async readEvents(signal: AbortSignal): Promise<void> {
    const headers = this.headers()
    if (!headers) return
    try {
      const response = await fetch(this.url('/events'), { headers, signal })
      if (response.status !== 200 || !response.body) {
        Log.warn('claude', 'channel event stream refused')
        return
      }
      Log.info('claude', "attached to the live session's channel")
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        for (;;) {
          const newline = buffer.indexOf('\n')
          if (newline < 0) break
          const line = buffer.slice(0, newline).replace(/\r$/, '')
          buffer = buffer.slice(newline + 1)
          if (!line.startsWith('data: ')) continue
          try {
            this.handle(JSON.parse(line.slice(6)))
          } catch {
            // not JSON; skip
          }
        }
      }
    } catch (error) {
      if (!signal.aborted) Log.warn('claude', `channel event stream ended: ${describeError(error)}`)
    } finally {
      if (this.abort?.signal === signal) {
        this.abort = null
        this.attached = false
      }
    }
  }

  private handle(event: Record<string, unknown>): void {
    switch (event.kind) {
      case 'reply':
        this.emit?.({
          t: 'claude',
          sub: 'message',
          role: 'assistant',
          blocks: [{ type: 'text', text: typeof event.text === 'string' ? event.text : '' }],
        })
        break
      case 'permission':
        this.emit?.({
          t: 'claude',
          sub: 'permission',
          requestId: typeof event.requestId === 'string' ? event.requestId : '',
          toolName: typeof event.toolName === 'string' ? event.toolName : '',
          command: typeof event.inputPreview === 'string' ? event.inputPreview : '',
          explanation: typeof event.description === 'string' ? event.description : '',
          waitingMs: 0,
        })
        break
    }
  }
}
