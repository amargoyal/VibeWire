/**
 * 05 · KEYBOARD MODE.
 * Ported from ios/VibeWire/Screens/KeyboardBarView.swift.
 *
 * The system keyboard stays stock — building a custom one would cost the muscle
 * memory and autocorrect the user already has. This adds only what macOS needs and
 * a touch device does not have: two rows above the keyboard, and a banner naming
 * what is being typed into, because typing blind into the wrong window is the
 * expensive mistake here.
 *
 * Two keyboards, one bar. On a touch device the hidden field below owns the system
 * keyboard and its contents are diffed, so autocorrect replacements and emoji all
 * forward correctly. On a machine with a real keyboard there is nothing to summon:
 * `Remote` captures keydown directly and this bar is the modifier row and the combo
 * row, which a physical keyboard still cannot send without the browser eating them.
 */

import { useEffect, useRef, useState } from 'preact/hooks'

import { store } from '../app/store'
import { BROWSER_RESERVED } from '../app/keymap'
import {
  Caps,
  Caret,
  KeyCap,
  MODIFIERS,
  PrimaryAction,
  ScreenBody,
  SectionLabel,
  SheetDismiss,
} from '../design/components'

const DEFAULT_COMBOS: string[][] = [
  ['cmd', 's'],
  ['cmd', 'z'],
  ['cmd', 'shift', 'z'],
  ['cmd', 'k'],
  ['control', 'c'],
]

export function isTouchPrimary(): boolean {
  return matchMedia('(pointer: coarse)').matches
}

/**
 * The field that owns the system keyboard, and why it lives outside the bar.
 *
 * iOS Safari opens the keyboard for a programmatic `focus()` **only while a user
 * gesture is still being handled**. Mounting the field with the bar and focusing it
 * from an effect is one render too late: the gesture is over, the field takes focus,
 * and no keyboard appears. That is exactly what KEYS did.
 *
 * So the field is mounted for the whole session and `focusKeyboardField()` is called
 * synchronously inside the tap handler. Same field, same diffing; the only change is
 * *when* focus happens, which is the whole of the bug.
 */
let fieldElement: HTMLTextAreaElement | null = null

export function focusKeyboardField(): void {
  const field = fieldElement
  if (!field) return
  // `preventScroll` stops iOS yanking the picture around to reveal a 1px field.
  field.focus({ preventScroll: true })
}

export function blurKeyboardField(): void {
  fieldElement?.blur()
}

/**
 * Diffs the field rather than intercepting keystrokes, so autocorrect replacements,
 * dictation and emoji all forward correctly.
 */
export function KeyboardField() {
  const previous = useRef('')

  const forward = (current: string) => {
    const before = previous.current
    if (current.length > before.length && current.startsWith(before)) {
      store.type(current.slice(before.length))
    } else if (current.length < before.length && before.startsWith(current)) {
      for (let index = 0; index < before.length - current.length; index += 1) {
        store.key('delete')
      }
    } else if (current !== before) {
      // An autocorrect replacement: erase what was there and retype.
      for (let index = 0; index < before.length; index += 1) store.key('delete')
      store.type(current)
    }

    // Keep the buffer short so the diff stays cheap over a long session.
    if (current.length > 200) {
      const trimmed = current.slice(-40)
      previous.current = trimmed
      if (fieldElement) fieldElement.value = trimmed
    } else {
      previous.current = current
    }
  }

  return (
    <textarea
      ref={(node) => {
        fieldElement = node
      }}
      aria-label="Type into the Mac"
      rows={1}
      autocapitalize="sentences"
      autocomplete="off"
      spellcheck={false}
      onInput={(event) => forward(event.currentTarget.value)}
      onKeyDown={(event) => {
        if (event.key !== 'Enter') return
        event.preventDefault()
        store.key('return')
      }}
      // Present but invisible. Off-screen would stop iOS treating it as focusable at
      // all; 1px and all but transparent keeps it real without being seen.
      style={{
        position: 'fixed',
        bottom: 0,
        left: 0,
        width: '1px',
        height: '1px',
        opacity: 0.001,
        padding: 0,
        border: 0,
        resize: 'none',
        zIndex: 0,
      }}
    />
  )
}

