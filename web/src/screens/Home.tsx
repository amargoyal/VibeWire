/**
 * 03 · HOME — THE CONSOLE, 04 · HOME — UNREACHABLE, and 16 · HOME ON A LAPTOP.
 * Mirrored by ios/VibeWire/Screens/HomeView.swift.
 *
 * Home shows the Mac instead of describing it.
 *
 * The screen used to answer three questions in prose and numbers — is it awake,
 * is the link good enough, which displays exist — and then offer a way in at the
 * bottom. Every one of those answers is still here and still measured, but the
 * last frame the Mac sent is now the largest thing on the screen and is itself the
 * way in, so the numbers shrink to one strip and the displays to one row of chips.
 * The three unhappy states are designed with the same care as the happy one,
 * because those are the ones that waste the two minutes.
 *
 * Past 900px the same content becomes two columns rather than a phone column
 * stranded in the middle of a laptop window: the picture and the way in on the
 * left, the readings on a rail to the right. Grid areas do the rearranging, so
 * nothing is rendered twice and there is no `isDesktop` anywhere in this file.
 */

import { useEffect, useState } from 'preact/hooks'

import { resolutionLabel, store, type DisplayEntry } from '../app/store'
import {
  Caps,
  Card,
  ConditionDot,
  conditionColor,
  CornerTicks,
  DashedRule,
  Display,
  Group,
  OverflowButton,
  PrimaryAction,
  Readout,
  SectionLabel,
  Sparkline,
  tapVerb,
  VideoCaption,
} from '../design/components'
import { parseEndpoint } from '../net/endpoint'
import { VideoSurface } from './VideoSurface'

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
  // rather than counted down anywhere else, because rebuilding the condition
  // strip, the display row and the footer once a second to write the number 22
  // over the number 22 is the redraw this app already removed once.
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
    <div class="wide-shell screen--scrolls">
      <div class="column wide-column" style={{ paddingBottom: 0 }}>
        <TopBar posture={posture} />

        <div class="home">
          <div class="home__title narrow-only">
            <MachineTitle posture={posture} />
          </div>

          <div class="home__hero">
            <Hero posture={posture} />
          </div>

          <div class="home__rail">
            <ConditionStrip posture={posture} />
            {posture === 'unreachable' ? <Causes /> : <Displays posture={posture} />}
            {posture === 'unreachable' ? null : <WhatTheMacIsDoing />}
          </div>

          <div class="home__acts">
            <Footer
              posture={posture}
              retryCountdown={retryCountdown}
              onRetry={() => setRetryCountdown(22)}
            />
          </div>
        </div>
      </div>
    </div>
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

/**
 * The caption under the machine name: what it is, and how this client reaches it.
 *
 * `withTransport` is false where the path is already stated beside it. On the wide
 * header the condition pill carries the radio, the path and the round trip, and
 * this line was repeating the first two of them a hand's width to the left.
 */
function machineLine(
  posture: Posture,
  { withTransport = true }: { withTransport?: boolean } = {},
): { text: string; tone: string } {
  const link = store.link.value
  switch (posture) {
    case 'awake':
      return {
        text: [
          store.hostModel.value,
          `MACOS ${store.hostOS.value}`,
          withTransport ? transportLabel() : '',
        ]
          .filter(Boolean)
          .join(' · '),
        tone: 'var(--ns-text-tertiary)',
      }
    case 'weak':
      return { text: `LINK IS THIN OVER ${transportLabel()}`, tone: 'var(--ns-amber)' }
    case 'asleep':
      return {
        text: `${link.onPower ? 'ON POWER' : 'ON BATTERY'} · DISPLAY OFF`,
        tone: 'var(--ns-text-tertiary)',
      }
    case 'connecting':
      return {
        text: `${link.onPower ? 'ON POWER' : 'ON BATTERY'} · AWAITING HEARTBEAT`,
        tone: 'var(--ns-text-tertiary)',
      }
    case 'unreachable':
      return {
        text: `NO PATH TO THE MAC · ${
          store.transport.value.tailscaleRunning ? 'TAILSCALE UP' : 'TAILSCALE DOWN'
        }`,
        tone: 'var(--ns-red)',
      }
  }
}

function postureCondition(posture: Posture) {
  switch (posture) {
    case 'awake':
      return 'reachable' as const
    case 'weak':
      return 'degraded' as const
    case 'unreachable':
      return 'lost' as const
    default:
      return 'idle' as const
  }
}

/**
 * The wordmark, and — only where there is room for it — the machine itself.
 *
 * On a phone the name is a 36px heading under this bar. On a laptop it moves up
 * into the bar beside the wordmark, with the link condition as a pill on the
 * right, because a 36px machine name above a two-column layout is a title for a
 * page rather than a label for the left-hand picture.
 */
