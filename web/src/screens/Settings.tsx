/**
 * 13 · SETTINGS and 14 · REVOKE — CONFIRM.
 * Mirrored by ios/VibeWire/Screens/SettingsView.swift.
 *
 * Six groups, no search field, no icons in coloured squares. Every value that
 * affects the picture shows its cost in bytes or milliseconds, because that is the
 * only reason to come here.
 *
 * One group is new, and it exists because the browser made it necessary: THIS
 * BROWSER states where the private key actually lives and what that costs, since
 * unlike the phone there is no Secure Enclave to take for granted and the answer
 * differs between engines.
 *
 * Past 900px the six groups become two columns, split on which end of the wire
 * each one is about — see the comment over the two wrappers below. DOM order is
 * the phone's order and the wrappers are `display: contents` until the container
 * query fires, so nothing here is rendered twice and the phone lays out the same
 * flat run of sections it always has.
 */

import type { ComponentChildren } from 'preact'
import { useEffect } from 'preact/hooks'

import { bitrateMbps, store, type PairedDeviceEntry, type RevokeTarget } from '../app/store'
import { decoderSupport } from '../video/renderer'
import {
  Caps,
  Card,
  Display,
  FilledAction,
  Grabber,
  Group,
  OutlinedAction,
  SectionLabel,
  SheetDismiss,
  Toggle,
  useSheet,
} from '../design/components'
import { hasKeyboard, showShortcuts } from '../app/shortcuts'

export function Settings({ onClose }: { onClose: () => void }) {
  const settings = store.settings.value
  const target = store.revokeTarget.value
  // While the revoke sheet is up it owns Escape; this one would otherwise close
  // underneath it and take the question with it.
  const sheet = useSheet<HTMLDivElement>(target ? undefined : onClose)

  // A pending revoke belongs to this sheet. Closing it any other way — DONE, the
  // shortcut key, a route change — used to leave the confirmation armed, so the
  // question came back unasked the next time Settings was opened.
  useEffect(() => () => (store.revokeTarget.value = null), [])

  return (
    <div ref={sheet} class="sheet" role="dialog" aria-modal="true" aria-label="Settings">
      <div class="wide-shell screen--scrolls">
        <div class="column wide-column">
          <div
            class="settings"
            style={{
              opacity: target ? 0.18 : 1,
              pointerEvents: target ? 'none' : 'auto',
              transition: 'opacity var(--state-change) ease-out',
            }}
          >
            <div
              class="row settings__title"
              style={{ minHeight: '40px', marginTop: '12px', flex: '0 0 auto' }}
            >
              <Display level={26} rank={2}>Settings</Display>
              <span class="spacer" />
              <SheetDismiss onClick={onClose} id="dismissSettings" />
            </div>

            {/*
              The split is which end of the wire the group is about, not what would
              make the two columns the same height — they are not the same height,
              and the one about this browser is the shorter.

              Left: the Mac at the other end. The keys it holds, the picture it
              sends, the pointer it moves, the paths it will answer on. Every value
              in this column is stored on the Mac or spent by it.

              Right: this end. Where this browser's signing key actually lives,
              whether this engine can decode video at all, which origin the pairing
              belongs to, and which keys never leave this side. That difference is
              the reason this client has a group the phone does not, so it is the
              line the sheet splits on.

              Revoke and the version line stay at the foot of the right-hand column
              where the phone puts them, because that is the column they belong to:
              revoking every device deletes this browser's key with the rest, which
              is the second sentence of the confirmation.
            */}
            <div class="settings__mac">
              <SettingsGroup title="PAIRED">
                <PairedDevices />
              </SettingsGroup>
              <SettingsGroup title="VIDEO">
                <VideoSection />
              </SettingsGroup>
              <SettingsGroup title="TRACKPAD">
                <TrackpadSection />
              </SettingsGroup>
              <SettingsGroup title="ACCESS">
                <AccessSection />
              </SettingsGroup>
            </div>

            <div class="settings__browser">
              <SettingsGroup title="THIS BROWSER">
                <BrowserSection />
              </SettingsGroup>

              {/* The shortcut list is opened with `?`, which is only discoverable to
                  someone who already knows it. This is the other way in, and it is
                  absent on a touch device where there is no keyboard to list. */}
              {hasKeyboard() ? (
                <SettingsGroup title="KEYBOARD">
                  <button
                    class="group-row"
                    onClick={() => {
                      onClose()
                      showShortcuts.value = true
                    }}
                    style={{ borderRadius: 'var(--radius-group-outer)', textAlign: 'left' }}
                  >
                    <span style={{ fontSize: 'var(--fs-15)', fontWeight: 500 }}>
                      Keys that stay on this side
                    </span>
                    <span class="spacer" />
                    <span class="cap" style={{ flex: '0 0 auto', width: '38px', minHeight: '30px' }}>
                      <span class="mono" style={{ fontSize: 'var(--fs-13)' }}>
                        ?
                      </span>
                    </span>
                  </button>
                </SettingsGroup>
              ) : null}

              <button
                class="outlined"
                onClick={() =>
                  // Goes through the same sheet as a single revoke. Revoking one device
                  // asked for confirmation; revoking all of them, including this
                  // browser, went straight through on one tap.
                  (store.revokeTarget.value = {
                    kind: 'everything',
                    count: store.devices.value.length,
                  })
                }
                style={
                  {
                    marginTop: '20px',
                    minHeight: '54px',
                    justifyContent: 'flex-start',
                    paddingInline: '18px',
                    gap: '10px',
                    flex: '0 0 auto',
                    '--edge': 'color-mix(in srgb, var(--ns-red) 50%, transparent)',
                  } as Record<string, string>
                }
              >
                <span style={{ fontSize: 'var(--fs-15)', color: 'var(--ns-red)' }}>
                  Revoke every device
                </span>
                <span class="spacer" />
                {/* Solid, not 70%: the count is the scale of what the tap destroys, and
                    the faded version read at 3.4:1. */}
                <Caps size="var(--fs-9)" tracking="0.12em" color="var(--ns-red)">
                  {`${store.devices.value.length} KEYS`}
                </Caps>
              </button>

              <Caps
                size="var(--fs-9)"
                tracking="0.12em"
                color="var(--ns-text-faint)"
                style={{
                  marginTop: '12px',
                  paddingBottom: 'calc(40px + var(--safe-bottom))',
                  lineHeight: 1.7,
                  flex: '0 0 auto',
                }}
              >
                {`VIBEWIRE WEB ${store.appVersion} · HOST ${settings.hostVersion} · NO ACCOUNT, NO CLOUD`}
              </Caps>
            </div>
          </div>
        </div>
      </div>

      {target ? (
        <>
          <div class="scrim" />
          <RevokeConfirm target={target} />
        </>
      ) : null}
    </div>
  )
}

