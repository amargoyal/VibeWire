import type { PowerControl } from '../hostPlatform'
import { ES_CONTINUOUS, ES_DISPLAY_REQUIRED, INPUT_MOUSE, MOUSEEVENTF_MOVE, type User32 } from './user32'

/**
 * Lock and wake. Unlike macOS, a synthetic one-pixel nudge does turn a
 * sleeping Windows panel back on, and `SetThreadExecutionState` keeps it on.
 * `displaysAsleep` is not measured in this version, so it is reported false
 * and the card that claims "display is off" is never drawn on a guess.
 */
export function createWin32Power(user32: () => User32 | null): PowerControl {
  return {
    lock() {
      const api = user32()
      return api ? api.lockWorkStation() : false
    },
    wakeDisplays() {
      const api = user32()
      if (!api) return false
      api.setThreadExecutionState(ES_DISPLAY_REQUIRED)
      api.sendInput([
        { type: INPUT_MOUSE, u: { mi: { dx: 1, dy: 0, mouseData: 0, dwFlags: MOUSEEVENTF_MOVE, time: 0, dwExtraInfo: 0 } } },
        { type: INPUT_MOUSE, u: { mi: { dx: -1, dy: 0, mouseData: 0, dwFlags: MOUSEEVENTF_MOVE, time: 0, dwExtraInfo: 0 } } },
      ])
      return true
    },
    displaysAsleep() {
      return false
    },
  }
}

/** Holds the panels on while a phone is attached; released with the flag alone. */
export function keepDisplayOn(user32: () => User32 | null, on: boolean): void {
  const api = user32()
  if (!api) return
  api.setThreadExecutionState(on ? ES_CONTINUOUS | ES_DISPLAY_REQUIRED : ES_CONTINUOUS)
}
