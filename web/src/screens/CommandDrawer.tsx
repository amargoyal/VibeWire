/**
 * 06 · REMOTE — COMMANDS. Mirrored by ios/VibeWire/Screens/ControlHubView.swift.
 *
 * This replaces the thumb arc, and the reasons are worth keeping.
 *
 * The arc put seven 56px circles on a sweep struck from the bottom-right corner,
 * so nothing was more than one thumb-rotation away. It was the most authored thing
 * in the app and it had three faults that never went away: it only fitted a right
 * thumb, the captions were two-word fragments that had to be learnt rather than
 * read, and — because the sweep reached 330px up the glass — it sat squarely over
 * the Mac's picture, which is the one surface this app exists to show.
 *
 * A drawer fixes all three. It rises from the bottom edge and stops short of the
 * letterbox band, so the picture is never covered. Every action is a labelled tile
 * in a four-column grid, reachable by either hand. And the modifiers, which used
 * to be a tray that only appeared once something was already held, are a permanent
 * section of it — the one state you could not previously reach without the tray.
 *
 * What is unchanged: modifiers latch until released, so a two-hand chord is two
 * one-hand taps, and every trace of held state is violet, because machine
 * conditions never use it.
 */

import { store } from '../app/store'
import {
  Caps,
  Grabber,
  KeyCap,
  MODIFIERS,
  modifierGlyph,
  Tile,
  useSheet,
} from '../design/components'
import { focusKeyboardField } from './KeyboardBar'

interface Command {
  action: string
  glyph: string
  caption: string
  spoken: string
  glyphSize?: string
}

/**
 * Six commands and the modifier group, in the order they are reached for. KEYS and
 * SHOT lead because they are the two that get used in the first minute; LOCK is
 * last of the six because it ends the session.
 */
const COMMANDS: Command[] = [
  { action: 'keys', glyph: '⌨', caption: 'KEYS', spoken: 'Keyboard' },
  { action: 'shot', glyph: '⛶', caption: 'SHOT', spoken: 'Screenshot the Mac' },
  { action: 'copy', glyph: '←', caption: 'COPY', spoken: 'Copy from the Mac', glyphSize: 'var(--fs-13)' },
  { action: 'paste', glyph: '→', caption: 'PASTE', spoken: 'Paste to the Mac', glyphSize: 'var(--fs-13)' },
  { action: 'enter', glyph: '⏎', caption: 'ENTER', spoken: 'Press Return on the Mac' },
  { action: 'lock', glyph: '⏻', caption: 'LOCK', spoken: 'Lock the Mac’s screen' },
]

export function CommandDrawer() {
  const held = store.heldModifiers.value
  const sent = [...held].sort().map(modifierGlyph).join('')

  const sheet = useSheet<HTMLDivElement>(() => (store.showHub.value = false))

  const run = (action: string) => {
    navigator.vibrate?.(6)
    switch (action) {
      case 'keys':
        // Focus first, and synchronously. iOS Safari opens the keyboard only while
        // a gesture is being handled, so doing this after the state change — one
        // render later — focuses a field and shows no keyboard.
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
      default:
        void store.hub(action)
    }
  }

  return (
    <>
      {/* Tapping out closes. The scrim stops short of the picture: it is here to
          catch a tap, not to dim the Mac's screen. */}
      <button
        aria-label="Close the commands"
        data-nopad
        onClick={() => (store.showHub.value = false)}
        style={{
          position: 'fixed',
          inset: 0,
          zIndex: 55,
          background: 'transparent',
          cursor: 'default',
        }}
      />

      <div
        ref={sheet}
        class="drawer"
        data-nopad
        role="dialog"
        aria-modal="true"
        aria-label="Commands"
        style={{
          left: '8px',
          right: '8px',
          padding: '12px 16px calc(16px + var(--safe-bottom))',
          display: 'flex',
          flexDirection: 'column',
          gap: '14px',
        }}
      >
        <Grabber />

        <div class="row">
          <Caps size="var(--fs-9)" tracking="var(--caps-tracking-wide)">
            COMMANDS
          </Caps>
          <span class="spacer" />
          <button
            onClick={() => (store.showHub.value = false)}
            style={{
              minHeight: 'var(--target)',
              paddingInline: '10px',
              marginBlock: '-12px',
              marginInlineEnd: '-10px',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <Caps size="var(--fs-9)" tracking="0.14em" color="var(--ns-accent)">
              HIDE
            </Caps>
          </button>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '6px' }}>
          {COMMANDS.map((command) => (
            <Tile
              key={command.action}
              glyph={command.glyph}
              caption={command.caption}
              glyphSize={command.glyphSize}
              spoken={command.spoken}
              onClick={() => run(command.action)}
            />
          ))}
          {/* The modifier group is not an action; it is a label for the section
              below, and it states how many are down. It spans two columns because
              that caption does not fit in one. */}
          <div
            class="tile tile--accent"
            aria-hidden="true"
            style={{ gridColumn: 'span 2' }}
          >
            <span class="mono" style={{ fontSize: 'var(--fs-16)', color: 'var(--ns-accent)' }}>
              ⌘
            </span>
            <Caps size="var(--fs-8)" tracking="0.1em" color="var(--ns-accent)">
              {held.length ? `MODIFIERS · ${held.length} HELD` : 'MODIFIERS'}
            </Caps>
          </div>
        </div>

        <div class="stack" style={{ gap: '8px', paddingTop: '2px' }}>
          <div class="row">
            <Caps
              size="var(--fs-9)"
              tracking="0.16em"
              color={held.length ? 'var(--ns-accent)' : 'var(--ns-text-tertiary)'}
            >
              {held.length ? 'HELD UNTIL RELEASED' : 'TAP TO LATCH'}
            </Caps>
            <span class="spacer" />
            <Caps size="var(--fs-9)" tracking="0.12em">
              {`SENT: ${sent || '—'}`}
            </Caps>
          </div>

          {/* Four caps that share the row and take whatever the device gives them,
              and a fifth control that undoes the latch. Releasing everything is a
              different kind of act from pressing a key, so it is a wider target
              with a word on it rather than a fifth identical cap. */}
          <div class="row" style={{ gap: '6px' }}>
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
            <button
              class="outlined"
              onClick={() => store.releaseModifiers()}
              disabled={held.length === 0}
              aria-label="Release all modifiers"
              style={{
                flex: '1.3 1 0',
                minHeight: '52px',
                opacity: held.length === 0 ? 0.45 : 1,
              }}
            >
              <Caps size="var(--fs-8)" tracking="0.1em" color="var(--ns-text-secondary)">
                RELEASE
              </Caps>
            </button>
          </div>

          {held.length > 0 ? (
            <p
              class="wrap"
              style={{
                margin: 0,
                fontSize: 'var(--fs-13)',
                lineHeight: 1.45,
                color: 'var(--ns-text-secondary)',
              }}
            >
              Latched keys survive taps, drags and the keyboard. The next touch is a {sent} touch.
            </p>
          ) : null}
        </div>
      </div>
    </>
  )
}
