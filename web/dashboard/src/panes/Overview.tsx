import { useEffect, useState } from 'preact/hooks'
import { Caps, Card, Group, Readout, Sparkline } from '../../../src/design/components'
import { Kv, RuledLabel } from '../parts'
import { bars, bytes, DASH, duration, measured, resolution, ago } from '../format'
import { snapshotURL } from '../api'
import { claude, pairOpen, pane, selectedDeviceId, type DeviceFact, type Facts } from '../store'

/**
 * 01 · OVERVIEW.
 *
 * The one pane that answers "is this Mac reachable, and by whom" without being
 * asked anything. Everything on it is measured: the picture is a screenshot and
 * says so, the link figures come from the phone's own round trips and are dashes
 * until it has taken some, and the device cards report only what the socket in
 * front of them actually did.
 */
export function Overview({ state }: { state: Facts }) {
  return (
    <div class="pane pane--split" data-screen-label="Overview">
      <div class="pane__col pane__col--main" style={{ overflow: 'hidden' }}>
        <Hero state={state} />
        <div class="row" style={{ gap: 14, flex: '0 0 auto', alignItems: 'stretch' }}>
          <LinkCard state={state} />
          <EncoderCard state={state} />
        </div>
      </div>

      <div class="pane__col pane__col--rail">
        <CreatePair />
        <RuledLabel
          trailing={
            <Caps size="var(--fs-9)" color="var(--ns-text-tertiary)">
              {`${state.devices.filter((device) => device.connected).length} OF ${state.devices.length}`}
            </Caps>
          }
        >
          ATTACHED
        </RuledLabel>
        <DeviceCards state={state} />
        <RuledLabel
          trailing={
            <button
              type="button"
              class="mono"
              style={{
                fontSize: 'var(--fs-9)',
                letterSpacing: 'var(--caps-tracking)',
                color: 'var(--ns-accent)',
              }}
              onClick={() => {
                pane.value = 'log'
              }}
            >
              ALL →
            </button>
          }
        >
          LAST EVENTS
        </RuledLabel>
        <Group>
          {state.log.entries.slice(0, 5).map((entry) => (
            <div
              key={entry.seq}
              class="row mono"
              style={{
                gap: 10,
                minHeight: 36,
                paddingInline: 12,
                background: 'var(--ns-raised)',
                fontSize: 'var(--fs-9)',
                letterSpacing: '0.1em',
              }}
            >
              <span style={{ color: 'var(--ns-text-faint)', flex: '0 0 auto' }}>{entry.at}</span>
              <span class="ellipsis" style={{ color: levelInk(entry.level) }}>
                {entry.text}
              </span>
            </div>
          ))}
          {state.log.entries.length === 0 && (
            <div class="group-row">
              <Caps size="var(--fs-9)">NOTHING SINCE LAUNCH</Caps>
            </div>
          )}
        </Group>
      </div>
    </div>
  )
}

export function levelInk(level: string): string {
  switch (level) {
    case 'ERROR':
      return 'var(--ns-red)'
    case 'WARN':
      return 'var(--ns-amber)'
    default:
      return 'var(--ns-text-secondary)'
  }
}

/**
 * The picture, and everything that sits over it.
 *
 * A screenshot at one frame a second, labelled as one. The encoder's output is
 * H.264 addressed to the phone; decoding it again here to draw a thumbnail would
 * put a decoder on the same machine as the encoder for nothing. The chip says
 * SNAPSHOT · 1 FPS rather than borrowing the stream's frame rate, which would be
 * this window claiming to show something it is not.
 */
