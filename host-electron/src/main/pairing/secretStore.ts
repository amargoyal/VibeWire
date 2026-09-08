import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Where the trust records and the host's own key live.
 *
 * On the Mac host this is the login keychain with a file fallback. Here it is
 * a file, wrapped in the platform's encryption where one exists that never
 * prompts (DPAPI on Windows, via `SafeStorageStore`). A read that could not be
 * answered throws; nothing treats it as "no devices".
 */
export interface SecretStore {
  readonly kind: string
  /** The stored bytes, or null when the item is genuinely absent. */
  read(account: string): Promise<Buffer | null>
  write(account: string, data: Buffer): Promise<void>
  delete(account: string): Promise<void>
}

export class SecretStoreError extends Error {}

/** `<dir>/<account>.secret`, mode 0600, written atomically. */
export class FileStore implements SecretStore {
  readonly kind = 'file'

  constructor(private readonly directory: string) {}

  private path(account: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(account)) throw new SecretStoreError(`bad account name ${account}`)
    return join(this.directory, `${account}.secret`)
  }

  async read(account: string): Promise<Buffer | null> {
    const path = this.path(account)
    if (!existsSync(path)) return null
    try {
      return readFileSync(path)
    } catch (error) {
      throw new SecretStoreError(`could not read ${path}: ${String(error)}`)
    }
  }

  async write(account: string, data: Buffer): Promise<void> {
    const path = this.path(account)
    try {
      mkdirSync(this.directory, { recursive: true, mode: 0o700 })
      const temp = `${path}.tmp`
      writeFileSync(temp, data, { mode: 0o600 })
      renameSync(temp, path)
    } catch (error) {
      throw new SecretStoreError(`could not write ${path}: ${String(error)}`)
    }
  }

  async delete(account: string): Promise<void> {
    const path = this.path(account)
    try {
      if (existsSync(path)) unlinkSync(path)
    } catch (error) {
      throw new SecretStoreError(`could not delete ${path}: ${String(error)}`)
    }
  }
}

/** For tests, and for nothing else. */
export class MemoryStore implements SecretStore {
  readonly kind = 'memory'
  private items = new Map<string, Buffer>()

  async read(account: string): Promise<Buffer | null> {
    return this.items.get(account) ?? null
  }

  async write(account: string, data: Buffer): Promise<void> {
    this.items.set(account, Buffer.from(data))
  }

  async delete(account: string): Promise<void> {
    this.items.delete(account)
  }
}
