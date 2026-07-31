/**
 * The Nightshift component set.
 *
 * Each of these exists because the same mark appears on more than one screen and
 * must not drift between them. The comments that explain *why* a value is what it
 * is are the part that would otherwise be lost.
 */

import type { ComponentChildren, JSX, RefObject } from 'preact'
import { useEffect, useRef } from 'preact/hooks'

// MARK: - Condition

export type Condition = 'reachable' | 'degraded' | 'lost' | 'idle'

/** One colour per condition, chosen once here so no screen invents its own. */
export const conditionColor: Record<Condition, string> = {
  reachable: 'var(--ns-green)',
  degraded: 'var(--ns-amber)',
  lost: 'var(--ns-red)',
  idle: 'var(--ns-text-secondary)',
}

export const conditionInk: Record<Condition, string> = {
  reachable: 'var(--ns-on-green)',
  degraded: 'var(--ns-on-amber)',
  lost: 'var(--ns-on-red)',
  idle: 'var(--ns-text)',
}

/**
 * Derived from measured values, never from a hand-set flag, so the label and the
 * numbers beside it can never disagree.
 */
export function conditionFrom(
  rttMillis: number | null,
  lossPercent: number,
  awake: boolean,
): Condition {
  if (!awake) return 'idle'
  if (rttMillis == null) return 'lost'
  if (rttMillis > 250 || lossPercent > 3) return 'degraded'
  return 'reachable'
}

// MARK: - Type helpers

interface CapsProps {
  children: ComponentChildren
  size?: string
  color?: string
  tracking?: string
  weight?: number
  class?: string
  title?: string
  style?: JSX.CSSProperties
}

/**
 * All-caps monospace label with the spec's tracking. Used for every readout
 * heading, status line and unit.
 */
export function Caps({
  children,
  size = 'var(--fs-10)',
  color = 'var(--ns-text-tertiary)',
  tracking = 'var(--caps-tracking)',
  weight,
  class: className,
  title,
  style,
}: CapsProps) {
  return (
    <span
      class={className ? `caps ${className}` : 'caps'}
      title={title}
      style={{
        fontSize: size,
        color,
        letterSpacing: tracking,
        fontWeight: weight,
        ...style,
      }}
    >
      {children}
    </span>
  )
}

/**
 * The app's one heading. `level` picks the size; there is no separate typeface,
 * weight or colour decision to make at a call site.
 */
export function Display({
  children,
  level = 38,
  color,
  style,
}: {
  children: ComponentChildren
  level?: 38 | 36 | 30 | 26
  color?: string
  style?: JSX.CSSProperties
}) {
  const modifier = level === 38 ? '' : ` display--${level}`
  return (
    <h1 class={`display${modifier}`} style={{ color, ...style }}>
      {children}
    </h1>
  )
}

/**
 * A measured value with its unit set smaller and dimmer, e.g. `18ms`.
 *
 * Spoken as one reading rather than three fragments. Left to itself a screen
 * reader announces "RTT", "18", "MS" as separate elements, which is three swipes
 * to learn one number.
 *
 * `lead` is the one reading on a card that is the reason to look at it — the RTT
 * on the condition strip. It is set larger than the two beside it, because three
 * numbers at the same size is a table and the eye has to read all of it.
 */
