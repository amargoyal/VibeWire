/**
 * 04A · HUB OPEN and 04B · MODIFIERS LATCHED.
 * Ported from ios/VibeWire/Screens/ControlHubView.swift.
 *
 * Six things actually reached for, on an arc swept by the right thumb from a single
 * hub. Nothing is more than one thumb-rotation away, nothing sits above the video,
 * and modifiers latch until dismissed so a two-hand chord becomes two one-hand
 * taps.
 */

import { useEffect, useState } from 'preact/hooks'

import { store } from '../app/store'
import { Caps, KeyCap, MODIFIERS, modifierGlyph } from '../design/components'
import { focusKeyboardField } from './KeyboardBar'

interface Spoke {
  action: string
  glyph: string
  caption: string
  x: number
  y: number
  accent: boolean
}

/**
 * The arc traces the path of a thumb pivoting at the base of the palm: 56px targets
 * on a 62px pitch, ending at the two easiest positions. Offsets are from the
 * bottom-right corner.
 *
 * Seven of them now, and the sweep had to grow for it. Six sat on a 245px radius
 * across 77°, which is a 66px pitch. Adding a seventh in the same span drops the
 * pitch to 55px — closer than the buttons are wide, so they would overlap. Extending
 * the span instead runs off the right edge, because the arc already ends pointing
 * straight up. So the radius went to 277px, which holds seven at 62px with 6px of
 * air between them, and reaches 330px from the right edge — inside the narrowest
 * phone this app targets.
 */
const SPOKES: Spoke[] = [
  { action: 'keys', glyph: '⌨', caption: 'KEYS', x: 22, y: 276, accent: false },
  { action: 'shot', glyph: '⛶', caption: 'SHOT', x: 83, y: 264, accent: false },
  { action: 'copy', glyph: 'COPY', caption: '← MAC', x: 140, y: 239, accent: false },
  { action: 'paste', glyph: 'PASTE', caption: '→ MAC', x: 189, y: 202, accent: false },
  { action: 'enter', glyph: '⏎', caption: 'ENTER', x: 229, y: 155, accent: false },
  { action: 'lock', glyph: '⏻', caption: 'LOCK MAC', x: 258, y: 100, accent: false },
  { action: 'mods', glyph: '⌘', caption: 'MODS', x: 274, y: 40, accent: true },
]

/**
 * The arc reads by glyph and a two-word caption — "⛶ SHOT", "⇅ LOCK", "COPY ← MAC".
 * Neither half survives being spoken: the symbols announce as their Unicode names,
 * and the captions are fragments.
 */
const SPOKEN: Record<string, string> = {
  keys: 'Keyboard',
  shot: 'Screenshot the Mac',
  copy: 'Copy from the Mac',
  paste: 'Paste to the Mac',
  enter: 'Press Return on the Mac',
  lock: 'Lock the Mac’s screen',
  mods: 'Modifier keys',
}