export function KeyboardBar() {
  const [combos, setCombos] = useState(DEFAULT_COMBOS)
  const [showEditor, setShowEditor] = useState(false)
  const touch = isTouchPrimary()

  // A second chance at focus, for the paths that reach here without a tap — a
  // restored session, or the bar being reopened by state rather than by a finger.
  // The tap handlers focus synchronously because iOS demands it; this covers the
  // rest without being the thing relied on.
  useEffect(() => {
    if (touch) focusKeyboardField()
  }, [touch])

  return (
    <div
      class="stack sheet--bottom"
      data-nopad
      style={{
        position: 'fixed',
        inset: 'auto 0 0 0',
        zIndex: 60,
        background: 'color-mix(in srgb, var(--ns-deep) 96%, transparent)',
        paddingBottom: 'calc(8px + var(--safe-bottom))',
        animation: 'ns-rise var(--state-change) ease-out',
      }}
    >
      <div style={{ padding: '0 10px 8px' }}>
        <TypingIntoBanner
          onClose={() => {
            store.showKeyboard.value = false
            store.releaseModifiers()
          }}
        />
      </div>

      <div class="stack" style={{ gap: '5px', paddingInline: '8px' }}>
        {/* Row one: hardware a touch device lacks. Arrows stay a single grouped cap
            so the shape is findable by feel — a flat row of four identical keys
            never is. */}
        <div class="row" style={{ gap: '5px' }}>
          <TextKey label="esc" code="escape" />
          <TextKey label="tab" code="tab" />
          {MODIFIERS.map((spec) => (
            <KeyCap
              key={spec.name}
              glyph={spec.glyph}
              width={44}
              height={46}
              fontSize="var(--fs-14)"
              isHeld={store.heldModifiers.value.includes(spec.name)}
              onClick={() => store.toggleModifier(spec.name)}
            />
          ))}
          <ArrowCluster />
        </div>

        {/* Row two: the combos actually sent, editable. Nothing scrolls
            horizontally — hidden keys are keys that will not be used. */}
        <div class="row" style={{ gap: '5px' }}>
          {combos.map((combo, index) => (
            <button
              key={index}
              onClick={() => {
                store.combo(combo)
                navigator.vibrate?.(6)
              }}
              aria-label={spokenCombo(combo)}
              style={{
                flex: '1 1 0',
                minWidth: 0,
                height: '44px',
                borderRadius: 'var(--radius-inner)',
                background: 'var(--ns-raised)',
              }}
            >
              <span class="mono" style={{ fontSize: 'var(--fs-12)' }}>
                {comboLabel(combo)}
              </span>
            </button>
          ))}
          <button
            onClick={() => setShowEditor(true)}
            aria-label="Add a key combination"
            style={{
              flex: '0.6 1 0',
              minWidth: 0,
              height: '44px',
              borderRadius: 'var(--radius-inner)',
              border: '1px dashed var(--ns-stroke)',
              color: 'var(--ns-text-tertiary)',
            }}
          >
            <span class="mono" style={{ fontSize: 'var(--fs-12)' }}>
              ＋
            </span>
          </button>
        </div>
      </div>

      {touch ? (
        // Tapping the bar's own ground brings the system keyboard back after it has
        // been dismissed by a swipe, which otherwise leaves the two rows on screen
        // with nothing to type into and no way to say so.
        <button
          onClick={() => focusKeyboardField()}
          style={{ paddingInline: '18px', marginTop: '8px', minHeight: '32px', width: '100%' }}
        >
          <Caps size="var(--fs-9)" tracking="0.12em">
            TAP HERE IF THE KEYBOARD HAS GONE
          </Caps>
        </button>
      ) : (
        <Caps
          size="var(--fs-9)"
          tracking="0.12em"
          color="var(--ns-text-faint)"
          style={{ paddingInline: '18px', marginTop: '10px', lineHeight: 1.7 }}
        >
          {`THIS KEYBOARD GOES STRAIGHT TO THE MAC · ${BROWSER_RESERVED.join(' ')} STAY WITH THE BROWSER`}
        </Caps>
      )}

      {showEditor ? (
        <ComboEditor
          onAdd={(combo) => {
            setCombos((current) => [...current, combo])
            setShowEditor(false)
          }}
          onClose={() => setShowEditor(false)}
        />
      ) : null}
    </div>
  )
}

/** What is being typed into, named. */
function TypingIntoBanner({ onClose }: { onClose: () => void }) {
  const app = store.link.value.frontmostApp
  const display = store.selectedDisplay.value

  return (
    <div
      class="row"
      // Typing blind into the wrong window is the expensive mistake here, so the
      // banner is one announcement rather than four fragments.
      role="status"
      aria-label={`Typing into ${app || 'an unknown window'}`}
      style={{
        gap: '11px',
        height: '50px',
        paddingLeft: '14px',
        borderRadius: 'var(--radius-control)',
        background: 'color-mix(in srgb, var(--ns-accent) 10%, transparent)',
        outline: '1px solid color-mix(in srgb, var(--ns-accent) 30%, transparent)',
        outlineOffset: '-1px',
      }}
    >
      <Caret height={18} />
      <Caps size="var(--fs-9)" tracking="0.14em" color="var(--ns-accent)">
        TYPING INTO
      </Caps>
      <span
        class="ellipsis"
        style={{ fontSize: 'var(--fs-14)', fontWeight: 500, letterSpacing: '-0.01em' }}
      >
        {app || 'Unknown window'}
      </span>
      <span class="spacer" />
      <Caps size="var(--fs-9)" tracking="0.12em">
        {display ? display.name.toUpperCase() : ''}
      </Caps>
      <button
        onClick={onClose}
        aria-label="Close the keyboard"
        style={{
          width: 'var(--target)',
          height: 'var(--target)',
          flex: '0 0 auto',
          color: 'var(--ns-text-secondary)',
        }}
      >
        <span class="mono" style={{ fontSize: 'var(--fs-13)' }}>
          ✕
        </span>
      </button>
    </div>
  )
}