export function Readout({
  label,
  value,
  unit,
  valueColor = 'var(--ns-text)',
  lead = false,
}: {
  label: string
  value: string | null
  unit: string
  valueColor?: string
  lead?: boolean
}) {
  const spokenUnit =
    { MS: 'milliseconds', '%': 'percent', 'MB/S': 'megabits per second' }[
      unit.toUpperCase()
    ] ?? unit
  const spoken =
    value == null ? 'not measured' : unit ? `${value} ${spokenUnit}` : value

  return (
    <div
      class="stack"
      style={{ gap: '4px' }}
      role="group"
      aria-label={label}
      aria-roledescription={spoken}
    >
      <Caps size="var(--fs-8)" tracking="0.18em">
        {label}
      </Caps>
      {value == null ? (
        // A dash, never a zero. An unmeasured value is not the same thing as a
        // measured zero — which makes the dash a reading, so it is legible like
        // one. Dimmer than a real value, never fainter than the label above it.
        <span
          class="mono"
          style={{
            fontSize: lead ? 'var(--fs-26)' : 'var(--fs-19)',
            lineHeight: 1,
            color: 'var(--ns-text-tertiary)',
          }}
          aria-hidden="true"
        >
          —
        </span>
      ) : (
        <span class="row row--baseline" style={{ gap: '2px' }} aria-hidden="true">
          <span
            class="mono"
            style={{
              fontSize: lead ? 'var(--fs-26)' : 'var(--fs-19)',
              lineHeight: lead ? 1 : 1.2,
              letterSpacing: lead ? '-0.03em' : '-0.02em',
              color: valueColor,
            }}
          >
            {value}
          </span>
          <span
            class="mono"
            style={{ fontSize: 'var(--fs-10)', color: 'var(--ns-text-tertiary)' }}
          >
            {unit}
          </span>
        </span>
      )}
      <span class="sr-only">{spoken}</span>
    </div>
  )
}

/** A caption laid over the Mac's picture. Carries its own ground — see .video-chip. */
export function VideoCaption({
  children,
  size = 'var(--fs-9)',
  color = 'var(--ns-text-secondary)',
}: {
  children: ComponentChildren
  size?: string
  color?: string
}) {
  return (
    <Caps class="video-chip" size={size} color={color} tracking="0.1em">
      {children}
    </Caps>
  )
}

// MARK: - Structure

export function Hairline({ color }: { color?: string }) {
  return <div class="hairline" style={color ? { background: color } : undefined} />
}

export function DashedRule() {
  return <div class="dashed-rule" />
}

/** The filled card used for status readouts and grouped content. */
export function Card({
  tint,
  children,
  style,
}: {
  tint?: string
  children: ComponentChildren
  style?: JSX.CSSProperties
}) {
  return (
    <div
      class={tint ? 'card card--tinted' : 'card'}
      style={{ ...(tint ? { '--tint': tint } : {}), ...style } as JSX.CSSProperties}
    >
      {children}
    </div>
  )
}

/**
 * A run of rows that reads as one object.
 *
 * The corner rounding lives in CSS on `:first-child` / `:last-child`, so a row
 * never has to be told where in the list it sits — which is what used to make
 * inserting one at the top a two-file change.
 */
export function Group({
  children,
  style,
}: {
  children: ComponentChildren
  style?: JSX.CSSProperties
}) {
  return (
    <div class="group" style={style}>
      {children}
    </div>
  )
}

/** A section heading over a group or a card. */
export function SectionLabel({
  children,
  style,
}: {
  children: ComponentChildren
  style?: JSX.CSSProperties
}) {
  return (
    <Caps size="var(--fs-9)" tracking="var(--caps-tracking-wide)" style={style}>
      {children}
    </Caps>
  )
}

// MARK: - Indicators

/**
 * The condition dot.
 *
 * A lost condition is drawn square rather than round: colour alone cannot carry
 * "this is the bad one" for a reader who cannot separate red from green, and the
 * shape is the redundant channel that costs nothing.
 *
 * `animated` is suppressed while video is on screen — nothing decorative moves
 * next to a live feed.
 */
export function ConditionDot({
  condition,
  size = 9,
  animated = true,
}: {
  condition: Condition
  size?: number
  animated?: boolean
}) {
  const pulses = animated && condition !== 'idle' && condition !== 'lost'
  const classes = [
    'dot',
    condition === 'lost' ? 'dot--square' : '',
    condition === 'idle' ? 'dot--idle' : '',
    pulses ? 'dot--pulse' : '',
    pulses && condition === 'degraded' ? 'dot--pulse-fast' : '',
  ]
    .filter(Boolean)
    .join(' ')

  return (
    <span
      class={classes}
      // The condition is always spelled out in the label beside this dot —
      // "REACHABLE" — so announcing the dot as well is one more swipe to reach
      // the same fact.
      aria-hidden="true"
      style={{
        width: `${size}px`,
        height: `${size}px`,
        background: condition === 'idle' ? 'transparent' : conditionColor[condition],
      }}
    />
  )
}

