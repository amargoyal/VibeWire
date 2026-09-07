import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, extname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { Log, describeError } from '../core/log'
import type { ClaudeMode, Payload, PermissionScope } from '../net/wireProtocol'
import { GitWorkingTree } from './gitWorkingTree'

/**
 * Drives the real `claude` CLI and translates its stream-json protocol into
 * the VibeWire messages that screens 06A/06B/06C render.
 *
 * Authentication is the whole point of doing it this way. The CLI uses the
 * credentials from `claude login`, which is the subscription — the init
 * message reports `apiKeySource: "none"`. Two consequences the code respects:
 *
 *  1. `ANTHROPIC_API_KEY` / `ANTHROPIC_AUTH_TOKEN` are stripped from the child
 *     environment. If either is set, Claude Code prefers it and silently moves
 *     the session onto API billing.
 *  2. `--bare` is never passed. That flag forces API-key auth.
 */
export interface OpenOptions {
  sessionId: string | null
  cwd: string
  mode: ClaudeMode
  model: string | null
}

export type Emit = (payload: Payload) => void

type Json = Record<string, unknown>

export class ClaudeError extends Error {}

/** Where the CLI is, or null. Prefers the native installer's location, then
 *  the platform's usual places, then whatever the PATH says. */
export function resolveClaudeExecutable(candidates: string[], env: NodeJS.ProcessEnv): string | null {
  const explicit = env.VIBEWIRE_CLAUDE_PATH
  const ordered = [explicit, ...candidates].filter((path): path is string => Boolean(path))
  for (const path of ordered) if (existsSync(path)) return path
  const lookup = process.platform === 'win32' ? spawnSync('where', ['claude'], { encoding: 'utf8', windowsHide: true }) : spawnSync('which', ['claude'], { encoding: 'utf8' })
  const found = (lookup.stdout ?? '').split(/\r?\n/).map((line) => line.trim()).find(Boolean)
  return found && existsSync(found) ? found : null
}

export class ClaudeBridge {
  private child: ChildProcess | null = null
  private stdoutBuffer = ''
  private emit: Emit | null = null
  private sessionId_: string | null = null
  private cwd_ = homedir()
  private running = false
  private startedAt: number | null = null
  /** Bumped on every launch so a superseded process's exit can be told apart
   *  from the live one's. */
  private generation = 0
  /** Permission requests waiting on the phone, keyed by the CLI's request id. */
  private pendingPermissions = new Map<string, { toolName: string; at: number }>()
  /** Tools the user chose "ALWAYS HERE" for. Scoped to this bridge, i.e. this
   *  project and this session. */
  private alwaysAllowedTools = new Set<string>()
  private runningTools = new Map<string, { name: string; target: string; at: number }>()
  private outputTokenCount = 0
  private turnStartedAt: number | null = null
  /** The file whose diff the phone has open, so edits to it are pushed as they land. */
  private watchedDiffPath: string | null = null

