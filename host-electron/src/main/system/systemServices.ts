import { clipboard, powerMonitor } from 'electron'
import { Log } from '../core/log'

/**
 * Clipboard, screenshot, lock, wake, power and the frontmost app: what the hub
 * actions and the status heartbeat read. Electron answers the cross-platform
 * half; the rest comes through the platform seam as it is built.
 */
export interface PowerState {
  isAwake: boolean
  isOnPower: boolean
  lidOpen: boolean
  /** The panels are off while the machine itself is running. */
  displaysAsleep: boolean
}

export interface Frontmost {
  name: string
  bundleId: string | null
}

export class SystemServices {
  private lastClipboard: string | null = null
  private sleepStartedAt: number | null = null

  constructor() {
    powerMonitor.on('suspend', () => {
      this.sleepStartedAt = Date.now()
      Log.info('app', 'system going to sleep')
    })
    powerMonitor.on('resume', () => {
      this.sleepStartedAt = null
      Log.info('app', 'system woke')
    })
  }

  // MARK: Clipboard

  async readClipboard(): Promise<string | null> {
    try {
      const text = await clipboard.readText()
      return text ? text : null
    } catch (error) {
      Log.debug('app', `clipboard read failed: ${String(error)}`)
      return null
    }
  }

  async writeClipboard(text: string): Promise<void> {
    try {
      await clipboard.writeText(text)
      this.lastClipboard = text
    } catch (error) {
      Log.warn('app', `clipboard write failed: ${String(error)}`)
    }
  }

  /** The text on the clipboard if it changed since the last look, else null. */
  async clipboardChangedSinceLastCheck(): Promise<string | null> {
    const text = await this.readClipboard()
    if (!text || text === this.lastClipboard) return null
    this.lastClipboard = text
    return text
  }

  // MARK: Screen, power, lock

  screenshot(_displayId: number | null): Buffer | null {
    return null
  }

  lockScreen(): boolean {
    return false
  }

  wakeDisplays(): boolean {
    return false
  }

  async waitForDisplaysAwake(): Promise<boolean> {
    return true
  }

  powerState(): PowerState {
    return {
      isAwake: this.sleepStartedAt === null,
      isOnPower: !powerMonitor.isOnBatteryPower(),
      lidOpen: true,
      displaysAsleep: false,
    }
  }

  /** Whether a *sleeping* machine could be reached by Wake-on-LAN. Nothing
   *  here sends a magic packet, so the honest answer is no. */
  canWakeOverNetwork(): boolean {
    return false
  }

  preventSleep(_on: boolean): void {}

  frontmostApplication(): Frontmost {
    return { name: 'Unknown', bundleId: null }
  }
}
