import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from 'node:fs'
import { basename, join } from 'node:path'

/**
 * Reads Claude Code's on-disk session history so the phone can list and resume
 * real past conversations. One JSONL transcript per session under
 * `~/.claude/projects/<slugified-cwd>/<session-uuid>.jsonl`. Nothing here
 * writes; resuming is done by handing the session id to the CLI.
 */
export interface ClaudeSessionSummary {
  id: string
  summary: string
  cwd: string
  gitBranch: string | null
  modifiedAt: Date
  messageCount: number
}

export function sessionWire(session: ClaudeSessionSummary): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    id: session.id,
    summary: session.summary,
    cwd: session.cwd,
    modifiedAt: session.modifiedAt.toISOString(),
    messages: session.messageCount,
  }
  if (session.gitBranch) payload.gitBranch = session.gitBranch
  return payload
}

/** One past message, for repopulating the panel when a session is resumed. */
export interface Turn {
  role: 'user' | 'assistant'
  text: string
  at: Date | null
}

export function turnWire(turn: Turn): Record<string, unknown> {
  const payload: Record<string, unknown> = { role: turn.role, text: turn.text }
  if (turn.at) payload.at = turn.at.toISOString()
  return payload
}

type Json = Record<string, unknown>

export class ClaudeSessionIndex {
  constructor(private readonly projectsDirectory: string) {}

  /** Claude Code slugifies the working directory: every character that is not
   *  a letter or a digit becomes a dash. Matching that scopes the list to one repo. */
  static slug(path: string): string {
    return [...path].map((character) => (/[\p{L}\p{N}]/u.test(character) ? character : '-')).join('')
  }

  /** Most recent sessions first. `cwd` scopes to one project; null lists all. */
  recentSessions(cwd: string | null, limit = 25): ClaudeSessionSummary[] {
    let directories: string[] = []
    if (cwd) {
      const directory = join(this.projectsDirectory, ClaudeSessionIndex.slug(cwd))
      if (existsSync(directory)) directories = [directory]
    } else {
      directories = this.projectDirectories()
    }

    const summaries: ClaudeSessionSummary[] = []
    for (const directory of directories) {
      let files: string[]
      try {
        files = readdirSync(directory)
      } catch {
        continue
      }
      for (const file of files) {
        if (!file.endsWith('.jsonl') || file.startsWith('.')) continue
        const summary = parseTranscript(join(directory, file))
        if (summary) summaries.push(summary)
      }
    }
    return summaries.sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime()).slice(0, limit)
  }

  /**
   * The conversation so far. `claude --resume` under `--print` restores the
   * context for the model but prints nothing, so a resumed session would
   * arrive as an empty panel. The transcript on disk is the only copy.
   */
  transcript(sessionId: string, limit = 40): Turn[] {
    const path = this.transcriptPath(sessionId)
    if (!path) return []
    let contents: string
    try {
      contents = require('node:fs').readFileSync(path, 'utf8') as string
    } catch {
      return []
    }
    const turns: Turn[] = []
    for (const line of contents.split('\n')) {
      const object = parseLine(line)
      if (!object) continue
      const type = object.type
      if (type !== 'user' && type !== 'assistant') continue
      // Injected context, not something either party said.
      if (object.isMeta === true) continue
      const message = object.message as Json | undefined
      const text = extractText(message?.content)
      if (!text || !text.trim()) continue
      // Tool plumbing and harness scaffolding are not conversation.
      const lowered = text.toLowerCase()
      if (
        lowered.startsWith('<command') ||
        lowered.startsWith('caveat:') ||
        lowered.startsWith('<local-command') ||
        lowered.includes('</system-reminder>')
      ) {
        continue
      }
      const stamp = typeof object.timestamp === 'string' ? new Date(object.timestamp) : null
      turns.push({
        role: type === 'user' ? 'user' : 'assistant',
        text: text.slice(0, 4000),
        at: stamp && !Number.isNaN(stamp.getTime()) ? stamp : null,
      })
    }
    return turns.slice(-limit)
  }

  /** Transcripts are filed under a slug of the working directory, and a caller
   *  resuming by id does not necessarily know which one — so search. */
  private transcriptPath(sessionId: string): string | null {
    if (!/^[A-Za-z0-9-]+$/.test(sessionId)) return null
    for (const directory of this.projectDirectories()) {
      const candidate = join(directory, `${sessionId}.jsonl`)
      if (existsSync(candidate)) return candidate
    }
    return null
  }

  private projectDirectories(): string[] {
    try {
      return readdirSync(this.projectsDirectory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
        .map((entry) => join(this.projectsDirectory, entry.name))
    } catch {
      return []
    }
  }
}