function SettingsGroup({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <section
      class="stack"
      style={{ gap: '9px', marginTop: '22px', flex: '0 0 auto' }}
    >
      <SectionLabel>{title}</SectionLabel>
      {children}
    </section>
  )
}

// MARK: Paired

function PairedDevices() {
  const devices = store.devices.value

  if (!devices.length) {
    return (
      <Caps
        size="var(--fs-10)"
        tracking="0.12em"
        style={{ minHeight: '50px', display: 'flex', alignItems: 'center' }}
      >
        NO DEVICES REPORTED BY THE HOST
      </Caps>
    )
  }

  return (
    <Group>
      {devices.map((device) => (
        <div
          key={device.id}
          class={device.isThisDevice ? 'group-row group-row--selected' : 'group-row'}
        >
          <DeviceGlyph kind={device.kind} isThisDevice={device.isThisDevice} />
          <span class="stack" style={{ gap: '3px', minWidth: 0 }}>
            <span
              class="ellipsis"
              style={{ fontSize: 'var(--fs-15)', fontWeight: 500, letterSpacing: '-0.01em' }}
            >
              {device.name}
            </span>
            <Caps
              size="var(--fs-9)"
              tracking="0.1em"
              color={device.isThisDevice ? 'var(--ns-accent)' : 'var(--ns-text-tertiary)'}
            >
              {device.isThisDevice
                ? `THIS BROWSER · PAIRED ${shortDate(device.pairedAt)}`
                : lastSeenLabel(device)}
            </Caps>
          </span>
          <span class="spacer" style={{ minWidth: '8px' }} />
          {device.isThisDevice ? null : (
            <button
              class="outlined"
              onClick={() => (store.revokeTarget.value = { kind: 'device', device })}
              // Every row's button is the word REVOKE, so a reader moving between
              // them hears the same name three times and cannot tell which key is
              // about to be deleted.
              aria-label={`Revoke ${device.name}`}
              style={
                {
                  width: 'auto',
                  minHeight: '38px',
                  paddingInline: '13px',
                  flex: '0 0 auto',
                  borderRadius: 'var(--radius-inner)',
                  '--edge': 'color-mix(in srgb, var(--ns-red) 50%, transparent)',
                } as Record<string, string>
              }
            >
              <Caps size="var(--fs-9)" tracking="0.12em" color="var(--ns-red)">
                REVOKE
              </Caps>
            </button>
          )}
        </div>
      ))}
    </Group>
  )
}