function TopBar({ posture }: { posture: Posture }) {
  const link = store.link.value
  const condition = postureCondition(posture)
  const line = machineLine(posture, { withTransport: false })

  return (
    <header
      class="row"
      style={{ minHeight: '40px', paddingBlock: '10px', gap: '18px', flex: '0 0 auto' }}
    >
      <Caps size="var(--fs-11)" tracking="0.32em" weight={500} color="var(--ns-text-secondary)">
        VibeWire
      </Caps>

      <span
        class="wide-only"
        aria-hidden="true"
        style={{ width: '1px', height: '20px', background: 'var(--ns-hairline)', flex: '0 0 auto' }}
      />
      <span class="wide-only row" style={{ gap: '10px', minWidth: 0 }}>
        <ConditionDot condition={condition} size={8} />
        <span
          style={{ fontSize: 'var(--fs-19)', fontWeight: 600, letterSpacing: '-0.02em' }}
          class="ellipsis"
        >
          {store.hostName.value}
        </span>
        <Caps size="var(--fs-10)" tracking="0.1em" class="ellipsis" color={line.tone}>
          {line.text}
        </Caps>
      </span>

      <span class="spacer" />

      <span
        class="wide-only pill"
        style={{
          background: `color-mix(in srgb, ${conditionColor[condition]} 12%, transparent)`,
          minHeight: '36px',
          flex: '0 0 auto',
        }}
      >
        <Caps size="var(--fs-10)" tracking="0.14em" color={conditionColor[condition]}>
          {posture === 'awake' || posture === 'weak'
            ? `${transportLabel()} · ${
                link.rttMillis == null ? '—' : `${Math.round(link.rttMillis)}MS`
              }`
            : postureWord(posture)}
        </Caps>
      </span>

      <OverflowButton onClick={() => (store.presented.value = 'settings')} />
    </header>
  )
}

function postureWord(posture: Posture): string {
  switch (posture) {
    case 'asleep':
      return 'ASLEEP'
    case 'connecting':
      return 'CONNECTING'
    case 'unreachable':
      return 'UNREACHABLE'
    default:
      return 'REACHABLE'
  }
}

function MachineTitle({ posture }: { posture: Posture }) {
  const condition = postureCondition(posture)
  const line = machineLine(posture)

  return (
    <div class="stack" style={{ gap: '7px', paddingBlock: '10px 4px' }}>
      <div class="row" style={{ gap: '10px' }}>
        <ConditionDot condition={condition} />
        <Display
          level={36}
          color={posture === 'asleep' ? 'var(--ns-text-secondary)' : undefined}
          style={{ minWidth: 0 }}
        >
          {store.hostName.value}
        </Display>
      </div>
      <Caps size="var(--fs-10)" tracking="0.1em" color={line.tone} style={{ paddingLeft: '19px' }}>
        {line.text}
      </Caps>
    </div>
  )
}

/**
 * The Mac's screen, at whatever age it is, and the way in.
 *
 * The whole rectangle is the button. A picture of the thing being reached for is a
 * better target than a word for it, and it is the one control on this screen that
 * does not have to be read to be understood. When there is nothing to show it
 * stays a hatched frame with its corner ticks — an empty frame, never a black one,
 * because a black rectangle is a claim about what the Mac is displaying.
 */
function Hero({ posture }: { posture: Posture }) {
  const display = store.selectedDisplay.value
  const renderer = store.selectedRenderer()
  // A renderer having painted is not enough to show its picture here.
  //
  // Until the host answers a `selectDisplay`, an unstreamed display resolves to
  // stream 0 — which is the decoder the *previous* display filled, still holding
  // its last frame. Selecting MON 2 on this screen therefore put MON 1's picture
  // under MON 2's caption: the one lie this screen is built to not tell. So the
  // hero shows a picture only when a `videoConfig` actually maps the selected
  // display to a stream, and otherwise says it has no frame yet.
  const carried = Object.values(store.videoConfigs.value).some(
    (config) => config.displayId === display?.id,
  )
  const painted = carried && renderer.framesRendered > 0
  const age = store.lastFrameAgeSeconds.value
  const lost = posture === 'unreachable'
  const tick = lost ? 'var(--ns-red)' : 'color-mix(in srgb, var(--ns-accent) 70%, transparent)'

  const ageChip = (() => {
    if (age == null) return { text: painted ? 'LAST FRAME' : 'NO FRAME YET', tone: 'var(--ns-text-secondary)' }
    if (age < 60) return { text: `LAST FRAME · ${Math.round(age)}S AGO`, tone: 'var(--ns-green)' }
    if (age < 3600)
      return { text: `LAST FRAME · ${Math.floor(age / 60)}M AGO`, tone: 'var(--ns-text-secondary)' }
    return { text: `${Math.floor(age / 3600)}H OLD · ${tapVerb()} TO OPEN`, tone: 'var(--ns-amber)' }
  })()

  const openable = posture === 'awake' || posture === 'weak'

  return (
    <button
      class="hero"
      // The lost screen keeps a smaller picture: the causes underneath it are what
      // the user came to read, and a full-height frame of three-hour-old pixels
      // pushes them off the screen.
      style={{ minHeight: lost ? '128px' : '226px' }}
      onClick={() => {
        if (openable) store.startStream()
        else store.requestLastFrame()
      }}
      aria-label={
        openable
          ? `View ${display?.name ?? 'the Mac'}’s screen`
          : 'Ask the Mac for its last frame'
      }
    >
      {painted ? (
        <VideoSurface renderer={renderer} aspect={heroAspect(display)} />
      ) : (
        <span
          class="caps"
          aria-hidden="true"
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: 'var(--fs-10)',
            letterSpacing: 'var(--caps-tracking-wide)',
            color: 'var(--ns-text-disabled)',
          }}
        >
          {lost ? 'LAST FRAME' : 'MAC SCREEN'}
        </span>
      )}

      <CornerTicks color={tick} />

      <span class="hero__chip" style={{ top: '14px' }}>
        <VideoCaption color={ageChip.tone}>{ageChip.text}</VideoCaption>
      </span>

      {display ? (
        <span class="hero__chip" style={{ bottom: '14px' }}>
          <VideoCaption>{`${display.name.toUpperCase()} · ${display.width} × ${display.height}`}</VideoCaption>
        </span>
      ) : null}
    </button>
  )
}