  constructor(
    private readonly claudeCandidates: string[],
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  setEmitter(emit: Emit): void {
    this.emit = emit
  }

  get sessionId(): string | null {
    return this.sessionId_
  }

  get cwd(): string {
    return this.cwd_
  }

  get isRunning(): boolean {
    return this.running
  }

  // MARK: Lifecycle

  async open(options: OpenOptions): Promise<void> {
    await this.close()
    const executable = resolveClaudeExecutable(this.claudeCandidates, this.env)
    if (!executable) throw new ClaudeError('claude CLI not found. Install Claude Code and run `claude login`.')

    this.cwd_ = options.cwd
    // A new session is given an id up front rather than letting the CLI keep
    // one to itself, so the conversation is journaled and resumable.
    this.sessionId_ = options.sessionId ?? randomUUID()

    const args = [
      '--print',
      '--input-format',
      'stream-json',
      '--output-format',
      'stream-json',
      '--include-partial-messages',
      '--replay-user-messages',
      '--verbose',
      // Manual means the CLI asks before running a tool, which is what makes
      // screen 06C possible at all.
      '--permission-mode',
      'manual',
    ]
    if (options.sessionId) args.push('--resume', options.sessionId)
    else args.push('--session-id', this.sessionId_)
    if (options.model) args.push('--model', options.model)
    if (options.mode === 'chat') {
      // Chat mode answers questions about the machine; it should not be able
      // to edit the filesystem out from under the user.
      args.push('--tools', 'Bash,Read,Glob,Grep,WebSearch,WebFetch')
    }

    const environment = { ...this.env }
    // The two lines that keep this on the subscription.
    delete environment.ANTHROPIC_API_KEY
    delete environment.ANTHROPIC_AUTH_TOKEN
    // Claude Code writes control characters when it thinks it owns a TTY.
    environment.TERM = 'dumb'
    environment.NO_COLOR = '1'

    // npm's shim on Windows is a batch file, which Node will only run through
    // the shell; the native installer's `.exe` and every Unix binary run as is.
    const isBatch = process.platform === 'win32' && ['.cmd', '.bat'].includes(extname(executable).toLowerCase())
    const child = isBatch
      ? spawn('cmd.exe', ['/d', '/s', '/c', `"${executable}" ${args.map(quoteForCmd).join(' ')}`], {
          cwd: this.cwd_,
          env: environment,
          windowsHide: true,
          windowsVerbatimArguments: true,
          stdio: ['pipe', 'pipe', 'pipe'],
        })
      : spawn(executable, args, { cwd: this.cwd_, env: environment, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })

    this.generation += 1
    const launchGeneration = this.generation
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.ingest(chunk))
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      const text = chunk.trim()
      if (text) Log.warn('claude', `cli stderr: ${text}`)
    })
    child.on('error', (error) => {
      Log.error('claude', `claude failed to start: ${error.message}`)
      this.handleTermination(launchGeneration, -1)
    })
    child.on('exit', (code) => this.handleTermination(launchGeneration, code ?? -1))

    this.child = child
    this.running = true
    this.startedAt = Date.now()
    Log.info('claude', `claude started (pid ${child.pid}) in ${this.cwd_} via ${basename(executable)}`)
  }

  async close(): Promise<void> {
    const child = this.child
    if (!child) return
    this.child = null
    this.running = false
    this.pendingPermissions.clear()
    this.runningTools.clear()
    this.stdoutBuffer = ''
    try {
      child.stdin?.end()
    } catch {
      // already closed
    }
    if (child.exitCode === null) {
      if (process.platform === 'win32' && child.pid) {
        // A batch shim spawns node underneath it; killing the shim alone
        // leaves the real process running. /T takes the tree.
        spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      } else {
        child.kill('SIGTERM')
      }
    }
  }

  /** `generation` identifies which process an exit belongs to. Reopening a
   *  session terminates the old process and starts a new one, and the old
   *  process's exit must not clear `isRunning` out from under the new one. */
  private handleTermination(generation: number, status: number): void {
    if (generation !== this.generation) {
      Log.debug('claude', `ignoring exit ${status} from superseded claude (gen ${generation})`)
      return
    }
    this.running = false
    this.child = null
    const duration = this.startedAt ? Date.now() - this.startedAt : 0
    this.emit?.({ t: 'claude', sub: 'ended', reason: status === 0 ? 'completed' : `exited(${status})`, durationMs: duration })
    Log.info('claude', `claude exited with status ${status}`)
  }

  // MARK: Sending

  send(text: string): void {
    if (!this.running || !this.child?.stdin) {
      Log.warn('claude', `send refused: no running CLI (${text.length} chars dropped)`)
      this.emit?.({ t: 'claude', sub: 'error', message: 'no active session' })
      return
    }
    Log.info('claude', `sending ${text.length} chars to claude`)
    this.turnStartedAt = Date.now()
    this.outputTokenCount = 0
    this.write({ type: 'user', message: { role: 'user', content: [{ type: 'text', text }] } })
  }

  /** The red STOP target on 06B: a first-class control, not a kill. */
  interrupt(): void {
    if (!this.running) return
    this.write({ type: 'control_request', request_id: randomUUID(), request: { subtype: 'interrupt' } })
    Log.info('claude', 'interrupt sent')
  }

  /** Answers a `can_use_tool` control request: `{behavior: "allow"}` or
   *  `{behavior: "deny", message}`. */
  respondToPermission(requestId: string, allow: boolean, scope: PermissionScope, message: string | null): void {
    const pending = this.pendingPermissions.get(requestId)
    if (!pending) {
      Log.warn('claude', `no pending permission for ${requestId}`)
      return
    }
    this.pendingPermissions.delete(requestId)
    if (allow && scope === 'always') this.alwaysAllowedTools.add(pending.toolName)
    const response = allow ? { behavior: 'allow' } : { behavior: 'deny', message: message ?? 'Denied from phone' }
    this.write({ type: 'control_response', response: { subtype: 'success', request_id: requestId, response } })
    Log.info('claude', `permission ${allow ? 'allowed' : 'denied'} for ${pending.toolName}`)
  }

  private write(object: Json): void {
    const stdin = this.child?.stdin
    if (!stdin) return
    try {
      stdin.write(JSON.stringify(object) + '\n')
    } catch (error) {
      Log.error('claude', `failed writing to claude stdin: ${describeError(error)}`)
    }
  }

  // MARK: Receiving

  private ingest(chunk: string): void {
    this.stdoutBuffer += chunk
    for (;;) {
      const newline = this.stdoutBuffer.indexOf('\n')
      if (newline < 0) break
      const line = this.stdoutBuffer.slice(0, newline)
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1)
      if (!line.trim()) continue
      let object: Json
      try {
        object = JSON.parse(line)
      } catch {
        Log.debug('claude', 'unparsable line from claude')
        continue
      }
      this.route(object)
    }
  }

  private route(object: Json): void {
    const type = object.type
    if (typeof type !== 'string') return
    if (typeof object.session_id === 'string') this.sessionId_ = object.session_id
    switch (type) {
      case 'system':
        this.handleSystem(object)
        break
      case 'assistant':
        this.handleAssistant(object)
        break
      case 'user':
        this.handleUserEcho(object)
        break
      case 'stream_event':
        this.handlePartial(object)
        break
      case 'control_request':
        this.handleControlRequest(object)
        break
      case 'rate_limit_event': {
        const info = object.rate_limit_info as Json | undefined
        if (info) {
          this.emit?.({
            t: 'claude',
            sub: 'rateLimit',
            status: typeof info.status === 'string' ? info.status : 'unknown',
            resetsAt: typeof info.resetsAt === 'number' ? info.resetsAt : 0,
            type: typeof info.rateLimitType === 'string' ? info.rateLimitType : '',
          })
        }
        break
      }
      case 'result':
        this.handleResult(object)
        break
      default:
        Log.debug('claude', `unhandled message type ${type}`)
    }
  }

  private handleSystem(object: Json): void {
    if (object.subtype !== 'init') return
    const apiKeySource = typeof object.apiKeySource === 'string' ? object.apiKeySource : 'unknown'
    if (apiKeySource !== 'none') {
      // Loud, because it means the user is being billed per token when they
      // asked specifically not to be.
      Log.warn('claude', `claude authenticated via ${apiKeySource}, not the subscription`)
    }
    this.emit?.({
      t: 'claude',
      sub: 'opened',
      sessionId: this.sessionId_ ?? '',
      cwd: typeof object.cwd === 'string' ? object.cwd : this.cwd_,
      model: typeof object.model === 'string' ? object.model : '',
      tools: Array.isArray(object.tools) ? object.tools : [],
      permissionMode: typeof object.permissionMode === 'string' ? object.permissionMode : '',
      apiKeySource,
      usingSubscription: apiKeySource === 'none',
      version: typeof object.claude_code_version === 'string' ? object.claude_code_version : '',
    })
  }

  private handlePartial(object: Json): void {
    // Token-level deltas drive the "STREAMING · 31 TOK/S" readout on 06A.
    const event = object.event as Json | undefined
    if (!event || event.type !== 'content_block_delta') return
    const delta = event.delta as Json | undefined
    const text = delta?.text
    if (typeof text !== 'string') return
    this.outputTokenCount += 1
    const payload: Payload = { t: 'claude', sub: 'delta', text }
    if (this.turnStartedAt) {
      const elapsed = (Date.now() - this.turnStartedAt) / 1000
      if (elapsed > 0.5) payload.tokensPerSecond = Math.floor(this.outputTokenCount / elapsed)
    }
    this.emit?.(payload)
  }

  private handleAssistant(object: Json): void {
    const message = object.message as Json | undefined
    const content = message?.content
    if (!Array.isArray(content)) return
    const blocks: Json[] = []
    for (const raw of content) {
      const block = raw as Json
      switch (block.type) {
        case 'text':
          if (typeof block.text === 'string' && block.text) blocks.push({ type: 'text', text: block.text })
          break
        case 'thinking':
          if (typeof block.thinking === 'string' && block.thinking) blocks.push({ type: 'thinking', text: block.thinking })
          break
        case 'tool_use': {
          if (typeof block.id !== 'string' || typeof block.name !== 'string') break
          const input = (block.input as Json | undefined) ?? {}
          const target = describeTarget(block.name, input)
          this.runningTools.set(block.id, { name: block.name, target, at: Date.now() })
          this.emit?.({ t: 'claude', sub: 'tool', id: block.id, name: block.name, target, state: 'running' })
          break
        }
      }
    }
    if (blocks.length) this.emit?.({ t: 'claude', sub: 'message', role: 'assistant', blocks })
  }

  private handleUserEcho(object: Json): void {
    const message = object.message as Json | undefined
    const content = message?.content
    if (!Array.isArray(content)) return
    for (const raw of content) {
      const block = raw as Json
      if (block.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue
      const started = this.runningTools.get(block.tool_use_id)
      this.runningTools.delete(block.tool_use_id)
      this.emit?.({
        t: 'claude',
        sub: 'tool',
        id: block.tool_use_id,
        name: started?.name ?? '',
        target: started?.target ?? '',
        state: block.is_error === true ? 'error' : 'ok',
        ms: started ? Date.now() - started.at : 0,
        preview: previewText(block.content),
      })
    }
    // A tool just finished; the working tree may have moved. Read it from git
    // rather than inferring it from which tool ran.
    this.publishWorkingTree()
  }

  // MARK: Working tree

  /** Pushes the changed-file list, and the open diff along with it. */
  publishWorkingTree(): void {
    const { files, total } = GitWorkingTree.changes(this.cwd_)
    this.emit?.({ t: 'claude', sub: 'files', files, total })
    if (this.watchedDiffPath) this.emitDiff(this.watchedDiffPath)
  }

  /** Opens (or with null, closes) the live diff for one path. */
  watchDiff(path: string | null): void {
    this.watchedDiffPath = path
    if (path) this.emitDiff(path)
  }

  private emitDiff(path: string): void {
    this.emit?.({ t: 'claude', sub: 'diff', path, patch: GitWorkingTree.diff(this.cwd_, path) })
  }

  private handleControlRequest(object: Json): void {
    const requestId = object.request_id
    const request = object.request as Json | undefined
    if (typeof requestId !== 'string' || !request || typeof request.subtype !== 'string') return
    if (request.subtype !== 'can_use_tool') {
      Log.debug('claude', `unhandled control request ${request.subtype}`)
      return
    }
    const toolName = typeof request.tool_name === 'string' ? request.tool_name : 'unknown'
    const input = (request.input as Json | undefined) ?? {}
    this.pendingPermissions.set(requestId, { toolName, at: Date.now() })
    // "ALWAYS HERE" from a previous prompt: answer without waking the phone.
    if (this.alwaysAllowedTools.has(toolName)) {
      this.respondToPermission(requestId, true, 'once', null)
      return
    }
    this.emit?.({
      t: 'claude',
      sub: 'permission',
      requestId,
      toolName,
      command: describeCommand(toolName, input),
      explanation: explain(toolName, input),
      waitingMs: 0,
    })
    Log.info('claude', `permission requested for ${toolName}`)
  }

  private handleResult(object: Json): void {
    const usage = object.usage as Json | undefined
    const payload: Payload = {
      t: 'claude',
      sub: 'usage',
      durationMs: typeof object.duration_ms === 'number' ? object.duration_ms : 0,
      turns: typeof object.num_turns === 'number' ? object.num_turns : 0,
      stopReason: typeof object.stop_reason === 'string' ? object.stop_reason : '',
    }
    if (usage) {
      payload.inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0
      payload.outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0
    }
    this.emit?.(payload)
  }

  /** Long-pending permissions with a refreshed age, so 06C's "PAUSED 12S"
   *  counts up truthfully even if the phone reconnects mid-wait. */
  pendingPermissionSnapshot(): Payload[] {
    return [...this.pendingPermissions].map(([requestId, pending]) => ({
      requestId,
      toolName: pending.toolName,
      waitingMs: Date.now() - pending.at,
    }))
  }
}

