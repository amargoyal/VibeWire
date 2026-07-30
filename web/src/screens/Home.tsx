/**
 * 02A–02D · HOME · the condition report.
 * Ported from ios/VibeWire/Screens/HomeView.swift.
 *
 * Answers three questions before the hand moves — is it awake, is the link good
 * enough, which displays exist — then offers one 76px way in. The three unhappy
 * states are designed with the same care as the happy one, because those are the
 * ones that waste the two minutes.
 */

import { useEffect, useState } from 'preact/hooks'

import { resolutionLabel, store, type DisplayEntry } from '../app/store'
import {
  Caps,
  ConditionDot,
  conditionColor,
  DashedRule,
  Panel,
  PrimaryAction,
  Readout,
  ScreenBody,
  ScreenHeader,
  SecondaryAction,
  SignalBars,
  Sparkline,
} from '../design/components'
import { parseEndpoint } from '../net/endpoint'

type Posture = 'awake' | 'weak' | 'asleep' | 'connecting' | 'unreachable'

export function Home() {
  const [retryCountdown, setRetryCountdown] = useState(22)

  const connection = store.connection.value
  const link = store.link.value
  const condition = store.condition.value

  const posture: Posture = (() => {
    switch (connection.kind) {
      case 'failed':
      case 'idle':
      case 'unauthorized':
      case 'reconnecting':
        return 'unreachable'
      case 'connecting':
        // Connecting used to report `asleep`, which showed a "Wake it" button for
        // a Mac that was fine and merely being dialled — and, the other way round,
        // a genuinely asleep Mac got a card reading "CONNECTING · WAITING FOR THE
        // FIRST HEARTBEAT".
        return 'connecting'
      case 'connected':
        if (!link.awake) return 'asleep'
        return condition === 'degraded' ? 'weak' : 'awake'
    }
  })()

  // The countdown only exists on the unreachable screen. Driven off the store's
  // one-second tick so this screen does not add a timer of its own — and reset
  // rather than counted down anywhere else, because rebuilding the condition card,
  // the display list and the footer once a second to write the number 22 over the
  // number 22 is the redraw this app already removed once.
  const seconds = store.tick.value
  useEffect(() => {
    if (posture !== 'unreachable') {
      if (retryCountdown !== 22) setRetryCountdown(22)
      return
    }
    const next = retryCountdown - 1
    if (next <= 0) {
      setRetryCountdown(22)
      store.retry()
    } else {
      setRetryCountdown(next)
    }
  }, [seconds, posture])

  return (
    <ScreenBody scrolls>
      <ScreenHeader onMenu={() => (store.presented.value = 'settings')} />

      <MachineTitle posture={posture} />

      <div style={{ marginTop: '24px' }}>
        <ConditionCard posture={posture} />
      </div>

      {posture === 'unreachable' ? (
        <>
          <Caps size="var(--fs-10)" tracking="0.2em" style={{ marginTop: '26px' }}>
            MOST LIKELY, IN ORDER
          </Caps>
          <div style={{ marginTop: '12px' }}>
            <CauseList />
          </div>
        </>
      ) : (
        <>
          <Caps size="var(--fs-10)" tracking="0.2em" style={{ marginTop: '26px' }}>
            DISPLAYS
          </Caps>
          <div style={{ marginTop: '12px' }}>
            <DisplayList posture={posture} />
          </div>
        </>
      )}

      <span class="spacer" style={{ minHeight: '12px' }} />

      <div style={{ paddingBottom: 'calc(20px + var(--safe-bottom))' }}>
        <Footer posture={posture} retryCountdown={retryCountdown} onRetry={() => setRetryCountdown(22)} />
      </div>
    </ScreenBody>
  )
}

/**
 * Names the radio alongside the path. "You are on GUEST-5G" is usually the actual
 * bug, so it is stated rather than implied — and where the browser will not say
 * which radio this is, `UNKNOWN LINK` says that instead of guessing.
 */
function transportLabel(): string {
  const radio = store.linkMonitor.description
  const transport = store.transport.value
  switch (transport.path) {
    case 'direct':
      return `${radio} · DIRECT`
    case 'relay':
      return transport.relayName ? `${radio} · RELAY ${transport.relayName}` : `${radio} · RELAY`
    default:
      return `${radio} · NO PATH`
  }
}

