/**
 * The numbers both hosts and both clients agree on. PROTOCOL.md is the prose;
 * this is the one place the values live so a host written in another language
 * cannot drift from the client by a digit.
 */

/** Bumped when the wire protocol changes incompatibly. */
export const PROTOCOL_VERSION = 1

/** Prefixed to the nonce before signing, so a signature over a nonce cannot be
 *  replayed as a signature over anything else. */
export const AUTH_CONTEXT = 'vibewire-auth-v1'

/** Seconds a `GET /v1/challenge` nonce stays valid, and single-use inside that. */
export const NONCE_LIFETIME_S = 30
/** Seconds a pairing code is shown before it rotates. */
export const PAIR_CODE_LIFETIME_S = 60
/** Wrong codes before the host stops listening for a while. */
export const MAX_PAIR_ATTEMPTS = 5
/** Seconds of that while. */
export const PAIR_LOCKOUT_S = 60

/** First byte of every binary video frame, so a desynced reader notices. */
export const VIDEO_MAGIC = 0xb1
export const VIDEO_HEADER_SIZE = 20

export const FLAG_KEYFRAME = 1 << 0
export const FLAG_PARAMETER_SETS = 1 << 1
export const FLAG_RESOLUTION_CHANGED = 1 << 2