function quoteForCmd(argument: string): string {
  return /[\s"]/.test(argument) ? `"${argument.replace(/"/g, '\\"')}"` : argument
}

/** "Grep \"queue\"" style targets for the 06B ledger. */
function describeTarget(tool: string, input: Json): string {
  const str = (key: string) => (typeof input[key] === 'string' ? (input[key] as string) : '')
  switch (tool) {
    case 'Bash':
      return str('command')
    case 'Read':
    case 'Write':
    case 'Edit':
      return basename(str('file_path'))
    case 'Grep':
      return `"${str('pattern')}"`
    case 'Glob':
      return str('pattern')
    case 'WebFetch':
      return str('url')
    case 'WebSearch':
      return str('query')
    default:
      return ''
  }
}

/** 06C states the command verbatim; never summarised or truncated here. */
function describeCommand(tool: string, input: Json): string {
  if (tool === 'Bash' && typeof input.command === 'string') return input.command
  if (typeof input.file_path === 'string') return `${tool} ${input.file_path}`
  try {
    const sorted = Object.fromEntries(Object.entries(input).sort(([a], [b]) => (a < b ? -1 : 1)))
    return `${tool} ${JSON.stringify(sorted)}`
  } catch {
    return tool
  }
}

/** The plain-units sentence under the command on 06C. */
function explain(tool: string, input: Json): string {
  switch (tool) {
    case 'Bash': {
      const command = typeof input.command === 'string' ? input.command : ''
      if (command.includes('rm ') || command.includes('rm -rf')) {
        return 'Deletes files. Nothing tracked by git is restored automatically.'
      }
      return typeof input.description === 'string' ? input.description : 'Runs a shell command on the host.'
    }
    case 'Write':
      return 'Creates or overwrites a file on the host.'
    case 'Edit':
      return 'Modifies a file on the host.'
    default:
      return `Runs the ${tool} tool.`
  }
}

function previewText(content: unknown): string {
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    text = content
      .map((block) => (block && typeof block === 'object' && typeof (block as Json).text === 'string' ? ((block as Json).text as string) : null))
      .filter((value): value is string => value !== null)
      .join('\n')
  }
  // 06B shows only the running tool's output, and only a few lines of it.
  return text.split('\n').slice(0, 3).join('\n')
}
