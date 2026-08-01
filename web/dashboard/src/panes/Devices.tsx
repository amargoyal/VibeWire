import { useState } from 'preact/hooks'
import { Caps, Card, FilledAction, Group, OutlinedAction } from '../../../src/design/components'
import { Chip, Kv, RowButton, RuledLabel } from '../parts'
import { ago, bytes, clockTime, duration } from '../format'
import { pairOpen, selectedDeviceId, send, type DeviceFact, type Facts } from '../store'

/**
 * 02 · DEVICES.
 *
 * The pane that exists so revoking a phone does not require finding the phone
 * first. Two verbs, and they are deliberately not one: sever closes the socket
 * and keeps the key, revoke destroys the key and needs a new code. Collapsing
 * them into "disconnect" is exactly the kind of thing PROTOCOL §1.1 is precise
 * about and the interface would be sloppy about.
 *
 * Both destructive actions confirm in place rather than in an alert. An alert
 * would take focus away from the row that says which device is about to lose its
 * key, which is the one fact worth having on screen at that moment.
 */
export function Devices({ state }: { state: Facts }) {
  const selected =
    state.devices.find((device) => device.id === selectedDeviceId.value) ?? state.devices[0]

  return (
    <div class="pane pane--split" data-screen-label="Devices">
      <div class="pane__col pane__col--rail">
        <div class="stack" style={{ gap: 6, flex: '0 0 auto' }}>
          <h2
            style={{
              margin: 0,
              fontSize: 'var(--fs-26)',
              fontWeight: 600,
              letterSpacing: 'var(--title-tracking)',
            }}
          >
            Paired devices
          </h2>
          <Caps size="var(--fs-9)">
            TRUST LIVES IN THE LOGIN KEYCHAIN · REVOKE SEVERS IN UNDER 1S
          </Caps>
        </div>

        {state.devicesReadable !== 'yes' ? (
          <Card tint="var(--ns-amber)" style={{ padding: 16 }}>
            <Caps size="var(--fs-9)" color="var(--ns-amber)">
              THE KEYCHAIN DID NOT ANSWER
            </Caps>
            <p style={wash}>
              Not the same as nothing being paired. Nothing here can be trusted until it answers,
              so no list is drawn.
            </p>
          </Card>
        ) : (
          <Group>
            {state.devices.map((device) => (
              <RowButton
                key={device.id}
                selected={device.id === selected?.id}
                onClick={() => {
                  selectedDeviceId.value = device.id
                }}
                style={{ minHeight: 64 }}
              >
                <span
                  class={`dot${device.connected ? '' : ' dot--idle'}`}
                  style={{
                    width: 8,
                    height: 8,
                    background: device.connected ? 'var(--ns-green)' : 'transparent',
                  }}
                />
                <span class="stack" style={{ gap: 4, minWidth: 0 }}>
                  <span class="ellipsis" style={{ fontSize: 'var(--fs-14)', fontWeight: 500 }}>
                    {device.name}
                  </span>
                  <Caps
                    size="var(--fs-9)"
                    color={device.connected ? 'var(--ns-green)' : 'var(--ns-text-tertiary)'}
                  >
                    {device.connected
                      ? `${device.kind.toUpperCase()} · ATTACHED`
                      : `${device.kind.toUpperCase()} · ${ago(device.lastSeenAt)}`}
                  </Caps>
                </span>
              </RowButton>
            ))}
            {state.devices.length === 0 && (
              <div class="group-row">
                <Caps size="var(--fs-9)">NONE YET</Caps>
              </div>
            )}
          </Group>
        )}

        <OutlinedAction
          title="＋ CREATE PAIR"
          onClick={() => {
            pairOpen.value = true
          }}
        />

        <span class="spacer" />

        {state.devices.length > 0 && <RevokeAll count={state.devices.length} />}
      </div>

      <div class="pane__col pane__col--main">
        {selected ? (
          <Detail device={selected} state={state} />
        ) : (
          <Card style={{ padding: 18 }}>
            <Caps size="var(--fs-9)">NOTHING TO SHOW</Caps>
            <p style={{ ...wash, color: 'var(--ns-text-secondary)' }}>
              No device has completed a handshake with this Mac yet.
            </p>
          </Card>
        )}
      </div>
    </div>
  )
}