function MachineTitle({ posture }: { posture: Posture }) {
  const link = store.link.value
  return (
    <div class="stack" style={{ gap: '7px', marginTop: '22px' }}>
      <h1
        style={{
          fontSize: 'var(--fs-30)',
          fontWeight: 500,
          margin: 0,
          lineHeight: 1.15,
          color: posture === 'asleep' ? 'var(--lg-text-secondary)' : 'var(--lg-text)',
        }}
      >
        {store.hostName.value}
      </h1>
      {posture === 'awake' ? (
        <Caps size="var(--fs-11)" tracking="0.1em">
          {[store.hostModel.value, `MACOS ${store.hostOS.value}`, transportLabel()]
            .filter(Boolean)
            .join(' · ')}
        </Caps>
      ) : posture === 'weak' ? (
        <span class="row" style={{ gap: '4px' }}>
          <Caps size="var(--fs-11)" tracking="0.1em">
            LINK IS THIN OVER
          </Caps>
          <Caps size="var(--fs-11)" tracking="0.1em" color="var(--lg-amber)">
            {transportLabel()}
          </Caps>
        </span>
      ) : posture === 'asleep' ? (
        <Caps size="var(--fs-11)" tracking="0.1em">
          {`${link.onPower ? 'ON POWER' : 'ON BATTERY'} · DISPLAY OFF`}
        </Caps>
      ) : posture === 'connecting' ? (
        <Caps size="var(--fs-11)" tracking="0.1em">
          {`${link.onPower ? 'ON POWER' : 'ON BATTERY'} · AWAITING HEARTBEAT`}
        </Caps>
      ) : (
        <span class="row" style={{ gap: '4px' }}>
          <Caps size="var(--fs-11)" tracking="0.1em">
            NO PATH TO THE MAC ·
          </Caps>
          <Caps size="var(--fs-11)" tracking="0.1em" color="var(--lg-red)">
            {store.transport.value.tailscaleRunning ? 'TAILSCALE UP' : 'TAILSCALE DOWN'}
          </Caps>
        </span>
      )}
    </div>
  )
}

function ConditionCard({ posture }: { posture: Posture }) {
  switch (posture) {
    case 'awake':
    case 'weak':
      return <LiveCard />
    case 'connecting':
      return <ConnectingCard />
    case 'asleep':
      return <AsleepCard />
    case 'unreachable':
      return <UnreachableCard />
  }
}

function LiveCard() {
  const condition = store.condition.value
  const link = store.link.value
  const degraded = condition === 'degraded'
  const tint = conditionColor[condition]
  const valueColor = degraded ? 'var(--lg-amber)' : 'var(--lg-text)'

  return (
    <Panel tint={tint}>
      <div class="stack" style={{ padding: '18px' }}>
        <div class="row">
          <ConditionDot condition={condition} />
          <Caps size="var(--fs-13)" color={tint} weight={500}>
            {degraded ? 'AWAKE · THIN LINK' : 'AWAKE · REACHABLE'}
          </Caps>
          <span class="spacer" />
          <SignalBars filled={store.signalBars.value} color={tint} />
        </div>

        <div class="row" style={{ gap: '26px', marginTop: '18px', alignItems: 'flex-start' }}>
          <Readout
            label="RTT"
            value={link.rttMillis == null ? null : String(Math.round(link.rttMillis))}
            unit="MS"
            valueColor={valueColor}
          />
          <Readout
            label="LOSS"
            value={link.lossPercent.toFixed(1)}
            unit="%"
            valueColor={valueColor}
          />
          <Readout label="DOWN" value={link.downMbps.toFixed(1)} unit="MB" valueColor={valueColor} />
        </div>

        <div class="row" style={{ marginTop: '16px' }}>
          <Sparkline values={link.rttHistory} color={tint} />
          <Caps size="var(--fs-9)" tracking="0.12em">
            {degraded
              ? `JITTER ${link.jitterMillis == null ? '—' : Math.round(link.jitterMillis)}MS`
              : '60S RTT'}
          </Caps>
        </div>
      </div>
    </Panel>
  )
}

