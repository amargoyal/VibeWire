import { Log, describeError } from './log'

/**
 * Whether a newer VibeWire has been published, asked of GitHub.
 *
 * An app people install from a downloaded installer has no other way of
 * telling them a fix exists: the copy they ran is the copy they keep, and the
 * release that fixes what they hit sits on a page they have no reason to
 * visit. Asked once at launch and every six hours after; the window says so.
 *
 * Nothing is installed by it. These installers are not code-signed, so an
 * updater that fetched and ran one would be asking for trust that nothing
 * here can check. The prompt opens the release page.
 */

export interface UpdateVerdict {
  current: string
  latest: string | null
  url: string | null
  available: boolean
  checkedAt: string | null
  problem: string | null
  enabled: boolean
}

/** The repository releases are published from. */
export const UPDATE_REPOSITORY = 'amargoyal/VibeWire'
export const RELEASES_PAGE = `https://github.com/${UPDATE_REPOSITORY}/releases/latest`

const SIX_HOURS_MS = 6 * 60 * 60 * 1000

export class UpdateCheck {
  private cached: UpdateVerdict
  private checking: Promise<void> | null = null

  constructor(private readonly currentVersion: string) {
    this.cached = {
      current: currentVersion,
      latest: null,
      url: null,
      available: false,
      checkedAt: null,
      problem: null,
      enabled: true,
    }
  }

  verdict(): UpdateVerdict {
    return this.cached
  }

  /** Asks unless it was asked in the last six hours, or the reader turned the
   *  check off. */
  async refreshIfStale(enabled: boolean, intervalMs = SIX_HOURS_MS): Promise<void> {
    if (!enabled) {
      this.cached = { ...this.cached, enabled: false }
      return
    }
    this.cached = { ...this.cached, enabled: true }
    const checkedAt = this.cached.checkedAt
    if (checkedAt && Date.now() - Date.parse(checkedAt) < intervalMs) return
    await this.refresh()
  }

  async refresh(): Promise<void> {
    if (this.checking) return this.checking
    this.checking = (async () => {
      try {
        const response = await fetch(
          `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`,
          {
            headers: {
              Accept: 'application/vnd.github+json',
              'User-Agent': `VibeWire/${this.currentVersion}`,
            },
            signal: AbortSignal.timeout(8000),
          },
        )
        if (!response.ok) throw new Error(`GitHub answered ${response.status}`)
        const body = (await response.json()) as { tag_name?: string; html_url?: string }
        if (!body.tag_name) throw new Error("GitHub's answer had no release in it")
        const latest = body.tag_name.startsWith('v') ? body.tag_name.slice(1) : body.tag_name
        const available = isNewer(latest, this.currentVersion)
        this.cached = {
          current: this.currentVersion,
          latest,
          url: body.html_url ?? RELEASES_PAGE,
          available,
          checkedAt: new Date().toISOString(),
          problem: null,
          enabled: true,
        }
        if (available) Log.info('app', `update available: ${latest} (running ${this.currentVersion})`)
      } catch (error) {
        // No network, a rate limit, or a repository with no releases yet all
        // land here, and none of them are the reader's problem.
        this.cached = {
          ...this.cached,
          checkedAt: new Date().toISOString(),
          problem: describeError(error),
        }
      } finally {
        this.checking = null
      }
    })()
    return this.checking
  }
}

/** Numeric, part by part, with anything after a dash ignored. */
export function isNewer(candidate: string, current: string): boolean {
  const parts = (version: string) =>
    version
      .split('-')[0]
      .split('.')
      .map((part) => Number.parseInt(part, 10) || 0)
  const left = parts(candidate)
  const right = parts(current)
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0
    const b = right[index] ?? 0
    if (a !== b) return a > b
  }
  return false
}