/** Four ascending bars. Signal strength, drawn the same way everywhere. */
export function SignalBars({ filled, color }: { filled: number; color: string }) {
  return (
    // Strength is a picture of the condition the card already states, and the RTT
    // and loss readouts carry the numbers behind it.
    <span class="bars" style={{ height: '14px' }} aria-hidden="true">
      {[0, 1, 2, 3].map((index) => (
        <i
          key={index}
          style={{
            height: `${5 + index * 3}px`,
            background: index < filled ? color : 'var(--ns-stroke)',
          }}
        />
      ))}
    </span>
  )
}

/**
 * The 60-second RTT trace. Spiky means jittery, and the most recent five samples
 * are drawn at full strength so "now" is legible.
 */
export function Sparkline({
  values,
  color,
  height = 18,
  grow = false,
}: {
  values: number[]
  color: string
  height?: number
  grow?: boolean
}) {
  const recent = values.slice(-20)
  const peak = Math.max(...values, 1)
  const brightFrom = Math.max(0, recent.length - 5)

  return (
    // Sixty bars is not something to hear one at a time. The trace shows jitter;
    // the RTT readout beside it is the number that matters.
    <span
      class="spark"
      style={{
        color,
        height: `${height}px`,
        ...(grow ? { flex: '1 1 auto' } : {}),
      }}
      aria-hidden="true"
    >
      {recent.map((value, index) => (
        <i
          key={index}
          class={index >= brightFrom ? 'spark--now' : undefined}
          style={{
            height: `${Math.max(5, (value / peak) * height)}px`,
            ...(grow ? { flex: '1 1 0', width: 'auto' } : {}),
          }}
        />
      ))}
    </span>
  )
}

/**
 * The one loop that keeps running under Reduce Motion.
 *
 * A small rotating arc is not a vestibular trigger, and the platform keeps its own
 * progress indicators turning under the setting for the same reason. A frozen
 * spinner would say the host had stopped answering — a claim about the Mac that
 * nothing measured, which is exactly what this app refuses to make.
 */
export function Spinner({
  size = 16,
  color = 'var(--ns-accent)',
}: {
  size?: number
  color?: string
}) {
  return (
    <span
      class="spinner"
      role="progressbar"
      aria-label="Working"
      style={{ width: `${size}px`, height: `${size}px`, color, flex: '0 0 auto' }}
    />
  )
}

export function Caret({ height = 26 }: { height?: number }) {
  return <span class="caret" aria-hidden="true" style={{ height: `${height}px` }} />
}

/**
 * The countdown to the next pairing code, drawn as a sweep rather than as a
 * number that ticks. The number is beside it — this says at a glance whether
 * there is time to finish typing.
 */
export function RotatesIn({
  fraction,
  size = 14,
  background = 'var(--ns-screen)',
}: {
  fraction: number
  size?: number
  background?: string
}) {
  return (
    <span
      class="rotates"
      aria-hidden="true"
      style={
        {
          width: `${size}px`,
          height: `${size}px`,
          '--sweep': `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)}%`,
          '--hole': background,
        } as JSX.CSSProperties
      }
    />
  )
}

// MARK: - Controls

/** The primary action, with its preflight line. */
export function PrimaryAction({
  title,
  detail,
  glyph,
  tint = 'var(--ns-green)',
  ink = 'var(--ns-on-green)',
  enabled = true,
  onClick,
}: {
  title: string
  detail: string
  glyph: string
  tint?: string
  ink?: string
  enabled?: boolean
  onClick: () => void
}) {
  return (
    <button
      class="primary"
      style={{ '--tint': tint, '--ink': ink } as JSX.CSSProperties}
      disabled={!enabled}
      onClick={onClick}
      // The preflight is the cost of the tap, so it is spoken as the value of the
      // control rather than as a second element after it.
      aria-label={title}
      aria-description={detail}
    >
      <span class="stack" style={{ minWidth: 0 }}>
        <span class="primary__title">{title}</span>
        <Caps class="primary__detail ellipsis" size="var(--fs-9)" color="inherit" tracking="0.1em">
          {detail}
        </Caps>
      </span>
      <span class="primary__glyph" aria-hidden="true">
        {glyph}
      </span>
    </button>
  )
}