/**
 * 02C. The Mac answered and told us it is asleep, so this states that rather than
 * pretending the socket is still being opened. Dashed rules replace live values;
 * the layout does not move when it wakes — it just fills in.
 */
function AsleepCard() {
  const link = store.link.value
  return (
    <Panel tint="var(--lg-amber)">
      <div class="stack" style={{ padding: '18px' }}>
        <div class="row">
          <ConditionDot condition="idle" />
          <Caps size="var(--fs-13)" color="var(--lg-amber)" weight={500}>
            ASLEEP
          </Caps>
          <span class="spacer" />
          <SignalBars filled={0} color="var(--lg-stroke)" />
        </div>
        <p class="wrap" style={{ fontSize: 'var(--fs-15)', margin: '14px 0 0', lineHeight: 1.45 }}>
          The Mac is reachable but its display is off. Waking it takes a few seconds.
        </p>
        <div style={{ marginTop: '16px' }}>
          <DashedRule />
        </div>
        <Caps size="var(--fs-9)" tracking="0.12em" style={{ marginTop: '12px' }}>
          {link.onPower ? 'ON POWER · WILL ANSWER' : 'ON BATTERY · MAY NOT ANSWER'}
        </Caps>
      </div>
    </Panel>
  )
}

function ConnectingCard() {
  return (
    <Panel>
      <div class="stack" style={{ padding: '18px' }}>
        <div class="row">
          <ConditionDot condition="idle" />
          <Caps size="var(--fs-13)" color="var(--lg-text-secondary)" weight={500}>
            CONNECTING
          </Caps>
          <span class="spacer" />
          <SignalBars filled={0} color="var(--lg-stroke)" />
        </div>
        <div class="row" style={{ gap: '26px', marginTop: '18px', alignItems: 'flex-start' }}>
          <Readout label="RTT" value={null} unit="MS" />
          <Readout label="LOSS" value={null} unit="%" />
          <Readout label="AGENT" value="IDLE" unit="" valueColor="var(--lg-text-secondary)" />
        </div>
        <div style={{ marginTop: '16px' }}>
          <DashedRule />
        </div>
        <Caps size="var(--fs-9)" tracking="0.12em" style={{ marginTop: '12px' }}>
          WAITING FOR THE FIRST HEARTBEAT
        </Caps>
      </div>
    </Panel>
  )
}

/** Both transports listed with their own verdict. A failure with an address, not
 *  one vague "offline". */
function UnreachableCard() {
  const transport = store.transport.value
  const connection = store.connection.value
  const paired = store.pairedHost.value

  const sentence =
    connection.kind === 'reconnecting'
      ? `Tried ${connection.attempt} time${connection.attempt === 1 ? '' : 's'}. Nothing answered.`
      : 'Nothing answered on either path.'

  const lastContact = (() => {
    if (!paired) return 'NEVER'
    const elapsed = (Date.now() - Date.parse(paired.pairedAt)) / 1000
    if (elapsed < 60) return 'JUST NOW'
    if (elapsed < 3600) return `${Math.floor(elapsed / 60)}M AGO`
    return `${Math.floor(elapsed / 3600)}H AGO`
  })()

  return (
    <Panel tint="var(--lg-red)">
      <div class="stack" style={{ padding: '18px' }}>
        <div class="row">
          <span
            aria-hidden="true"
            style={{ width: '8px', height: '8px', background: 'var(--lg-red)', flex: '0 0 auto' }}
          />
          <Caps size="var(--fs-13)" color="var(--lg-red)" weight={500}>
            UNREACHABLE
          </Caps>
        </div>
        <p class="wrap" style={{ fontSize: 'var(--fs-15)', margin: '14px 0 0', lineHeight: 1.45 }}>
          {sentence}
        </p>
        <div class="stack" style={{ gap: '9px', marginTop: '16px' }}>
          <TransportRow
            label={`DIRECT · ${transport.tailscaleAddress ?? paired?.host ?? '—'}`}
            verdict={transport.path === 'direct' ? 'OK' : 'TIMEOUT'}
            ok={transport.path === 'direct'}
          />
          <TransportRow
            label={`RELAY · ${transport.relayName ?? transport.cloudflareHostname ?? 'NOT CONFIGURED'}`}
            verdict={
              transport.path === 'relay' ? 'OK' : transport.cloudflareRunning ? 'NO HOST' : 'OFF'
            }
            ok={transport.path === 'relay'}
          />
          <TransportRow label="LAST CONTACT" verdict={lastContact} ok={null} />
        </div>
      </div>
    </Panel>
  )
}

