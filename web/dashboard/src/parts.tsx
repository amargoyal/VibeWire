/**
 * The few marks this window needs that the phone never did.
 *
 * Everything else comes from `src/design/components.tsx` unchanged. These are
 * here because a window has a title bar, a sidebar and label-left/value-right
 * detail lists, and a phone has none of those.
 */

import type { ComponentChildren, JSX } from 'preact'
import { Caps } from '../../src/design/components'
import { DASH } from './format'

/**
 * A label-left, value-right line.
 *
 * The dash is applied here rather than by every caller: a value that was not
 * measured must print as one, and centralising it is what stops the fifteenth
 * readout from being the one that prints `0`.
 */
export function Kv({
  label,
  value,
  color = 'var(--ns-text)',
  boxed = false,
  ruled = false,
  labelWidth,
}: {
  label: string
  value: string | null | undefined
  color?: string
  boxed?: boolean
  ruled?: boolean
  labelWidth?: number
}) {
  const missing = value === null || value === undefined || value === ''
  return (
    <div class={`kv${boxed ? ' kv--boxed' : ''}${ruled ? ' kv--ruled' : ''}`}>
      <span class="kv__label" style={labelWidth ? { width: labelWidth, flex: '0 0 auto' } : undefined}>
        {label}
      </span>
      {!labelWidth && <span class="spacer" />}
      <span
        class="ellipsis"
        style={{ color: missing ? 'var(--ns-text-tertiary)' : color }}
      >
        {missing ? DASH : value}
      </span>
    </div>
  )
}

/** A dot and a word, on a ground the palette was measured against. */
export function Chip({
  tint,
  children,
  dot = true,
  pulse = false,
}: {
  tint: string
  children: ComponentChildren
  dot?: boolean
  pulse?: boolean
}) {
  return (
    <span
      class="row"
      style={{
        gap: 9,
        height: 30,
        paddingInline: 13,
        borderRadius: 'var(--radius-control)',
        background: 'var(--ns-raised)',
        flex: '0 0 auto',
      }}
    >
      {dot && (
        <span
          class={`dot${pulse ? ' dot--pulse' : ''}`}
          style={{ width: 7, height: 7, background: tint }}
        />
      )}
      <Caps size="var(--fs-9)" color={tint}>
        {children}
      </Caps>
    </span>
  )
}

/** The heading of a pane: a title, and the sentence that qualifies it. */
export function PaneHeading({
  title,
  caption,
  children,
}: {
  title: string
  caption: string
  children?: ComponentChildren
}) {
  return (
    <div class="row" style={{ alignItems: 'flex-end', gap: 16, flex: '0 0 auto' }}>
      <div class="stack" style={{ gap: 6, minWidth: 0 }}>
        <h2
          style={{
            margin: 0,
            fontSize: 'var(--fs-26)',
            fontWeight: 600,
            letterSpacing: 'var(--title-tracking)',
          }}
        >
          {title}
        </h2>
        <Caps size="var(--fs-9)">{caption}</Caps>
      </div>
      <span class="spacer" />
      {children}
    </div>
  )
}

/** A dashed rule with a label at each end — the section divider on every pane. */
export function RuledLabel({
  children,
  trailing,
}: {
  children: ComponentChildren
  trailing?: ComponentChildren
}) {
  return (
    <div class="row" style={{ gap: 10, flex: '0 0 auto' }}>
      <Caps size="var(--fs-9)" tracking="var(--caps-tracking-wide)" color="var(--ns-text-faint)">
        {children}
      </Caps>
      <span class="dashed-rule spacer" />
      {trailing}
    </div>
  )
}

/**
 * The countdown dial.
 *
 * A conic gradient repainted by the poll rather than an animation, so there is
 * nothing perpetual running behind a window nobody is looking at and nothing for
 * Reduce Motion to freeze.
 */
export function Dial({ fraction, tint }: { fraction: number; tint: string }) {
  const sweep = `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%`
  return (
    <span
      class="dial"
      style={{
        background: `conic-gradient(${tint} 0 ${sweep}, var(--ns-raised-2) ${sweep} 100%)`,
      }}
    />
  )
}

/** A button that is a whole row, with the hover a pointer expects. */
export function RowButton({
  onClick,
  selected = false,
  children,
  style,
  title,
}: {
  onClick: () => void
  selected?: boolean
  children: ComponentChildren
  style?: JSX.CSSProperties
  title?: string
}) {
  return (
    <button
      type="button"
      title={title}
      onClick={onClick}
      class={`group-row hoverable${selected ? ' group-row--selected' : ''}`}
      style={style}
    >
      {children}
    </button>
  )
}
