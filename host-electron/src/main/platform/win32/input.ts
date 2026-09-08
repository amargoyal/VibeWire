import { screen } from 'electron'
import type { ModifierName } from '../../../../../shared/keyNames'
import { Log } from '../../core/log'
import { isExtendedKey, modifierVirtualKey, VK, virtualKey } from '../../input/keyMap'
import type { InputSink, PhysicalRect } from '../../input/inputRouter'
import type { MouseButton } from '../../net/wireProtocol'
import {
  INPUT_KEYBOARD,
  INPUT_MOUSE,
  KEYEVENTF_EXTENDEDKEY,
  KEYEVENTF_KEYUP,
  KEYEVENTF_UNICODE,
  MAPVK_VK_TO_VSC,
  MOUSEEVENTF_ABSOLUTE,
  MOUSEEVENTF_HWHEEL,
  MOUSEEVENTF_LEFTDOWN,
  MOUSEEVENTF_LEFTUP,
  MOUSEEVENTF_MIDDLEDOWN,
  MOUSEEVENTF_MIDDLEUP,
  MOUSEEVENTF_MOVE,
  MOUSEEVENTF_RIGHTDOWN,
  MOUSEEVENTF_RIGHTUP,
  MOUSEEVENTF_VIRTUALDESK,
  MOUSEEVENTF_WHEEL,
  SM_CXVIRTUALSCREEN,
  SM_CYVIRTUALSCREEN,
  SM_XVIRTUALSCREEN,
  SM_YVIRTUALSCREEN,
  WHEEL_DELTA,
  type Input,
  type User32,
} from './user32'

/**
 * The Windows `InputSink`: everything goes through `SendInput`, one call per
 * wire message so a combo is atomic against a physical keyboard.
 *
 * Pointer placement is absolute over the virtual desktop. Relative
 * `MOUSEEVENTF_MOVE` would pass through "Enhance pointer precision" and the
 * router's cursor model would drift within seconds; the Mac host is absolute
 * for the same reason.
 */
export class Win32InputSink implements InputSink {
  private readonly heldModifiers = new Set<ModifierName>()
  private keySentSinceModifier = false

  constructor(private readonly user32: User32) {}

  private send(inputs: Input[]): void {
    const sent = this.user32.sendInput(inputs)
    if (sent !== inputs.length) Log.debug('input', `SendInput placed ${sent} of ${inputs.length} events`)
  }