function TransportRow({
  label,
  verdict,
  ok,
}: {
  label: string
  verdict: string
  ok: boolean | null
}) {
  return (
    <div class="row">
      <Caps size="var(--fs-10)" tracking="0.1em">
        {label}
      </Caps>
      <span class="spacer" style={{ minWidth: '8px' }} />
      <Caps
        size="var(--fs-10)"
        tracking="0.1em"
        color={
          ok === true
            ? 'var(--lg-green)'
            : ok === null
              ? 'var(--lg-text-secondary)'
              : 'var(--lg-red)'
        }
      >
        {verdict}
      </Caps>
    </div>
  )
}

/**
 * A connected, awake Mac reporting no displays is not an empty list — it is almost
 * always Screen Recording permission missing, because that is what
 * ScreenCaptureKit returns nothing without. The host only says so when a stream is
 * actually requested, so until then this screen offered a heading over nothing and
 * a button reading "NO DISPLAY".
 */
function NoDisplays() {
  return (
    <div
      class="stack"
      style={{
        gap: '10px',
        padding: '16px',
        borderRadius: 'var(--radius-medium)',
        background: 'color-mix(in srgb, var(--lg-amber) 5%, transparent)',
        border: '1px solid color-mix(in srgb, var(--lg-amber) 30%, transparent)',
      }}
    >
      <p class="wrap" style={{ margin: 0, fontSize: 'var(--fs-15)', lineHeight: 1.45 }}>
        The Mac answered, but reports no displays.
      </p>
      <p
        class="wrap"
        style={{
          margin: 0,
          fontSize: 'var(--fs-13)',
          color: 'var(--lg-text-secondary)',
          lineHeight: 1.45,
        }}
      >
        Screen Recording permission is the usual cause. On the Mac: System Settings → Privacy &
        Security → Screen Recording → VibeWire.
      </p>
    </div>
  )
}

function DisplayList({ posture }: { posture: Posture }) {
  const displays = store.displays.value
  return (
    <div class="stack" style={{ gap: '8px' }}>
      {displays.length === 0 ? <NoDisplays /> : null}

      {displays.map((display) => (
        <DisplayRow
          key={display.id}
          display={display}
          degraded={posture === 'weak'}
          dimmed={posture === 'asleep'}
          onClick={() => store.selectDisplay(display.id)}
        />
      ))}

      {displays.length > 1 ? (
        <button
          onClick={() => store.selectBothDisplays()}
          disabled={posture === 'weak'}
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: '12px',
            minHeight: '50px',
            paddingInline: '16px',
            borderRadius: 'var(--radius-row)',
            border: `1px dashed ${store.sideBySide.value ? 'var(--lg-cyan)' : 'var(--lg-hairline)'}`,
            opacity: posture === 'weak' ? 0.55 : 1,
          }}
        >
          <span class="row" style={{ gap: '3px' }} aria-hidden="true">
            {[0, 1].map((index) => (
              <span
                key={index}
                style={{
                  width: '15px',
                  height: '20px',
                  borderRadius: 'var(--radius-screen)',
                  border: '1px solid var(--lg-text-tertiary)',
                }}
              />
            ))}
          </span>
          <Caps
            size="var(--fs-11)"
            tracking="0.12em"
            color={posture === 'weak' ? 'var(--lg-text-tertiary)' : 'var(--lg-text-secondary)'}
          >
            {posture === 'weak' ? 'SIDE BY SIDE · NEEDS 3 MB' : 'SIDE BY SIDE · BOTH'}
          </Caps>
        </button>
      ) : null}
    </div>
  )
}

