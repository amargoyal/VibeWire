/**
 * Where the account lives.
 *
 * VibeWire's trust model does not run through here and is not weakened by it:
 * pairing is still a signing key in this browser against a public key in the
 * host's keychain, and a Supabase outage takes nothing away from a paired
 * device. The account is a second, separate thing — an identity that follows a
 * person between browsers, so clearing site data on a phone does not lose the
 * list of computers they own.
 *
 * The publishable key is meant to be in a client bundle. It grants exactly what
 * the row-level security policies grant to `anon` and `authenticated`, which is
 * nothing at all until a session exists and then only that account's own rows.
 *
 * Both values are overridable at build time so a fork, a staging project, or a
 * self-hosted GoTrue does not need a patch:
 *
 *     VITE_SUPABASE_URL=https://… VITE_SUPABASE_KEY=sb_publishable_… npm run build
 */

const DEFAULT_URL = 'https://iqtuikhyqkythaffxuca.supabase.co'
const DEFAULT_KEY = 'sb_publishable_UdTwW-cDWfJ-TrhNtDEjMQ_qcSWlpP3'

export const SUPABASE_URL: string = (import.meta.env.VITE_SUPABASE_URL ?? DEFAULT_URL).replace(
  /\/+$/,
  '',
)

export const SUPABASE_KEY: string = import.meta.env.VITE_SUPABASE_KEY ?? DEFAULT_KEY

/**
 * Whether signing in is possible at all in this build.
 *
 * A fork that clears both values gets a client with no account screens rather
 * than a sign-in button that reaches an empty URL — the same rule the rest of
 * this client follows, that a control which cannot work is not drawn.
 */
export const accountsConfigured: boolean = SUPABASE_URL.length > 0 && SUPABASE_KEY.length > 0

/** `https://…supabase.co/auth/v1/token` and friends. */
export function authUrl(path: string): string {
  return `${SUPABASE_URL}/auth/v1/${path.replace(/^\/+/, '')}`
}

/** `https://…supabase.co/rest/v1/profiles` and friends. */
export function restUrl(path: string): string {
  return `${SUPABASE_URL}/rest/v1/${path.replace(/^\/+/, '')}`
}