const wash = {
  margin: '10px 0 0',
  fontSize: 'var(--fs-13)',
  lineHeight: 1.45,
  color: 'var(--ns-on-amber-wash)',
  textWrap: 'pretty' as const,
}

function Detail({ device, state }: { device: DeviceFact; state: Facts }) {
  const [renaming, setRenaming] = useState(false)
  const [draft, setDraft] = useState(device.name)
  const [confirming, setConfirming] = useState(false)

  const session = device.session
  const rows: [string, string | null, string?][] = [
    [
      'STATE',
      device.connected ? (state.encoder.capturing ? 'ATTACHED · STREAMING' : 'ATTACHED') : 'IDLE',
      device.connected ? 'var(--ns-green)' : 'var(--ns-text-tertiary)',
    ],
    [
      'ROUND TRIP',
      device.attached && state.link.rtt !== undefined
        ? `${Math.round(state.link.rtt)} MS${state.link.jitter !== undefined ? ` · JITTER ${Math.round(state.link.jitter)} MS` : ''}`
        : null,
    ],
    [
      'TRANSPORT',
      device.attached
        ? `${state.transport.path.toUpperCase()} · ${state.addresses.host}`
        : null,
      device.attached ? 'var(--ns-green)' : undefined,
    ],
    [
      'WATCHING',
      session && session.watching.length > 0
        ? session.watching
            .map((streamId) => {
              const display = state.displays.find(
                (entry) => entry.stream?.streamId === streamId,
              )
              return display
                ? `${display.name} · ${display.stream?.sentWidth}×${display.stream?.sentHeight}`
                : `STREAM ${streamId}`
            })
            .join(' · ')
        : null,
    ],
    [
      'LADDER',
      device.attached
        ? `${state.encoder.ladderSetting.toUpperCase()}${state.encoder.ladder ? ` → ${state.encoder.ladder}P` : ''} · CELLULAR CAP ${state.settings?.capOnCellular ? 'ON' : 'OFF'}`
        : null,
    ],
    [
      'SENT · SESSION',
      session ? `${bytes(session.bytesSent)} IN ${duration((Date.now() - Date.parse(session.since)) / 1000)}` : null,
    ],
    ['FRAMES DROPPED', session ? String(session.framesDropped) : null],
    // No Claude row. The host runs one Claude session and does not record which
    // device opened it, so anything printed here would be attribution this Mac
    // never made. The Claude pane says who is talking to it; this one does not
    // guess.
    ['KIND', device.kind.toUpperCase(), 'var(--ns-text-secondary)'],
    ['KEY', `ED25519 · ${device.keyFingerprint}`, 'var(--ns-text-secondary)'],
    [
      'PAIRED',
      `${clockTime(device.pairedAt)} · ${ago(device.pairedAt)}`,
      'var(--ns-text-secondary)',
    ],
    ['LAST SEEN', device.lastSeenAt ? ago(device.lastSeenAt) : null, 'var(--ns-text-secondary)'],
    ['DEVICE ID', device.id, 'var(--ns-text-secondary)'],
    ['PROTOCOL', `VERSION ${state.host.protocol} · MATCHED`, 'var(--ns-green)'],
  ]

  async function rename() {
    const name = draft.trim()
    if (!name || name === device.name) {
      setRenaming(false)
      return
    }
    await send({ do: 'device.rename', deviceId: device.id, name })
    setRenaming(false)
  }

  return (
    <>
      <div class="row" style={{ gap: 14, flex: '0 0 auto' }}>
        {renaming ? (
          <input
            class="mono"
            autoFocus
            value={draft}
            onInput={(event) => setDraft((event.target as HTMLInputElement).value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') void rename()
              if (event.key === 'Escape') setRenaming(false)
            }}
            aria-label="Device name"
            style={{
              flex: '1 1 auto',
              minWidth: 0,
              fontSize: 'var(--fs-19)',
              background: 'var(--ns-raised-2)',
              borderRadius: 'var(--radius-inner)',
              padding: '10px 12px',
            }}
          />
        ) : (
          <h3
            class="ellipsis"
            style={{
              margin: 0,
              fontSize: 'var(--fs-22)',
              fontWeight: 600,
              letterSpacing: 'var(--title-tracking)',
            }}
          >
            {device.name}
          </h3>
        )}
        <Chip
          tint={device.connected ? 'var(--ns-green)' : 'var(--ns-text-tertiary)'}
          dot={false}
        >
          {device.connected ? 'ATTACHED' : 'IDLE'}
        </Chip>
        <span class="spacer" />
        <button
          type="button"
          class="mono hoverable"
          onClick={() => {
            if (renaming) {
              void rename()
            } else {
              setDraft(device.name)
              setRenaming(true)
            }
          }}
          style={{
            minHeight: 36,
            paddingInline: 14,
            borderRadius: 'var(--radius-inner)',
            background: 'var(--ns-raised)',
            fontSize: 'var(--fs-9)',
            letterSpacing: 'var(--caps-tracking)',
            color: 'var(--ns-text-secondary)',
          }}
        >
          {renaming ? 'SAVE' : 'RENAME'}
        </button>
      </div>

      <Card style={{ padding: '6px 18px', flex: '0 0 auto' }}>
        <div class="detail-grid">
          {rows.map(([label, value, color]) => (
            <Kv key={label} label={label} value={value} color={color} ruled labelWidth={116} />
          ))}
        </div>
      </Card>

      <RuledLabel>THE TWO VERBS</RuledLabel>

      <div class="row" style={{ gap: 10, flex: '0 0 auto' }}>
        <div style={{ flex: '1 1 0' }}>
          <OutlinedAction
            title="Sever the socket"
            height={56}
            enabled={device.connected}
            onClick={() => void send({ do: 'device.sever', deviceId: device.id })}
          />
        </div>
        <div style={{ flex: '1 1 0' }}>
          {confirming ? (
            <FilledAction
              title={`Revoke ${device.name}`}
              tint="var(--ns-red)"
              ink="var(--ns-on-red)"
              height={56}
              onClick={() => {
                setConfirming(false)
                void send({ do: 'device.revoke', deviceId: device.id })
              }}
            />
          ) : (
            <OutlinedAction
              title="Revoke this device"
              tint="var(--ns-red)"
              edge="var(--ns-red)"
              height={56}
              onClick={() => setConfirming(true)}
            />
          )}
        </div>
      </div>

      <Caps size="var(--fs-9)" style={{ lineHeight: 1.6, flex: '0 0 auto' }}>
        {confirming
          ? 'PRESS AGAIN TO DESTROY THE KEY · ANY LIVE SOCKET ENDS INSIDE 1S · CLICK ANYWHERE ELSE TO STAND DOWN'
          : 'SEVER CLOSES THE SOCKET AND KEEPS THE KEY · REVOKE DESTROYS THE KEY AND NEEDS A NEW CODE · NEITHER TOUCHES ANYTHING ON THIS MAC'}
      </Caps>

      {device.connected && !device.attached && (
        <Caps size="var(--fs-9)" color="var(--ns-amber)" style={{ lineHeight: 1.6 }}>
          THIS DEVICE HOLDS A SOCKET BUT IS NOT THE ONE CLAUDE AND THE STREAM ARE ADDRESSED TO ·
          THE HOST KEEPS ONE ACTIVE SOCKET AND THE NEWEST TAKES IT
        </Caps>
      )}
    </>
  )
}

