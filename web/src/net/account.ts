/**
 * The account, spoken to over GoTrue's REST API directly.
 *
 * There is no Supabase SDK in this bundle on purpose. The client ships as one
 * file served by the host itself over a link that is sometimes a Cloudflare
 * quick tunnel on a phone's cellular connection, and the SDK is larger than
 * every other dependency here combined for a handful of POSTs. What it would
 * buy — session persistence, refresh, the PKCE dance — is what this file is.
 *
 * Three ways in, in the order they are offered:
 *
 *  - **A six-digit code by email.** The one that always works. It needs no
 *    redirect URL, which matters more here than anywhere else: this same bundle
 *    is served from `http://192.168.1.24:8787`, from a tunnel hostname that
 *    changes every time the host restarts, and from GitHub Pages, and an
 *    allowlist cannot be written for the middle one. It is also the shape the
 *    pairing screen already taught: six digits, typed once.
 *  - **The link in the same email.** The same message carries both. Tapping it
 *    lands back here with tokens in the fragment, which is what `adoptFromUrl`
 *    reads. A mail client that opens the link in its own in-app browser signs
 *    that browser in and not this one, which is why the code is offered first.
 *  - **Google.** Only where the project has the provider enabled and
 *    only where this origin is in the redirect allowlist; `providers()` asks
 *    rather than assuming, so a button that cannot work is not drawn.
 *
 * Nothing here is a credential for the host. A session proves who the person
 * is; the Ed25519 key in `identity.ts` proves which browser this is, and the
 * host still checks that key on every socket. Where a host is set to require an
 * account, it verifies the access token against this same project — see
 * PROTOCOL.md — and the two checks are independent.
 */

import { records } from './identity'
import { accountsConfigured, authUrl, SUPABASE_KEY } from './supabase'

const SESSION_RECORD = 'account-session'

/** Refresh this far before the access token actually expires. */
const REFRESH_MARGIN_SECONDS = 60

export interface AccountUser {
  id: string
  email: string | null
  displayName: string | null
}

export interface Session {
  accessToken: string
  refreshToken: string
  /** Unix seconds. */
  expiresAt: number
  user: AccountUser
}

/** What went wrong, in a sentence that can be put on the glass unedited. */
export class AccountFailure extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AccountFailure'
  }
}

// MARK: - Stored session

async function readStored(): Promise<Session | null> {
  try {
    return await records.read<Session>(SESSION_RECORD)
  } catch {
    // Blocked storage is not a signed-out account, but it is indistinguishable
    // from one until the next sign-in, and saying so is `storageWorks`'s job.
    return null
  }
}

async function writeStored(session: Session | null): Promise<void> {
  try {
    if (session) await records.write(SESSION_RECORD, session)
    else await records.remove(SESSION_RECORD)
  } catch {
    /* A session that cannot be stored still works until the tab closes. */
  }
}

/**
 * Whether this browser can keep a session at all.
 *
 * Private browsing and blocked third-party storage both refuse IndexedDB, and
 * the difference between "signed out" and "cannot remember that you signed in"
 * is worth a sentence on the sign-in screen rather than a mystery every launch.
 */
export async function storageWorks(): Promise<boolean> {
  try {
    await records.write('account-storage-probe', Date.now())
    await records.remove('account-storage-probe')
    return true
  } catch {
    return false
  }
}

// MARK: - Requests

async function post(path: string, body: unknown, token?: string): Promise<Response> {
  return fetch(authUrl(path), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_KEY,
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
    cache: 'no-store',
    signal: AbortSignal.timeout(15000),
  })
}

/**
 * GoTrue's error shape, turned into something worth reading.
 *
 * It answers with `error_description`, `msg`, or `message` depending on the
 * endpoint and the version, and a client that picks one of the three reports
 * "undefined" for the other two.
 */
async function failureFrom(response: Response): Promise<AccountFailure> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>
  const stated =
    (typeof body['error_description'] === 'string' && body['error_description']) ||
    (typeof body['msg'] === 'string' && body['msg']) ||
    (typeof body['message'] === 'string' && body['message']) ||
    ''

  if (response.status === 429) {
    return new AccountFailure(stated || 'Too many tries. Wait a minute and ask for another code.')
  }
  if (response.status === 403 && /expired|invalid/i.test(stated)) {
    return new AccountFailure('That code has expired. Ask for another one.')
  }
  return new AccountFailure(stated || `The account server answered ${response.status}.`)
}

