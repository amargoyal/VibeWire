/**
 * This browser's identity to the Mac. Ported from ios/VibeWire/Net/Identity.swift.
 *
 * The private key is generated once and never sent. Pairing sends only the public
 * half; every later connection proves possession by signing a server nonce. There
 * is no token to steal off disk, which is what lets the Cloudflare path be
 * publicly reachable without being a liability.
 *
 * Two honest differences from the phone, both worth stating rather than glossing:
 *
 *  - There is no Secure Enclave here. Where the browser has WebCrypto Ed25519 the
 *    key is a **non-extractable** `CryptoKey`, which is the closest equivalent
 *    the platform offers: script can ask it to sign and cannot read it back, even
 *    though it lives in the same IndexedDB as everything else. Where Ed25519 is
 *    missing the fallback holds a raw 32-byte seed, which script *can* read, and
 *    `keyStorage` reports which of the two is in force so Settings can say so.
 *
 *  - Storage is per-origin. A key made on `https://you.github.io` is a different
 *    device from one made on `http://mac:8787`, so each origin pairs once. That
 *    is the browser's rule, not a choice, and the paired-device list on the Mac
 *    shows both entries with the name each was paired under.
 */

import { etc, getPublicKeyAsync, signAsync } from '@noble/ed25519'

const DB_NAME = 'vibewire'
const DB_VERSION = 1
const STORE = 'identity'
const KEY_RECORD = 'device-signing-key'
const HOST_RECORD = 'paired-host'

/** The domain separator the host's verifier expects. */
const AUTH_CONTEXT = 'vibewire-auth-v1'

export interface PairedHost {
  hostId: string
  hostName: string
  hostKey: string
  deviceId: string
  /** Canonical origin, e.g. `http://192.168.1.24:8787`. The one that answered
   *  last, which is not necessarily the one it was paired on. */
  origin: string
  host: string
  port: number
  /**
   * The Mac's other addresses, in the order to try them when `origin` stops
   * answering.
   *
   * One Mac has up to three: the Cloudflare tunnel, which answers from anywhere;
   * the tailnet address, which answers wherever Tailscale is up; and the LAN
   * address, which answers at home and nowhere else. Storing one of them meant
   * this browser worked on exactly the network it was paired on — paired at home
   * over Wi-Fi, so it worked at home over Wi-Fi, and a phone that walked out of
   * the front door got "the Mac is unreachable" about a Mac that was answering
   * on its other two addresses the whole time.
   *
   * The list is learned rather than typed: the Mac reports every address it
   * believes in once a second over the socket, and a quick tunnel's hostname
   * exists nowhere else — it is minted at host launch and never written down.
   */
  alternates: string[]
  /** ISO 8601, so the record survives a structured-clone round trip legibly. */
  pairedAt: string
}

export type KeyStorage = 'non-extractable' | 'raw-seed'

// MARK: - IndexedDB

let database: Promise<IDBDatabase> | null = null

function open(): Promise<IDBDatabase> {
  if (database) return database
  database = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) {
        request.result.createObjectStore(STORE)
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('IndexedDB unavailable'))
    // Private-browsing modes and blocked third-party storage both land here, and
    // the difference between them is not something the page can see.
    request.onblocked = () => reject(new Error('IndexedDB is blocked in this browser'))
  })
  return database
}

async function read<T>(key: string): Promise<T | null> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const request = db.transaction(STORE, 'readonly').objectStore(STORE).get(key)
    request.onsuccess = () => resolve((request.result as T | undefined) ?? null)
    request.onerror = () => reject(request.error)
  })
}

async function write(key: string, value: unknown): Promise<void> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite')
    transaction.objectStore(STORE).put(value, key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}

async function remove(key: string): Promise<void> {
  const db = await open()
  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE, 'readwrite')
    transaction.objectStore(STORE).delete(key)
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => reject(transaction.error)
  })
}

// MARK: - Signing key

interface WebCryptoRecord {
  kind: 'webcrypto'
  privateKey: CryptoKey
  publicKeyRaw: ArrayBuffer
}

interface SeedRecord {
  kind: 'seed'
  seed: Uint8Array
}

type KeyRecord = WebCryptoRecord | SeedRecord

interface Signer {
  storage: KeyStorage
  publicKey: Uint8Array
  sign(message: Uint8Array): Promise<Uint8Array>
}

let signer: Promise<Signer> | null = null

/**
 * WebCrypto gained Ed25519 late and unevenly, and `generateKey` is the only
 * reliable probe: a browser can expose the algorithm name and still throw
 * `NotSupportedError` on use.
 */
async function tryWebCrypto(): Promise<WebCryptoRecord | null> {
  if (!globalThis.crypto?.subtle) return null
  try {
    const pair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, false, [
      'sign',
      'verify',
    ])) as CryptoKeyPair
    const raw = await crypto.subtle.exportKey('raw', pair.publicKey)
    return { kind: 'webcrypto', privateKey: pair.privateKey, publicKeyRaw: raw }
  } catch {
    return null
  }
}

async function makeSigner(record: KeyRecord): Promise<Signer> {
  if (record.kind === 'webcrypto') {
    const publicKey = new Uint8Array(record.publicKeyRaw)
    return {
      storage: 'non-extractable',
      publicKey,
      async sign(message) {
        const signature = await crypto.subtle.sign(
          { name: 'Ed25519' },
          record.privateKey,
          message as BufferSource,
        )
        return new Uint8Array(signature)
      },
    }
  }

  const seed = new Uint8Array(record.seed)
  const publicKey = await getPublicKeyAsync(seed)
  return {
    storage: 'raw-seed',
    publicKey,
    sign: (message) => signAsync(message, seed),
  }
}

