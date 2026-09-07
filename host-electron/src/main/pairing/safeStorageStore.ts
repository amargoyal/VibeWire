import { safeStorage } from 'electron'
import { Log } from '../core/log'
import { SecretStoreError, type SecretStore } from './secretStore'

/**
 * Wraps another store so that what lands on disk is DPAPI-sealed on Windows
 * (and Keychain-sealed on a Mac, where this is not used by default because the
 * keychain prompts and the Mac host already learned what that costs).
 *
 * A short magic prefix tells a sealed record from a plain one, so a store that
 * was written before encryption became available is still readable, and a
 * record is re-sealed on its next write rather than migrated in bulk.
 */
export class SafeStorageStore implements SecretStore {
  readonly kind: string
  private static readonly MAGIC = Buffer.from('VWSS1', 'utf8')

  constructor(private readonly inner: SecretStore) {
    const backend = safeStorage.isEncryptionAvailable() ? safeStorage.getSelectedStorageBackend?.() ?? 'os' : 'none'
    this.kind = backend === 'none' ? inner.kind : `${inner.kind}+${backend}`
    if (backend === 'none') Log.warn('app', 'OS encryption unavailable; secrets are stored as plain files')
  }

  async read(account: string): Promise<Buffer | null> {
    const stored = await this.inner.read(account)
    if (!stored) return null
    if (!stored.subarray(0, SafeStorageStore.MAGIC.length).equals(SafeStorageStore.MAGIC)) return stored
    if (!safeStorage.isEncryptionAvailable()) {
      throw new SecretStoreError('secret is sealed but OS encryption is unavailable')
    }
    try {
      return Buffer.from(safeStorage.decryptString(stored.subarray(SafeStorageStore.MAGIC.length)), 'base64')
    } catch (error) {
      throw new SecretStoreError(`could not unseal ${account}: ${String(error)}`)
    }
  }

  async write(account: string, data: Buffer): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) return this.inner.write(account, data)
    const sealed = safeStorage.encryptString(data.toString('base64'))
    return this.inner.write(account, Buffer.concat([SafeStorageStore.MAGIC, sealed]))
  }

  delete(account: string): Promise<void> {
    return this.inner.delete(account)
  }
}