/** A filled action with no sub-label. */
export function FilledAction({
  title,
  tint = 'var(--ns-accent)',
  ink = 'var(--ns-on-accent)',
  height,
  hint,
  onClick,
}: {
  title: string
  tint?: string
  ink?: string
  height?: number
  hint?: string
  onClick: () => void
}) {
  return (
    <button
      class="filled"
      title={hint}
      onClick={onClick}
      style={
        {
          '--tint': tint,
          '--ink': ink,
          ...(height ? { minHeight: `${height}px` } : {}),
        } as JSX.CSSProperties
      }
    >
      {title}
    </button>
  )
}

/** An outlined action, labelled in caps. 44px minimum. */
export function OutlinedAction({
  title,
  tint = 'var(--ns-text-secondary)',
  edge = 'var(--ns-stroke)',
  height,
  onClick,
}: {
  title: string
  tint?: string
  edge?: string
  height?: number
  onClick: () => void
}) {
  return (
    <button
      class="outlined"
      style={
        {
          '--edge': edge,
          ...(height ? { minHeight: `${height}px` } : {}),
        } as JSX.CSSProperties
      }
      onClick={onClick}
    >
      <Caps size="var(--fs-10)" color={tint}>
        {title}
      </Caps>
    </button>
  )
}

/** The segmented control: MON 1 / MON 2 / BOTH, CHAT / CODE, the quality ladder. */
export function Segmented<T extends string | number>({
  options,
  selection,
  onSelect,
  label,
  onGlass = false,
}: {
  options: { value: T; label: string; badge?: string | null }[]
  selection: T
  onSelect: (value: T) => void
  label: string
  onGlass?: boolean
}) {
  return (
    <div
      class={onGlass ? 'segmented segmented--onGlass' : 'segmented'}
      role="tablist"
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={String(option.value)}
          role="tab"
          // Without this the selected segment sounds exactly like the three beside
          // it, and the control's whole job is to say which one is current.
          aria-selected={selection === option.value}
          onClick={() => onSelect(option.value)}
        >
          <Caps
            size="var(--fs-9)"
            color={
              selection === option.value ? 'var(--ns-accent)' : 'var(--ns-text-tertiary)'
            }
          >
            {option.label}
          </Caps>
          {option.badge ? (
            <span
              class="dot"
              aria-hidden="true"
              style={{ width: '5px', height: '5px', background: option.badge }}
            />
          ) : null}
        </button>
      ))}
    </div>
  )
}

export function Toggle({
  isOn,
  onChange,
  label,
}: {
  isOn: boolean
  onChange: (value: boolean) => void
  label: string
}) {
  return (
    <button
      class="toggle"
      role="switch"
      aria-checked={isOn}
      aria-label={label}
      onClick={() => onChange(!isOn)}
    />
  )
}

/** A key cap. Violet and dotted when held. */
export function KeyCap({
  glyph,
  caption,
  width,
  height = 46,
  isHeld = false,
  fontSize = 'var(--fs-15)',
  onClick,
}: {
  glyph: string
  caption?: string
  width?: number
  height?: number
  isHeld?: boolean
  fontSize?: string
  onClick: () => void
}) {
  return (
    <button
      class={isHeld ? 'cap cap--held' : 'cap'}
      style={{
        minHeight: `${height}px`,
        ...(width ? { width: `${width}px`, flex: '0 0 auto' } : {}),
      }}
      // A modifier symbol read aloud is a coin toss — "⌘" is announced as "place
      // of interest sign". The caption is the word for it.
      aria-label={caption ?? spokenGlyph(glyph)}
      aria-pressed={isHeld}
      title={isHeld ? 'Held. Activate to release.' : undefined}
      onClick={onClick}
    >
      <span class="cap__glyph" style={{ fontSize }}>
        {glyph}
      </span>
      {caption ? (
        <Caps
          size="var(--fs-8)"
          tracking="0.08em"
          color={isHeld ? 'var(--ns-accent)' : 'var(--ns-text-tertiary)'}
        >
          {caption}
        </Caps>
      ) : null}
    </button>
  )
}

