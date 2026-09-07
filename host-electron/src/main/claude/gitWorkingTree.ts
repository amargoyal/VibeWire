import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * What Claude has actually changed on disk, read straight from git.
 *
 * The alternative — believing the tool calls — drifts the moment a `Bash`
 * step writes a file, a build regenerates something, or an edit gets
 * reverted. Git already tracks exactly this and is the same thing the user
 * would check, so the phone shows the working tree rather than a guess.
 */
export interface FileChange {
  /** Relative to the repository root. */
  path: string
  status: 'A' | 'M' | 'D'
  added: number
  removed: number
}

/** Build output and caches. A repository without a .gitignore reports
 *  thousands of untracked files, and none of them are a change anyone made. */
const IGNORED_COMPONENTS = new Set([
  '.build',
  '.git',
  'DerivedData',
  'node_modules',
  '.venv',
  '__pycache__',
  '.next',
  'dist',
  'build',
  '.DS_Store',
])

/** More than this and the list has stopped being a list of what changed. */
const FILE_LIMIT = 200

export const GitWorkingTree = {
  /** Every uncommitted change, staged or not, including files git has never
   *  seen. Returns the total before truncation, so the phone can say so. */
  changes(cwd: string): { files: FileChange[]; total: number } {
    const all = allChanges(cwd)
    return { files: all.slice(0, FILE_LIMIT), total: all.length }
  },

  /** A unified diff for one path, as git would print it. Untracked files are
   *  compared to /dev/null — which git on Windows understands too — so the
   *  whole file shows as additions instead of an empty patch. */
  diff(cwd: string, path: string): string {
    const root = repositoryRoot(cwd)
    if (!root) return ''
    const tracked = run(['ls-files', '--error-unmatch', path], root, true)
    if (!tracked) return run(['diff', '--no-index', '--', '/dev/null', path], root)
    return run(['diff', 'HEAD', '--', path], root)
  },

  repositoryRoot,
}

function allChanges(cwd: string): FileChange[] {
  const root = repositoryRoot(cwd)
  if (!root) return []

  // --numstat covers tracked edits; untracked files are counted by hand below.
  const counts = new Map<string, { added: number; removed: number }>()
  for (const line of run(['diff', 'HEAD', '--numstat'], root).split('\n')) {
    const fields = line.split('\t')
    if (fields.length < 3) continue
    // "-" in place of a count means binary.
    counts.set(fields.slice(2).join('\t'), { added: Number(fields[0]) || 0, removed: Number(fields[1]) || 0 })
  }

  const changes: FileChange[] = []
  for (const line of run(['status', '--porcelain=v1', '--untracked-files=all'], root).split('\n')) {
    if (line.length <= 3) continue
    const code = line.slice(0, 2)
    let path = line.slice(3)
    // Renames arrive as "old -> new"; the new name is what changed.
    const arrow = path.indexOf(' -> ')
    if (arrow >= 0) path = path.slice(arrow + 4)
    path = path.replace(/^"|"$/g, '')

    if (path.split('/').some((component) => IGNORED_COMPONENTS.has(component))) continue

    const status: FileChange['status'] = code.includes('D') ? 'D' : code.includes('?') || code.includes('A') ? 'A' : 'M'
    const count = counts.get(path) ?? (status === 'A' ? { added: lineCount(root, path), removed: 0 } : { added: 0, removed: 0 })
    changes.push({ path, status, added: count.added, removed: count.removed })
  }
  return changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
}

function repositoryRoot(cwd: string): string | null {
  const root = run(['rev-parse', '--show-toplevel'], cwd, true).trim()
  return root ? root : null
}

function lineCount(root: string, path: string): number {
  try {
    return readFileSync(join(root, path), 'utf8').split('\n').length
  } catch {
    return 0
  }
}

/** `git` with a fixed working directory. Failures come back as an empty
 *  string: a missing repository is a normal state here, not an error. */
function run(args: string[], directory: string, quiet = false): string {
  const result = spawnSync('git', ['-C', directory, ...args], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
    stdio: ['ignore', 'pipe', quiet ? 'ignore' : 'ignore'],
  })
  if (result.error || result.status !== 0) return ''
  return result.stdout ?? ''
}