  private mouse(flags: number, dx = 0, dy = 0, mouseData = 0): Input {
    return { type: INPUT_MOUSE, u: { mi: { dx, dy, mouseData: mouseData >>> 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }
  }

  private keyInput(vk: number, down: boolean): Input {
    const scan = this.user32.mapVirtualKey(vk, MAPVK_VK_TO_VSC)
    let flags = down ? 0 : KEYEVENTF_KEYUP
    if (isExtendedKey(vk)) flags |= KEYEVENTF_EXTENDEDKEY
    return { type: INPUT_KEYBOARD, u: { ki: { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }
  }

  // MARK: Pointer

  moveTo(x: number, y: number): void {
    const left = this.user32.getSystemMetrics(SM_XVIRTUALSCREEN)
    const top = this.user32.getSystemMetrics(SM_YVIRTUALSCREEN)
    const width = this.user32.getSystemMetrics(SM_CXVIRTUALSCREEN)
    const height = this.user32.getSystemMetrics(SM_CYVIRTUALSCREEN)
    if (width <= 1 || height <= 1) return
    const dx = Math.round(((x - left) * 65535) / (width - 1))
    const dy = Math.round(((y - top) * 65535) / (height - 1))
    this.send([this.mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, dx, dy)])
  }

  button(which: MouseButton, down: boolean): void {
    const flag =
      which === 'left'
        ? down
          ? MOUSEEVENTF_LEFTDOWN
          : MOUSEEVENTF_LEFTUP
        : which === 'right'
          ? down
            ? MOUSEEVENTF_RIGHTDOWN
            : MOUSEEVENTF_RIGHTUP
          : down
            ? MOUSEEVENTF_MIDDLEDOWN
            : MOUSEEVENTF_MIDDLEUP
    this.send([this.mouse(flag)])
  }

  wheel(vertical: number, horizontal: number): void {
    const inputs: Input[] = []
    const v = Math.round(vertical * WHEEL_DELTA)
    const h = Math.round(horizontal * WHEEL_DELTA)
    if (v !== 0) inputs.push(this.mouse(MOUSEEVENTF_WHEEL, 0, 0, v))
    if (h !== 0) inputs.push(this.mouse(MOUSEEVENTF_HWHEEL, 0, 0, h))
    if (inputs.length) this.send(inputs)
  }

  zoom(steps: number): void {
    this.send([
      this.keyInput(VK.CONTROL, true),
      this.mouse(MOUSEEVENTF_WHEEL, 0, 0, steps * WHEEL_DELTA),
      this.keyInput(VK.CONTROL, false),
    ])
  }

  // MARK: Keys

  key(name: string, down: boolean): boolean {
    const vk = virtualKey(name)
    if (vk === null) return false
    this.keySentSinceModifier = true
    this.send([this.keyInput(vk, down)])
    return true
  }

  unicode(text: string): void {
    // KEYEVENTF_UNICODE, one down and one up per UTF-16 unit; surrogate pairs
    // arrive as two units and Windows reassembles them. Batched so a paste-sized
    // string is a handful of calls, not hundreds.
    const units = Array.from(text, (character) => character).flatMap((character) => {
      const codes: number[] = []
      for (let index = 0; index < character.length; index += 1) codes.push(character.charCodeAt(index))
      return codes
    })
    for (let start = 0; start < units.length; start += 32) {
      const inputs: Input[] = []
      for (const unit of units.slice(start, start + 32)) {
        inputs.push({ type: INPUT_KEYBOARD, u: { ki: { wVk: 0, wScan: unit, dwFlags: KEYEVENTF_UNICODE, time: 0, dwExtraInfo: 0 } } })
        inputs.push({ type: INPUT_KEYBOARD, u: { ki: { wVk: 0, wScan: unit, dwFlags: KEYEVENTF_UNICODE | KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0 } } })
      }
      this.send(inputs)
    }
    this.keySentSinceModifier = true
  }

  modifier(name: ModifierName, down: boolean): void {
    const vk = modifierVirtualKey(name)
    if (vk === null) {
      if (down) Log.debug('input', `modifier ${name} has no key on Windows`)
      return
    }
    const inputs: Input[] = []
    if (down) {
      this.heldModifiers.add(name)
      this.keySentSinceModifier = false
    } else {
      this.heldModifiers.delete(name)
      // A lone Win or Alt press-and-release opens the Start menu or focuses
      // the menu bar. Tapping an unassigned key first tells Windows the
      // modifier was part of a chord that went nowhere.
      if ((vk === VK.LWIN || vk === VK.MENU) && !this.keySentSinceModifier) {
        inputs.push(this.keyInput(VK.UNASSIGNED, true), this.keyInput(VK.UNASSIGNED, false))
      }
    }
    inputs.push(this.keyInput(vk, down))
    this.send(inputs)
  }

  combo(modifiers: ModifierName[], key: string): boolean {
    const vk = virtualKey(key)
    if (vk === null) return false
    const held = modifiers.map(modifierVirtualKey).filter((code): code is number => code !== null)
    const inputs: Input[] = []
    for (const code of held) inputs.push(this.keyInput(code, true))
    inputs.push(this.keyInput(vk, true), this.keyInput(vk, false))
    for (const code of [...held].reverse()) inputs.push(this.keyInput(code, false))
    this.send(inputs)
    this.keySentSinceModifier = true
    return true
  }

  // MARK: Displays

  /** Physical bounds: Electron's DIP rectangle through the platform's own
   *  conversion, so a 150 % monitor is described in the pixels the capture
   *  and `SendInput` both use. */
  displayBounds(displayId: number | null): PhysicalRect | null {
    const displays = screen.getAllDisplays()
    const display = displays.find((entry) => entry.id === displayId) ?? (displayId === null ? screen.getPrimaryDisplay() : null)
    if (!display) return null
    const physical = screen.dipToScreenRect(null, display.bounds)
    return { x: physical.x, y: physical.y, width: physical.width, height: physical.height, scaleFactor: display.scaleFactor }
  }

  primaryDisplayId(): number {
    return screen.getPrimaryDisplay().id
  }
}
