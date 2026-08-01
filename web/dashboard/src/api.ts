/**
 * The dashboard's half of `/v1/dashboard/*`.
 *
 * Everything here carries the launch key. It arrives in this document's own
 * path — the host serves the bundle from `/dashboard/<key>/`, so a page that
 * loaded at all has the key by definition and there is nothing to paste. Fetches
 * send it as a header; images send it as a query parameter, because an `<img>`
 * cannot set one.
 *
 * The key is a per-launch secret and never leaves this origin: the only two
 * places it appears are this document's URL and the requests it makes back to
 * the process that served it.
 */

/** The key this bundle was served under, or '' when opened some other way. */
export const key: string = (() => {
  // `/dashboard/<key>` or `/dashboard/<key>/assets/…`
  const match = /^\/dashboard\/([^/]+)/.exec(location.pathname)
  return match ? match[1] : ''
})()

export class ApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string) {
    super(`${status} ${code}`)
    this.status = status
    this.code = code
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/v1/dashboard/${path}`, {
    ...init,
    headers: {
      ...(init?.headers ?? {}),
      'X-VibeWire-Dashboard': key,
    },
  })
  if (!response.ok) {
    // The host answers failures as `{ error: "code" }`; a body that is not that
    // shape still has a status worth reporting.
    const body = (await response.json().catch(() => null)) as { error?: string } | null
    throw new ApiError(response.status, body?.error ?? 'unreadable')
  }
  return (await response.json()) as T
}

export function fetchState<T>(): Promise<T> {
  return request<T>('state')
}

export function fetchEvents<T>(since: number): Promise<T> {
  return request<T>(`events?since=${since}`)
}

/** Fire-and-report. Callers surface the failure; none of them retry blindly. */
export function command(body: Record<string, unknown>): Promise<{ ok: boolean }> {
  return request<{ ok: boolean }>('command', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/**
 * A screenshot of one display.
 *
 * `at` is a cache-buster the caller ticks, not a timestamp the host reads: the
 * response is `no-store`, but a browser that reuses a URL it already has in
 * flight would still coalesce two ticks into one picture.
 */
export function snapshotURL(displayId: number, width: number, at: number): string {
  return `/v1/dashboard/snapshot?display=${displayId}&width=${width}&at=${at}&k=${encodeURIComponent(key)}`
}

export function qrURL(kind: 'app' | 'browser', at: number): string {
  return `/v1/dashboard/qr?kind=${kind}&at=${at}&k=${encodeURIComponent(key)}`
}
