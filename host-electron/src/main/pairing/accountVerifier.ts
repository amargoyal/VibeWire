import { createHash } from 'node:crypto'

import { Config } from '../core/config'
import { Log } from '../core/log'

/** Who a browser says it is, once this host has checked rather than believed it. */
export interface VerifiedAccount {
  id: string
  email: string | null
}

interface Entry {
  account: VerifiedAccount
  checkedAt: number
}

/** How long a confirmed answer is reused. */
const LIFETIME_MS = 60_000

/**
 * Checks an account token with the account server that issued it.
 *
 * The token is verified by asking the issuer, not by reading it. This host
 * could fetch the project's public keys and check the signature itself, and
 * that would save a round trip — but it would also keep answering a browser
 * whose session was revoked ten minutes ago, for as long as the unexpired token
 * said it could. Asking is the answer that can change.
 *
 * Cached for a minute, keyed by a hash of the token rather than by the token: a
 * crash dump of this process should not be a list of live sessions.
 *
 * Mirrors host/Sources/VibeWireHost/Pairing/AccountVerifier.swift.
 */
export class AccountVerifier {
  private cache = new Map<string, Entry>()

  /**
   * The account behind this token, or null for anything this host cannot
   * confirm — a refused token, an unreachable account server, or a build with
   * no account server configured.
   *
   * Null on an outage is deliberate and is the strict direction: the setting
   * says a browser must be signed in, and "the check could not be made" is not
   * "the check passed".
   */
  async verify(token: string): Promise<VerifiedAccount | null> {
    if (!token || !Config.accountsAvailable) return null

    const key = createHash('sha256').update(token).digest('hex')
    const cached = this.cache.get(key)
    if (cached && Date.now() - cached.checkedAt < LIFETIME_MS) return cached.account

    try {
      const response = await fetch(`${Config.accountServerURL}/auth/v1/user`, {
        headers: {
          apikey: Config.accountServerKey,
          authorization: `Bearer ${token}`,
          'user-agent': `VibeWire/${Config.hostVersion}`,
        },
        signal: AbortSignal.timeout(8000),
      })
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) this.cache.delete(key)
        return null
      }
      const body = (await response.json()) as { id?: unknown; email?: unknown }
      if (typeof body.id !== 'string' || body.id.length === 0) return null

      const account: VerifiedAccount = {
        id: body.id,
        email: typeof body.email === 'string' ? body.email : null,
      }
      this.cache.set(key, { account, checkedAt: Date.now() })
      this.prune()
      return account
    } catch (error) {
      Log.debug('net', `account check failed: ${String(error)}`)
      return null
    }
  }

  /**
   * Forgets every cached answer. Called when the requirement is turned off and
   * again when the owner is cleared, so nothing decided under the old rule
   * survives the change.
   */
  forgetEverything(): void {
    this.cache.clear()
  }

  private prune(): void {
    if (this.cache.size <= 32) return
    const cutoff = Date.now() - LIFETIME_MS
    for (const [key, entry] of this.cache) {
      if (entry.checkedAt <= cutoff) this.cache.delete(key)
    }
  }
}
