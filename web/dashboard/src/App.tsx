import { useEffect } from 'preact/hooks'
import { Caps, Spinner } from '../../src/design/components'
import { Chip } from './parts'
import { duration } from './format'
import { PairSheet } from './PairSheet'
import { Overview } from './panes/Overview'
import { Devices } from './panes/Devices'
import { Displays } from './panes/Displays'
import { ClaudePane } from './panes/ClaudePane'
import { Transport } from './panes/Transport'
import { Log } from './panes/Log'
import { Settings } from './panes/Settings'
import {
  claude,
  facts,
  notice,
  pairOpen,
  pane,
  reachability,
  type PaneId,
} from './store'

const PANES: { id: PaneId; label: string }[] = [
  { id: 'overview', label: 'OVERVIEW' },
  { id: 'devices', label: 'DEVICES' },
  { id: 'displays', label: 'DISPLAYS' },
  { id: 'claude', label: 'CLAUDE' },
  { id: 'transport', label: 'TRANSPORT' },
  { id: 'log', label: 'LOG' },
  { id: 'settings', label: 'SETTINGS' },
]

export function App() {
  const state = facts.value

  // The window can be opened straight onto a pane — the menu's "Pair a device…"
  // does exactly that. A fragment on first load, a call afterwards, because a
  // reload to change pane would throw away the poll cursor and the transcript
  // with it.
  useEffect(() => {
    const target = location.hash.replace('#', '')
    if (target === 'pair') {
      pairOpen.value = true
    } else if (PANES.some((entry) => entry.id === target)) {
      pane.value = target as PaneId
    }
    const show = (name: string) => {
      if (name === 'pair') {
        pairOpen.value = true
        return
      }
      if (PANES.some((entry) => entry.id === name)) pane.value = name as PaneId
    }
    ;(window as unknown as { vibewireShowPane?: (name: string) => void }).vibewireShowPane = show
    return () => {
      delete (window as unknown as { vibewireShowPane?: (name: string) => void }).vibewireShowPane
    }
  }, [])

  // ⌘1…⌘7 for the panes, which is what a window with a sidebar is expected to
  // do on this platform.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (!event.metaKey || event.altKey || event.ctrlKey) return
      const index = Number.parseInt(event.key, 10)
      if (Number.isNaN(index) || index < 1 || index > PANES.length) return
      event.preventDefault()
      pane.value = PANES[index - 1]!.id
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (reachability.value === 'unauthorized') {
    return <Fatal title="This window is not holding a key the host will take">
      The launch key changes every time the host starts. If the host restarted, close this window
      and open it again from the menu bar — that is the only place a current key comes from.
    </Fatal>
  }

  if (!state) {
    return (
      <div class="mac" style={{ display: 'grid', placeItems: 'center' }}>
        <div class="row" style={{ gap: 12 }}>
          <Spinner />
          <Caps size="var(--fs-10)" tracking="var(--caps-tracking-wide)">
            {reachability.value === 'lost' ? 'NO ANSWER FROM THE HOST' : 'ASKING THE HOST'}
          </Caps>
        </div>
      </div>
    )
  }

  const counts: Partial<Record<PaneId, number>> = {
    devices: state.devices.length,
    displays: state.displays.length,
    claude: claude.value.sessions.length,
    log: state.log.entries.length,
  }

  return (
    <div class="mac">
      <header class="mac__bar">
        <span class="mac__wordmark">VIBEWIRE</span>
        <span class="mac__divider" />
        <div class="row" style={{ gap: 10, minWidth: 0 }}>
          <span
            class={`dot${state.host.awake ? ' dot--pulse' : ''}`}
            style={{
              width: 8,
              height: 8,
              background: state.host.awake ? 'var(--ns-green)' : 'var(--ns-amber)',
            }}
          />
          <span
            class="ellipsis"
            style={{ fontSize: 'var(--fs-15)', fontWeight: 600, letterSpacing: '-0.02em' }}
          >
            {state.host.name}
          </span>
          <Caps size="var(--fs-9)" class="ellipsis">
            {`${state.host.model} · MACOS ${state.host.os} · UP ${duration(state.host.uptimeSeconds)}`}
          </Caps>
        </div>
        <span class="spacer" />
        <Chip
          tint={
            reachability.value === 'live' ? 'var(--ns-green)' : 'var(--ns-red)'
          }
          pulse={reachability.value === 'live'}
        >
          {reachability.value === 'live' ? 'SERVING' : 'NO ANSWER'}
          <span style={{ color: 'var(--ns-text-disabled)' }}> · </span>
          <span style={{ color: 'var(--ns-text-secondary)' }}>{`:${state.host.port}`}</span>
          <span style={{ color: 'var(--ns-text-disabled)' }}> · </span>
          <span style={{ color: 'var(--ns-text-secondary)' }}>{state.host.pathWord}</span>
        </Chip>
        <Caps size="var(--fs-9)" color="var(--ns-text-faint)">
          {`HOST ${state.host.version}`}
        </Caps>
      </header>

      {reachability.value === 'lost' && (
        <div class="mac__notice mac__notice--lost">
          THE HOST STOPPED ANSWERING · EVERY READING BELOW IS THE LAST ONE IT GAVE
        </div>
      )}
      {notice.value && (
        <div class="mac__notice mac__notice--warn">
          {notice.value.toUpperCase()}
          <span class="spacer" />
          <button
            type="button"
            onClick={() => {
              notice.value = null
            }}
            style={{ color: 'inherit' }}
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      )}

      <div class="mac__body">
        <nav class="mac__nav" aria-label="Panels">
          <Caps
            size="var(--fs-9)"
            tracking="var(--caps-tracking-wide)"
            color="var(--ns-text-faint)"
            style={{ padding: '0 10px 10px' }}
          >
            PANELS
          </Caps>
          <div class="group">
            {PANES.map((entry) => {
              const current = pane.value === entry.id
              return (
                <button
                  key={entry.id}
                  type="button"
                  class="mac__nav-item"
                  aria-current={current ? 'page' : undefined}
                  onClick={() => {
                    pane.value = entry.id
                  }}
                >
                  <span
                    class="dot"
                    style={{
                      width: 6,
                      height: 6,
                      background: current ? 'var(--ns-accent)' : 'var(--ns-stroke)',
                    }}
                  />
                  <span>{entry.label}</span>
                  <span class="spacer" />
                  <span
                    style={{
                      fontSize: 'var(--fs-9)',
                      color: current ? 'var(--ns-accent)' : 'var(--ns-text-faint)',
                    }}
                  >
                    {counts[entry.id] ?? ''}
                  </span>
                </button>
              )
            })}
          </div>

          <span class="spacer" />

          <Caps
            size="var(--fs-9)"
            tracking="var(--caps-tracking-wide)"
            color="var(--ns-text-faint)"
            style={{ padding: '0 10px 9px' }}
          >
            PERMISSIONS
          </Caps>
          <div class="group">
            {[
              ['SCREEN', state.permissions.screenRecording],
              ['ACCESSIBILITY', state.permissions.accessibility],
            ].map(([label, granted]) => (
              <div
                key={label as string}
                class="row"
                style={{
                  gap: 9,
                  minHeight: 36,
                  paddingInline: 10,
                  background: 'var(--ns-raised)',
                }}
              >
                <span
                  class={`dot${granted ? '' : ' dot--idle'}`}
                  style={{
                    width: 6,
                    height: 6,
                    background: granted ? 'var(--ns-green)' : 'transparent',
                  }}
                />
                <Caps size="var(--fs-9)" color="var(--ns-text-secondary)">
                  {label as string}
                </Caps>
                <span class="spacer" />
                <Caps
                  size="var(--fs-9)"
                  color={granted ? 'var(--ns-green)' : 'var(--ns-amber)'}
                >
                  {granted ? 'GRANTED' : 'MISSING'}
                </Caps>
              </div>
            ))}
          </div>
        </nav>

        <main class="mac__pane">
          {pane.value === 'overview' && <Overview state={state} />}
          {pane.value === 'devices' && <Devices state={state} />}
          {pane.value === 'displays' && <Displays state={state} />}
          {pane.value === 'claude' && <ClaudePane state={state} />}
          {pane.value === 'transport' && <Transport state={state} />}
          {pane.value === 'log' && <Log state={state} />}
          {pane.value === 'settings' && <Settings state={state} />}
        </main>
      </div>

      {pairOpen.value && <PairSheet state={state} />}
    </div>
  )
}

/** The two states where nothing else is worth drawing. */
function Fatal({ title, children }: { title: string; children: string }) {
  return (
    <div class="mac" style={{ display: 'grid', placeItems: 'center', padding: 32 }}>
      <div class="stack" style={{ gap: 12, maxWidth: '34rem' }}>
        <h1 style={{ margin: 0, fontSize: 'var(--fs-26)', letterSpacing: 'var(--title-tracking)' }}>
          {title}
        </h1>
        <p style={{ margin: 0, fontSize: 'var(--fs-15)', lineHeight: 1.5, color: 'var(--ns-text-secondary)' }}>
          {children}
        </p>
      </div>
    </div>
  )
}
