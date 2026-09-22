/**
 * The few things this client keeps for itself, carried by the account.
 *
 * Only what a person built by hand is worth carrying: the keyboard bar they
 * edited, and whether they have read the connect guide. Everything about the
 * picture, the pointer and the trackpad is a host setting and stays on the
 * host, where it describes a machine rather than a person.
 *
 * The merge rule is one line and is the honest one for a list with no clocks on
 * it: what the account holds wins, and a key the account has never seen is sent
 * up. A second phone therefore inherits the bar that was built on the first,
 * and the first does not lose it by signing in somewhere else.
 */

import { loadPrefs, savePrefs } from '../net/accountSync'

/**
 * The localStorage keys that travel. Named explicitly rather than swept up by
 * prefix: this store also holds things that are about *this* browser and would
 * be wrong somewhere else.
 */
const CARRIED = [
  'vibewire.combos',
  'vibewire.combos.windows',
  'vibewire.client-setup.v1',
  'vibewire.account-invite.v1',
] as const

function localSnapshot(): Record<string, string> {
  const snapshot: Record<string, string> = {}
  for (const key of CARRIED) {
    try {
      const value = localStorage.getItem(key)
      if (value != null) snapshot[key] = value
    } catch {
      /* Blocked storage carries nothing, which is not a failure. */
    }
  }
  return snapshot
}

/** Brings the account's copy down, and sends up anything it did not have. */
export async function pullPrefs(): Promise<void> {
  const remote = await loadPrefs()
  const local = localSnapshot()
  if (!remote) {
    if (Object.keys(local).length > 0) await savePrefs(local)
    return
  }

  const merged = { ...local }
  for (const key of CARRIED) {
    const value = remote[key]
    if (typeof value !== 'string') continue
    merged[key] = value
    try {
      localStorage.setItem(key, value)
    } catch {
      /* The value is still in this session's memory of it. */
    }
  }

  // Only when this browser actually knew something the account did not. A write
  // on every launch would be a round trip that changes nothing.
  const additions = Object.keys(merged).filter((key) => remote[key] !== merged[key])
  if (additions.length > 0) await savePrefs(merged)
}

/** Sends the current local copy up. Safe to call on every edit. */
export async function pushPrefs(): Promise<void> {
  const local = localSnapshot()
  if (Object.keys(local).length === 0) return
  await savePrefs(local)
}