export function ControlHub() {
  const [appeared, setAppeared] = useState(false)
  const [showModifiers, setShowModifiers] = useState(false)
  const held = store.heldModifiers.value

  useEffect(() => {
    const frame = requestAnimationFrame(() => setAppeared(true))
    return () => cancelAnimationFrame(frame)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') store.showHub.value = false
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div
      data-nopad
      style={{ position: 'absolute', inset: 0, zIndex: 30 }}
      role="dialog"
      aria-label="Control hub"
    >
      {/* Tapping out closes, as the hint says. */}
      <button
        aria-label="Close the control hub"
        onClick={() => (store.showHub.value = false)}
        style={{ position: 'absolute', inset: 0, background: 'transparent', cursor: 'default' }}
      />

      {/* The radial scrim keeps the arc legible over live video without covering the
          picture with a flat sheet, and the dashed ring traces the sweep. Both are
          larger than the glass on purpose — they read as a corner of something
          bigger. Absolutely positioned so they overflow rather than widening the
          layout, which is what pushed the arc past the edge of the phone when it
          was a stack child. */}
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          right: '-186px',
          bottom: '-186px',
          width: '724px',
          height: '724px',
          borderRadius: '50%',
          background:
            'radial-gradient(circle at bottom right, color-mix(in srgb, var(--lg-deep) 95%, transparent) 40px, transparent 330px)',
          pointerEvents: 'none',
        }}
      />
      <div
        aria-hidden="true"
        style={{
          position: 'absolute',
          right: '-183px',
          bottom: '-167px',
          width: '475px',
          height: '475px',
          borderRadius: '50%',
          border: '1px dashed color-mix(in srgb, var(--lg-cyan) 16%, transparent)',
          pointerEvents: 'none',
        }}
      />

      {SPOKES.map((spoke, index) => (
        <button
          key={spoke.action}
          aria-label={SPOKEN[spoke.action] ?? spoke.caption}
          onClick={() => {
            navigator.vibrate?.(6)
            switch (spoke.action) {
              case 'keys':
                // Focus first, and synchronously. iOS Safari opens the keyboard only
                // while a gesture is being handled, so doing this after the state
                // change — one render later — focuses a field and shows no keyboard,
                // which is what KEYS used to do.
                focusKeyboardField()
                store.showKeyboard.value = true
                store.showHub.value = false
                break
              case 'enter':
                // The one key worth reaching without opening a keyboard: it is what
                // finishes a command in a terminal, and summoning the whole system
                // keyboard to press it once is the long way round.
                store.key('return')
                store.showHub.value = false
                break
              case 'mods':
                // Reveals the latch tray rather than firing an action. Without this
                // the spoke was dead: the tray only showed once something was
                // already held, which is the one state you cannot reach without the
                // tray.
                setShowModifiers((current) => !current)
                break
              default:
                void store.hub(spoke.action)
            }
          }}
          style={{
            position: 'absolute',
            right: `calc(${spoke.x}px + var(--safe-right))`,
            bottom: `calc(${spoke.y}px + var(--safe-bottom))`,
            width: 'var(--hub-button)',
            height: 'var(--hub-button)',
            borderRadius: '50%',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: spoke.glyph.length > 2 ? '2px' : '3px',
            background: spoke.accent
              ? 'color-mix(in srgb, var(--lg-cyan) 14%, transparent)'
              : 'var(--lg-chrome)',
            border: `1px solid ${spoke.accent ? 'var(--lg-cyan)' : 'var(--lg-stroke)'}`,
            // The spokes land in sequence along the thumb arc, which is the one
            // authored moment in the app. Reduce Motion keeps the sequence — the
            // stagger is timing, not movement — and drops the scale, which is the
            // part that travels.
            opacity: appeared ? 1 : 0,
            transform: appeared ? 'none' : 'scale(0.6)',
            transition: `opacity 140ms ease-out ${index * 18}ms, transform 240ms cubic-bezier(0.2, 0.9, 0.3, 1) ${index * 18}ms`,
          }}
        >
          <span
            class="mono"
            aria-hidden="true"
            style={{
              fontSize: spoke.glyph.length > 2 ? 'var(--fs-10)' : 'var(--fs-15)',
              fontWeight: spoke.glyph.length > 2 ? 500 : 400,
              color: spoke.accent ? 'var(--lg-cyan)' : 'var(--lg-text)',
            }}
          >
            {spoke.glyph}
          </span>
          <Caps
            size="var(--fs-9)"
            tracking="0.08em"
            color={spoke.accent ? 'var(--lg-cyan)' : 'var(--lg-text-secondary)'}
          >
            {spoke.caption}
          </Caps>
        </button>
      ))}

      <button
        aria-label="Close the control hub"
        onClick={() => (store.showHub.value = false)}
        style={{
          position: 'absolute',
          right: 'calc(20px + var(--safe-right))',
          bottom: 'calc(34px + var(--safe-bottom))',
          width: 'var(--hub-button)',
          height: 'var(--hub-button)',
          borderRadius: '50%',
          background: 'color-mix(in srgb, var(--lg-cyan) 18%, transparent)',
          border: '1px solid var(--lg-cyan)',
          color: 'var(--lg-cyan)',
        }}
      >
        <span class="mono" style={{ fontSize: 'var(--fs-19)' }}>
          ✕
        </span>
      </button>

      {showModifiers || held.length > 0 ? <ModifierTray held={held} /> : null}

      <Caps
        size="var(--fs-10)"
        tracking="0.12em"
        style={{
          position: 'absolute',
          left: 'calc(20px + var(--safe-left))',
          bottom: 'calc(120px + var(--safe-bottom))',
          lineHeight: 1.8,
          pointerEvents: 'none',
        }}
      >
        {'SWEEP THE THUMB\nTAP OUT TO CLOSE'}
      </Caps>
    </div>
  )
}

/**
 * 04B. Every trace of held state is cyan: the caps, the scroll-lock badge, the
 * cursor halo. Machine conditions never use it, so a glance separates "the Mac is
 * doing something" from "I left something switched on".
 */
function ModifierTray({ held }: { held: string[] }) {
  const sent = [...held].sort().map(modifierGlyph).join('')

  return (
    <div
      class="sheet--bottom"
      style={{
        left: '18px',
        right: '18px',
        bottom: 'calc(128px + var(--safe-bottom))',
        padding: '14px 16px',
        borderRadius: 'var(--radius-large)',
        background: 'color-mix(in srgb, #0D1014 92%, transparent)',
        border: '1px solid color-mix(in srgb, var(--lg-cyan) 28%, transparent)',
      }}
    >
      <div class="row">
        <Caps size="var(--fs-10)" tracking="0.16em" color="var(--lg-cyan)">
          HELD UNTIL RELEASED
        </Caps>
        <span class="spacer" />
        <Caps size="var(--fs-10)" tracking="0.12em">
          {`SENT: ${sent}`}
        </Caps>
      </div>

      {/* Four fixed caps plus a flexible fifth control left that control 27px wide
          on a narrow phone — a two-line label in a target too narrow to read, for
          the one action that undoes a latch. The caps share the row and take
          whatever the device gives them; releasing everything is its own full-width
          row, because it is a different kind of act from pressing a key. */}
      <div class="row" style={{ gap: '8px', marginTop: '12px' }}>
        {MODIFIERS.map((spec) => (
          <KeyCap
            key={spec.name}
            glyph={spec.glyph}
            caption={spec.caption}
            height={52}
            isHeld={held.includes(spec.name)}
            onClick={() => store.toggleModifier(spec.name)}
          />
        ))}
      </div>

      <button
        onClick={() => store.releaseModifiers()}
        style={{
          width: '100%',
          minHeight: 'var(--target)',
          marginTop: '12px',
          borderRadius: 'var(--radius-row)',
          background: 'var(--lg-chrome)',
          border: '1px solid var(--lg-hairline)',
        }}
      >
        <Caps size="var(--fs-10)" color="var(--lg-text-secondary)">
          RELEASE ALL
        </Caps>
      </button>

      <p
        class="wrap"
        style={{
          margin: '12px 0 0',
          fontSize: 'var(--fs-13)',
          color: 'var(--lg-text-secondary)',
          lineHeight: 1.45,
        }}
      >
        Latched keys survive taps, drags and the keyboard. Two lit caps means the next touch is a{' '}
        {sent || '—'} touch.
      </p>
    </div>
  )
}
