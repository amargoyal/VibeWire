import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { randomBytes } from 'node:crypto'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { PROTOCOL_VERSION } from '../../../../shared/protocol'
import { Log, describeError } from './log'

/** `auto` lets the encoder pick from the ladder based on the measured link. */
export type QualityLadder = 'auto' | '1080' | '720' | '540'

export function ladderMaxHeight(ladder: QualityLadder): number | null {
  switch (ladder) {
    case 'auto':
      return null
    case '1080':
      return 1080
    case '720':
      return 720
    case '540':
      return 540
  }
}

export function parseLadder(raw: unknown): QualityLadder {
  return raw === '1080' || raw === '720' || raw === '540' ? raw : 'auto'
}

/**
 * Host configuration: `config.json` in the config directory, the same keys the
 * Mac host writes. Settings changed from the phone or the dashboard are written
 * back so they survive a restart.
 */
export interface HostSettings {
  quality: QualityLadder
  /** 07A "Cap on cellular · CEILING 3 MB/S" */
  capOnCellular: boolean
  cellularCeilingMbps: number
  /** 07A trackpad, 8 discrete ticks so a thumb can hit one. */
  sensitivity: number
  naturalScrolling: boolean
  /** 07A "Face ID each session"; the browser client cannot honour it, the phone can. */
  requireBiometricEachSession: boolean
  /** 07A "Relay over internet". Off means no cloudflared. */
  relayOverInternet: boolean
  targetFps: number
  port: number
  /**
   * Where the public copy of the web client lives, e.g.
   * `https://you.github.io/VibeWire`. Only affects the BROWSER QR: set, the QR
   * sends a phone to that page carrying this host's address; unset, to the copy
   * this host serves itself.
   */
  webClientURL: string | null
}

export const DEFAULT_SETTINGS: HostSettings = {
  quality: 'auto',
  capOnCellular: true,
  cellularCeilingMbps: 3.0,
  sensitivity: 5,
  naturalScrolling: true,
  requireBiometricEachSession: true,
  relayOverInternet: false,
  targetFps: 60,
  port: 8787,
  webClientURL: null,
}

function decodeSettings(raw: unknown): HostSettings {
  const settings: HostSettings = { ...DEFAULT_SETTINGS }
  if (!raw || typeof raw !== 'object') return settings
  const record = raw as Record<string, unknown>
  settings.quality = parseLadder(record.quality)
  if (typeof record.capOnCellular === 'boolean') settings.capOnCellular = record.capOnCellular
  if (typeof record.cellularCeilingMbps === 'number') settings.cellularCeilingMbps = record.cellularCeilingMbps
  if (typeof record.sensitivity === 'number') settings.sensitivity = Math.max(1, Math.min(8, Math.round(record.sensitivity)))
  if (typeof record.naturalScrolling === 'boolean') settings.naturalScrolling = record.naturalScrolling
  if (typeof record.requireBiometricEachSession === 'boolean') {
    settings.requireBiometricEachSession = record.requireBiometricEachSession
  }
  if (typeof record.relayOverInternet === 'boolean') settings.relayOverInternet = record.relayOverInternet
  if (typeof record.targetFps === 'number') settings.targetFps = record.targetFps
  if (typeof record.port === 'number' && record.port > 0 && record.port < 65536) settings.port = record.port
  if (typeof record.webClientURL === 'string' && record.webClientURL) settings.webClientURL = record.webClientURL
  return settings
}

export interface ConfigInit {
  /** Where `config.json`, the secrets and the deployed bundles live. */
  configDir: string
  /** The repository root when running out of a checkout, else null. */
  checkoutRoot: string | null
  /** `process.resourcesPath` when packaged, else null. */
  resourcesPath: string | null
  argv: string[]
  env: NodeJS.ProcessEnv
  /** From package.json, via the app. */
  version: string
}

class ConfigStore {
  private init_: ConfigInit | null = null

  /** Bumped when the wire protocol changes incompatibly. */
  readonly protocolVersion = PROTOCOL_VERSION

  init(init: ConfigInit): void {
    this.init_ = init
    mkdirSync(init.configDir, { recursive: true })
    Log.setVerbose(init.env.VIBEWIRE_VERBOSE === '1')
  }