/** GoTrue's token response, which every sign-in path ends at. */
function sessionFrom(payload: Record<string, unknown>): Session {
  const accessToken = payload['access_token']
  const refreshToken = payload['refresh_token']
  if (typeof accessToken !== 'string' || typeof refreshToken !== 'string') {
    throw new AccountFailure('The account server sent a reply this client could not read.')
  }

  const expiresIn = typeof payload['expires_in'] === 'number' ? payload['expires_in'] : 3600
  const user = (payload['user'] ?? {}) as Record<string, unknown>
  const metadata = (user['user_metadata'] ?? {}) as Record<string, unknown>
  const email = typeof user['email'] === 'string' ? user['email'] : null

  return {
    accessToken,
    refreshToken,
    expiresAt: Math.floor(Date.now() / 1000) + expiresIn,
    user: {
      id: typeof user['id'] === 'string' ? user['id'] : '',
      email,
      displayName:
        (typeof metadata['full_name'] === 'string' && metadata['full_name']) ||
        (typeof metadata['name'] === 'string' && metadata['name']) ||
        (email ? email.split('@')[0]! : null),
    },
  }
}

// MARK: - The live session

let current: Session | null = null
let loaded = false
/** One refresh at a time. Two tabs are two refreshes; two callers are not. */
let refreshing: Promise<Session | null> | null = null

const listeners = new Set<(session: Session | null) => void>()

function publish(): void {
  for (const listener of listeners) listener(current)
}

