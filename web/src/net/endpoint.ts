/**
 * Where the Mac is, and whether this page is allowed to reach it.
 *
 * The phone had one answer to this: `http://<address>:<port>`. A browser has
 * three, and one of them is a refusal the user has to be told about precisely
 * rather than left to read as "the Mac is down".
 *
 *  1. This bundle served *by the host itself* at `http://<mac>:8787/`. Same
 *     origin as the API, no scheme mismatch, works over Tailscale and the LAN.
 *     This is the local path and it is the one that needs no configuration.
 *
 *  2. This bundle served from GitHub Pages, i.e. `https://…`. A page on `https`
 *     may not open `http://` or `ws://` — the browser blocks it as mixed content
 *     before a packet leaves. So from Pages the only reachable address is an
 *     `https` one, which in practice means the Cloudflare Tunnel the host can
 *     start (Settings → Relay over internet).
 *
 *  3. `npm run dev` on `http://localhost:5273`, talking to the Mac on `:8787`.
 *
 * `describe()` below is what turns case 2 into a sentence with an instruction in
 * it instead of a timeout.
 */

export interface Endpoint {
  /** Canonical origin, no trailing slash: `http://192.168.1.24:8787`. */
  origin: string
  /** Hostname alone, for display and for the paired-host record. */
  host: string
  /** The port actually in play, including the 80/443 a bare https URL implies. */
  port: number
  secure: boolean
}

export class EndpointError extends Error {}

/**
 * Parses what the user typed. Accepts a bare address, an address with a port, or
 * a full URL — because the tunnel hostname is something they will paste, and
 * demanding it be split into host and port is a needless trap.
 */
export function parseEndpoint(input: string, fallbackPort = 8787): Endpoint {
  const trimmed = input.trim().replace(/\/+$/, '')
  if (!trimmed) throw new EndpointError('Enter the Mac’s address first.')

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)
  // A bare `host:port` is not a URL, and `new URL('mac:8787')` parses `mac:` as
  // a scheme. Give it one it cannot mistake.
  const candidate = hasScheme ? trimmed : `http://${trimmed}`

  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    throw new EndpointError(`Not a usable address: ${input}`)
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new EndpointError(`VibeWire speaks HTTP, not ${url.protocol.replace(':', '')}.`)
  }
  if (!url.hostname) throw new EndpointError(`Not a usable address: ${input}`)

  const secure = url.protocol === 'https:'
  // An explicit port wins; a bare `https://tunnel` means 443 and must not have
  // 8787 bolted onto it.
  const port = url.port
    ? Number(url.port)
    : hasScheme
      ? secure
        ? 443
        : 80
      : fallbackPort

  const origin =
    (secure ? 'https://' : 'http://') +
    url.hostname +
    (port === (secure ? 443 : 80) ? '' : `:${port}`)

  return { origin, host: url.hostname, port, secure }
}

/** `ws://` or `wss://` for the same origin. */
export function socketOrigin(endpoint: Endpoint): string {
  return endpoint.origin.replace(/^http/, 'ws')
}

/**
 * True when the browser will refuse this endpoint outright.
 *
 * The mixed-content rule has one exception that matters here: a loopback address
 * counts as potentially trustworthy in Chromium, so `http://localhost:8787` from
 * an `https` page works there — but not in Safari. Treating loopback as blocked
 * would be wrong on the browser most likely to be used for development; treating
 * it as fine would be wrong on Safari. It is reported as `warn`, with the
 * sentence saying which is which, rather than pretending to a certainty nobody
 * has.
 */
export type Reachability = 'ok' | 'blocked' | 'warn'

const LOOPBACK = /^(localhost|127(?:\.\d+){3}|\[?::1\]?)$/i

export function reachability(endpoint: Endpoint): Reachability {
  if (endpoint.secure) return 'ok'
  if (location.protocol !== 'https:') return 'ok'
  if (LOOPBACK.test(endpoint.host)) return 'warn'
  return 'blocked'
}

/**
 * The sentence to show. Names the failure precisely — a blocked scheme, a
 * loopback special case, and a Mac that simply is not answering are three
 * different states, and collapsing them into one message is the defect this
 * product has already paid for once.
 */
export function describe(endpoint: Endpoint): string | null {
  switch (reachability(endpoint)) {
    case 'blocked':
      return (
        `This page is served over HTTPS, so the browser will not open a plain ` +
        `http:// connection to ${endpoint.host}. Two ways round it: turn on ` +
        `Settings → Relay over internet on the Mac and use the https:// tunnel ` +
        `address it prints, or open this client from the Mac itself at ` +
        `http://${endpoint.host}:${endpoint.port}/.`
      )
    case 'warn':
      return (
        `Loopback over HTTPS works in Chrome and Edge and is refused by Safari. ` +
        `If nothing answers here, that is why.`
      )
    default:
      return null
  }
}

/**
 * The address to offer before the user has typed anything.
 *
 * Served by the host, this page's own origin *is* the Mac — so the field is
 * pre-filled and pairing is one code away. Served from Pages, there is nothing
 * to guess and the field stays empty rather than suggesting a wrong answer.
 */
export function suggestedAddress(): string {
  const port = location.port ? Number(location.port) : location.protocol === 'https:' ? 443 : 80
  // The dev server is not the host, and neither is a Pages origin.
  if (port === 5273 || /github\.io$/i.test(location.hostname)) return ''
  if (!location.hostname || location.protocol === 'file:') return ''
  return location.origin
}

/** True when this bundle is being served by the Mac it talks to. */
export function isHostServed(): boolean {
  const port = location.port ? Number(location.port) : 0
  return port === 8787
}
