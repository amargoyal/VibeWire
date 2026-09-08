import type { ClaudeInbound, Payload } from '../net/wireProtocol'

/**
 * What the router asks of Claude. The bridge to the real `claude` CLI and the
 * MCP channel arrive with the Claude phase; until then every request is
 * answered with the one honest message.
 */
export interface ClaudeService {
  readonly available: boolean
  setEmitter(emit: (payload: Payload) => void): void
  handle(inbound: ClaudeInbound): Promise<void>
  close(): Promise<void>
}

export class NoClaude implements ClaudeService {
  readonly available = false
  private emit: ((payload: Payload) => void) | null = null

  setEmitter(emit: (payload: Payload) => void): void {
    this.emit = emit
  }

  async handle(_inbound: ClaudeInbound): Promise<void> {
    this.emit?.({ t: 'claude', sub: 'error', message: 'Claude Code is not wired into this host yet.' })
  }

  async close(): Promise<void> {}
}
