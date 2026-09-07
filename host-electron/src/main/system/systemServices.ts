import { clipboard, desktopCapturer, powerMonitor, powerSaveBlocker, screen } from 'electron'
import { Log } from '../core/log'
import type { HostPlatform } from '../platform/hostPlatform'

/**
 * Clipboard, screenshot, lock, wake, power and the frontmost app: what the hub
 * actions and the status heartbeat read. Electron answers the cross-platform
 * half; the platform seam answers the rest.
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
  title: string
  elevated: boolean
}

export class SystemServices {
  private lastClipboard: string | null = null
  private sleepStartedAt: number | null = null
  private blocker: number | null = null

  constructor(private readonly platform: HostPlatform) {
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

  // MARK: Screen

  /** One frame of a display as a PNG. A screenshot, taken on request, at up
   *  to `maxWidth` pixels wide; null when the platform will not hand one over. */
  async screenshot(displayId: number | null, maxWidth = 1600): Promise<Buffer | null> {
    const displays = screen.getAllDisplays()
    const display = displays.find((entry) => entry.id === displayId) ?? screen.getPrimaryDisplay()
    const physicalWidth = Math.round(display.size.width * display.scaleFactor)
    const physicalHeight = Math.round(display.size.height * display.scaleFactor)
    const scale = Math.min(1, maxWidth / physicalWidth)
    try {
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: { width: Math.round(physicalWidth * scale), height: Math.round(physicalHeight * scale) },
      })
      const source =
        sources.find((entry) => entry.display_id === String(display.id)) ??
        sources[displays.findIndex((entry) => entry.id === display.id)] ??
        sources[0]
      if (!source || source.thumbnail.isEmpty()) return null
      return source.thumbnail.toPNG()
    } catch (error) {
      Log.warn('app', `screenshot failed: ${String(error)}`)
      return null
    }
  }

  // MARK: Power, lock

  lockScreen(): boolean {
    return this.platform.power.lock()
  }

  wakeDisplays(): boolean {
    return this.platform.power.wakeDisplays()
  }

  /** Polls for up to 6 s for the panels to come back. */
  async waitForDisplaysAwake(): Promise<boolean> {
    for (let attempt = 0; attempt < 12; attempt += 1) {
      if (!this.platform.power.displaysAsleep()) return true
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
    return !this.platform.power.displaysAsleep()
  }

  powerState(): PowerState {
    const displaysAsleep = this.platform.power.displaysAsleep()
    return {
      isAwake: this.sleepStartedAt === null && !displaysAsleep,
      isOnPower: !powerMonitor.isOnBatteryPower(),
      lidOpen: true,
      displaysAsleep,
    }
  }

  /** Whether a *sleeping* machine could be reached by Wake-on-LAN. Nothing
   *  here sends a magic packet, so the honest answer is no. */
  canWakeOverNetwork(): boolean {
    return false
  }

  /** Keeps the panels on while a phone is attached, the way the Mac host
   *  holds a power assertion. */
  preventSleep(on: boolean): void {
    if (on && this.blocker === null) this.blocker = powerSaveBlocker.start('prevent-display-sleep')
    if (!on && this.blocker !== null) {
      powerSaveBlocker.stop(this.blocker)
      this.blocker = null
    }
  }

  frontmostApplication(): Frontmost {
    const front = this.platform.desktop.foregroundWindow()
    return { name: front.app || 'Unknown', bundleId: front.path || null, title: front.title, elevated: front.elevated }
  }
}