function Hero({ state }: { state: Facts }) {
  const display =
    state.displays.find((entry) => entry.selected) ??
    state.displays.find((entry) => entry.isMain) ??
    state.displays[0]

  const [tick, setTick] = useState(0)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!state.permissions.screenRecording) return undefined
    const timer = setInterval(() => setTick((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [state.permissions.screenRecording])

  const others = state.displays.filter((entry) => entry.id !== display?.id)

  return (
    <div class="hero-shot">
      {display && state.permissions.screenRecording && !failed ? (
        <img
          class="hero-shot__image"
          src={snapshotURL(display.id, 1100, tick)}
          alt={`${display.name}, one frame a second`}
          onError={() => setFailed(true)}
        />
      ) : (
        <div class="hero-shot__empty stack" style={{ gap: 8, alignItems: 'center' }}>
          <Caps size="var(--fs-10)" tracking="var(--caps-tracking-wide)">
            {!state.permissions.screenRecording
              ? 'SCREEN RECORDING NOT GRANTED'
              : failed
                ? 'THE MAC WOULD NOT ANSWER WITH A FRAME'
                : 'NO DISPLAY REPORTED'}
          </Caps>
          {!state.permissions.screenRecording && (
            <span
              style={{
                fontSize: 'var(--fs-13)',
                color: 'var(--ns-text-secondary)',
                maxWidth: '32rem',
                textAlign: 'center',
              }}
            >
              ScreenCaptureKit has no frames to give, so neither this panel nor the phone has a
              picture. The Settings pane can ask for the grant.
            </span>
          )}
        </div>
      )}

      <span class="hero-shot__corner hero-shot__corner--tl" />
      <span class="hero-shot__corner hero-shot__corner--tr" />
      <span class="hero-shot__corner hero-shot__corner--bl" />
      <span class="hero-shot__corner hero-shot__corner--br" />

      {display && (
        <div class="hero-shot__chips hero-shot__chips--tl">
          <span class="video-chip mono">
            {`${display.name.toUpperCase()} · ${resolution(display.width, display.height)}`}
          </span>
        </div>
      )}

      <div class="hero-shot__chips hero-shot__chips--tr">
        <span class="video-chip mono row" style={{ gap: 7 }}>
          <span
            class="dot"
            style={{
              width: 6,
              height: 6,
              background: state.encoder.capturing ? 'var(--ns-green)' : 'var(--ns-text-tertiary)',
            }}
          />
          <span
            style={{
              color: state.encoder.capturing ? 'var(--ns-green)' : 'var(--ns-text-tertiary)',
            }}
          >
            {state.encoder.capturing
              ? `STREAMING · ${state.encoder.fps ?? DASH} FPS`
              : 'NOT STREAMING'}
          </span>
        </span>
      </div>

      <div class="hero-shot__chips hero-shot__chips--bl">
        <span class="video-chip mono" style={{ color: 'var(--ns-text-secondary)' }}>
          {state.encoder.capturing
            ? `H.264 · ${state.encoder.ladder ?? DASH}P · ${measured(state.encoder.mbps, (value) => value.toFixed(1))} MB/S`
            : 'SNAPSHOT · 1 FPS · NOT THE STREAM'}
        </span>
        {state.encoder.capturing && (
          <span class="video-chip mono" style={{ color: 'var(--ns-text-secondary)' }}>
            {`KEYFRAME ${(state.encoder.keyframeSeconds ?? 2).toFixed(1)}S`}
          </span>
        )}
      </div>

      {others.length > 0 && (
        <div class="hero-shot__chips hero-shot__chips--br">
          {others.map((other) => (
            <div
              key={other.id}
              class="stack"
              style={{
                width: 104,
                gap: 5,
                padding: 6,
                borderRadius: 'var(--radius-small)',
                background: 'rgb(6 7 10 / 92%)',
              }}
            >
              <div
                style={{
                  height: 44,
                  borderRadius: 'var(--radius-screen)',
                  border: `1px ${other.stream ? 'solid' : 'dashed'} var(--ns-stroke)`,
                  display: 'grid',
                  placeItems: 'center',
                }}
              >
                <Caps size="var(--fs-9)">{other.stream ? 'SENDING' : 'IDLE'}</Caps>
              </div>
              <Caps size="var(--fs-9)" style={{ textAlign: 'center' }}>
                {other.stream ? `STREAM ${other.stream.streamId}` : 'NOT SENT'}
              </Caps>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** RTT, jitter, loss and rate — every one of them a dash until it is measured. */
function LinkCard({ state }: { state: Facts }) {
  const link = state.link
  const attached = link.attached
  const tint = !attached
    ? 'var(--ns-text-tertiary)'
    : link.rtt === undefined
      ? 'var(--ns-text-tertiary)'
      : link.rtt > 250 || (link.loss ?? 0) > 3
        ? 'var(--ns-red)'
        : link.rtt > 120 || (link.loss ?? 0) > 1
          ? 'var(--ns-amber)'
          : 'var(--ns-green)'

  const verdict = !attached
    ? 'NOTHING ATTACHED'
    : link.rtt === undefined
      ? 'NO ROUND TRIP YET'
      : tint === 'var(--ns-green)'
        ? 'REACHABLE'
        : tint === 'var(--ns-amber)'
          ? 'DEGRADED'
          : 'POOR'

  return (
    <Card style={{ flex: '1 1 auto', padding: '15px 18px 16px' }}>
      <div class="row" style={{ gap: 9 }}>
        <Caps size="var(--fs-10)" color={tint} tracking="0.18em" weight={500}>
          {verdict}
        </Caps>
        <span class="spacer" />
        <Sparkline values={link.rttHistory} color={tint} />
        <Caps size="var(--fs-9)">60S</Caps>
      </div>
      <div class="row row--baseline mono" style={{ gap: 26, marginTop: 15, flexWrap: 'wrap' }}>
        <Readout
          label="RTT"
          value={link.rtt === undefined ? null : String(Math.round(link.rtt))}
          unit="MS"
          lead
        />
        <Readout
          label="JITTER"
          value={link.jitter === undefined ? null : String(Math.round(link.jitter))}
          unit="MS"
        />
        <Readout
          label="LOSS"
          value={link.loss === undefined ? null : link.loss.toFixed(1)}
          unit="%"
        />
        <Readout label="OUT" value={link.outMbps.toFixed(1)} unit="MB/S" />
      </div>
    </Card>
  )
}

/** What the encoder is doing, or the reason there is nothing to report. */
function EncoderCard({ state }: { state: Facts }) {
  const encoder = state.encoder
  const trace = bars(encoder.rateHistory, 1, 34)

  return (
    <Card style={{ width: 290, flex: '0 0 auto', padding: '15px 18px 16px' }}>
      <div class="row">
        <Caps size="var(--fs-10)" color="var(--ns-text-secondary)" tracking="0.18em" weight={500}>
          ENCODER
        </Caps>
        <span class="spacer" />
        <Caps
          size="var(--fs-9)"
          color={encoder.capturing ? 'var(--ns-green)' : 'var(--ns-text-tertiary)'}
        >
          {encoder.capturing
            ? `${encoder.ladder}P · ${encoder.ladderSetting.toUpperCase()}`
            : 'IDLE'}
        </Caps>
      </div>

      <div
        class="row"
        style={{
          alignItems: 'flex-end',
          gap: 2,
          height: 34,
          marginTop: 14,
          color: 'var(--ns-accent)',
        }}
      >
        {trace.length === 0 ? (
          <Caps size="var(--fs-9)">NOTHING SENT YET</Caps>
        ) : (
          trace.map((bar, index) => (
            <i
              key={index}
              style={{
                flex: '1 1 0',
                display: 'block',
                borderRadius: 'var(--radius-bar)',
                background: 'currentColor',
                opacity: bar.now ? 1 : 0.35,
                height: bar.h,
              }}
            />
          ))
        )}
      </div>

      <div class="row mono" style={{ gap: 18, marginTop: 14, fontSize: 'var(--fs-9)' }}>
        <span style={{ color: 'var(--ns-text-tertiary)' }}>
          DROPPED <span style={{ color: 'var(--ns-text)' }}>{encoder.dropped}</span>
        </span>
        <span style={{ color: 'var(--ns-text-tertiary)' }}>
          FRAMES{' '}
          <span style={{ color: 'var(--ns-text)' }}>
            {measured(encoder.framesEncoded, (value) => value.toLocaleString())}
          </span>
        </span>
        <span style={{ color: 'var(--ns-text-tertiary)' }}>
          GOP <span style={{ color: 'var(--ns-text)' }}>{measured(encoder.gop, String)}</span>
        </span>
      </div>
    </Card>
  )
}

/** The action that replaces pasting a command into a terminal. */
function CreatePair() {
  return (
    <button
      type="button"
      class="row"
      onClick={() => {
        pairOpen.value = true
      }}
      style={{
        gap: 14,
        width: '100%',
        minHeight: 'var(--primary-action)',
        padding: '12px 20px',
        borderRadius: 'var(--radius-card)',
        background: 'var(--ns-accent)',
        color: 'var(--ns-on-accent)',
        flex: '0 0 auto',
      }}
    >
      <span class="stack" style={{ minWidth: 0, alignItems: 'flex-start' }}>
        <span
          style={{
            fontSize: 'var(--fs-19)',
            fontWeight: 600,
            letterSpacing: 'var(--title-tracking)',
          }}
        >
          Create pair
        </span>
        <span
          class="mono"
          style={{ fontSize: 'var(--fs-9)', letterSpacing: '0.12em', opacity: 0.72, marginTop: 3 }}
        >
          6 DIGITS · ROTATES EVERY 60S
        </span>
      </span>
      <span class="spacer" />
      <span class="mono" style={{ fontSize: 'var(--fs-22)' }} aria-hidden="true">
        ＋
      </span>
    </button>
  )
}

function DeviceCards({ state }: { state: Facts }) {
  if (state.devicesReadable !== 'yes') {
    return (
      <Card tint="var(--ns-amber)" style={{ padding: 16 }}>
        <Caps size="var(--fs-9)" color="var(--ns-amber)">
          THE KEYCHAIN DID NOT ANSWER
        </Caps>
        <p
          style={{
            margin: '10px 0 0',
            fontSize: 'var(--fs-13)',
            lineHeight: 1.45,
            color: 'var(--ns-on-amber-wash)',
          }}
        >
          This is not the same as nothing being paired. Until it answers, every phone that
          reconnects will be refused as an unknown device.
        </p>
      </Card>
    )
  }

  if (state.devices.length === 0) {
    return (
      <Card style={{ padding: 16 }}>
        <Caps size="var(--fs-9)">NOTHING PAIRED YET</Caps>
        <p
          style={{
            margin: '10px 0 0',
            fontSize: 'var(--fs-13)',
            lineHeight: 1.45,
            color: 'var(--ns-text-secondary)',
          }}
        >
          Create a pair above. The code is shown here and typed or scanned on the phone; nothing is
          stored on this Mac until the handshake completes.
        </p>
      </Card>
    )
  }

  return (
    <div class="stack" style={{ gap: 14 }}>
      {state.devices.map((device) => (
        <DeviceCard key={device.id} device={device} sessions={claude.value.sessions.length} />
      ))}
    </div>
  )
}

function DeviceCard({ device, sessions }: { device: DeviceFact; sessions: number }) {
  const tint = device.connected ? 'var(--ns-green)' : 'var(--ns-text-tertiary)'
  const stats: { label: string; value: string | null }[] = device.session
    ? [
        { label: 'ATTACHED', value: duration((Date.now() - Date.parse(device.session.since)) / 1000) },
        { label: 'SENT', value: bytes(device.session.bytesSent) },
        { label: 'DROPPED', value: String(device.session.framesDropped) },
      ]
    : [
        { label: 'LAST SEEN', value: ago(device.lastSeenAt) },
        { label: 'PAIRED', value: ago(device.pairedAt) },
        { label: 'SENT', value: null },
      ]

  return (
    <button
      type="button"
      class="card stack hoverable"
      onClick={() => {
        selectedDeviceId.value = device.id
        pane.value = 'devices'
      }}
      style={{
        gap: 12,
        width: '100%',
        padding: '15px 16px 14px',
        alignItems: 'stretch',
        textAlign: 'left',
      }}
    >
      <span class="row" style={{ gap: 9, width: '100%' }}>
        <span
          class={`dot${device.connected ? ' dot--pulse' : ' dot--idle'}`}
          style={{ width: 8, height: 8, background: device.connected ? tint : 'transparent' }}
        />
        <span
          class="ellipsis"
          style={{
            fontSize: 'var(--fs-14)',
            fontWeight: 500,
            color: device.connected ? 'var(--ns-text)' : 'var(--ns-text-secondary)',
          }}
        >
          {device.name}
        </span>
        <span class="spacer" />
        <Caps size="var(--fs-10)" color={tint}>
          {device.connected ? 'ATTACHED' : ago(device.lastSeenAt)}
        </Caps>
      </span>

      <Caps size="var(--fs-9)" class="ellipsis">
        {`${device.kind.toUpperCase()} · ED25519 ${device.keyFingerprint}`}
      </Caps>

      <span class="row" style={{ gap: 2, width: '100%' }}>
        {stats.map((stat) => (
          <span
            key={stat.label}
            class="stack"
            style={{
              flex: '1 1 0',
              minWidth: 0,
              background: 'var(--ns-raised-2)',
              borderRadius: 'var(--radius-group-inner)',
              padding: '8px 10px',
              gap: 5,
            }}
          >
            <Caps size="var(--fs-9)">{stat.label}</Caps>
            <span
              class="mono ellipsis"
              style={{
                fontSize: 'var(--fs-12)',
                color: stat.value === null ? 'var(--ns-text-tertiary)' : 'var(--ns-text)',
              }}
            >
              {stat.value ?? DASH}
            </span>
          </span>
        ))}
      </span>

      {device.session && sessions > 0 && (
        <Kv label="CLAUDE" value={`${sessions} SESSIONS ON DISK`} color="var(--ns-accent)" />
      )}
    </button>
  )
}
