/**
 * The Longarm component set, ported from ios/VibeWire/Design/Components.swift.
 *
 * Each of these exists because the same mark appears on more than one screen and
 * must not drift between them. The comments that explain *why* a value is what
 * it is are carried over verbatim from the phone, because the reason is the part
 * that would otherwise be lost.
 */

import type { ComponentChildren, JSX } from 'preact'

// MARK: - Condition

export type Condition = 'reachable' | 'degraded' | 'lost' | 'idle'

/** One colour per condition, chosen once here so no screen invents its own. */
export const conditionColor: Record<Condition, string> = {
  reachable: 'var(--lg-green)',
  degraded: 'var(--lg-amber)',
  lost: 'var(--lg-red)',
  idle: 'var(--lg-text-secondary)',
}

export const conditionInk: Record<Condition, string> = {
  reachable: 'var(--lg-on-green)',
  degraded: 'var(--lg-on-amber)',
  lost: 'var(--lg-on-red)',
  idle: 'var(--lg-text)',
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
  color = 'var(--lg-text-tertiary)',
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
 * A measured value with its unit set smaller and dimmer, e.g. `18ms`.
 *
 * Spoken as one reading rather than three fragments. Left to itself a screen
 * reader announces "RTT", "18", "MS" as separate elements, which is three swipes
 * to learn one number.
 */
export function Readout({
  label,
  value,
  unit,
  valueColor = 'var(--lg-text)',
}: {
  label: string
  value: string | null
  unit: string
  valueColor?: string
}) {
  const spokenUnit =
    { MS: 'milliseconds', '%': 'percent', MB: 'megabits per second' }[
      unit.toUpperCase()
    ] ?? unit
  const spoken =
    value == null ? 'not measured' : unit ? `${value} ${spokenUnit}` : value

  return (
    <div
      class="stack"
      style={{ gap: '5px' }}
      role="group"
      aria-label={label}
      aria-roledescription={spoken}
    >
      <Caps size="var(--fs-9)">{label}</Caps>
      {value == null ? (
        // A dash, never a zero. An unmeasured value is not the same thing as a
        // measured zero — which makes the dash a reading, so it is legible like
        // one. Dimmer than a real value, never fainter than the label above it.
        <span
          class="mono"
          style={{ fontSize: 'var(--fs-19)', color: 'var(--lg-text-tertiary)' }}
          aria-hidden="true"
        >
          —
        </span>
      ) : (
        <span class="row row--baseline" style={{ gap: '1px' }} aria-hidden="true">
          <span class="mono" style={{ fontSize: 'var(--fs-19)', color: valueColor }}>
            {value}
          </span>
          <span
            class="mono"
            style={{ fontSize: 'var(--fs-11)', color: 'var(--lg-text-tertiary)' }}
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
  color = 'var(--lg-text-secondary)',
}: {
  children: ComponentChildren
  size?: string
  color?: string
}) {
  return (
    <Caps class="video-chip" size={size} color={color}>
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

/** The bordered box used for status cards and grouped rows. */
export function Panel({
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
      class={tint ? 'panel panel--tinted' : 'panel'}
      style={{ ...(tint ? { '--tint': tint } : {}), ...style } as JSX.CSSProperties}
    >
      {children}
    </div>
  )
}

// MARK: - Indicators

/**
 * The pulsing condition dot.
 *
 * `animated` is suppressed while video is on screen — nothing decorative moves
 * next to a live feed.
 */
export function ConditionDot({
  condition,
  size = 8,
  animated = true,
}: {
  condition: Condition
  size?: number
  animated?: boolean
}) {
  const pulses = animated && condition !== 'idle'
  const classes = [
    'dot',
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
      // "AWAKE · REACHABLE" — so announcing the dot as well is one more swipe to
      // reach the same fact.
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
    // Strength is a picture of the condition the card already states, and the
    // RTT and loss readouts carry the numbers behind it.
    <span class="bars" aria-hidden="true">
      {[0, 1, 2, 3].map((index) => (
        <i
          key={index}
          style={{
            height: `${6 + index * 3.4}px`,
            background: index < filled ? color : 'var(--lg-stroke)',
          }}
        />
      ))}
    </span>
  )
}

/**
 * The 60-second RTT trace. Spiky means jittery, and the most recent five samples
 * are drawn brighter so "now" is legible.
 */
export function Sparkline({
  values,
  color,
  height = 22,
}: {
  values: number[]
  color: string
  height?: number
}) {
  const recent = values.slice(-20)
  const peak = Math.max(...values, 1)
  const brightFrom = Math.max(0, recent.length - 5)

  return (
    // Sixty bars is not something to hear one at a time. The trace shows jitter;
    // the RTT readout beside it is the number that matters.
    <span class="spark" style={{ color, height: `${height}px` }} aria-hidden="true">
      {recent.map((value, index) => (
        <i
          key={index}
          class={index >= brightFrom ? 'spark--now' : undefined}
          style={{ height: `${Math.max(6, (value / peak) * height)}px` }}
        />
      ))}
    </span>
  )
}

/**
 * The one loop that keeps running under Reduce Motion.
 *
 * A small rotating arc is not a vestibular trigger, and the platform keeps its
 * own progress indicators turning under the setting for the same reason. A
 * frozen spinner would say the host had stopped answering — a claim about the
 * Mac that nothing measured, which is exactly what this app refuses to make.
 */
export function Spinner({
  size = 18,
  color = 'var(--lg-cyan)',
}: {
  size?: number
  color?: string
}) {
  return (
    <span
      class="lg-spinner"
      role="progressbar"
      aria-label="Working"
      style={{ width: `${size}px`, height: `${size}px`, color }}
    />
  )
}

export function Caret({ height = 26 }: { height?: number }) {
  return <span class="caret" aria-hidden="true" style={{ height: `${height}px` }} />
}

// MARK: - Controls

/** The 76px primary action, with its preflight line. */
export function PrimaryAction({
  title,
  detail,
  glyph,
  tint = 'var(--lg-green)',
  ink = 'var(--lg-on-green)',
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
      // The preflight is the cost of the tap, so it is spoken as the value of
      // the control rather than as a second element after it.
      aria-label={title}
      aria-description={detail}
    >
      <span class="stack" style={{ minWidth: 0 }}>
        <span class="primary__title">{title}</span>
        <Caps class="primary__detail ellipsis" size="var(--fs-10)" color="inherit">
          {detail}
        </Caps>
      </span>
      <span class="primary__glyph" aria-hidden="true">
        {glyph}
      </span>
    </button>
  )
}

/** Bordered secondary action, 44px minimum. */
export function SecondaryAction({
  title,
  tint = 'var(--lg-text-secondary)',
  border = 'var(--lg-hairline)',
  onClick,
}: {
  title: string
  tint?: string
  border?: string
  onClick: () => void
}) {
  return (
    <button class="secondary" style={{ borderColor: border }} onClick={onClick}>
      <Caps size="var(--fs-10)" color={tint}>
        {title}
      </Caps>
    </button>
  )
}

/** The segmented control used for MON 1 / MON 2 / BOTH and CHAT / CODE. */
export function Segmented<T extends string | number>({
  options,
  selection,
  onSelect,
  label,
}: {
  options: { value: T; label: string; badge?: string | null }[]
  selection: T
  onSelect: (value: T) => void
  label: string
}) {
  return (
    <div class="segmented" role="tablist" aria-label={label}>
      {options.map((option) => (
        <button
          key={String(option.value)}
          role="tab"
          // Without this the selected segment sounds exactly like the three
          // beside it, and the control's whole job is to say which one is current.
          aria-selected={selection === option.value}
          onClick={() => onSelect(option.value)}
        >
          <Caps
            size="var(--fs-11)"
            color={
              selection === option.value ? 'var(--lg-cyan)' : 'var(--lg-text-secondary)'
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

/** A key cap. Cyan and dotted when held. */
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
      // A modifier symbol read aloud is a coin toss — "⌘" is announced as
      // "place of interest sign". The caption is the word for it.
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
          size="var(--fs-9)"
          color={isHeld ? 'var(--lg-cyan)' : 'var(--lg-text-tertiary)'}
        >
          {caption}
        </Caps>
      ) : null}
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
        display: 'flex',
        alignItems: 'center',
        flex: '0 0 auto',
      }}
    >
      <Caps size="var(--fs-11)" color="var(--lg-text-secondary)">
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
      <Caps size="var(--fs-12)" tracking="0.34em" weight={500}>
        VibeWire
      </Caps>
      <span class="spacer" />
      {onMenu ? (
        <button
          onClick={onMenu}
          aria-label="Settings"
          data-testid="menu"
          // Hit testing follows the drawn shapes, not the frame around them.
          // Without a full-size target this is three 3px dots with gaps between
          // them — visually a button, practically unhittable, and it is the only
          // way into Settings and unpairing.
          style={{
            width: 'var(--target)',
            height: 'var(--target)',
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
              style={{
                width: '3px',
                height: '3px',
                background: 'var(--lg-text-secondary)',
              }}
            />
          ))}
        </button>
      ) : null}
    </header>
  )
}

/**
 * Wraps a screen in the app's ground colour and edge insets.
 *
 * `scrolls` is set on screens that are one fixed column ending in a primary
 * action: at a large text size, or in a short window, the footer holding the
 * only way forward would otherwise leave the screen.
 */
export function ScreenBody({
  children,
  scrolls = false,
  background = 'var(--lg-screen)',
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
