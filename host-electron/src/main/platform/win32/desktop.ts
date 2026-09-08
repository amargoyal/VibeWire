import { basename } from 'node:path'
import type { DesktopInfo } from '../hostPlatform'
import type { User32 } from './user32'

/**
 * Who has the screen. The lock screen and a UAC prompt live on the secure
 * desktop, where nothing this host sends can land; an elevated window on the
 * user's desktop refuses input from a non-elevated process just as quietly.
 * Both are measured here so they can be named instead of looking like dead
 * input.
 */
export function createWin32Desktop(user32: () => User32 | null): DesktopInfo {
  let ownPid = process.pid
  let ownElevated: boolean | null = null

  return {
    secureDesktopActive() {
      const api = user32()
      if (!api) return false
      const name = api.inputDesktopName()
      // null means the input desktop could not even be opened, which is the
      // secure desktop's own way of saying no.
      return name === null || name.toLowerCase() !== 'default'
    },
    foregroundWindow() {
      const api = user32()
      if (!api) return { app: 'Unknown', title: '', path: '', elevated: false }
      const hwnd = api.getForegroundWindow()
      if (!hwnd) return { app: 'Unknown', title: '', path: '', elevated: false }
      const pid = api.windowProcessId(hwnd)
      const path = (pid ? api.processImagePath(pid) : null) ?? ''
      const title = api.windowText(hwnd)
      ownElevated ??= api.processIsElevated(ownPid) ?? false
      const theirs = pid ? api.processIsElevated(pid) : null
      // A window whose elevation cannot be read from here is, in practice, an
      // elevated one: `OpenProcess` on it is what a non-admin is refused.
      const elevated = !ownElevated && (theirs === null || theirs)
      return { app: path ? basename(path).replace(/\.exe$/i, '') : title || 'Unknown', title, path, elevated }
    },
  }
}
