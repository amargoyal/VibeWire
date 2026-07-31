/**
 * 19 · THE TAB ITSELF, as a readout.
 *
 * A phone shows this app or it does not. A browser buries it behind eleven other
 * tabs, and the one question worth answering from there is the same one every
 * other surface in this client answers: is the Mac still on the end of it. So the
 * tab reports the condition — its title says the state in words, and its icon is
 * the same dot the app draws, in the same colour, obeying the same rules.
 *
 * Two of those rules matter here:
 *
 *  - **Derived, never asserted.** Everything below comes from a measured value:
 *    the stream state, the link condition the store already computes, the host's
 *    own name. Nothing is a guess about what is probably happening.
 *  - **Redundant channel.** A lost condition is drawn as a square, so the icon
 *    still says "lost" in a monochrome tab strip, to a colour-blind reader, and at
 *    the 16px a favicon is actually rendered at. Colour is never the only carrier,
 *    least of all at this size.
 *
 * The colours are read out of the stylesheet rather than repeated here, so the tab
 * cannot drift from the app the way a second copy of a palette always does.
 */

import { effect } from '@preact/signals'

import { store } from './store'
import { conditionColor } from '../design/components'

const ICON_SIZE = 32

/** What the app is called when there is nothing to report about. */
const PLAIN = 'VibeWire'

function resolve(token: string): string {
  // `conditionColor` hands back `var(--ns-green)`; a canvas needs the value.
  const name = token.replace(/^var\(/, '').replace(/\)$/, '')
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim()
  return value || '#5CE4B1'
}

function paint(color: string, lost: boolean): string | null {
  const canvas = document.createElement('canvas')
  canvas.width = ICON_SIZE
  canvas.height = ICON_SIZE
  const context = canvas.getContext('2d')
  if (!context) return null

  context.fillStyle = color
  if (lost) {
    // The square, at the size the shape has to survive: a favicon is drawn at 16px
    // and a rounded corner at that scale is a circle again.
    context.fillRect(6, 6, 20, 20)
  } else {
    context.beginPath()
    context.arc(ICON_SIZE / 2, ICON_SIZE / 2, 10, 0, Math.PI * 2)
    context.fill()
  }
  return canvas.toDataURL('image/png')
}

/** What the tab strip should say, from what has actually been measured. */
function describe(): { title: string; color: string; lost: boolean } {
  const host = store.hostName.value || 'the Mac'
  const route = store.route.value

  if (route === 'pairing') {
    return { title: PLAIN, color: conditionColor.idle, lost: false }
  }

  const stream = store.streamState.value
  if (route === 'remote') {
    switch (stream.kind) {
      case 'live': {
        const display = store.selectedDisplay.value
        return {
          title: `${display ? display.name : 'Screen'} · ${host}`,
          color: conditionColor.reachable,
          lost: false,
        }
      }
      case 'stalled':
        return { title: `Stalled · ${host}`, color: conditionColor.degraded, lost: false }
      case 'reconnecting':
        return { title: `Reconnecting · ${host}`, color: conditionColor.degraded, lost: false }
      case 'failed':
        return { title: `Lost · ${host}`, color: conditionColor.lost, lost: true }
      default:
        return { title: `${host} · ${PLAIN}`, color: conditionColor.idle, lost: false }
    }
  }

  const connection = store.connection.value
  if (connection.kind === 'failed' || connection.kind === 'unauthorized') {
    return { title: `No answer · ${host}`, color: conditionColor.lost, lost: true }
  }
  if (connection.kind !== 'connected') {
    return { title: `${host} · ${PLAIN}`, color: conditionColor.idle, lost: false }
  }
  if (!store.link.value.awake) {
    return { title: `Asleep · ${host}`, color: conditionColor.idle, lost: false }
  }

  // A permission waiting on an answer is the one thing worth pulling someone back
  // to a tab for, and it is measured — the host sent the request.
  if (store.permission.value) {
    return { title: `Claude is asking · ${host}`, color: conditionColor.degraded, lost: false }
  }

  return { title: `${host} · ${PLAIN}`, color: conditionColor.reachable, lost: false }
}

/**
 * Keeps the tab in step with the condition, for as long as the page is open.
 *
 * Both writes are guarded on the value actually changing. The stream state is
 * recomputed on every frame's worth of stats, and re-encoding a PNG at that rate
 * to draw the identical dot is the sort of thing that shows up in a battery
 * graph on the machine that is supposed to be watching a video.
 */
export function watchTabCondition(): () => void {
  let lastTitle = ''
  let lastKey = ''

  const icon = document.querySelector<HTMLLinkElement>('link[rel="icon"]')

  return effect(() => {
    const { title, color, lost } = describe()

    if (title !== lastTitle) {
      lastTitle = title
      document.title = title
    }

    const key = `${color}:${lost}`
    if (key !== lastKey && icon) {
      lastKey = key
      const href = paint(resolve(color), lost)
      if (href) icon.href = href
    }
  })
}