function DeviceGlyph({ kind, isThisDevice }: { kind: string; isThisDevice: boolean }) {
  // A browser is a third shape. Drawing it as a phone would put two identical
  // outlines next to each other in the one list whose job is telling them apart.
  const shape =
    kind === 'tablet'
      ? { width: 27, height: 21, radius: 2 }
      : kind === 'browser'
        ? { width: 28, height: 22, radius: 3 }
        : { width: 19, height: 28, radius: 4 }
  return (
    <span
      aria-hidden="true"
      style={{
        width: `${shape.width}px`,
        height: `${shape.height}px`,
        flex: '0 0 auto',
        borderRadius: `${shape.radius}px`,
        border: `1px solid ${isThisDevice ? 'var(--ns-accent)' : 'var(--ns-text-tertiary)'}`,
        // The browser shape gets a title bar, so it reads as a window.
        borderTopWidth: kind === 'browser' ? '5px' : '1px',
      }}
    />
  )
}

function lastSeenLabel(device: PairedDeviceEntry): string {
  if (device.lastSeenAt == null) return 'NEVER CONNECTED'
  const elapsed = (Date.now() - device.lastSeenAt) / 1000
  // Under a minute this read "0 MIN AGO", and a host clock a few seconds ahead of
  // this one read "-1 MIN AGO".
  if (elapsed < 60) return 'LAST SEEN JUST NOW'
  if (elapsed < 3600) return `LAST SEEN ${count(elapsed / 60, 'MIN')} AGO`
  if (elapsed < 86400) return `LAST SEEN ${count(elapsed / 3600, 'HOUR')} AGO`
  return `LAST SEEN ${count(elapsed / 86400, 'DAY')} AGO`
}

/** "1 DAY", not "1 DAYS". */
function count(value: number, noun: string): string {
  const whole = Math.floor(value)
  return `${whole} ${noun}${whole === 1 ? '' : 'S'}`
}

const DAY_FORMAT = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' })

function shortDate(at: number): string {
  return DAY_FORMAT.format(new Date(at)).toUpperCase()
}

// MARK: Video

function VideoSection() {
  const settings = store.settings.value
  const config = Object.values(store.videoConfigs.value)[0]
  const rtt = store.link.value.rttMillis

  const nowLabel = config
    ? `NOW: ${config.height}P · ${bitrateMbps(config).toFixed(1)} MB/S · ${
        rtt == null ? '—' : `${Math.round(rtt)}MS`
      }`
    : 'NOT STREAMING'

  return (
    <div class="stack" style={{ gap: '10px' }}>
      <div class="segmented" role="radiogroup" aria-label="Video quality">
        {['auto', '1080', '720', '540'].map((ladder) => (
          <button
            key={ladder}
            role="radio"
            aria-checked={settings.quality === ladder}
            onClick={() => store.setQuality(ladder)}
            style={{ minHeight: '40px' }}
          >
            <Caps
              size="var(--fs-10)"
              tracking="0.12em"
              color={settings.quality === ladder ? 'var(--ns-accent)' : 'var(--ns-text-tertiary)'}
            >
              {ladder}
            </Caps>
          </button>
        ))}
      </div>

      <div class="row">
        <Caps size="var(--fs-9)" tracking="0.12em">
          {nowLabel}
        </Caps>
        <span class="spacer" style={{ minWidth: '8px' }} />
        <Caps size="var(--fs-9)" tracking="0.12em" color="var(--ns-text-secondary)">
          DROPS ON ITS OWN
        </Caps>
      </div>

      <SettingRow
        title="Cap on cellular"
        subtitle={
          store.linkMonitor.measured
            ? `CEILING ${Math.round(settings.cellularCeilingMbps)} MB/S`
            : `CEILING ${Math.round(
                settings.cellularCeilingMbps,
              )} MB/S · THIS BROWSER WILL NOT NAME THE RADIO`
        }
        isOn={settings.capOnCellular}
        onChange={(value) => store.setSetting('capOnCellular', value)}
      />
    </div>
  )
}