/** Notified whenever the session appears, changes, or goes away. */
export function onAccountChange(listener: (session: Session | null) => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

async function adopt(session: Session | null): Promise<Session | null> {
  current = session
  await writeStored(session)
  publish()
  return session
}

/** The session as last known, without touching the network. */
export function session(): Session | null {
  return current
}

/**
 * Read the stored session once at launch.
 *
 * Deliberately does not refresh: the pairing screen and the remote view both
 * open before anything needs a token, and a network round trip in front of them
 * would put a spinner over a client that was going to work offline anyway. The
 * refresh happens the first time a token is actually asked for.
 */
export async function loadAccount(): Promise<Session | null> {
  if (loaded) return current
  loaded = true
  if (!accountsConfigured) return null
  current = await readStored()
  if (current) publish()
  return current
}

/**
 * A usable access token, or null.
 *
 * Refreshes inside the margin rather than on expiry, because the host verifies
 * this token against the account server and a token that dies in flight reads
 * as a refused sign-in rather than a late one.
 */
export async function accessToken(): Promise<string | null> {
  await loadAccount()
  if (!current) return null
  if (current.expiresAt - REFRESH_MARGIN_SECONDS > Date.now() / 1000) return current.accessToken
  const refreshed = await refresh()
  return refreshed?.accessToken ?? null
}

async function refresh(): Promise<Session | null> {
  if (refreshing) return refreshing
  const token = current?.refreshToken
  if (!token) return null

  refreshing = (async () => {
    let response: Response
    try {
      response = await post('token?grant_type=refresh_token', { refresh_token: token })
    } catch {
      // Offline. The stored session is not wrong, it is just unverifiable, and
      // throwing it away here would sign a person out every time a phone walked
      // through a dead spot.
      return current
    }
    if (!response.ok) {
      // A refused refresh token is gone for good — revoked, rotated, or expired
      // past its window. Keeping it would retry forever against a 400.
      if (response.status === 400 || response.status === 401) return adopt(null)
      return current
    }
    return adopt(sessionFrom((await response.json()) as Record<string, unknown>))
  })().finally(() => {
    refreshing = null
  })

  return refreshing
}

/** Ends the session here, and on the account server where it can be reached. */
export async function signOut(): Promise<void> {
  const token = current?.accessToken
  await adopt(null)
  if (!token) return
  try {
    await post('logout?scope=local', {}, token)
  } catch {
    /* The session is gone from this browser either way. */
  }
}

// MARK: - Email: a code, and the link beside it

/**
 * Sends the sign-in email. One message; it carries both the code and the link.
 *
 * `create_user` is left at its default, so a first-time address makes an
 * account and a returning one signs in. There is no separate sign-up screen for
 * the same reason there is no password field: nothing here is worth two paths.
 *
 * `emailRedirectTo` only decides where the *link* lands. It is sent as this
 * page's own origin, which is right for the host-served copy and for Pages, and
 * is rejected by the account server's allowlist for a tunnel hostname nobody
 * could have listed in advance. That rejection costs nothing: the code in the
 * same email still works, which is why it is the thing the screen asks for.
 */
export async function sendEmailCode(email: string, redirectTo = location.origin + location.pathname): Promise<void> {
  // The redirect is a query parameter on this endpoint, not a body field. Sent
  // as a body field it is accepted, ignored, and the link in the email then
  // lands on the project's Site URL instead of on the page that asked.
  const redirect = encodeURIComponent(redirectTo)
  const response = await post(`otp?redirect_to=${redirect}`, {
    email,
    create_user: true,
    // GoTrue reads this object for its own anti-abuse fields (a captcha token,
    // where one is configured). Absent, some versions refuse the request.
    gotrue_meta_security: {},
  })
  if (!response.ok) throw await failureFrom(response)
}

/**
 * Exchanges the six digits for a session.
 *
 * Tried as `email` and then as `signup`. The same six digits mean one of two
 * things depending on whether this address had an account a minute ago, and the
 * client cannot know which — `create_user` is what makes that not matter, and
 * this is the other half of it. Without the second attempt, the very first
 * sign-in of every new account failed with "Token has expired or is invalid"
 * about a code that was correct.
 */
export async function verifyEmailCode(email: string, code: string): Promise<Session> {
  let response = await post('verify', { type: 'email', email, token: code })
  if (!response.ok && (response.status === 400 || response.status === 403)) {
    response = await post('verify', { type: 'signup', email, token: code })
  }
  if (!response.ok) throw await failureFrom(response)
  const session = sessionFrom((await response.json()) as Record<string, unknown>)
  await adopt(session)
  return session
}

// MARK: - Coming back from somewhere else

const VERIFIER_RECORD = 'account-pkce-verifier'

/**
 * Picks a session out of the URL this page was opened with, if there is one.
 *
 * Two shapes arrive here, and neither is this client's choice:
 *
 *  - `#access_token=…&refresh_token=…`, from the link in the email. The tokens
 *    are in the fragment, which never left the device — it is not sent with the
 *    request — and they are cleared out of the address bar as soon as they are
 *    read, so a shared screenshot of the URL bar is not a shared session.
 *  - `?code=…`, from Google, which is exchanged with the verifier this
 *    browser kept before it left.
 *
 * `?error=…` arrives too, and is reported rather than swallowed: an origin
 * missing from the redirect allowlist fails exactly here, and silence would
 * make a tapped link look like a link that did nothing.
 */
export async function adoptFromUrl(): Promise<Session | null> {
  if (!accountsConfigured) return null

  const hash = new URLSearchParams(location.hash.startsWith('#') ? location.hash.slice(1) : '')
  const query = new URLSearchParams(location.search)

  const errorText = hash.get('error_description') ?? query.get('error_description')
  const errorCode = hash.get('error') ?? query.get('error')
  if (errorText || errorCode) {
    scrubUrl(['error', 'error_code', 'error_description'])
    throw new AccountFailure(errorText ?? `Signing in was refused: ${errorCode}.`)
  }

  const accessToken = hash.get('access_token')
  const refreshToken = hash.get('refresh_token')
  if (accessToken && refreshToken) {
    const expiresIn = Number(hash.get('expires_in') ?? '3600')
    scrubUrl(['access_token', 'refresh_token', 'expires_in', 'expires_at', 'token_type', 'type'])
    // The fragment carries no user object, so the account is asked who this is.
    const user = await fetchUser(accessToken)
    return adopt({
      accessToken,
      refreshToken,
      expiresAt: Math.floor(Date.now() / 1000) + (Number.isFinite(expiresIn) ? expiresIn : 3600),
      user,
    })
  }

  const code = query.get('code')
  // `?code=` is also the pairing QR's parameter, and that one is six digits.
  // Taking it for an OAuth authorization code would trade a pairing link for a
  // failed token exchange.
  if (code && !/^\d{6}$/.test(code)) {
    const verifier = await records.read<string>(VERIFIER_RECORD).catch(() => null)
    scrubUrl(['code'])
    if (!verifier) {
      throw new AccountFailure(
        'This browser did not start that sign-in. Begin again from the sign-in screen.',
      )
    }
    await records.remove(VERIFIER_RECORD).catch(() => undefined)
    return exchangeProviderCode(code, verifier)
  }

  return null
}

/**
 * Trades a provider's authorization code for a session, with the verifier the
 * code's challenge was made from.
 */
export async function exchangeProviderCode(code: string, verifier: string): Promise<Session> {
  const response = await post('token?grant_type=pkce', { auth_code: code, code_verifier: verifier })
  if (!response.ok) throw await failureFrom(response)
  const session = sessionFrom((await response.json()) as Record<string, unknown>)
  await adopt(session)
  return session
}

/** Whether a URL is worth handing to `adoptFromUrl` at all. */
export function urlCarriesAccount(): boolean {
  const hash = location.hash.startsWith('#') ? location.hash.slice(1) : ''
  return /(^|&)(access_token|error|error_description)=/.test(hash) || /[?&]code=(?!\d{6}(&|$))/.test(location.search)
}

async function fetchUser(token: string): Promise<AccountUser> {
  try {
    const response = await fetch(authUrl('user'), {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${token}` },
      cache: 'no-store',
    })
    if (!response.ok) throw new Error('user')
    const body = (await response.json()) as Record<string, unknown>
    const metadata = (body['user_metadata'] ?? {}) as Record<string, unknown>
    const email = typeof body['email'] === 'string' ? body['email'] : null
    return {
      id: typeof body['id'] === 'string' ? body['id'] : '',
      email,
      displayName:
        (typeof metadata['full_name'] === 'string' && metadata['full_name']) ||
        (typeof metadata['name'] === 'string' && metadata['name']) ||
        (email ? email.split('@')[0]! : null),
    }
  } catch {
    return { id: '', email: null, displayName: null }
  }
}

/** Takes the named parameters out of both the query and the fragment. */
function scrubUrl(names: string[]): void {
  try {
    const url = new URL(location.href)
    const hash = new URLSearchParams(url.hash.startsWith('#') ? url.hash.slice(1) : '')
    for (const name of names) {
      url.searchParams.delete(name)
      hash.delete(name)
    }
    const remaining = hash.toString()
    url.hash = remaining ? `#${remaining}` : ''
    history.replaceState(null, '', url.toString())
  } catch {
    /* An address bar that cannot be rewritten is cosmetic, not a failure. */
  }
}

// MARK: - Google

export type Provider = 'google'

/**
 * Which providers this project actually has switched on.
 *
 * Asked rather than assumed. Enabling Google needs credentials from Google and
 * a redirect URL this deployment controls; until that is done the button would
 * be a way to reach an error page, and this client's
 * rule everywhere else is that a control which cannot work is not drawn.
 */
export async function providers(): Promise<Provider[]> {
  if (!accountsConfigured) return []
  try {
    const response = await fetch(authUrl('settings'), {
      headers: { apikey: SUPABASE_KEY },
      cache: 'no-store',
      signal: AbortSignal.timeout(4000),
    })
    if (!response.ok) return []
    const body = (await response.json()) as { external?: Record<string, boolean> }
    return (['google'] as Provider[]).filter((name) => body.external?.[name] === true)
  } catch {
    return []
  }
}

/**
 * Leaves this page for the provider, with PKCE.
 *
 * The verifier is kept in the same per-origin store as everything else, and is
 * deleted the moment it is spent: a verifier left behind would sit in the
 * browser until it was overwritten by the next attempt.
 */
export async function startProviderSignIn(provider: Provider): Promise<void> {
  const verifier = randomVerifier()
  await records.write(VERIFIER_RECORD, verifier)

  location.assign(await providerAuthorizeUrl(provider, location.origin + location.pathname, verifier))
}

/**
 * The account server's authorize URL for a provider, with the PKCE challenge
 * for `verifier`. Whoever holds the verifier is the only one who can turn the
 * code that comes back into a session.
 */
export async function providerAuthorizeUrl(
  provider: Provider,
  redirectTo: string,
  verifier: string,
): Promise<string> {
  const url = new URL(authUrl('authorize'))
  url.searchParams.set('provider', provider)
  url.searchParams.set('redirect_to', redirectTo)
  url.searchParams.set('code_challenge', await challengeFor(verifier))
  url.searchParams.set('code_challenge_method', 's256')
  return url.toString()
}

export function randomVerifier(): string {
  const bytes = new Uint8Array(32)
  crypto.getRandomValues(bytes)
  return base64Url(bytes)
}

export async function challengeFor(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))
  return base64Url(new Uint8Array(digest))
}

function base64Url(bytes: Uint8Array): string {
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}
