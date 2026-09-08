import { ALL_KEY_NAMES } from '../../../../shared/keyNames'

/**
 * Wire key names → Windows virtual-key codes. The names are the same ones the
 * Mac host maps to Carbon keycodes; only the right-hand side differs. A name
 * with no entry makes the caller fall back to Unicode injection rather than
 * guessing a layout.
 */
const NAMED: Record<string, number> = {
  escape: 0x1b,
  tab: 0x09,
  return: 0x0d,
  enter: 0x0d,
  delete: 0x08, // VK_BACK — the Mac's "delete" is a backspace
  backspace: 0x08,
  forwardDelete: 0x2e, // VK_DELETE
  space: 0x20,
  arrowLeft: 0x25,
  arrowUp: 0x26,
  arrowRight: 0x27,
  arrowDown: 0x28,
  home: 0x24,
  end: 0x23,
  pageUp: 0x21,
  pageDown: 0x22,
  minus: 0xbd, // VK_OEM_MINUS
  equal: 0xbb, // VK_OEM_PLUS
  leftBracket: 0xdb, // VK_OEM_4
  rightBracket: 0xdd, // VK_OEM_6
  backslash: 0xdc, // VK_OEM_5
  semicolon: 0xba, // VK_OEM_1
  quote: 0xde, // VK_OEM_7
  comma: 0xbc, // VK_OEM_COMMA
  period: 0xbe, // VK_OEM_PERIOD
  slash: 0xbf, // VK_OEM_2
  grave: 0xc0, // VK_OEM_3
}

/** Keys whose scan codes carry the extended-key bit on a PC keyboard. */
const EXTENDED = new Set([0x2e, 0x25, 0x26, 0x27, 0x28, 0x24, 0x23, 0x21, 0x22, 0x2d, 0x5b, 0x5c])

export const VK = {
  SHIFT: 0x10,
  CONTROL: 0x11,
  MENU: 0x12,
  LWIN: 0x5b,
  CAPITAL: 0x14,
  /** An unassigned code, tapped before a lone Win or Alt is released so the
   *  Start menu and the menu bar do not take the release as a request. */
  UNASSIGNED: 0xe8,
}

export function virtualKey(name: string): number | null {
  if (NAMED[name] !== undefined) return NAMED[name]
  const lower = name.toLowerCase()
  if (NAMED[lower] !== undefined) return NAMED[lower]
  if (/^[a-z]$/.test(lower)) return lower.charCodeAt(0) - 0x61 + 0x41
  if (/^[0-9]$/.test(lower)) return lower.charCodeAt(0)
  const fn = /^f(\d{1,2})$/.exec(lower)
  if (fn) {
    const index = Number(fn[1])
    if (index >= 1 && index <= 24) return 0x70 + index - 1
  }
  return null
}

export function isExtendedKey(vk: number): boolean {
  return EXTENDED.has(vk)
}

/** The wire modifier → the key Windows holds. `cmd` is Ctrl because every
 *  stored combo means "the primary chord key"; `control` is the Win key, the
 *  one modifier with no other home. */
export function modifierVirtualKey(name: string): number | null {
  switch (name) {
    case 'cmd':
      return VK.CONTROL
    case 'shift':
      return VK.SHIFT
    case 'option':
      return VK.MENU
    case 'control':
      return VK.LWIN
    case 'capsLock':
      return VK.CAPITAL
    default:
      return null
  }
}

/** Every name the protocol promises has a code here; the unit test proves it. */
export function unmappedKeyNames(): string[] {
  return ALL_KEY_NAMES.filter((name) => virtualKey(name) === null)
}