/**
 * Revoke-all, behind the same in-place confirmation and with the count in the
 * button so the second click cannot be about a number nobody read.
 */
function RevokeAll({ count }: { count: number }) {
  const [confirming, setConfirming] = useState(false)
  return (
    <Card tint="var(--ns-red)" style={{ padding: 16, flex: '0 0 auto' }}>
      <div class="stack" style={{ gap: 11 }}>
        <Caps size="var(--fs-9)" color="var(--ns-red)">
          REVOKE ALL
        </Caps>
        <span style={{ fontSize: 'var(--fs-13)', lineHeight: 1.45, color: 'var(--ns-text-secondary)' }}>
          Destroys every key. Each device pairs again from a new code. Nothing on this Mac is
          deleted.
        </span>
        {confirming ? (
          <FilledAction
            title={`Revoke all ${count}`}
            tint="var(--ns-red)"
            ink="var(--ns-on-red)"
            onClick={() => {
              setConfirming(false)
              void send({ do: 'device.revoke', all: true })
            }}
          />
        ) : (
          <OutlinedAction
            title={count === 1 ? 'REVOKE THE ONE' : `REVOKE ALL ${count}`}
            tint="var(--ns-red)"
            edge="var(--ns-red)"
            onClick={() => setConfirming(true)}
          />
        )}
      </div>
    </Card>
  )
}