function heroAspect(display: DisplayEntry | null): number {
  const config = Object.values(store.videoConfigs.value)[0]
  if (config && config.height > 0) return config.width / config.height
  if (display && display.height > 0) return display.width / display.height
  return 16 / 10
}

// MARK: - The condition strip

function ConditionStrip({ posture }: { posture: Posture }) {
  switch (posture) {
    case 'awake':
    case 'weak':
      return <LiveStrip />
    case 'connecting':
      return <PendingStrip label="CONNECTING" detail="WAITING FOR THE FIRST HEARTBEAT" />
    case 'asleep':
      return <AsleepStrip />
    case 'unreachable':
      return <UnreachableStrip />
  }
}

/**
 * One card, one strip of readings.
 *
 * RTT is set larger than loss and downstream beside it, because three numbers at
 * the same size is a table and the eye has to read all of it. RTT is the one that
 * decides whether this session is going to be worth having.
 */
function LiveStrip() {
  const condition = store.condition.value
  const link = store.link.value
  const degraded = condition === 'degraded'
  const tint = conditionColor[condition]
  const valueColor = degraded ? 'var(--ns-amber)' : 'var(--ns-text)'

  return (
    <Card style={{ padding: '15px 18px 16px' }}>
      <div class="stack" style={{ gap: '15px' }}>
        <div class="row" style={{ gap: '9px' }}>
          <Caps size="var(--fs-10)" tracking="0.18em" color={tint} weight={500}>
            {degraded ? 'THIN LINK' : 'REACHABLE'}
          </Caps>
          <span class="spacer" />
          <Sparkline values={link.rttHistory} color={tint} grow />
          <Caps size="var(--fs-8)" tracking="0.12em">
            60S
          </Caps>
        </div>

        <div class="row" style={{ gap: '20px', alignItems: 'flex-end' }}>
          <Readout
            label="RTT"
            lead
            value={link.rttMillis == null ? null : String(Math.round(link.rttMillis))}
            unit="MS"
            valueColor={valueColor}
          />
          <Readout
            label="LOSS"
            value={link.lossPercent.toFixed(1)}
            unit="%"
            valueColor={degraded ? 'var(--ns-amber)' : 'var(--ns-text-secondary)'}
          />
          <Readout
            label="DOWN"
            value={link.downMbps.toFixed(1)}
            unit="MB/S"
            valueColor={degraded ? 'var(--ns-amber)' : 'var(--ns-text-secondary)'}
          />
        </div>
      </div>
    </Card>
  )
}

/**
 * The Mac answered and told us it is asleep, so this states that rather than
 * pretending the socket is still being opened. A dashed rule replaces live values;
 * the layout does not move when it wakes — it just fills in.
 */
function AsleepStrip() {
  const link = store.link.value
  return (
    <Card tint="var(--ns-amber)" style={{ padding: '16px 18px 17px' }}>
      <div class="stack" style={{ gap: '13px' }}>
        <div class="row" style={{ gap: '9px' }}>
          <ConditionDot condition="idle" size={7} />
          <Caps size="var(--fs-10)" tracking="0.18em" color="var(--ns-amber)" weight={500}>
            ASLEEP
          </Caps>
        </div>
        <p class="prose wrap">
          The Mac is reachable but its display is off. Waking it takes a few seconds.
        </p>
        <DashedRule />
        <Caps size="var(--fs-9)" tracking="0.12em">
          {link.onPower ? 'ON POWER · WILL ANSWER' : 'ON BATTERY · MAY NOT ANSWER'}
        </Caps>
      </div>
    </Card>
  )
}

