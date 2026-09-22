/**
 * What the account remembers, and what it deliberately does not.
 *
 * It remembers a directory: which computers this person has paired with, which
 * browsers they have signed in from, and the handful of preferences the client
 * keeps for itself. All of it is convenience — a phone whose site data was
 * cleared can be told the name and address of the Mac it used to reach instead
 * of showing an empty pairing screen.
 *
 * It does not remember anything that would let a row in a database reach a
 * computer. No private key, no host public key, no pairing code, no frame, no
 * clipboard, no Claude transcript. Restoring from this directory still ends at
 * the pairing screen with six digits to type, because that is the only thing
 * that can make a host trust a browser.
 *
 * Every call here is best-effort and every failure is swallowed at the call
 * site. The product works with the account server unreachable; a sync that
 * throws into the remote view would make an outage in a database look like a
 * fault in the wire.
 */

import { accessToken } from './account'
import type { PairedHost } from './identity'
import { restUrl } from './supabase'
import { SUPABASE_KEY } from './supabase'

export interface RememberedHost {
  hostId: string
  name: string
  platform: string
  origin: string | null
  alternates: string[]
  pairedAt: string
  lastSeenAt: string | null
}

async function request(
  path: string,
  init: RequestInit & { prefer?: string } = {},
): Promise<Response | null> {
  const token = await accessToken()
  if (!token) return null
  const { prefer, ...rest } = init
  try {
    return await fetch(restUrl(path), {
      ...rest,
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${token}`,
        ...(prefer ? { Prefer: prefer } : {}),
        ...(rest.headers as Record<string, string> | undefined),
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    })
  } catch {
    return null
  }
}

// MARK: - Computers

/**
 * Writes down that this account reached this host, or that it reached it again.
 *
 * Upserted on `(user_id, host_id)` rather than inserted: the same Mac at a new
 * tunnel hostname is the same Mac, and a row per address would turn the list
 * this is here to provide into a list of every address the Mac ever had.
 */
export async function rememberHost(host: PairedHost): Promise<void> {
  await request('hosts?on_conflict=user_id,host_id', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: JSON.stringify({
      host_id: host.hostId,
      name: host.hostName,
      platform: host.platform ?? 'macos',
      origin: host.origin,
      alternates: host.alternates,
      paired_at: host.pairedAt,
      last_seen_at: new Date().toISOString(),
    }),
  })
}

/** The computers this account has paired with, most recently seen first. */
export async function listHosts(): Promise<RememberedHost[]> {
  const response = await request(
    'hosts?select=host_id,name,platform,origin,alternates,paired_at,last_seen_at&order=last_seen_at.desc.nullslast',
  )
  if (!response?.ok) return []
  const rows = (await response.json().catch(() => [])) as Record<string, unknown>[]
  return rows.map((row) => ({
    hostId: String(row['host_id'] ?? ''),
    name: String(row['name'] ?? ''),
    platform: String(row['platform'] ?? 'macos'),
    origin: typeof row['origin'] === 'string' ? row['origin'] : null,
    alternates: Array.isArray(row['alternates']) ? (row['alternates'] as string[]) : [],
    pairedAt: String(row['paired_at'] ?? ''),
    lastSeenAt: typeof row['last_seen_at'] === 'string' ? row['last_seen_at'] : null,
  }))
}

/** Drops one computer from the directory. Revoking the key is the host's job. */
export async function forgetHost(hostId: string): Promise<void> {
  await request(`hosts?host_id=eq.${encodeURIComponent(hostId)}`, {
    method: 'DELETE',
    prefer: 'return=minimal',
  })
}

// MARK: - Preferences

/** The client's own preferences as this account last left them. */
export async function loadPrefs(): Promise<Record<string, unknown> | null> {
  const response = await request('client_prefs?select=prefs')
  if (!response?.ok) return null
  const rows = (await response.json().catch(() => [])) as { prefs?: Record<string, unknown> }[]
  return rows[0]?.prefs ?? null
}

/**
 * Stores the whole preference document.
 *
 * Whole, not merged: there is one writer per account per moment, the document
 * is a few hundred bytes, and a partial write is how two phones end up each
 * holding half of a keyboard bar.
 */
export async function savePrefs(prefs: Record<string, unknown>): Promise<void> {
  await request('client_prefs?on_conflict=user_id', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: JSON.stringify({ prefs }),
  })
}

// MARK: - Browsers

/** Notes that this browser is signed in, so the account can list where it is. */
export async function rememberThisBrowser(
  name: string,
  platform: string,
  deviceId: string | null,
): Promise<void> {
  await request('client_devices?on_conflict=user_id,name,kind', {
    method: 'POST',
    prefer: 'resolution=merge-duplicates,return=minimal',
    body: JSON.stringify({
      name,
      kind: 'browser',
      platform,
      device_id: deviceId,
      last_seen_at: new Date().toISOString(),
    }),
  })
}
