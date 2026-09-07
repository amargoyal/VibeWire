import { desktopCapturer, screen, type DesktopCapturerSource, type Display } from 'electron'
import { Log, describeError } from '../core/log'
import type { DisplayInfo } from './captureHost'

/**
 * Enumerates displays and tracks hot-plug. `screen` is the source of truth for
 * geometry and refresh rate; `desktopCapturer` names the source Chromium will
 * capture, matched back to a display by its id.
 *
 * Sizes on the wire are physical pixels, as the Mac host reports them: the
 * picture the phone sees is the captured frame, and the injector clamps in the
 * same space, so a 150 % display is not described as smaller than it is.
 */
export class DisplayCatalog {
  private displays: DisplayInfo[] = []
  private lastRefresh = 0
  private stale = true

  constructor() {
    const changed = (event: string) => () => {
      this.stale = true
      Log.info('capture', `displays changed (${event})`)
    }
    screen.on('display-added', changed('display-added'))
    screen.on('display-removed', changed('display-removed'))
    screen.on('display-metrics-changed', changed('display-metrics-changed'))
  }

  /** Refreshes at most every 2 s unless forced or a display came or went. */
  async refresh(force = false): Promise<DisplayInfo[]> {
    if (!force && !this.stale && Date.now() - this.lastRefresh < 2000) return this.displays
    const primary = screen.getPrimaryDisplay().id
    const result: DisplayInfo[] = screen.getAllDisplays().map((display, index) => ({
      id: display.id,
      name: label(index + 1, display),
      width: Math.round(display.size.width * display.scaleFactor),
      height: Math.round(display.size.height * display.scaleFactor),
      // A 0 means "unknown", which in practice is a 60 Hz external panel.
      hz: display.displayFrequency > 0 ? Math.round(display.displayFrequency) : 60,
      isBuiltIn: display.internal,
      isMain: display.id === primary,
    }))
    if (result.length === 0 && this.displays.length > 0) {
      // Displays online but reported absent means the panels are off, not
      // gone. Hold what was last seen rather than telling the phone the host
      // has no screens.
      Log.info('capture', 'no displays reported; holding the last known list')
    } else {
      this.displays = result
    }
    this.lastRefresh = Date.now()
    this.stale = false
    return this.displays
  }

  display(id: number): DisplayInfo | null {
    return this.displays.find((display) => display.id === id) ?? null
  }

  defaultDisplay(): DisplayInfo | null {
    return this.displays.find((display) => display.isMain) ?? this.displays[0] ?? null
  }

  /** The `desktopCapturer` source for a display, matched by id first and by
   *  position in the list second, saying which strategy won. */
  async source(displayId: number): Promise<DesktopCapturerSource | null> {
    let sources: DesktopCapturerSource[]
    try {
      sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } })
    } catch (error) {
      Log.error('capture', `desktopCapturer failed: ${describeError(error)}`)
      return null
    }
    Log.debug(
      'capture',
      `capture sources: ${sources.map((source) => `${source.id} display_id=${JSON.stringify(source.display_id)} "${source.name}"`).join(' | ') || 'none'}; screens: ${screen
        .getAllDisplays()
        .map((display) => display.id)
        .join(',')}`,
    )
    const byId = sources.find((source) => source.display_id === String(displayId))
    if (byId) return byId
    const index = screen.getAllDisplays().findIndex((display) => display.id === displayId)
    const byOrder = index >= 0 ? sources[index] : undefined
    if (byOrder) {
      Log.warn('capture', `display ${displayId} matched a capture source by position, not by id`)
      return byOrder
    }
    return null
  }
}

/** "Monitor 1 · built-in", "Monitor 2 · DELL U2723QE" */
function label(index: number, display: Display): string {
  const suffix = display.internal ? 'built-in' : display.label?.trim() || 'external'
  return `Monitor ${index} · ${suffix}`
}