// MARK: Trackpad

function TrackpadSection() {
  const settings = store.settings.value

  return (
    <div class="stack" style={{ gap: '12px' }}>
      <div class="row">
        <span style={{ fontSize: 'var(--fs-15)', fontWeight: 500, letterSpacing: '-0.01em' }}>
          Sensitivity
        </span>
        <span class="spacer" />
        <Caps size="var(--fs-11)" tracking="0" color="var(--ns-accent)">
          {`${settings.sensitivity} / 8`}
        </Caps>
      </div>

      {/* Eight ticks rather than a continuous slider, because a thumb can hit a
          tick. Collapsed into the one adjustable control it has always looked like,
          so it announces as a value with a range instead of eight anonymous
          buttons, none of which said what it would set or what was set now. */}
      <div
        class="row"
        role="slider"
        tabIndex={0}
        aria-label="Trackpad sensitivity"
        aria-valuemin={1}
        aria-valuemax={8}
        aria-valuenow={settings.sensitivity}
        aria-valuetext={`${settings.sensitivity} of 8, ${settings.sensitivity * 216} pixels per swipe`}
        onKeyDown={(event) => {
          if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
            event.preventDefault()
            if (settings.sensitivity < 8) store.setSetting('sensitivity', settings.sensitivity + 1)
          } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
            event.preventDefault()
            if (settings.sensitivity > 1) store.setSetting('sensitivity', settings.sensitivity - 1)
          }
        }}
        style={{ gap: '5px', alignItems: 'flex-end' }}
      >
        {[1, 2, 3, 4, 5, 6, 7, 8].map((tick) => (
          <button
            key={tick}
            tabIndex={-1}
            aria-hidden="true"
            onClick={() => store.setSetting('sensitivity', tick)}
            style={{
              width: '22px',
              height: 'var(--target)',
              flex: '0 0 auto',
              display: 'flex',
              alignItems: 'flex-end',
              justifyContent: 'center',
            }}
          >
            <span
              style={{
                width: '4px',
                // Half of the width, so the tick is a capsule: the pill token,
                // not a hand-typed 2 that happens to land there.
                borderRadius: 'var(--radius-pill)',
                height: `${10 + (tick - 1) * 4}px`,
                background:
                  tick <= settings.sensitivity ? 'var(--ns-accent)' : 'var(--ns-raised-2)',
              }}
            />
          </button>
        ))}
        <span class="spacer" />
        <Caps size="var(--fs-9)" tracking="0.1em" style={{ paddingBottom: '4px' }}>
          {`${settings.sensitivity * 216}PX / SWIPE`}
        </Caps>
      </div>

      <SettingRow
        title="Natural scrolling"
        isOn={settings.naturalScrolling}
        onChange={(value) => store.setSetting('naturalScrolling', value)}
      />
    </div>
  )
}

// MARK: Access

function AccessSection() {
  const settings = store.settings.value
  const transport = store.transport.value

  const relaySubtitle = settings.relayOverInternet
    ? transport.cloudflareHostname
      ? `ON · ${transport.cloudflareHostname.replace(/^https:\/\//, '')}`
      : 'ON · STARTING TUNNEL…'
    : transport.tailscaleRunning
      ? 'OFF · TAILSCALE COVERS REMOTE ACCESS'
      : 'OFF · NO REMOTE PATH CONFIGURED'

  return (
    <div class="stack">
      <SettingRow
        title="Face ID each session"
        // The setting belongs to the Mac and the phone honours it. A browser has no
        // Face ID to honour, so this says which of the two paired clients it
        // governs rather than implying this one is protected.
        subtitle="ADDS ~0.4S TO OPEN · APPLIES TO THE iPHONE APP"
        isOn={settings.requireBiometricEachSession}
        onChange={(value) => store.setSetting('requireBiometricEachSession', value)}
      />
      <SettingRow
        title="Relay over internet"
        subtitle={relaySubtitle}
        subtitleColor={settings.relayOverInternet ? 'var(--ns-amber)' : 'var(--ns-text-tertiary)'}
        isOn={settings.relayOverInternet}
        onChange={(value) => store.setSetting('relayOverInternet', value)}
      />
    </div>
  )
}

