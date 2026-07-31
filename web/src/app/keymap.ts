/**
 * Browser `KeyboardEvent.code` → the stable key names the host understands.
 *
 * The host's `KeyMap` (host/Sources/VibeWireHost/Input/KeyMap.swift) is the
 * authority on the name list; this is only the translation into it. `code` is used
 * rather than `key` on purpose: `code` is the physical key and does not change
 * under a held Shift or a non-US layout, which is what makes ⌘⇧Z arrive as ⌘⇧Z
 * rather than as ⌘+"z" with a shift the Mac has to guess at.
 */

const NAMED: Record<string, string> = {
  Escape: 'escape',
  Tab: 'tab',
  Enter: 'return',
  NumpadEnter: 'return',
  Backspace: 'delete',
  Delete: 'forwardDelete',
  Space: 'space',

  ArrowLeft: 'arrowLeft',
  ArrowRight: 'arrowRight',
  ArrowUp: 'arrowUp',
  ArrowDown: 'arrowDown',

  Home: 'home',
  End: 'end',
  PageUp: 'pageUp',
  PageDown: 'pageDown',

  Minus: 'minus',
  Equal: 'equal',
  BracketLeft: 'leftBracket',
  BracketRight: 'rightBracket',
  Backslash: 'backslash',
  Semicolon: 'semicolon',
  Quote: 'quote',
  Comma: 'comma',
  Period: 'period',
  Slash: 'slash',
  Backquote: 'grave',
}

/** The four the host tracks as held state rather than as keystrokes. */
export const MODIFIER_CODES: Record<string, string> = {
  MetaLeft: 'cmd',
  MetaRight: 'cmd',
  ShiftLeft: 'shift',
  ShiftRight: 'shift',
  AltLeft: 'option',
  AltRight: 'option',
  ControlLeft: 'control',
  ControlRight: 'control',
}

/** Returns the host's name for a physical key, or null if it has none. */
export function hostKeyName(code: string): string | null {
  if (NAMED[code]) return NAMED[code]

  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1].toLowerCase()

  const digit = /^Digit(\d)$/.exec(code)
  if (digit) return digit[1]

  const numpad = /^Numpad(\d)$/.exec(code)
  if (numpad) return numpad[1]

  const functionKey = /^F(\d{1,2})$/.exec(code)
  if (functionKey && Number(functionKey[1]) <= 12) return `f${functionKey[1]}`

  return null
}

/** The modifier set a keyboard event is carrying, in the host's spelling. */
export function modifiersFrom(event: KeyboardEvent): string[] {
  const held: string[] = []
  if (event.metaKey) held.push('cmd')
  if (event.shiftKey) held.push('shift')
  if (event.altKey) held.push('option')
  if (event.ctrlKey) held.push('control')
  return held
}

/**
 * Whether this keystroke is being typed into the browser rather than at the Mac.
 *
 * The hidden field in `KeyboardBar` is the one text box on the page that belongs
 * to the Mac, and it marks itself with `data-mac-keyboard`; every other field —
 * the combo editor, the Claude composer, the address box — keeps its own
 * keystrokes. Both the Mac-forwarding handler and the app's own shortcuts ask
 * this before claiming a key.
 */
export function typedIntoBrowser(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null
  if (!node || typeof node.tagName !== 'string') return false
  if (node.dataset?.['macKeyboard'] === 'true') return false
  return (
    node.tagName === 'INPUT' ||
    node.tagName === 'TEXTAREA' ||
    node.tagName === 'SELECT' ||
    node.isContentEditable
  )
}

/**
 * Keys the browser will not let go of, and what to say about it.
 *
 * Without the Keyboard Lock API — Chromium only, and only in fullscreen —
 * `preventDefault` cannot stop ⌘W closing the tab or ⌘T opening one. There is no
 * workaround, so the honest move is to name them where the user will look, which
 * is what the keyboard banner does with this list.
 */
export const BROWSER_RESERVED = ['⌘W', '⌘T', '⌘N', '⌘Q', '⌘⇧W']

/**
 * Ask for every keystroke, including the reserved ones.
 *
 * Requires fullscreen and is Chromium-only. Returns whether the lock was taken, so
 * the caller can say which of the two keyboard behaviours is in force rather than
 * leaving the user to discover it by losing a tab.
 */
export async function requestKeyboardLock(): Promise<boolean> {
  const keyboard = (navigator as Navigator & { keyboard?: { lock(keys?: string[]): Promise<void> } })
    .keyboard
  if (!keyboard?.lock || !document.fullscreenElement) return false
  try {
    await keyboard.lock()
    return true
  } catch {
    return false
  }
}

export function releaseKeyboardLock(): void {
  const keyboard = (navigator as Navigator & { keyboard?: { unlock(): void } }).keyboard
  try {
    keyboard?.unlock()
  } catch {
    /* nothing was locked */
  }
}