function PendingStrip({ label, detail }: { label: string; detail: string }) {
  return (
    <Card style={{ padding: '15px 18px 16px' }}>
      <div class="stack" style={{ gap: '15px' }}>
        <div class="row" style={{ gap: '9px' }}>
          <ConditionDot condition="idle" size={7} />
          <Caps size="var(--fs-10)" tracking="0.18em" color="var(--ns-text-secondary)" weight={500}>
            {label}
          </Caps>
        </div>
        <div class="row" style={{ gap: '20px', alignItems: 'flex-end' }}>
          <Readout label="RTT" lead value={null} unit="MS" />
          <Readout label="LOSS" value={null} unit="%" />
          <Readout label="DOWN" value={null} unit="MB/S" />
        </div>
        <DashedRule />
        <Caps size="var(--fs-9)" tracking="0.12em">
          {detail}
        </Caps>
      </div>
    </Card>
  )
}

/** Both transports listed with their own verdict. A failure with an address, not
 *  one vague "offline". */
function UnreachableStrip() {
  const transport = store.transport.value
  const connection = store.connection.value
  const paired = store.pairedHost.value

  const sentence =
    connection.kind === 'reconnecting'
      ? `Tried ${connection.attempt} time${
          connection.attempt === 1 ? '' : 's'
        }. Nothing answered on either path.`
      : 'Nothing answered on either path.'

  // How long ago this browser and this Mac traded keys. It was labelled LAST
  // CONTACT, which is a different fact and a more useful one — and one nothing
  // here has: `pairedAt` is the only timestamp the client stores about the host,
  // and the protocol carries a last-seen time for the Mac's *devices*, not for
  // the Mac. A row that answers a question it was not asked is worse on this
  // screen than on any other, because the screen exists to say why nothing is
  // answering.
  const pairedAge = (() => {
    if (!paired) return 'NEVER'
    const elapsed = (Date.now() - Date.parse(paired.pairedAt)) / 1000
    if (elapsed < 60) return 'JUST NOW'
    if (elapsed < 3600) return `${Math.floor(elapsed / 60)}M AGO`
    if (elapsed < 86_400) return `${Math.floor(elapsed / 3600)}H AGO`
    return `${Math.floor(elapsed / 86_400)}D AGO`
  })()

  return (
    <Card style={{ padding: '16px 18px 17px' }}>
      <div class="stack" style={{ gap: '13px' }}>
        <span style={{ fontSize: 'var(--fs-15)', fontWeight: 500, lineHeight: 1.4 }}>
          {sentence}
        </span>
        <div class="stack" style={{ gap: '9px' }}>
          <TransportRow
            label={`DIRECT · ${transport.tailscaleAddress ?? paired?.host ?? '—'}`}
            verdict={transport.path === 'direct' ? 'OK' : 'TIMEOUT'}
            ok={transport.path === 'direct'}
          />
          <TransportRow
            label={`RELAY · ${
              transport.relayName ?? transport.cloudflareHostname ?? 'NOT CONFIGURED'
            }`}
            verdict={
              transport.path === 'relay' ? 'OK' : transport.cloudflareRunning ? 'NO HOST' : 'OFF'
            }
            ok={transport.path === 'relay'}
          />
          <TransportRow label="PAIRED" verdict={pairedAge} ok={null} />
        </div>
      </div>
    </Card>
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
    <div class="row" style={{ gap: '8px' }}>
      <Caps size="var(--fs-9)" tracking="0.1em" class="ellipsis">
        {label}
      </Caps>
      <span class="spacer" style={{ minWidth: '8px' }} />
      <Caps
        size="var(--fs-9)"
        tracking="0.12em"
        color={
          ok === true
            ? 'var(--ns-green)'
            : ok === null
              ? 'var(--ns-text-secondary)'
              : 'var(--ns-red)'
        }
      >
        {verdict}
      </Caps>
    </div>
  )
}

// MARK: - Displays

/**
 * A connected, awake Mac reporting no displays is not an empty list — it is almost
 * always Screen Recording permission missing, because that is what ScreenCaptureKit
 * returns nothing without. The host only says so when a stream is actually
 * requested, so until then this screen offered a heading over nothing and a button
 * reading "NO DISPLAY".
 */
function NoDisplays() {
  return (
    <Card tint="var(--ns-amber)" style={{ padding: '16px' }}>
      <div class="stack" style={{ gap: '10px' }}>
        <p class="prose wrap">The Mac answered, but reports no displays.</p>
        <p
          class="wrap"
          style={{
            margin: 0,
            fontSize: 'var(--fs-13)',
            color: 'var(--ns-on-amber-wash)',
            lineHeight: 1.45,
          }}
        >
          Screen Recording permission is the usual cause. On the Mac: System Settings → Privacy &
          Security → Screen Recording → VibeWire.
        </p>
      </div>
    </Card>
  )
}