async function loadSigner(): Promise<Signer> {
  const existing = await read<KeyRecord>(KEY_RECORD)
  if (existing) {
    // A key made under WebCrypto stays a WebCrypto key even if the page is later
    // opened somewhere the fallback would have been chosen: the private half
    // cannot be exported, so there is nothing to migrate and re-keying would
    // silently unpair the device.
    return makeSigner(existing)
  }

  const fresh = await tryWebCrypto()
  if (fresh) {
    await write(KEY_RECORD, fresh)
    return makeSigner(fresh)
  }

  const seed = etc.randomBytes(32)
  const record: SeedRecord = { kind: 'seed', seed }
  await write(KEY_RECORD, record)
  return makeSigner(record)
}

function currentSigner(): Promise<Signer> {
  signer ??= loadSigner()
  return signer
}

// MARK: - Public surface

export const Identity = {
  async publicKeyBase64(): Promise<string> {
    return base64((await currentSigner()).publicKey)
  },

  /** Signs `"vibewire-auth-v1" || nonce`, matching the host's verifier. */
  async sign(nonce: Uint8Array): Promise<Uint8Array> {
    const context = new TextEncoder().encode(AUTH_CONTEXT)
    const payload = new Uint8Array(context.length + nonce.length)
    payload.set(context, 0)
    payload.set(nonce, context.length)
    return (await currentSigner()).sign(payload)
  },

  async keyStorage(): Promise<KeyStorage> {
    return (await currentSigner()).storage
  },

  /**
   * What the Mac lists this device as. A browser cannot read the machine name, so
   * this names the browser and the platform instead — which is the useful thing
   * anyway, because two browsers on one laptop are two paired devices and the
   * revoke list has to tell them apart.
   */
  deviceName(): string {
    const engine = browserName()
    const platform =
      (navigator as { userAgentData?: { platform?: string } }).userAgentData?.platform ??
      guessPlatform()
    return platform ? `${engine} on ${platform}` : engine
  },

  deviceKind(): string {
    // The host stores this verbatim and the paired-device list draws a phone or a
    // tablet from it, so a browser says which it is rather than borrowing a shape
    // that would be a lie on a desktop.
    const coarse = matchMedia('(pointer: coarse)').matches
    const wide = Math.min(screen.width, screen.height) >= 600
    if (!coarse) return 'browser'
    return wide ? 'tablet' : 'phone'
  },

  /**
   * The stored pairing, brought up to the current shape.
   *
   * A record written before this browser knew about alternates is not a reason
   * to make anyone pair again: the key and the device id do not depend on where
   * the Mac is, so an old record needs only the fields it never had. `origin` is
   * rebuilt from the host and port it did store, and the alternates start empty
   * and are refilled from the Mac's own report within a second of connecting.
   */
  async loadPairedHost(): Promise<PairedHost | null> {
    const stored = await read<Partial<PairedHost>>(HOST_RECORD)
    if (!stored?.hostId || !stored.deviceId) return null
    const origin =
      stored.origin && stored.origin.length > 0
        ? stored.origin
        : `http://${stored.host ?? '127.0.0.1'}:${stored.port ?? 8787}`
    return {
      hostId: stored.hostId,
      hostName: stored.hostName ?? 'Mac',
      hostKey: stored.hostKey ?? '',
      deviceId: stored.deviceId,
      origin,
      host: stored.host ?? '',
      port: stored.port ?? 8787,
      alternates: stored.alternates ?? [],
      pairedAt: stored.pairedAt ?? new Date().toISOString(),
    }
  },

  async savePairedHost(host: PairedHost): Promise<void> {
    await write(HOST_RECORD, host)
  },

  /**
   * Called when the Mac revokes this device, or the user unpairs. The signing key
   * is kept so a re-pair does not churn identity unnecessarily — and, more to the
   * point, so the Mac's paired list does not fill up with dead entries for one
   * browser.
   */
  async forgetHost(): Promise<void> {
    await remove(HOST_RECORD)
  },
}

// MARK: - Small helpers

export function base64(bytes: Uint8Array): string {
  let text = ''
  for (const byte of bytes) text += String.fromCharCode(byte)
  return btoa(text)
}

export function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index)
  }
  return bytes
}

function browserName(): string {
  const brands = (
    navigator as { userAgentData?: { brands?: { brand: string; version: string }[] } }
  ).userAgentData?.brands
  if (brands?.length) {
    // The brand list deliberately contains decoys ("Not/A)Brand"); the real one is
    // whatever is left.
    const real = brands.find((entry) => !/not[\W_]*a[\W_]*brand/i.test(entry.brand))
    if (real) return real.brand
  }
  const agent = navigator.userAgent
  if (/\bEdg\//.test(agent)) return 'Edge'
  if (/\bOPR\//.test(agent)) return 'Opera'
  if (/\bFirefox\//.test(agent)) return 'Firefox'
  if (/\bChrome\//.test(agent)) return 'Chrome'
  if (/\bSafari\//.test(agent)) return 'Safari'
  return 'Browser'
}

function guessPlatform(): string {
  const agent = navigator.userAgent
  if (/iPhone/.test(agent)) return 'iPhone'
  if (/iPad/.test(agent)) return 'iPad'
  if (/Android/.test(agent)) return 'Android'
  if (/Macintosh/.test(agent)) return 'Mac'
  if (/Windows/.test(agent)) return 'Windows'
  if (/Linux/.test(agent)) return 'Linux'
  return ''
}