export function DisplayRow({
  display,
  degraded,
  dimmed,
  onClick,
}: {
  display: DisplayEntry
  degraded: boolean
  dimmed: boolean
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      aria-pressed={display.selected}
      aria-label={display.name}
      aria-description={
        dimmed
          ? `Last known ${display.width} by ${display.height}`
          : `${display.width} by ${display.height}`
      }
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '14px',
        minHeight: '62px',
        paddingInline: '16px',
        borderRadius: 'var(--radius-row)',
        textAlign: 'left',
        background: display.selected
          ? 'color-mix(in srgb, var(--lg-cyan) 8%, transparent)'
          : 'var(--lg-panel)',
        border: `1px solid ${display.selected ? 'var(--lg-cyan)' : 'var(--lg-hairline)'}`,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: '34px',
          height: '22px',
          flex: '0 0 auto',
          borderRadius: 'var(--radius-screen)',
          background: display.selected
            ? 'color-mix(in srgb, var(--lg-cyan) 14%, transparent)'
            : 'transparent',
          border: `1px ${dimmed ? 'dashed' : 'solid'} ${
            display.selected ? 'var(--lg-cyan)' : 'var(--lg-text-tertiary)'
          }`,
        }}
      />
      <span class="stack" style={{ gap: '3px', minWidth: 0 }}>
        <span
          class="ellipsis"
          style={{
            fontSize: 'var(--fs-15)',
            color: dimmed ? 'var(--lg-text-tertiary)' : 'var(--lg-text)',
          }}
        >
          {display.name}
        </span>
        <Caps
          size="var(--fs-10)"
          tracking="0.1em"
          color={degraded && display.selected ? 'var(--lg-amber)' : 'var(--lg-text-tertiary)'}
        >
          {degraded && display.selected
            ? 'WILL OPEN AT 540P'
            : dimmed
              ? `LAST KNOWN ${display.width} × ${display.height}`
              : resolutionLabel(display)}
        </Caps>
      </span>
      <span class="spacer" />
      {display.selected ? (
        <Caps size="var(--fs-10)" color="var(--lg-cyan)">
          SELECTED
        </Caps>
      ) : null}
    </button>
  )
}

/** Causes ranked by likelihood rather than alphabetised. */
function CauseList() {
  const transport = store.transport.value
  const rows: [string, string, string][] = [
    ['01', 'The Mac is asleep, or VibeWire is not running on it.', 'var(--lg-red)'],
    [
      '02',
      transport.tailscaleRunning
        ? 'You are off the tailnet, or the Mac dropped off it.'
        : 'Tailscale is not running on the Mac.',
      'var(--lg-amber)',
    ],
    ['03', 'A VPN on the Mac is eating the route.', 'var(--lg-text-tertiary)'],
  ]

  return (
    <ol
      class="stack"
      style={{
        gap: '1px',
        margin: 0,
        padding: 0,
        listStyle: 'none',
        background: 'var(--lg-hairline-dim)',
        border: '1px solid var(--lg-hairline-dim)',
        borderRadius: 'var(--radius-row)',
        overflow: 'hidden',
      }}
    >
      {rows.map(([number, text, color]) => (
        <li
          key={number}
          class="row row--baseline"
          style={{ gap: '12px', padding: '15px 16px', background: 'var(--lg-raised)' }}
        >
          <Caps size="var(--fs-10)" tracking="0" color={color}>
            {number}
          </Caps>
          <span
            class="wrap"
            style={{
              fontSize: 'var(--fs-14)',
              lineHeight: 1.45,
              color:
                color === 'var(--lg-text-tertiary)' ? 'var(--lg-text-secondary)' : 'var(--lg-text)',
            }}
          >
            {text}
          </span>
        </li>
      ))}
    </ol>
  )
}