/**
 * Which screen.
 *
 * Two forms of the same choice, because the two layouts have genuinely different
 * room for it. On a phone a display is a 64px chip — a shape and one word — laid
 * across one row under the readings. On the rail there is 320px of width and a
 * column of height, so it becomes the full row the fact deserves: the display's
 * real name, its resolution and refresh rate, and which one is in use.
 *
 * Both forms call the same two handlers. Nothing about the selection lives in
 * either of them.
 */
/**
 * Three facts about the far end, on the rail a laptop window has room for.
 *
 * All three were already being measured and stated somewhere else — the path in
 * the header strip, the address on the unreachable screen, the frontmost window
 * only in the landscape dock, which means only once the picture is already open.
 * On the screen where the question is "is it worth opening", they are the answer,
 * and the rail below the displays was empty.
 *
 * Narrow layouts do not get this: a phone screen has one column and it belongs to
 * the picture and the way in.
 */
function WhatTheMacIsDoing() {
  const transport = store.transport.value
  const frontmost = store.link.value.frontmostApp
  const address =
    transport.path === 'direct'
      ? transport.tailscaleAddress ?? transport.lanAddress
      : transport.path === 'relay'
        ? transport.cloudflareHostname
        : null

  const rows: [string, string, string][] = [
    [
      'PATH',
      transport.path === 'direct' ? 'DIRECT' : transport.path === 'relay' ? 'RELAY' : 'NONE',
      transport.path === 'none' ? 'var(--ns-text-tertiary)' : 'var(--ns-green)',
    ],
    ['ADDRESS', address ?? '—', 'var(--ns-text-secondary)'],
    // Never a guess: the host sends this and an empty string means it has not.
    ['FRONTMOST', frontmost || '—', 'var(--ns-text-secondary)'],
  ]

  return (
    <div class="wide-only stack" style={{ gap: '10px', marginTop: '20px' }}>
      <SectionLabel>THE MAC</SectionLabel>
      <Card style={{ padding: '16px' }}>
        <div class="stack" style={{ gap: '11px' }}>
          {rows.map(([label, value, tone]) => (
            <div key={label} class="row">
              <Caps size="var(--fs-9)" tracking="0.12em">
                {label}
              </Caps>
              <span class="spacer" style={{ minWidth: '8px' }} />
              <Caps size="var(--fs-9)" tracking="0.12em" color={tone} class="ellipsis">
                {value}
              </Caps>
            </div>
          ))}
        </div>
      </Card>
    </div>
  )
}

function Displays({ posture }: { posture: Posture }) {
  const displays = store.displays.value

  if (displays.length === 0) {
    // "The Mac answered, but reports no displays" is a claim about a machine
    // that has answered. While the socket is still opening, or while the Mac is
    // asleep, nothing has answered — and printing a permission diagnosis over a
    // connection that has not completed sends the reader to System Settings to
    // fix a problem they do not have. This screen does not get to say the Mac
    // said something it has not said, so before the first heartbeat the heading
    // stands over a dashed rule and the condition strip carries the state.
    if (posture !== 'awake' && posture !== 'weak') {
      return (
        <div class="stack" style={{ gap: '10px' }}>
          <SectionLabel>DISPLAYS</SectionLabel>
          <div style={{ paddingBlock: '14px' }}>
            <DashedRule />
          </div>
        </div>
      )
    }
    return (
      <div class="stack" style={{ gap: '10px' }}>
        <SectionLabel>DISPLAYS</SectionLabel>
        <NoDisplays />
      </div>
    )
  }

  const weak = posture === 'weak'
  const dimmed = posture === 'asleep'

  return (
    <div class="stack" style={{ gap: '10px' }}>
      <SectionLabel>DISPLAYS</SectionLabel>

      <div class="row narrow-only" style={{ gap: '8px', alignItems: 'stretch' }}>
        {displays.map((display) => (
          <DisplayChip
            key={display.id}
            display={display}
            degraded={weak}
            dimmed={dimmed}
            onClick={() => store.selectDisplay(display.id)}
          />
        ))}
        {displays.length > 1 ? (
          <button
            onClick={() => store.selectBothDisplays()}
            disabled={weak}
            aria-pressed={store.sideBySide.value}
            aria-label={weak ? 'Side by side, needs 3 megabits' : 'Both displays side by side'}
            style={{
              flex: '0.85 1 0',
              minWidth: 0,
              minHeight: '64px',
              borderRadius: 'var(--radius-control)',
              border: `1px dashed ${
                store.sideBySide.value ? 'var(--ns-accent)' : 'var(--ns-stroke)'
              }`,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '6px',
              opacity: weak ? 0.55 : 1,
            }}
          >
            <SideBySideGlyph />
            <Caps size="var(--fs-8)" tracking="0.12em">
              BOTH
            </Caps>
          </button>
        ) : null}
      </div>

      <div class="wide-only" style={{ flexDirection: 'column' }}>
        <Group>
          {displays.map((display) => (
            <DisplayRow
              key={display.id}
              display={display}
              degraded={weak}
              dimmed={dimmed}
              onClick={() => store.selectDisplay(display.id)}
            />
          ))}
          {displays.length > 1 ? (
            <button
              class="group-row group-row--dashed"
              onClick={() => store.selectBothDisplays()}
              disabled={weak}
              aria-pressed={store.sideBySide.value}
              style={{
                minHeight: '50px',
                gap: '12px',
                opacity: weak ? 0.55 : 1,
                borderColor: store.sideBySide.value ? 'var(--ns-accent)' : undefined,
              }}
            >
              <SideBySideGlyph />
              <Caps size="var(--fs-9)" tracking="0.14em" color="var(--ns-text-secondary)">
                {weak ? 'SIDE BY SIDE · NEEDS 3 MB' : 'SIDE BY SIDE · BOTH'}
              </Caps>
            </button>
          ) : null}
        </Group>
      </div>
    </div>
  )
}