// MARK: This browser

/**
 * The three facts a browser client has to state and the phone never did: where the
 * private key lives, whether this engine can decode the video at all, and which
 * origin this pairing belongs to.
 */
function BrowserSection() {
  const storage = store.keyStorage.value
  const decoder = decoderSupport()
  const paired = store.pairedHost.value
  const wrong = storage === 'raw-seed' || decoder !== 'ok'

  return (
    <Card tint={wrong ? 'var(--ns-amber)' : undefined} style={{ padding: '16px' }}>
      <div class="stack" style={{ gap: '12px' }}>
        <FactRow
          label="SIGNING KEY"
          value={
            storage == null
              ? '—'
              : storage === 'non-extractable'
                ? 'NON-EXTRACTABLE'
                : 'RAW SEED IN THIS ORIGIN'
          }
          tone={storage === 'raw-seed' ? 'var(--ns-amber)' : 'var(--ns-green)'}
        />
        <p
          class="wrap"
          style={{
            margin: 0,
            fontSize: 'var(--fs-13)',
            lineHeight: 1.45,
            color: storage === 'raw-seed' ? 'var(--ns-on-amber-wash)' : 'var(--ns-text-secondary)',
          }}
        >
          {storage === 'raw-seed'
            ? 'This browser has no WebCrypto Ed25519, so the key is a raw seed in its own storage and script on this origin could read it. The iPhone app keeps its key in the Secure Enclave-backed keychain; this is weaker. Revoking this device on the Mac is what makes a leaked seed worthless.'
            : 'The key was generated non-extractable: this page can ask it to sign and cannot read it back. It never leaves this browser and never syncs.'}
        </p>

        <FactRow
          label="VIDEO DECODER"
          value={decoder === 'ok' ? 'WEBCODECS H.264' : 'MISSING'}
          tone={decoder === 'ok' ? 'var(--ns-green)' : 'var(--ns-amber)'}
        />
        {decoder === 'ok' ? null : (
          <p
            class="wrap"
            style={{
              margin: 0,
              fontSize: 'var(--fs-13)',
              lineHeight: 1.45,
              color: 'var(--ns-on-amber-wash)',
            }}
          >
            This browser has no WebCodecs video decoder, so the picture will not arrive. Everything
            else — pointer, keyboard, clipboard, Claude — still works.
          </p>
        )}

        <FactRow label="PAIRED FROM" value={location.origin} tone="var(--ns-text)" />
        <p
          class="wrap"
          style={{
            margin: 0,
            fontSize: 'var(--fs-13)',
            lineHeight: 1.45,
            color: 'var(--ns-text-secondary)',
          }}
        >
          Browser storage is per-origin, so each address you open this client from pairs once and
          appears as its own device on the Mac.
          {paired ? ` This one talks to ${paired.origin}.` : ''}
        </p>
      </div>
    </Card>
  )
}

function FactRow({ label, value, tone }: { label: string; value: string; tone: string }) {
  return (
    <div class="row">
      <Caps size="var(--fs-9)" tracking="0.12em">
        {label}
      </Caps>
      <span class="spacer" style={{ minWidth: '8px' }} />
      <Caps size="var(--fs-9)" tracking="0.12em" color={tone} class="ellipsis">
        {value}
      </Caps>
    </div>
  )
}

// MARK: Rows

function SettingRow({
  title,
  subtitle,
  subtitleColor = 'var(--ns-text-tertiary)',
  isOn,
  onChange,
}: {
  title: string
  subtitle?: string
  subtitleColor?: string
  isOn: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <div class="row" style={{ gap: '14px', minHeight: '56px', paddingBlock: '6px' }}>
      <span class="stack" style={{ gap: '3px', minWidth: 0 }}>
        <span style={{ fontSize: 'var(--fs-15)', fontWeight: 500, letterSpacing: '-0.01em' }}>
          {title}
        </span>
        {subtitle ? (
          <Caps size="var(--fs-9)" tracking="0.1em" color={subtitleColor}>
            {subtitle}
          </Caps>
        ) : null}
      </span>
      <span class="spacer" style={{ minWidth: '8px' }} />
      <Toggle isOn={isOn} onChange={onChange} label={title} />
    </div>
  )
}

