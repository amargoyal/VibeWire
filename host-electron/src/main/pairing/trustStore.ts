import { createHash, randomUUID } from 'node:crypto'
import { Log, describeError } from '../core/log'
import { generateSeed, publicKeyFromSeed } from './ed25519'
import { SecretStoreError, type SecretStore } from './secretStore'

/** A device that has completed the handshake. Screens 07A/07B render this list. */
export interface TrustedDevice {
  id: string
  name: string
  /** "phone" | "tablet" | "browser" */
  kind: string
  /** Raw Ed25519, 32 bytes. */
  publicKey: Buffer
  pairedAt: Date
  lastSeenAt: Date | null
}

export interface HostIdentity {
  seed: Buffer
  publicKey: Buffer
}

interface StoredDevice {
  id: string
  name: string
  kind: string
  publicKey: string
  pairedAt: string
  lastSeenAt: string | null
}

/**
 * Device trust and the host's own key. The whole device set is one record, so
 * revoke-all is atomic. The cache holds *successful* loads only: caching a
 * failed read as an empty set is what made a slow store look like a wiped one.
 */
export class TrustStore {
  private cache: Map<string, TrustedDevice> | null = null
  private inflightLoad: Promise<Map<string, TrustedDevice>> | null = null
  private identity: HostIdentity | null = null
  private readonly hostIdentityAccount = 'host-identity'
  private readonly devicesAccount = 'devices'

  constructor(private readonly store: SecretStore) {}

  get storeKind(): string {
    return this.store.kind
  }

  /** Pays the first-touch cost at launch instead of during a pairing. Retries,
   *  because a store that answers late is not a store with nothing in it. */
  async prime(): Promise<void> {
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      try {
        await this.loadDevices()
        await this.hostIdentity()
        return
      } catch (error) {
        Log.warn('app', `trust store unreadable (attempt ${attempt}): ${describeError(error)}`)
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    }
    Log.error('app', 'trust store still unreadable — paired devices will be rejected until it answers')
  }

  // MARK: Host identity

  /**
   * This host's own Ed25519 key. Generated once and reused, so a phone can pin
   * it and notice if it ever changes. Minted only when the store says the item
   * is genuinely absent; a read failure throws instead.
   */
  async hostIdentity(): Promise<HostIdentity> {
    if (this.identity) return this.identity
    const raw = await this.store.read(this.hostIdentityAccount)
    if (raw) {
      if (raw.length !== 32) throw new SecretStoreError('host identity record is not a 32-byte seed')
      this.identity = { seed: Buffer.from(raw), publicKey: publicKeyFromSeed(raw) }
      return this.identity
    }
    const seed = generateSeed()
    await this.store.write(this.hostIdentityAccount, seed)
    Log.info('net', 'generated new host identity key')
    this.identity = { seed, publicKey: publicKeyFromSeed(seed) }
    return this.identity
  }

  /** Stable, derived, and not the raw key: the first 16 bytes of SHA-256 of the
   *  public key, in hex. */
  async hostId(): Promise<string> {
    const identity = await this.hostIdentity()
    return createHash('sha256').update(identity.publicKey).digest().subarray(0, 16).toString('hex')
  }

  // MARK: Devices

  async all(): Promise<TrustedDevice[]> {
    return [...(await this.loadDevices()).values()].sort((a, b) => a.pairedAt.getTime() - b.pairedAt.getTime())
  }

  async device(id: string): Promise<TrustedDevice | null> {
    return (await this.loadDevices()).get(id) ?? null
  }

  async add(device: TrustedDevice): Promise<void> {
    const devices = await this.loadDevices()
    devices.set(device.id, device)
    await this.persist(devices)
    Log.info('net', `paired device ${device.name} (${device.id})`)
  }

  async touch(id: string): Promise<void> {
    try {
      const devices = await this.loadDevices()
      const device = devices.get(id)
      if (!device) return
      device.lastSeenAt = new Date()
      await this.persist(devices)
    } catch {
      // A missed lastSeen is not worth failing an authentication over.
    }
  }

  /** Renames without touching the key. False when there is no such device. */
  async rename(id: string, name: string): Promise<boolean> {
    const trimmed = name.trim()
    if (!trimmed) return false
    const devices = await this.loadDevices()
    const device = devices.get(id)
    if (!device) return false
    device.name = trimmed.slice(0, 64)
    await this.persist(devices)
    Log.info('net', `renamed device ${id} to ${device.name}`)
    return true
  }

  /** True when something was actually removed, so callers can sever a socket. */
  async revoke(id: string): Promise<boolean> {
    const devices = await this.loadDevices()
    if (!devices.delete(id)) return false
    await this.persist(devices)
    Log.info('net', `revoked device ${id}`)
    return true
  }

  async revokeAll(): Promise<string[]> {
    const devices = await this.loadDevices()
    const ids = [...devices.keys()]
    await this.persist(new Map())
    Log.info('net', `revoked all devices (${ids.length})`)
    return ids
  }

  static newDeviceId(): string {
    return randomUUID().toUpperCase()
  }

  // MARK: Storage

  private loadDevices(): Promise<Map<string, TrustedDevice>> {
    if (this.cache) return Promise.resolve(this.cache)
    if (this.inflightLoad) return this.inflightLoad
    const load = (async () => {
      const data = await this.store.read(this.devicesAccount)
      if (!data) return new Map<string, TrustedDevice>()
      let decoded: Record<string, StoredDevice>
      try {
        decoded = JSON.parse(data.toString('utf8'))
      } catch {
        // Present but unreadable. Never cached: pretending the set is empty
        // would let the next pairing overwrite it.
        Log.error('app', `device trust record is corrupt (${data.length} bytes); refusing to overwrite it`)
        throw new SecretStoreError('device trust record is corrupt')
      }
      const devices = new Map<string, TrustedDevice>()
      for (const [id, stored] of Object.entries(decoded)) {
        devices.set(id, {
          id: stored.id ?? id,
          name: stored.name ?? 'Device',
          kind: stored.kind ?? 'phone',
          publicKey: Buffer.from(stored.publicKey, 'base64'),
          pairedAt: new Date(stored.pairedAt),
          lastSeenAt: stored.lastSeenAt ? new Date(stored.lastSeenAt) : null,
        })
      }
      return devices
    })()
    this.inflightLoad = load
    return load
      .then((devices) => {
        this.cache = devices
        return devices
      })
      .finally(() => {
        this.inflightLoad = null
      })
  }

  private async persist(devices: Map<string, TrustedDevice>): Promise<void> {
    const record: Record<string, StoredDevice> = {}
    for (const [id, device] of devices) {
      record[id] = {
        id: device.id,
        name: device.name,
        kind: device.kind,
        publicKey: device.publicKey.toString('base64'),
        pairedAt: device.pairedAt.toISOString(),
        lastSeenAt: device.lastSeenAt ? device.lastSeenAt.toISOString() : null,
      }
    }
    await this.store.write(this.devicesAccount, Buffer.from(JSON.stringify(record), 'utf8'))
    this.cache = devices
  }
}