/**
 * A tile in the command drawer — a glyph over a caption.
 *
 * This is what replaced the thumb arc. The arc put seven unlabelled circles on a
 * sweep only a right thumb could reach; a tile says what it does in a word and is
 * the same distance from either hand.
 */
export function Tile({
  glyph,
  caption,
  accent = false,
  span = 1,
  glyphSize = 'var(--fs-16)',
  spoken,
  onClick,
}: {
  glyph: string
  caption: string
  accent?: boolean
  span?: number
  glyphSize?: string
  spoken: string
  onClick: () => void
}) {
  return (
    <button
      class={accent ? 'tile tile--accent' : 'tile'}
      aria-label={spoken}
      onClick={onClick}
      style={span > 1 ? { gridColumn: `span ${span}` } : undefined}
    >
      <span
        class="mono"
        aria-hidden="true"
        style={{ fontSize: glyphSize, color: accent ? 'var(--ns-accent)' : 'var(--ns-text)' }}
      >
        {glyph}
      </span>
      <Caps
        size="var(--fs-8)"
        tracking="0.1em"
        color={accent ? 'var(--ns-accent)' : 'var(--ns-text-secondary)'}
      >
        {caption}
      </Caps>
    </button>
  )
}

/** Caps without captions still have to be nameable. */
export function spokenGlyph(glyph: string): string {
  switch (glyph) {
    case '⌘':
      return 'Command'
    case '⇧':
      return 'Shift'
    case '⌥':
      return 'Option'
    case '⌃':
      return 'Control'
    case '←':
      return 'Left arrow'
    case '→':
      return 'Right arrow'
    case '↑':
      return 'Up arrow'
    case '↓':
      return 'Down arrow'
    default:
      return glyph
  }
}

/**
 * "TAP" on glass, "CLICK" with a mouse.
 *
 * The same instrument runs under a thumb and under a trackpad, and a laptop being
 * told to tap is the small wrongness that says a page was written for something
 * else and handed over. Read from the pointer the device reports rather than from
 * a user-agent string, and read at render, because a tablet can gain a trackpad
 * between one screen and the next.
 */
export function tapVerb(): string {
  return matchMedia('(pointer: coarse)').matches ? 'TAP' : 'CLICK'
}

// MARK: - Sheets

/** What a keyboard can land on. Order is document order, which is tab order. */
const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

function focusablesIn(node: HTMLElement): HTMLElement[] {
  return Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (element) => element.getClientRects().length > 0,
  )
}

/**
 * The open sheets, innermost last.
 *
 * Escape belongs to exactly one of them — the combo editor over the keyboard bar
 * closes the editor, not the bar — and without a stack every open sheet would take
 * the same keystroke and the screen would collapse two layers at once.
 */
const sheetStack: Array<{ node: HTMLElement | null; dismiss?: () => void }> = []

/**
 * Makes a `role="dialog"` behave like one.
 *
 * Three things, all of which the browser does for `<dialog>` and for nothing else:
 * Escape closes the topmost sheet (which `SheetDismiss` has always claimed);
 * focus moves into the sheet on open and Tab stays inside it, instead of walking
 * into the screen behind the scrim where a sighted user cannot see where they are;
 * and focus returns to whatever opened the sheet when it closes, so the next Tab
 * carries on from where it was rather than from the top of the document.
 *
 * Focus lands on the sheet itself, never on the first control inside it. Focusing
 * a button draws a ring on it the moment the sheet opens — which reads as an error
 * on a DONE that nobody has touched — and on a destructive sheet it puts Return on
 * the irreversible answer. The dialog takes focus; the first Tab reaches the first
 * control, which is where it should have come from.
 *
 * Returns the ref to put on the dialog element.
 */