/**
 * 14 · REVOKE — CONFIRM.
 *
 * Three consequences in plain sentences, including the one that is *not* affected —
 * that last line is what makes a destructive tap safe to make one-handed. The
 * confirming verb is the same word as the button that opened it.
 */
function RevokeConfirm({ target }: { target: RevokeTarget }) {
  const isEverything = target.kind === 'everything'
  // Escape answers the question with the safe answer, the same as KEEP IT PAIRED.
  const sheet = useSheet<HTMLDivElement>(() => (store.revokeTarget.value = null))

  const title = isEverything
    ? `REVOKE ALL ${target.count} DEVICES`
    : `REVOKE ${target.device.name.toUpperCase()}`

  const headline = isEverything
    ? 'Every key is deleted on the Mac. There is no undo.'
    : 'Its key is deleted on the Mac. There is no undo.'

  /** The third line is the one that makes the tap safe to judge: for a single
   *  device it says what keeps working, and for all of them it says plainly that
   *  this browser is included, which is the part a one-tap button hid. */
  const consequences: [string, boolean][] = isEverything
    ? [
        ['Every live session ends inside 1s.', true],
        ['This browser is included. You will be signed out.', true],
        ['Pairing again needs physical access to the Mac.', true],
      ]
    : [
        ['Any live session from that device ends inside 1s.', true],
        ['Pairing again needs physical access to the Mac.', true],
        ['This browser keeps working. Nothing else changes.', false],
      ]

  const auditSubject = isEverything ? `ALL ${target.count} DEVICES` : target.device.name.toUpperCase()
  const auditNoun = isEverything ? (target.count === 1 ? 'KEY' : 'KEYS') : 'KEY'

  return (
    <div
      ref={sheet}
      class="drawer"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        borderTop: '1px solid color-mix(in srgb, var(--ns-red) 34%, transparent)',
        padding: '16px 22px calc(34px + var(--safe-bottom))',
        display: 'flex',
        flexDirection: 'column',
        gap: '18px',
      }}
    >
      <div
        class="stack"
        style={{ gap: '18px', width: '100%', maxWidth: 'var(--measure)', marginInline: 'auto' }}
      >
        <Grabber />

        <div class="stack" style={{ gap: '10px' }}>
          <Caps size="var(--fs-10)" tracking="0.18em" color="var(--ns-red)">
            {title}
          </Caps>
          <p
            class="wrap"
            style={{
              margin: 0,
              fontSize: 'var(--fs-24)',
              fontWeight: 600,
              letterSpacing: '-0.025em',
              lineHeight: 1.2,
            }}
          >
            {headline}
          </p>
        </div>

        <ul class="group" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {consequences.map(([text, severe]) => (
              <li
                key={text}
                class="row row--top"
                style={{ gap: '11px', padding: '13px 14px', background: 'var(--ns-screen)' }}
              >
                <span
                  class="mono"
                  aria-hidden="true"
                  style={{
                    fontSize: 'var(--fs-10)',
                    lineHeight: 1.5,
                    color: severe ? 'var(--ns-red)' : 'var(--ns-text-tertiary)',
                  }}
                >
                  ▸
                </span>
                <span
                  class="wrap"
                  style={{
                    fontSize: 'var(--fs-14)',
                    lineHeight: 1.45,
                    color: severe ? 'var(--ns-text)' : 'var(--ns-text-secondary)',
                  }}
                >
                  {text}
                </span>
              </li>
            ))}
        </ul>

        <div class="stack" style={{ gap: '9px' }}>
          <FilledAction
            title={isEverything ? 'Revoke everything' : 'Revoke it'}
            tint="var(--ns-red)"
            ink="var(--ns-on-red)"
            height={60}
            onClick={() => {
              if (target.kind === 'device') store.revoke(target.device)
              else store.revokeAll()
            }}
          />
          <OutlinedAction
            title={isEverything ? 'KEEP THEM PAIRED' : 'KEEP IT PAIRED'}
            height={52}
            onClick={() => (store.revokeTarget.value = null)}
          />
        </div>

        <Caps
          size="var(--fs-9)"
          tracking="0.12em"
          color="var(--ns-text-faint)"
          style={{ textAlign: 'center' }}
        >
          {`HOST WILL LOG: REVOKED · ${auditSubject} · ${auditNoun} DELETED`}
        </Caps>
      </div>
    </div>
  )
}
