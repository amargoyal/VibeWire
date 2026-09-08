import { homedir } from 'node:os'
import { Log, describeError } from '../core/log'
import type { ClaudeInbound, Payload } from '../net/wireProtocol'
import { ChannelBridge } from './channelBridge'
import { ClaudeBridge } from './claudeBridge'
import type { ClaudeService } from './claudeService'
import { ClaudeSessionIndex, sessionWire, turnWire } from './claudeSessionIndex'

/** Reserved session id standing for "the live one", not a transcript file. */
export const LIVE_SESSION_ID = 'vibewire-live-session'

/**
 * Claude, from the phone or the dashboard. Replies go to the emitter, not to
 * whoever asked: there is one Claude session on this host, and both surfaces
 * are looking at it. Ported from `HostRouter.handleClaude`.
 */
export class LiveClaudeService implements ClaudeService {
  readonly available = true
  private readonly bridge: ClaudeBridge
  private readonly channel: ChannelBridge
  private readonly index: ClaudeSessionIndex

  constructor(options: { claudeCandidates: string[]; channelTokenPath: string; projectsDirectory: string }) {
    this.bridge = new ClaudeBridge(options.claudeCandidates)
    this.channel = new ChannelBridge(options.channelTokenPath)
    this.index = new ClaudeSessionIndex(options.projectsDirectory)
  }

  setEmitter(emit: (payload: Payload) => void): void {
    this.bridge.setEmitter(emit)
    this.channel.setEmitter(emit)
    this.emit = emit
  }

  private emit: (payload: Payload) => void = () => {}

  async close(): Promise<void> {
    await this.bridge.close()
  }

  async handle(inbound: ClaudeInbound): Promise<void> {
    switch (inbound.sub) {
      case 'listSessions': {
        const listed: Payload[] = this.index.recentSessions(inbound.cwd).map(sessionWire)
        // The channel server only exists while a Claude Code session is
        // running it, so reaching it *is* the test for "there is a live
        // session to join". It goes first.
        const liveAvailable = await this.channel.isAvailable()
        Log.info('claude', `session list: ${listed.length} on disk, live session ${liveAvailable ? 'OFFERED' : 'not reachable on 8790'}`)
        if (liveAvailable) {
          listed.unshift({
            id: LIVE_SESSION_ID,
            summary: 'Live session in your terminal',
            cwd: '',
            gitBranch: '',
            modifiedAt: new Date().toISOString(),
          })
        }
        this.emit({ t: 'claude', sub: 'sessions', sessions: listed })
        break
      }

      case 'open': {
        if (inbound.sessionId === LIVE_SESSION_ID) {
          await this.bridge.close()
          this.channel.attach()
          this.emit({ t: 'claude', sub: 'opened', sessionId: LIVE_SESSION_ID, cwd: inbound.cwd ?? '', live: true })
          Log.info('claude', 'attached to the live terminal session over the channel')
          return
        }
        this.channel.detach()
        const workingDirectory = inbound.cwd ?? this.index.recentSessions(null, 1)[0]?.cwd ?? homedir()
        try {
          await this.bridge.open({ sessionId: inbound.sessionId, cwd: workingDirectory, mode: inbound.mode, model: null })
          // Confirm the spawn now: `claude --print` emits its init only once it
          // has a prompt. The real init overwrites this with the authoritative
          // values. Report the id the bridge settled on, not the one asked for.
          const openedId = this.bridge.sessionId ?? inbound.sessionId ?? ''
          this.emit({ t: 'claude', sub: 'opened', sessionId: openedId, cwd: workingDirectory, pending: true })
          Log.info('claude', `session ${openedId} open in ${workingDirectory}`)

          // Resuming restores the model's context but prints nothing; the
          // transcript on disk is the only copy of what was already said.
          if (inbound.sessionId) {
            const turns = this.index.transcript(inbound.sessionId)
            if (turns.length) {
              this.emit({ t: 'claude', sub: 'history', sessionId: inbound.sessionId, turns: turns.map(turnWire) })
            }
          }
          // Whatever is already uncommitted in that project belongs on the
          // phone before Claude touches anything else.
          this.bridge.publishWorkingTree()
        } catch (error) {
          this.emit({ t: 'claude', sub: 'error', message: describeError(error) })
        }
        break
      }

      case 'send':
        if (this.channel.isAttached) {
          if (!(await this.channel.send(inbound.text))) {
            this.emit({
              t: 'claude',
              sub: 'error',
              message: 'The terminal session is no longer listening. Reopen it with the channel loaded.',
            })
          }
        } else {
          this.bridge.send(inbound.text)
        }
        break

      case 'interrupt':
        this.bridge.interrupt()
        break

      case 'permission':
        if (this.channel.isAttached) {
          // Channel verdicts are allow/deny only: the terminal dialog is open
          // at the same time and there is no "always" to record.
          await this.channel.answerPermission(inbound.requestId, inbound.allow)
        } else {
          this.bridge.respondToPermission(inbound.requestId, inbound.allow, inbound.scope, inbound.message)
        }
        break

      case 'diff':
        this.bridge.watchDiff(inbound.path)
        break

      case 'close':
        await this.bridge.close()
        break
    }
  }
}