  private get state(): ConfigInit {
    if (!this.init_) throw new Error('Config used before init')
    return this.init_
  }

  get hostVersion(): string {
    return this.state.version
  }

  get verbose(): boolean {
    return Log.verbose
  }

  get configDir(): string {
    return this.state.configDir
  }

  get settingsPath(): string {
    return join(this.configDir, 'config.json')
  }

  /**
   * `--port <n>` runs this host somewhere other than the stored port without
   * editing the stored port, which is what makes a second host testable beside
   * a real one that is already serving on 8787.
   */
  get portOverride(): number | null {
    const argv = this.state.argv
    const flag = argv.indexOf('--port')
    if (flag < 0 || flag + 1 >= argv.length) return null
    const value = Number(argv[flag + 1])
    return Number.isInteger(value) && value > 0 && value < 65536 ? value : null
  }

  loadSettings(): HostSettings {
    let settings = { ...DEFAULT_SETTINGS }
    try {
      if (existsSync(this.settingsPath)) {
        settings = decodeSettings(JSON.parse(readFileSync(this.settingsPath, 'utf8')))
      }
    } catch (error) {
      Log.warn('app', `settings file unreadable, using defaults: ${describeError(error)}`)
    }
    const override = this.portOverride
    if (override) settings.port = override
    return settings
  }

  saveSettings(settings: HostSettings): void {
    const toWrite = { ...settings }
    // A port supplied on the command line belongs to this run, not to the file.
    if (this.portOverride) toWrite.port = this.storedPort()
    const sorted = Object.fromEntries(Object.entries(toWrite).sort(([a], [b]) => (a < b ? -1 : 1)))
    const json = JSON.stringify(sorted, null, 2) + '\n'
    try {
      const temp = this.settingsPath + '.tmp'
      writeFileSync(temp, json, { mode: 0o600 })
      renameSync(temp, this.settingsPath)
    } catch (error) {
      Log.error('app', `could not save settings: ${describeError(error)}`)
    }
  }

  private storedPort(): number {
    try {
      if (existsSync(this.settingsPath)) {
        return decodeSettings(JSON.parse(readFileSync(this.settingsPath, 'utf8'))).port
      }
    } catch {
      // fall through to the default
    }
    return DEFAULT_SETTINGS.port
  }

  /**
   * The public web client to send a scanned QR to, or null to use the copy this
   * host serves. `VIBEWIRE_WEB_CLIENT` wins over the stored setting.
   */
  get webClientURL(): string | null {
    const override = this.state.env.VIBEWIRE_WEB_CLIENT
    if (override) return override
    return this.loadSettings().webClientURL
  }

  /**
   * The secret that stands between this host's whole control surface and
   * anything else that can reach the port. Fresh every launch, never written
   * anywhere: not the settings file, not the secret store, not the log.
   */
  readonly dashboardKey: string = randomBytes(32).toString('base64url')

  /**
   * Where the built web client lives, or null if it was never built. Four
   * places, in order of how deliberate they are: an env override, the installed
   * copy under the config directory, the checkout's `web/dist`, then whatever
   * was packaged into the app.
   */
  get webRoot(): string | null {
    return this.bundleRoot('VIBEWIRE_WEB_ROOT', 'web', 'web/dist')
  }

  get dashboardRoot(): string | null {
    return this.bundleRoot('VIBEWIRE_DASHBOARD_ROOT', 'dashboard', 'web/dist-dashboard')
  }

  private bundleRoot(envKey: string, installedName: string, checkoutPath: string): string | null {
    const { env, configDir, checkoutRoot, resourcesPath } = this.state
    const override = env[envKey]
    if (override) return resolve(override.replace(/^~(?=$|\/)/, homedir()))

    const installed = join(configDir, installedName)
    if (existsSync(join(installed, 'index.html'))) return installed

    if (checkoutRoot) {
      const checkout = join(checkoutRoot, checkoutPath)
      if (existsSync(join(checkout, 'index.html'))) return checkout
    }

    if (resourcesPath) {
      const bundled = join(resourcesPath, installedName)
      if (existsSync(join(bundled, 'index.html'))) return bundled
    }
    return null
  }
}

export const Config = new ConfigStore()