function parseLine(line: string): Json | null {
  if (!line) return null
  try {
    const value = JSON.parse(line)
    return value && typeof value === 'object' ? (value as Json) : null
  } catch {
    return null
  }
}

/**
 * Pulls just enough out of a transcript to render a list row: the first user
 * message as a title, plus cwd and branch. Transcripts can be megabytes, so
 * this reads the head for metadata and counts lines without parsing the rest.
 */
function parseTranscript(path: string): ClaudeSessionSummary | null {
  let modifiedAt: Date
  try {
    modifiedAt = statSync(path).mtime
  } catch {
    return null
  }
  const head = readHead(path, 256 * 1024)
  if (!head.length) return null

  let cwd = ''
  let gitBranch: string | null = null
  let title: string | null = null
  for (const line of head.split('\n')) {
    const object = parseLine(line)
    if (!object) continue
    if (!cwd && typeof object.cwd === 'string') cwd = object.cwd
    if (gitBranch === null && typeof object.gitBranch === 'string' && object.gitBranch) gitBranch = object.gitBranch
    if (title === null && object.type === 'user') {
      const message = object.message as Json | undefined
      const candidate = extractText(message?.content)
      const cleaned = candidate ? summaryText(candidate) : null
      if (cleaned) title = cleaned
    }
    if (title !== null && cwd && gitBranch !== null) break
  }

  const id = basename(path, '.jsonl')
  const summary = (title || 'Untitled session').replace(/\n/g, ' ').trim().slice(0, 120)
  return {
    id,
    summary,
    cwd: cwd || basename(join(path, '..')),
    gitBranch,
    modifiedAt,
    messageCount: countLines(path),
  }
}

function readHead(path: string, bytes: number): string {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return ''
  }
  try {
    const buffer = Buffer.alloc(bytes)
    const read = readSync(fd, buffer, 0, bytes, 0)
    return buffer.subarray(0, read).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

function countLines(path: string): number {
  let fd: number
  try {
    fd = openSync(path, 'r')
  } catch {
    return 0
  }
  try {
    const buffer = Buffer.alloc(1 << 20)
    let total = 0
    for (;;) {
      const read = readSync(fd, buffer, 0, buffer.length, null)
      if (read <= 0) break
      for (let index = 0; index < read; index += 1) if (buffer[index] === 0x0a) total += 1
    }
    return total
  } finally {
    closeSync(fd)
  }
}

/** Transcripts often open with tooling scaffolding — command wrappers, caveat
 *  banners, injected reminders. Strip those and take the first line that reads
 *  like something a person typed. */
function summaryText(raw: string): string | null {
  let text = raw
  for (;;) {
    const open = text.indexOf('<')
    if (open < 0) break
    const close = text.indexOf('>', open + 1)
    if (close < 0) break
    const tag = text.slice(open + 1, close).split(' ')[0] ?? ''
    if (!tag || tag.startsWith('/')) break
    const end = text.indexOf(`</${tag}>`)
    text = end >= 0 ? text.slice(0, open) + text.slice(end + tag.length + 3) : text.slice(0, open) + text.slice(close + 1)
  }
  const ignored = ['caveat:', 'system-reminder', '<command', 'local-command']
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length <= 3) continue
    const lowered = trimmed.toLowerCase()
    if (ignored.some((prefix) => lowered.startsWith(prefix))) continue
    return trimmed
  }
  return null
}

/** Message content is either a plain string or an array of typed blocks. */
function extractText(content: unknown): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  for (const block of content) {
    if (block && typeof block === 'object' && (block as Json).type === 'text') {
      const text = (block as Json).text
      if (typeof text === 'string' && text) return text
    }
  }
  return null
}
