import { createPrivateKey, createPublicKey, randomBytes, sign, verify, type KeyObject } from 'node:crypto'

/**
 * Ed25519 the way Node exposes it: raw 32-byte keys on the wire, DER-wrapped
 * `KeyObject`s inside. The two DER prefixes are constants of the algorithm, not
 * of any key, which is why they can be pasted in rather than computed.
 */

/** SubjectPublicKeyInfo for Ed25519: a 12-byte prefix then the raw 32 bytes. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')
/** PKCS#8 for Ed25519: a 16-byte prefix then the raw 32-byte seed. */
const PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex')

export function generateSeed(): Buffer {
  return randomBytes(32)
}

function privateKeyObject(seed: Uint8Array): KeyObject {
  return createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, Buffer.from(seed)]), format: 'der', type: 'pkcs8' })
}

function publicKeyObject(raw: Uint8Array): KeyObject {
  return createPublicKey({ key: Buffer.concat([SPKI_PREFIX, Buffer.from(raw)]), format: 'der', type: 'spki' })
}

export function publicKeyFromSeed(seed: Uint8Array): Buffer {
  const der = createPublicKey(privateKeyObject(seed)).export({ format: 'der', type: 'spki' })
  return Buffer.from(der.subarray(SPKI_PREFIX.length))
}

export function signMessage(seed: Uint8Array, message: Uint8Array): Buffer {
  return sign(null, Buffer.from(message), privateKeyObject(seed))
}

/** False on a bad signature *and* on a malformed key, which is the right
 *  answer for an authenticator: neither is a caller to let in. */
export function verifySignature(publicKeyRaw: Uint8Array, message: Uint8Array, signature: Uint8Array): boolean {
  if (publicKeyRaw.byteLength !== 32 || signature.byteLength !== 64) return false
  try {
    return verify(null, Buffer.from(message), publicKeyObject(publicKeyRaw), Buffer.from(signature))
  } catch {
    return false
  }
}

export function isValidPublicKey(raw: Uint8Array): boolean {
  if (raw.byteLength !== 32) return false
  try {
    publicKeyObject(raw)
    return true
  } catch {
    return false
  }
}

/**
 * Standard base64 only, decoded strictly. Node's decoder is forgiving — it
 * skips characters it does not know and accepts the URL-safe alphabet — and
 * the Mac host is not, so a client that sends `-` or `_` would work here and
 * fail there. Matching the stricter of the two is what keeps the protocol one.
 */
export function strictBase64(text: string): Buffer | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return null
  return Buffer.from(text, 'base64')
}