function Footer({
  posture,
  retryCountdown,
  onRetry,
}: {
  posture: Posture
  retryCountdown: number
  onRetry: () => void
}) {
  const link = store.link.value
  const displays = store.displays.value

  const preflight = (() => {
    const display = displays.find((entry) => entry.selected)
    const name = display ? display.name.toUpperCase() : 'NO DISPLAY'
    const quality = store.settings.value.quality
    const ladder = quality === 'auto' ? 'FIT' : quality.toUpperCase()
    const estimate = link.rttMillis == null ? 800 : Math.round(link.rttMillis * 6 + 120)
    return `${name} · ${ladder} · ~${estimate}MS TO FIRST FRAME`
  })()

  switch (posture) {
    case 'awake':
      return (
        <div class="stack" style={{ gap: '14px' }}>
          <PrimaryAction
            title="View screen"
            detail={preflight}
            glyph="→"
            // Nothing to open, and the card above now says why.
            enabled={displays.length > 0}
            onClick={() => store.startStream()}
          />
          <ClaudeHandle />
        </div>
      )

    case 'weak':
      return (
        <div class="stack" style={{ gap: '14px' }}>
          <p
            class="wrap"
            style={{
              margin: 0,
              padding: '13px 12px',
              fontSize: 'var(--fs-13)',
              lineHeight: 1.45,
              color: 'var(--lg-on-amber-wash)',
              background: 'color-mix(in srgb, var(--lg-amber) 7%, transparent)',
              borderLeft: '2px solid var(--lg-amber)',
            }}
          >
            Text will be soft until the link recovers. Pointer input stays instant — only video is
            throttled.
          </p>
          <PrimaryAction
            title="View screen anyway"
            detail="540P · SOFT TEXT UNTIL IT RECOVERS"
            glyph="→"
            tint="var(--lg-amber)"
            ink="var(--lg-on-amber)"
            onClick={() => store.startStream()}
          />
          <ClaudeHandle />
        </div>
      )

    case 'connecting':
      return (
        <p
          class="wrap"
          style={{
            margin: 0,
            fontSize: 'var(--fs-13)',
            color: 'var(--lg-text-secondary)',
            lineHeight: 1.45,
          }}
        >
          Waiting on the Mac to answer. Nothing is being retried in a loop — the battery is not the
          price of an unanswered question.
        </p>
      )

    case 'asleep':
      return (
        <div class="stack" style={{ gap: '14px' }}>
          <p
            class="wrap"
            style={{
              margin: 0,
              fontSize: 'var(--fs-13)',
              color: 'var(--lg-text-secondary)',
              lineHeight: 1.45,
            }}
          >
            Its display is off. Waking it is a nudge, not a restart — anything you had open stays
            open.
          </p>
          <PrimaryAction
            title="Wake it"
            detail={
              link.canWake
                ? 'NUDGES THE DISPLAY · USUALLY 4S'
                : 'MAC IS ON BATTERY — MAY NOT ANSWER'
            }
            glyph="↑"
            tint="var(--lg-cyan)"
            ink="var(--lg-on-cyan)"
            onClick={() => store.wake()}
          />
        </div>
      )

    case 'unreachable':
      return (
        <div class="stack" style={{ gap: '12px' }}>
          <button
            onClick={() => store.requestLastFrame()}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '12px',
              minHeight: '56px',
              paddingInline: '18px',
              borderRadius: 'var(--radius-medium)',
              background: 'var(--lg-panel)',
              border: '1px solid var(--lg-hairline)',
            }}
          >
            <span
              aria-hidden="true"
              style={{
                width: '30px',
                height: '20px',
                flex: '0 0 auto',
                borderRadius: 'var(--radius-screen)',
                border: '1px solid var(--lg-text-tertiary)',
              }}
            />
            <Caps size="var(--fs-11)" tracking="0.1em" color="var(--lg-text-secondary)">
              SHOW LAST FRAME
            </Caps>
            <span class="spacer" />
            <Caps size="var(--fs-10)" tracking="0">
              {store.lastFrameAgeSeconds.value == null
                ? 'IF ANY'
                : `${Math.floor(store.lastFrameAgeSeconds.value / 3600)}H OLD`}
            </Caps>
          </button>
          <PrimaryAction
            title="Try again"
            detail={`AUTO-RETRY IN ${retryCountdown}S · TAP TO GO NOW`}
            glyph="↻"
            tint="var(--lg-cyan)"
            ink="var(--lg-on-cyan)"
            onClick={() => {
              onRetry()
              store.retry()
            }}
          />
          <MovedAddress />
        </div>
      )
  }
}