function TextKey({ label, code }: { label: string; code: string }) {
  return (
    <button
      onClick={() => store.key(code)}
      aria-label={label}
      style={{
        height: '46px',
        paddingInline: '13px',
        flex: '0 0 auto',
        borderRadius: 'var(--radius-inner)',
        background: 'var(--ns-chrome-2)',
      }}
    >
      <span class="mono" style={{ fontSize: 'var(--fs-11)', letterSpacing: '0.06em' }}>
        {label}
      </span>
    </button>
  )
}

function ArrowCluster() {
  return (
    <div
      class="row"
      style={{
        gap: 0,
        flex: '1 1 auto',
        minWidth: 0,
        height: '46px',
        borderRadius: 'var(--radius-inner)',
        background: 'var(--ns-chrome)',
        justifyContent: 'center',
      }}
    >
      <ArrowKey glyph="←" code="arrowLeft" name="Left arrow" height={34} />
      <span style={{ width: '1px', height: '30px', background: 'var(--ns-stroke)' }} />
      <div class="stack" style={{ width: '26px' }}>
        <ArrowKey glyph="↑" code="arrowUp" name="Up arrow" height={23} size="var(--fs-10)" />
        <ArrowKey glyph="↓" code="arrowDown" name="Down arrow" height={23} size="var(--fs-10)" />
      </div>
      <span style={{ width: '1px', height: '30px', background: 'var(--ns-stroke)' }} />
      <ArrowKey glyph="→" code="arrowRight" name="Right arrow" height={34} />
    </div>
  )
}

function ArrowKey({
  glyph,
  code,
  name,
  height,
  size = 'var(--fs-12)',
}: {
  glyph: string
  code: string
  name: string
  height: number
  size?: string
}) {
  return (
    <button
      onClick={() => store.key(code)}
      aria-label={name}
      // An arrow glyph is mostly empty space, and these keys have no fill behind
      // them, so only the strokes would be hittable without a full-box target.
      style={{
        width: '26px',
        height: `${height}px`,
        flex: '0 0 auto',
        color: 'var(--ns-text-secondary)',
      }}
    >
      <span class="mono" style={{ fontSize: size }}>
        {glyph}
      </span>
    </button>
  )
}

function comboLabel(combo: string[]): string {
  return combo
    .map((part) => MODIFIERS.find((spec) => spec.name === part)?.glyph ?? part.toUpperCase())
    .join('')
}

/** "⌘⇧Z" is four symbols run together with no spaces — a screen reader reads it as
 *  a stream of punctuation names. Spoken, it is "Command Shift Z". */
function spokenCombo(combo: string[]): string {
  const names: Record<string, string> = {
    cmd: 'Command',
    shift: 'Shift',
    option: 'Option',
    control: 'Control',
  }
  return combo.map((part) => names[part] ?? part.toUpperCase()).join(' ')
}

function ComboEditor({
  onAdd,
  onClose,
}: {
  onAdd: (combo: string[]) => void
  onClose: () => void
}) {
  const [selected, setSelected] = useState<string[]>(['cmd'])
  const [letter, setLetter] = useState('')

  return (
    <div class="sheet" role="dialog" aria-label="New combo">
      <ScreenBody scrolls>
        <div class="row" style={{ minHeight: '40px', marginTop: '16px' }}>
          <SectionLabel>NEW COMBO</SectionLabel>
          <span class="spacer" />
          <SheetDismiss title="CLOSE" onClick={onClose} />
        </div>

        <div class="row" style={{ gap: '8px', marginTop: '20px' }}>
          {MODIFIERS.map((spec) => (
            <KeyCap
              key={spec.name}
              glyph={spec.glyph}
              caption={spec.caption}
              height={52}
              isHeld={selected.includes(spec.name)}
              onClick={() =>
                setSelected((current) =>
                  current.includes(spec.name)
                    ? current.filter((name) => name !== spec.name)
                    : [...current, spec.name],
                )
              }
            />
          ))}
        </div>

        <input
          value={letter}
          placeholder="key"
          aria-label="The key to combine"
          maxLength={12}
          spellcheck={false}
          autocapitalize="none"
          autocorrect="off"
          onInput={(event) => setLetter(event.currentTarget.value)}
          class="mono"
          style={{
            marginTop: '20px',
            height: '52px',
            paddingInline: '14px',
            fontSize: 'var(--fs-15)',
            background: 'var(--ns-raised)',
            borderRadius: 'var(--radius-control)',
          }}
        />

        <span class="spacer" />

        <div style={{ paddingBottom: 'calc(24px + var(--safe-bottom))' }}>
          <PrimaryAction
            title="Add combo"
            detail="APPEARS IN ROW TWO"
            glyph="＋"
            tint="var(--ns-accent)"
            ink="var(--ns-on-accent)"
            enabled={letter.trim().length > 0 && selected.length > 0}
            onClick={() => onAdd([...[...selected].sort(), letter.trim().toLowerCase()])}
          />
        </div>
      </ScreenBody>
    </div>
  )
}
