/**
 * The key vocabulary on the wire. Names, never codes: the Mac host maps them to
 * Carbon virtual keycodes, the Windows host to VK codes, and the browser client
 * translates `KeyboardEvent.code` into them. This list is the authority; a host
 * that cannot place a name falls back to Unicode injection rather than guessing.
 */

export const NAMED_KEYS = [
  'escape',
  'tab',
  'return',
  'delete',
  'forwardDelete',
  'space',
  'arrowLeft',
  'arrowRight',
  'arrowUp',
  'arrowDown',
  'home',
  'end',
  'pageUp',
  'pageDown',
  'minus',
  'equal',
  'leftBracket',
  'rightBracket',
  'backslash',
  'semicolon',
  'quote',
  'comma',
  'period',
  'slash',
  'grave',
] as const

export const LETTER_KEYS = 'abcdefghijklmnopqrstuvwxyz'.split('')
export const DIGIT_KEYS = '0123456789'.split('')
export const FUNCTION_KEYS = Array.from({ length: 12 }, (_, index) => `f${index + 1}`)

/** Every name a host is expected to place. */
export const ALL_KEY_NAMES: readonly string[] = [
  ...NAMED_KEYS,
  ...LETTER_KEYS,
  ...DIGIT_KEYS,
  ...FUNCTION_KEYS,
]

/** The modifiers the host tracks as held state rather than as keystrokes. */
export type ModifierName = 'cmd' | 'shift' | 'option' | 'control' | 'fn' | 'capsLock'
export const MODIFIER_NAMES: readonly ModifierName[] = [
  'cmd',
  'shift',
  'option',
  'control',
  'fn',
  'capsLock',
]

/** The phone may send "⌘", "cmd", or "command"; normalise before matching. */
export function normalizeModifier(raw: string): string {
  switch (raw.toLowerCase()) {
    case '⌘':
    case 'cmd':
    case 'command':
    case 'meta':
      return 'cmd'
    case '⇧':
    case 'shift':
      return 'shift'
    case '⌥':
    case 'opt':
    case 'option':
    case 'alt':
      return 'option'
    case '⌃':
    case 'ctrl':
    case 'control':
      return 'control'
    case 'fn':
    case 'function':
      return 'fn'
    case 'caps':
    case 'capslock':
      return 'capsLock'
    default:
      return raw
  }
}

export function isModifierName(name: string): name is ModifierName {
  return (MODIFIER_NAMES as readonly string[]).includes(name)
}