function SideBySideGlyph() {
  return (
    <span class="row" style={{ gap: '3px', flex: '0 0 auto' }} aria-hidden="true">
      {[0, 1].map((index) => (
        <span
          key={index}
          style={{
            width: '12px',
            height: '17px',
            borderRadius: 'var(--radius-screen)',
            border: '1px solid var(--ns-text-tertiary)',
          }}
        />
      ))}
    </span>
  )
}

/** The rail form: the display's real name, what it is, and whether it is in use. */
function DisplayRow({
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
  const selected = display.selected
  return (
    <button
      class={selected ? 'group-row group-row--selected' : 'group-row'}
      onClick={onClick}
      aria-pressed={selected}
      style={{ minHeight: '62px' }}
    >
      <span
        aria-hidden="true"
        style={{
          width: '34px',
          height: '22px',
          flex: '0 0 auto',
          borderRadius: 'var(--radius-screen)',
          background: selected
            ? 'color-mix(in srgb, var(--ns-accent) 20%, transparent)'
            : 'transparent',
          border: `1px ${dimmed ? 'dashed' : 'solid'} ${
            selected ? 'var(--ns-accent)' : 'var(--ns-text-tertiary)'
          }`,
        }}
      />
      <span class="stack" style={{ gap: '3px', minWidth: 0 }}>
        <span
          class="ellipsis"
          style={{
            fontSize: 'var(--fs-14)',
            fontWeight: 500,
            letterSpacing: '-0.01em',
            color: dimmed ? 'var(--ns-text-tertiary)' : 'var(--ns-text)',
          }}
        >
          {display.name}
        </span>
        <Caps
          size="var(--fs-9)"
          tracking="0.1em"
          color={degraded && selected ? 'var(--ns-amber)' : 'var(--ns-text-secondary)'}
        >
          {degraded && selected
            ? 'WILL OPEN AT 540P'
            : dimmed
              ? `LAST KNOWN ${display.width} × ${display.height}`
              : resolutionLabel(display)}
        </Caps>
      </span>
      <span class="spacer" />
      {selected ? (
        <Caps size="var(--fs-9)" tracking="0.12em" color="var(--ns-accent)">
          IN USE
        </Caps>
      ) : null}
    </button>
  )
}

export function DisplayChip({
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
  const selected = display.selected
  return (
    <button
      onClick={onClick}
      aria-pressed={selected}
      aria-label={display.name}
      aria-description={
        dimmed
          ? `Last known ${display.width} by ${display.height}`
          : `${display.width} by ${display.height}`
      }
      style={{
        flex: '1.15 1 0',
        minWidth: 0,
        minHeight: '64px',
        borderRadius: 'var(--radius-control)',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '6px',
        background: selected
          ? 'color-mix(in srgb, var(--ns-accent) 12%, transparent)'
          : 'var(--ns-raised)',
        // An inset ring, not an outline: `outline` is spoken for by the focus
        // ring, and a selected chip is the one a keyboard is most likely on.
        boxShadow: selected
          ? 'inset 0 0 0 1px color-mix(in srgb, var(--ns-accent) 50%, transparent)'
          : undefined,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: '26px',
          height: '17px',
          flex: '0 0 auto',
          borderRadius: 'var(--radius-screen)',
          background: selected
            ? 'color-mix(in srgb, var(--ns-accent) 20%, transparent)'
            : 'transparent',
          border: `1px ${dimmed ? 'dashed' : 'solid'} ${
            selected ? 'var(--ns-accent)' : 'var(--ns-text-tertiary)'
          }`,
        }}
      />
      <Caps
        class="ellipsis"
        size="var(--fs-8)"
        tracking="0.12em"
        color={
          degraded && selected
            ? 'var(--ns-amber)'
            : selected
              ? 'var(--ns-accent)'
              : 'var(--ns-text-secondary)'
        }
        style={{ maxWidth: '100%', paddingInline: '6px' }}
      >
        {degraded && selected
          ? '540P'
          : dimmed
            ? `${display.width}×${display.height}`
            : shortDisplayName(display)}
      </Caps>
    </button>
  )
}

/**
 * "Built-in Liquid Retina XDR" in a 64px chip is one long ellipsis, so the chip
 * takes the part that distinguishes it from the other one on the desk. The full
 * name and resolution are on the hero's own caption and in the aria label.
 *
 * Taking the first word alone was wrong in the most ordinary case there is: two
 * screens called MON 1 and MON 2 both came back MON, so the control whose entire
 * job is telling them apart drew the same label twice. A short name is kept
 * whole, and where one has to be cut, a trailing index survives the cut — it is
 * usually the only thing separating two of the same model.
 */
function shortDisplayName(display: DisplayEntry): string {
  const name = display.name.toUpperCase()
  if (name.length <= 12) return name
  if (name.includes('BUILT-IN')) return 'BUILT-IN'
  const head = name.split(' ')[0]
  const index = /\s(\d+)$/.exec(name)
  return index ? `${head} ${index[1]}` : head
}

/** Causes ranked by likelihood rather than alphabetised. */
function Causes() {
  const transport = store.transport.value
  const rows: [string, string, string][] = [
    ['01', 'The Mac is asleep, or VibeWire is not running on it.', 'var(--ns-red)'],
    [
      '02',
      transport.tailscaleRunning
        ? 'You are off the tailnet, or the Mac dropped off it.'
        : 'Tailscale is not running on the Mac.',
      'var(--ns-amber)',
    ],
    ['03', 'A VPN on the Mac is eating the route.', 'var(--ns-text-tertiary)'],
  ]

  return (
    <div class="stack" style={{ gap: '9px' }}>
      <SectionLabel>MOST LIKELY, IN ORDER</SectionLabel>
      <ol class="group" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
          {rows.map(([number, text, color]) => (
            <li
              key={number}
              class="row row--top"
              style={{
                gap: '12px',
                minHeight: '50px',
                padding: '13px 16px',
                background: 'var(--ns-raised)',
              }}
            >
              <Caps size="var(--fs-10)" tracking="0" color={color} style={{ lineHeight: 1.35 }}>
                {number}
              </Caps>
              <span
                class="wrap"
                style={{
                  fontSize: 'var(--fs-13)',
                  lineHeight: 1.35,
                  color:
                    color === 'var(--ns-text-tertiary)'
                      ? 'var(--ns-text-secondary)'
                      : 'var(--ns-text)',
                }}
              >
                {text}
              </span>
            </li>
          ))}
      </ol>
    </div>
  )
}

// MARK: - The way forward

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
    // A disabled action still reads its own sub-label, and the estimate under it
    // was still promising a first frame in 228ms for a stream that cannot start.
    if (!displays.length) return 'NO DISPLAY TO OPEN'
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
        <>
          <PrimaryAction
            title="View screen"
            detail={preflight}
            glyph="→"
            // Nothing to open, and the strip above now says why.
            enabled={displays.length > 0}
            onClick={() => store.startStream()}
          />
          <ClaudeHandle />
        </>
      )

    case 'weak':
      return (
        <>
          <p
            class="wrap"
            style={{
              margin: 0,
              padding: '13px 16px',
              borderRadius: 'var(--radius-control)',
              fontSize: 'var(--fs-13)',
              lineHeight: 1.45,
              color: 'var(--ns-on-amber-wash)',
              background: 'color-mix(in srgb, var(--ns-amber) 8%, transparent)',
            }}
          >
            Text will be soft until the link recovers. Pointer input stays instant — only video is
            throttled.
          </p>
          <PrimaryAction
            title="View screen anyway"
            detail="540P · SOFT TEXT UNTIL IT RECOVERS"
            glyph="→"
            tint="var(--ns-amber)"
            ink="var(--ns-on-amber)"
            onClick={() => store.startStream()}
          />
          <ClaudeHandle />
        </>
      )

    case 'connecting':
      return (
        <p
          class="wrap"
          style={{
            margin: 0,
            fontSize: 'var(--fs-13)',
            color: 'var(--ns-text-secondary)',
            lineHeight: 1.45,
          }}
        >
          Waiting on the Mac to answer. Nothing is being retried in a loop — the battery is not the
          price of an unanswered question.
        </p>
      )

    case 'asleep':
      return (
        <>
          <p
            class="wrap"
            style={{
              margin: 0,
              fontSize: 'var(--fs-13)',
              color: 'var(--ns-text-secondary)',
              lineHeight: 1.45,
            }}
          >
            Its display is off. Waking it is a nudge, not a restart — anything you had open stays
            open.
          </p>
          <PrimaryAction
            title="Wake it"
            detail={
              link.canWake ? 'NUDGES THE DISPLAY · USUALLY 4S' : 'MAC IS ON BATTERY — MAY NOT ANSWER'
            }
            glyph="↑"
            tint="var(--ns-accent)"
            ink="var(--ns-on-accent)"
            onClick={() => store.wake()}
          />
        </>
      )

    case 'unreachable':
      return (
        <>
          <PrimaryAction
            title="Try again"
            detail={`AUTO-RETRY IN ${retryCountdown}S · ${tapVerb()} TO GO NOW`}
            glyph="↻"
            tint="var(--ns-accent)"
            ink="var(--ns-on-accent)"
            onClick={() => {
              onRetry()
              store.retry()
            }}
          />
          <MovedAddress />
        </>
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
 * Deliberately not a primary action, and deliberately not automatic: the app does
 * not go looking for a Mac at an address nobody gave it.
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
        style={{
          minHeight: 'var(--target)',
          display: 'flex',
          alignItems: 'center',
          gap: '8px',
        }}
      >
        <Caps size="var(--fs-9)" tracking="0.12em">
          THE MAC MOVED ·
        </Caps>
        <Caps size="var(--fs-9)" tracking="0.12em" color="var(--ns-accent)">
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
    <Card style={{ padding: '16px' }}>
      <div class="stack" style={{ gap: '10px' }}>
        <Caps size="var(--fs-9)" tracking="0.16em">
          NEW ADDRESS FOR THIS MAC
        </Caps>
        <p
          class="wrap"
          style={{
            margin: 0,
            fontSize: 'var(--fs-13)',
            lineHeight: 1.45,
            color: 'var(--ns-text-secondary)',
          }}
        >
          The key stays. This is the same Mac at a different address, so there is nothing to pair
          again — no code, no trip to the menu bar.
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
            background: 'var(--ns-raised-2)',
            borderRadius: 'var(--radius-inner)',
            color: 'var(--ns-text)',
          }}
        />
        {failure ? (
          <p
            class="wrap"
            role="alert"
            style={{ margin: 0, fontSize: 'var(--fs-13)', color: 'var(--ns-red)', lineHeight: 1.45 }}
          >
            {failure}
          </p>
        ) : null}
        <div class="row" style={{ gap: '9px' }}>
          <button
            class="outlined"
            onClick={() => setOpen(false)}
            style={{ minHeight: '46px' }}
          >
            <Caps size="var(--fs-10)">CANCEL</Caps>
          </button>
          <button
            class="outlined"
            onClick={() => {
              if (!busy) void submit()
            }}
            style={
              {
                minHeight: '46px',
                '--edge': 'color-mix(in srgb, var(--ns-accent) 50%, transparent)',
              } as Record<string, string>
            }
          >
            <Caps size="var(--fs-10)" color="var(--ns-accent)">
              {busy ? 'CHECKING…' : 'USE IT'}
            </Caps>
          </button>
        </div>
      </div>
    </Card>
  )
}