export function useSheet<T extends HTMLElement = HTMLDivElement>(
  onDismiss?: () => void,
): RefObject<T> {
  const container = useRef<T | null>(null)
  const dismiss = useRef(onDismiss)
  dismiss.current = onDismiss

  useEffect(() => {
    const node = container.current
    const restoreTo = document.activeElement as HTMLElement | null
    const entry = { node, dismiss: () => dismiss.current?.() }
    sheetStack.push(entry)

    if (node) {
      node.tabIndex = -1
      node.focus({ preventScroll: true })
    }

    const onKey = (event: KeyboardEvent) => {
      if (sheetStack[sheetStack.length - 1] !== entry) return

      if (event.key === 'Escape') {
        if (!dismiss.current) return
        event.preventDefault()
        // Stops the layer underneath — the keyboard bar, a pointer capture — from
        // reading the same press as its own way out.
        event.stopPropagation()
        dismiss.current()
        return
      }

      if (event.key !== 'Tab' || !node) return
      const focusables = focusablesIn(node)
      if (!focusables.length) return
      const first = focusables[0]
      const last = focusables[focusables.length - 1]
      const active = document.activeElement
      const outside = !node.contains(active)
      if (event.shiftKey ? active === first || outside : active === last || outside) {
        event.preventDefault()
        event.stopPropagation()
        ;(event.shiftKey ? last : first).focus()
      }
    }

    window.addEventListener('keydown', onKey, true)
    return () => {
      window.removeEventListener('keydown', onKey, true)
      const index = sheetStack.indexOf(entry)
      if (index >= 0) sheetStack.splice(index, 1)
      // Only if it is still on the page: a revoked device's row is gone by now.
      if (restoreTo?.isConnected) restoreTo.focus()
    }
  }, [])

  return container
}

/**
 * The way out of a sheet.
 *
 * Text Secondary rather than the accent, deliberately: every one of these sheets
 * can also be dismissed with Escape, so this is the second way out, never the
 * primary action on the screen. The accent is not spent on it.
 */
export function SheetDismiss({
  title = 'DONE',
  onClick,
  id,
}: {
  title?: string
  onClick: () => void
  id?: string
}) {
  return (
    <button
      data-testid={id}
      onClick={onClick}
      aria-label={title[0] + title.slice(1).toLowerCase()}
      style={{
        minHeight: 'var(--target)',
        paddingInline: '12px',
        marginInlineEnd: '-12px',
        display: 'flex',
        alignItems: 'center',
        flex: '0 0 auto',
      }}
    >
      <Caps size="var(--fs-10)" color="var(--ns-text-secondary)">
        {title}
      </Caps>
    </button>
  )
}

// MARK: - Screen chrome

/** The wordmark and overflow control at the top of the non-video screens. */
export function ScreenHeader({ onMenu }: { onMenu?: () => void }) {
  return (
    <header class="row" style={{ minHeight: 'var(--target)', flex: '0 0 auto' }}>
      <Caps size="var(--fs-11)" tracking="0.32em" weight={500} color="var(--ns-text-secondary)">
        VibeWire
      </Caps>
      <span class="spacer" />
      {onMenu ? <OverflowButton onClick={onMenu} /> : null}
    </header>
  )
}

/**
 * The three dots that open Settings.
 *
 * Hit testing follows the drawn shapes, not the frame around them. Without a
 * full-size target this is three 3px dots with gaps between them — visually a
 * button, practically unhittable, and it is the only way into Settings and
 * unpairing.
 */
export function OverflowButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      aria-label="Settings"
      data-testid="menu"
      style={{
        width: '40px',
        height: '40px',
        flex: '0 0 auto',
        borderRadius: 'var(--radius-inner)',
        background: 'var(--ns-raised)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '3px',
      }}
    >
      {[0, 1, 2].map((index) => (
        <span
          key={index}
          class="dot"
          aria-hidden="true"
          style={{ width: '3px', height: '3px', background: 'var(--ns-text-secondary)' }}
        />
      ))}
    </button>
  )
}