/**
 * The Mac moved.
 *
 * Sits under "Try again" because it is the second question to ask, not the first: a
 * Mac that is asleep and a Mac that changed address look identical from here, and
 * retrying is cheaper than typing. But when the address really has changed — and a
 * Cloudflare quick tunnel changes on every host restart — no amount of retrying the
 * old one will work, and the only other way out used to be revoking the pairing.
 *
 * Deliberately not a primary action, and deliberately not automatic: the app does not
 * go looking for a Mac at an address nobody gave it.
 */
function MovedAddress() {
  const [open, setOpen] = useState(false)
  const [address, setAddress] = useState('')
  const [failure, setFailure] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const paired = store.pairedHost.value

  if (!open) {
    return (
      <button
        onClick={() => {
          setAddress(paired?.origin ?? '')
          setOpen(true)
        }}
        style={{ minHeight: 'var(--target)', display: 'flex', alignItems: 'center', gap: '8px' }}
      >
        <Caps size="var(--fs-10)" tracking="0.12em">
          THE MAC MOVED ·
        </Caps>
        <Caps size="var(--fs-10)" tracking="0.12em" color="var(--lg-cyan)">
          CHANGE THE ADDRESS
        </Caps>
      </button>
    )
  }

  const submit = async () => {
    setBusy(true)
    setFailure(null)
    try {
      const endpoint = parseEndpoint(address)
      const problem = await store.repoint(endpoint)
      if (problem) setFailure(problem)
      else setOpen(false)
    } catch (error) {
      setFailure((error as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div class="stack" style={{ gap: '10px' }}>
      <Caps size="var(--fs-10)" tracking="0.12em">
        NEW ADDRESS FOR THIS MAC
      </Caps>
      <p
        class="wrap"
        style={{
          margin: 0,
          fontSize: 'var(--fs-13)',
          lineHeight: 1.45,
          color: 'var(--lg-text-secondary)',
        }}
      >
        The key stays. This is the same Mac at a different address, so there is nothing
        to pair again — no code, no trip to the menu bar.
      </p>
      <input
        value={address}
        placeholder="https://…trycloudflare.com, or 192.168.1.24"
        aria-label="The Mac’s new address"
        spellcheck={false}
        autocapitalize="none"
        autocorrect="off"
        inputMode="url"
        onInput={(event) => setAddress(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') void submit()
        }}
        class="mono"
        style={{
          fontSize: 'var(--fs-13)',
          paddingInline: '12px',
          minHeight: 'var(--target)',
          background: 'var(--lg-panel)',
          border: '1px solid var(--lg-hairline)',
          borderRadius: 'var(--radius-small)',
          color: 'var(--lg-text)',
        }}
      />
      {failure ? (
        <p
          class="wrap"
          role="alert"
          style={{ margin: 0, fontSize: 'var(--fs-13)', color: 'var(--lg-red)', lineHeight: 1.45 }}
        >
          {failure}
        </p>
      ) : null}
      <div class="row" style={{ gap: '9px' }}>
        <SecondaryAction title="CANCEL" onClick={() => setOpen(false)} />
        <SecondaryAction
          title={busy ? 'CHECKING…' : 'USE IT'}
          tint="var(--lg-cyan)"
          border="color-mix(in srgb, var(--lg-cyan) 45%, transparent)"
          onClick={() => {
            if (!busy) void submit()
          }}
        />
      </div>
    </div>
  )
}

function ClaudeHandle() {
  const count = store.sessionCount.value
  return (
    <div class="row">
      <Caps size="var(--fs-10)" tracking="0.12em">
        {count > 0 ? `SESSION ${count} THIS LAUNCH` : 'NO SESSION YET'}
      </Caps>
      <span class="spacer" />
      <button
        onClick={() => {
          store.presented.value = 'claude'
          store.listClaudeSessions()
        }}
        style={{
          minHeight: 'var(--target)',
          paddingInline: '12px',
          display: 'flex',
          alignItems: 'center',
        }}
      >
        <Caps size="var(--fs-10)" tracking="0.12em" color="var(--lg-cyan)">
          CLAUDE ⌃
        </Caps>
      </button>
    </div>
  )
}
