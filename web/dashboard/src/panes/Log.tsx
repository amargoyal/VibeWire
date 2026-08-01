import { Caps, Group } from '../../../src/design/components'
import { PaneHeading } from '../parts'
import { duration } from '../format'
import { logFilter, type Facts } from '../store'
import { levelInk } from './Overview'

/**
 * 05 · LOG.
 *
 * Everything the host said about itself since launch, from the same funnel that
 * writes the unified log and stderr — so a line here is a line that was really
 * emitted, in the area it was really emitted under.
 *
 * The filters are `Log.Area`'s own six cases and not a taxonomy invented for
 * this pane. Inventing one would mean deciding, per line, which of two names it
 * files under, and the first ambiguous line would be filed under both or
 * neither.
 *
 * Nothing is persisted, and the caption says so. A log that silently begins at
 * the last launch reads like a Mac that has done nothing for six days.
 */
export function Log({ state }: { state: Facts }) {
  const filter = logFilter.value
  const rows =
    filter === 'all' ? state.log.entries : state.log.entries.filter((entry) => entry.area === filter)

  return (
    <div class="pane" data-screen-label="Log" style={{ overflow: 'hidden' }}>
      <PaneHeading
        title="Event log"
        caption={`SINCE LAUNCH · ${duration(state.host.uptimeSeconds)} · NOT PERSISTED${
          state.log.dropped > 0 ? ` · ${state.log.dropped} OLDER LINES DROPPED` : ''
        }`}
      >
        <div class="row" style={{ gap: 6, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          {['all', ...state.log.areas].map((area) => {
            const active = filter === area
            const count =
              area === 'all'
                ? state.log.entries.length
                : state.log.entries.filter((entry) => entry.area === area).length
            return (
              <button
                key={area}
                type="button"
                aria-pressed={active}
                onClick={() => {
                  logFilter.value = area
                }}
                class="mono hoverable"
                style={{
                  minHeight: 38,
                  paddingInline: 15,
                  borderRadius: 'var(--radius-pill)',
                  background: active
                    ? 'color-mix(in srgb, var(--ns-accent) 16%, transparent)'
                    : 'var(--ns-raised)',
                  color: active ? 'var(--ns-accent)' : 'var(--ns-text-tertiary)',
                  fontSize: 'var(--fs-9)',
                  letterSpacing: 'var(--caps-tracking)',
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                }}
              >
                {area.toUpperCase()}
                <span style={{ color: active ? 'var(--ns-accent)' : 'var(--ns-text-faint)' }}>
                  {count}
                </span>
              </button>
            )
          })}
        </div>
      </PaneHeading>

      <div style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}>
        <Group>
          {rows.map((entry) => (
            <div
              key={entry.seq}
              class="row mono"
              style={{
                gap: 16,
                minHeight: 42,
                paddingInline: 16,
                background: 'var(--ns-raised)',
                fontSize: 'var(--fs-11)',
              }}
            >
              <span style={{ color: 'var(--ns-text-faint)', flex: '0 0 auto', letterSpacing: '0.06em' }}>
                {entry.at}
              </span>
              <Caps
                size="var(--fs-9)"
                style={{ flex: '0 0 auto', width: 74 }}
                color={levelInk(entry.level)}
              >
                {entry.area}
              </Caps>
              <span class="ellipsis" style={{ color: levelInk(entry.level) }} title={entry.text}>
                {entry.text}
              </span>
            </div>
          ))}
          {rows.length === 0 && (
            <div class="group-row">
              <Caps size="var(--fs-9)">
                {state.log.entries.length === 0
                  ? 'NOTHING SINCE LAUNCH'
                  : `NOTHING UNDER ${filter.toUpperCase()}`}
              </Caps>
            </div>
          )}
        </Group>
      </div>
    </div>
  )
}