/**
 * Wraps a screen in the app's ground colour and edge insets.
 *
 * `scrolls` is set on screens that are one fixed column ending in a primary
 * action: at a large text size, or in a short window, the footer holding the only
 * way forward would otherwise leave the screen.
 */
export function ScreenBody({
  children,
  scrolls = false,
  background = 'var(--ns-screen)',
}: {
  children: ComponentChildren
  scrolls?: boolean
  background?: string
}) {
  return (
    <div class={scrolls ? 'screen screen--scrolls' : 'screen'} style={{ background }}>
      <div class="column">{children}</div>
    </div>
  )
}

/** The corner ticks that mark the true edge of the captured pixels. */
export function CornerTicks({ color }: { color: string }) {
  const size = 11
  const corners: [string, string, string][] = [
    ['12px', '12px', `M0 ${size} L0 0 L${size} 0`],
    ['12px', 'auto', `M0 0 L${size} 0 L${size} ${size}`],
    ['auto', '12px', `M0 0 L0 ${size} L${size} ${size}`],
    ['auto', 'auto', `M${size} 0 L${size} ${size} L0 ${size}`],
  ]
  return (
    <div
      aria-hidden="true"
      style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
    >
      {corners.map(([top, left, path], index) => (
        <svg
          key={index}
          width={size}
          height={size}
          viewBox={`0 0 ${size} ${size}`}
          style={{
            position: 'absolute',
            top: top === 'auto' ? undefined : top,
            bottom: top === 'auto' ? '12px' : undefined,
            left: left === 'auto' ? undefined : left,
            right: left === 'auto' ? '12px' : undefined,
          }}
        >
          <path d={path} fill="none" stroke={color} stroke-width="1" />
        </svg>
      ))}
    </div>
  )
}

/** The grabber at the top of a drawer. Not a control — it names the edge. */
export function Grabber() {
  return <span class="grabber" aria-hidden="true" />
}

// MARK: - Timeline

export type TimelineState = 'done' | 'running' | 'failed' | 'pending'

/**
 * The marker on the timeline rail.
 *
 * Four states and four shapes: a green tick, a turning arc, a red cross, a dashed
 * ring. The colour repeats what the shape already said, which is what lets this
 * work in a photograph of a phone held at arm's length.
 */
export function TimelineMark({ state }: { state: TimelineState }) {
  const face =
    state === 'done'
      ? { glyph: '✓', color: 'var(--ns-green)', border: 'solid' }
      : state === 'failed'
        ? { glyph: '✕', color: 'var(--ns-red)', border: 'solid' }
        : { glyph: '', color: 'var(--ns-text-disabled)', border: 'dashed' }

  return (
    // The wrapper is what sits on the rail; the shape inside it is what says
    // which of the four states this is. Keeping the ring and the spinner in the
    // same box is what stops the rail jumping sideways when a call finishes.
    <span
      class="timeline__mark"
      aria-hidden="true"
      style={
        state === 'running'
          ? { background: 'transparent' }
          : { border: `1px ${face.border} ${face.color}`, color: face.color }
      }
    >
      {state === 'running' ? <Spinner size={15} /> : face.glyph}
    </span>
  )
}

// MARK: - Modifiers

export interface ModifierSpec {
  name: string
  glyph: string
  caption: string
}

export const MODIFIERS: ModifierSpec[] = [
  { name: 'control', glyph: '⌃', caption: 'CTRL' },
  { name: 'option', glyph: '⌥', caption: 'OPT' },
  { name: 'shift', glyph: '⇧', caption: 'SHIFT' },
  { name: 'cmd', glyph: '⌘', caption: 'CMD' },
]

export function modifierGlyph(name: string): string {
  return MODIFIERS.find((spec) => spec.name === name)?.glyph ?? ''
}