/**
 * Claude, as a row rather than a caption with a link in it.
 *
 * It is a second destination from this screen, not a footnote about one, and on a
 * laptop it sits beside "View screen" as the other thing worth opening.
 */
function ClaudeHandle() {
  // Sessions the Mac reports, not streams this tab has opened. This read
  // `sessionCount`, which counts pictures going live — so stopping and starting
  // the stream three times made this row claim three Claude sessions.
  const count = store.claudeSessions.value.length
  const cwd = store.claudeCwd.value

  const detail = (() => {
    if (cwd) {
      const short = cwd.replace(/^\/Users\/[^/]+/, '~').toUpperCase()
      return count > 0 ? `${count} SESSION${count === 1 ? '' : 'S'} · ${short} OPEN` : `${short}`
    }
    return count > 0 ? `${count} SESSION${count === 1 ? '' : 'S'} ON THE MAC` : 'NO SESSION YET'
  })()

  return (
    <button
      class="home__claude"
      onClick={() => {
        store.presented.value = 'claude'
        store.listClaudeSessions()
      }}
      aria-label="Claude Code"
      aria-description={detail}
      // The width lives in the stylesheet, not here: past 900px this sits beside
      // the primary action rather than under it, and an inline width: 100% is not
      // something a container query can argue with — which is how the way *in* to
      // the Mac ended up narrower than the row beside it.
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: '13px',
        minHeight: '62px',
        paddingInline: '18px',
        paddingBlock: '10px',
        borderRadius: 'var(--radius-control)',
        background: 'var(--ns-raised)',
        textAlign: 'left',
      }}
    >
      <span
        class="dot"
        aria-hidden="true"
        style={{ width: '8px', height: '8px', background: 'var(--ns-accent)' }}
      />
      <span class="stack" style={{ gap: '3px', minWidth: 0 }}>
        <span style={{ fontSize: 'var(--fs-15)', fontWeight: 500, letterSpacing: '-0.01em' }}>
          Claude Code
        </span>
        <Caps class="ellipsis" size="var(--fs-9)" tracking="0.1em">
          {detail}
        </Caps>
      </span>
      <span class="spacer" />
      <span
        class="mono"
        aria-hidden="true"
        style={{ fontSize: 'var(--fs-15)', color: 'var(--ns-accent)' }}
      >
        ↗
      </span>
    </button>
  )
}
