/**
 * 07A · SETTINGS and 07B · REVOKE · CONFIRM.
 * Ported from ios/VibeWire/Screens/SettingsView.swift.
 *
 * Four groups, no search field, no icons in coloured squares. Every value that
 * affects the picture shows its cost in bytes or milliseconds, because that is the
 * only reason to come here.
 *
 * One group is new, and it exists because the browser made it necessary: THIS
 * BROWSER states where the private key actually lives and what that costs, since
 * unlike the phone there is no Secure Enclave to take for granted and the answer
 * differs between engines.
 */

import type { ComponentChildren } from 'preact'

import { bitrateMbps, store, type PairedDeviceEntry, type RevokeTarget } from '../app/store'
import { decoderSupport } from '../video/renderer'
import {
  Caps,
  Hairline,
  Panel,
  ScreenBody,
  SecondaryAction,
  SheetDismiss,
  Toggle,
} from '../design/components'

export function Settings({ onClose }: { onClose: () => void }) {
  const settings = store.settings.value
  const target = store.revokeTarget.value

  return (
    <div class="sheet" role="dialog" aria-label="Settings">
      <ScreenBody scrolls>
        <div
          style={{
            opacity: target ? 0.22 : 1,
            pointerEvents: target ? 'none' : 'auto',
            display: 'flex',
            flexDirection: 'column',
            flex: '1 1 auto',
          }}
        >
          <div class="row" style={{ marginTop: '8px' }}>
            <h1 style={{ fontSize: 'var(--fs-22)', fontWeight: 500, margin: 0 }}>Settings</h1>
            <span class="spacer" />
            <SheetDismiss onClick={onClose} id="dismissSettings" />
          </div>

          <Group title="PAIRED">
            <PairedDevices />
          </Group>
          <Group title="VIDEO">
            <VideoSection />
          </Group>
          <Group title="TRACKPAD">
            <TrackpadSection />
          </Group>
          <Group title="ACCESS">
            <AccessSection />
          </Group>
          <Group title="THIS BROWSER">
            <BrowserSection />
          </Group>

          <button
            onClick={() =>
              // Goes through the same sheet as a single revoke. Revoking one device
              // asked for confirmation; revoking all of them, including this
              // browser, went straight through on one tap.
              (store.revokeTarget.value = {
                kind: 'everything',
                count: store.devices.value.length,
              })
            }
            style={{
              marginTop: '12px',
              display: 'flex',
              alignItems: 'center',
              minHeight: '54px',
              paddingInline: '18px',
              borderRadius: 'var(--radius-medium)',
              border: '1px solid color-mix(in srgb, var(--lg-red) 40%, transparent)',
            }}
          >
            <span style={{ fontSize: 'var(--fs-15)', color: 'var(--lg-red)' }}>
              Revoke every device
            </span>
            <span class="spacer" />
            {/* Solid, not 70%: the count is the scale of what the tap destroys, and
                the faded version read at 3.4:1. */}
            <Caps size="var(--fs-9)" tracking="0.12em" color="var(--lg-red)">
              {`${store.devices.value.length} KEYS`}
            </Caps>
          </button>

          <Caps
            size="var(--fs-9)"
            tracking="0.12em"
            style={{
              marginTop: '10px',
              paddingBottom: 'calc(40px + var(--safe-bottom))',
              lineHeight: 1.7,
            }}
          >
            {`VIBEWIRE WEB ${store.appVersion} · HOST ${settings.hostVersion} · NO ACCOUNT, NO CLOUD`}
          </Caps>
        </div>
      </ScreenBody>

      {target ? (
        <>
          <div class="scrim" />
          <RevokeConfirm target={target} />
        </>
      ) : null}
    </div>
  )
}

function Group({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <section class="stack" style={{ gap: '10px', marginTop: '20px' }}>
      <Caps size="var(--fs-10)" tracking="0.2em">
        {title}
      </Caps>
      {children}
    </section>
  )
}

// MARK: Paired

function PairedDevices() {
  const devices = store.devices.value

  if (!devices.length) {
    return (
      <Caps size="var(--fs-10)" tracking="0.12em" style={{ minHeight: '50px', display: 'flex', alignItems: 'center' }}>
        NO DEVICES REPORTED BY THE HOST
      </Caps>
    )
  }

  return (
    <div class="stack">
      {devices.map((device) => (
        <div
          key={device.id}
          class="row"
          style={{
            gap: '12px',
            minHeight: '50px',
            paddingBlock: '6px',
            borderBottom: '1px solid var(--lg-chrome)',
          }}
        >
          <DeviceGlyph kind={device.kind} isThisDevice={device.isThisDevice} />
          <span class="stack" style={{ gap: '2px', minWidth: 0 }}>
            <span class="ellipsis" style={{ fontSize: 'var(--fs-15)' }}>
              {device.name}
            </span>
            <Caps
              size="var(--fs-9)"
              tracking="0.12em"
              color={device.isThisDevice ? 'var(--lg-cyan)' : 'var(--lg-text-tertiary)'}
            >
              {device.isThisDevice
                ? `THIS BROWSER · PAIRED ${shortDate(device.pairedAt)}`
                : lastSeenLabel(device)}
            </Caps>
          </span>
          <span class="spacer" style={{ minWidth: '8px' }} />
          {device.isThisDevice ? null : (
            <button
              onClick={() => (store.revokeTarget.value = { kind: 'device', device })}
              style={{
                minHeight: 'var(--target)',
                paddingInline: '14px',
                flex: '0 0 auto',
                borderRadius: 'var(--radius-row)',
                border: '1px solid color-mix(in srgb, var(--lg-red) 40%, transparent)',
              }}
            >
              <Caps size="var(--fs-10)" tracking="0.1em" color="var(--lg-red)">
                REVOKE
              </Caps>
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

function DeviceGlyph({ kind, isThisDevice }: { kind: string; isThisDevice: boolean }) {
  // A browser is a third shape. Drawing it as a phone would put two identical
  // outlines next to each other in the one list whose job is telling them apart.
  const shape =
    kind === 'tablet'
      ? { width: 28, height: 22, radius: 2 }
      : kind === 'browser'
        ? { width: 30, height: 24, radius: 3 }
        : { width: 20, height: 30, radius: 3 }
  return (
    <span
      aria-hidden="true"
      style={{
        width: `${shape.width}px`,
        height: `${shape.height}px`,
        flex: '0 0 auto',
        borderRadius: `${shape.radius}px`,
        border: `1px solid ${isThisDevice ? 'var(--lg-cyan)' : 'var(--lg-text-tertiary)'}`,
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
            aria-selected={settings.quality === ladder}
            onClick={() => store.setQuality(ladder)}
          >
            <Caps
              size="var(--fs-11)"
              color={settings.quality === ladder ? 'var(--lg-cyan)' : 'var(--lg-text-secondary)'}
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
        <span class="spacer" />
        <Caps size="var(--fs-9)" tracking="0.12em" color="var(--lg-text-secondary)">
          DROPS ON ITS OWN
        </Caps>
      </div>

      <SettingRow
        title="Cap on cellular"
        subtitle={
          store.linkMonitor.measured
            ? `CEILING ${Math.round(settings.cellularCeilingMbps)} MB/S`
            : `CEILING ${Math.round(settings.cellularCeilingMbps)} MB/S · THIS BROWSER WILL NOT NAME THE RADIO`
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
        <span style={{ fontSize: 'var(--fs-15)' }}>Sensitivity</span>
        <span class="spacer" />
        <Caps size="var(--fs-11)" tracking="0" color="var(--lg-cyan)">
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
        style={{ gap: '6px' }}
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
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <span
              style={{
                width: '4px',
                height: `${10 + (tick - 1) * 4}px`,
                background: tick <= settings.sensitivity ? 'var(--lg-cyan)' : 'var(--lg-stroke)',
              }}
            />
          </button>
        ))}
        <span class="spacer" />
        <Caps size="var(--fs-9)" tracking="0.1em">
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
      <Hairline color="var(--lg-chrome)" />
      <SettingRow
        title="Relay over internet"
        subtitle={relaySubtitle}
        subtitleColor={settings.relayOverInternet ? 'var(--lg-amber)' : 'var(--lg-text-tertiary)'}
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

  return (
    <Panel tint={storage === 'raw-seed' || decoder !== 'ok' ? 'var(--lg-amber)' : undefined}>
      <div class="stack" style={{ gap: '12px', padding: '16px' }}>
        <FactRow
          label="SIGNING KEY"
          value={
            storage == null
              ? '—'
              : storage === 'non-extractable'
                ? 'NON-EXTRACTABLE'
                : 'RAW SEED IN THIS ORIGIN'
          }
          tone={storage === 'raw-seed' ? 'var(--lg-amber)' : 'var(--lg-green)'}
        />
        <p
          class="wrap"
          style={{
            margin: 0,
            fontSize: 'var(--fs-13)',
            lineHeight: 1.45,
            color: 'var(--lg-text-secondary)',
          }}
        >
          {storage === 'raw-seed'
            ? 'This browser has no WebCrypto Ed25519, so the key is a raw seed in its own storage and script on this origin could read it. The iPhone app keeps its key in the Secure Enclave-backed keychain; this is weaker. Revoking this device on the Mac is what makes a leaked seed worthless.'
            : 'The key was generated non-extractable: this page can ask it to sign and cannot read it back. It never leaves this browser and never syncs.'}
        </p>

        <Hairline color="var(--lg-chrome)" />

        <FactRow
          label="VIDEO DECODER"
          value={decoder === 'ok' ? 'WEBCODECS H.264' : 'MISSING'}
          tone={decoder === 'ok' ? 'var(--lg-green)' : 'var(--lg-amber)'}
        />
        {decoder === 'ok' ? null : (
          <p
            class="wrap"
            style={{
              margin: 0,
              fontSize: 'var(--fs-13)',
              lineHeight: 1.45,
              color: 'var(--lg-on-amber-wash)',
            }}
          >
            This browser has no WebCodecs video decoder, so the picture will not
            arrive. Everything else — pointer, keyboard, clipboard, Claude — still
            works.
          </p>
        )}

        <Hairline color="var(--lg-chrome)" />

        <FactRow label="PAIRED FROM" value={location.origin} tone="var(--lg-text)" />
        <p
          class="wrap"
          style={{
            margin: 0,
            fontSize: 'var(--fs-13)',
            lineHeight: 1.45,
            color: 'var(--lg-text-secondary)',
          }}
        >
          Browser storage is per-origin, so each address you open this client from
          pairs once and appears as its own device on the Mac.
          {paired ? ` This one talks to ${paired.origin}.` : ''}
        </p>
      </div>
    </Panel>
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
  subtitleColor = 'var(--lg-text-tertiary)',
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
    <div class="row" style={{ minHeight: '50px', paddingBlock: '6px' }}>
      <span class="stack" style={{ gap: '2px', minWidth: 0 }}>
        <span style={{ fontSize: 'var(--fs-15)' }}>{title}</span>
        {subtitle ? (
          <Caps size="var(--fs-9)" tracking="0.12em" color={subtitleColor}>
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
 * 07B. Three consequences in plain sentences, including the one that is *not*
 * affected — that last line is what makes a destructive tap safe to make
 * one-handed. The confirming verb is the same word as the button that opened it.
 */
function RevokeConfirm({ target }: { target: RevokeTarget }) {
  const isEverything = target.kind === 'everything'

  const title = isEverything
    ? `REVOKE ALL ${target.count} DEVICES`
    : `REVOKE ${target.device.name.toUpperCase()}`

  const headline = isEverything
    ? 'Every key is deleted on the Mac. There is no undo.'
    : 'Its key is deleted on the Mac. There is no undo.'

  /** The third line is the one that makes the tap safe to judge: for a single
   *  device it says what keeps working, and for all of them it says plainly that
   *  this browser is included, which is the part a one-tap button hid. */
  const consequences: [string, string][] = isEverything
    ? [
        ['Every live session ends inside 1s.', 'var(--lg-red)'],
        ['This browser is included. You will be signed out.', 'var(--lg-red)'],
        ['Pairing again needs physical access to the Mac.', 'var(--lg-red)'],
      ]
    : [
        ['Any live session from that device ends inside 1s.', 'var(--lg-red)'],
        ['Pairing again needs physical access to the Mac.', 'var(--lg-red)'],
        ['This browser keeps working. Nothing else changes.', 'var(--lg-text-tertiary)'],
      ]

  const auditSubject = isEverything
    ? `ALL ${target.count} DEVICES`
    : target.device.name.toUpperCase()
  const auditNoun = isEverything ? (target.count === 1 ? 'KEY' : 'KEYS') : 'KEY'

  return (
    <div
      class="sheet--bottom"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      style={{
        padding: '26px 22px calc(44px + var(--safe-bottom))',
        background: 'var(--lg-raised)',
        borderRadius: '18px 18px 0 0',
        borderTop: '1px solid color-mix(in srgb, var(--lg-red) 34%, transparent)',
      }}
    >
      <div class="stack" style={{ gap: '18px', maxWidth: 'var(--measure)', marginInline: 'auto' }}>
        <span
          aria-hidden="true"
          style={{
            width: '46px',
            height: '4px',
            borderRadius: 'var(--radius-pill)',
            background: 'var(--lg-stroke)',
            marginInline: 'auto',
          }}
        />

        <div class="stack" style={{ gap: '10px' }}>
          <Caps size="var(--fs-10)" tracking="0.18em" color="var(--lg-red)">
            {title}
          </Caps>
          <p class="wrap" style={{ margin: 0, fontSize: 'var(--fs-24)', lineHeight: 1.25 }}>
            {headline}
          </p>
        </div>

        <ul
          class="stack"
          style={{
            gap: '1px',
            margin: 0,
            padding: 0,
            listStyle: 'none',
            background: 'var(--lg-chrome)',
            borderRadius: 'var(--radius-row)',
            overflow: 'hidden',
          }}
        >
          {consequences.map(([text, color]) => (
            <li
              key={text}
              class="row row--baseline"
              style={{ gap: '11px', padding: '13px 14px', background: 'var(--lg-screen)' }}
            >
              <span class="mono" aria-hidden="true" style={{ fontSize: 'var(--fs-10)', color }}>
                ▸
              </span>
              <span
                class="wrap"
                style={{
                  fontSize: 'var(--fs-14)',
                  lineHeight: 1.45,
                  color:
                    color === 'var(--lg-text-tertiary)'
                      ? 'var(--lg-text-secondary)'
                      : 'var(--lg-text)',
                }}
              >
                {text}
              </span>
            </li>
          ))}
        </ul>

        <div class="stack" style={{ gap: '9px' }}>
          <button
            onClick={() => {
              if (target.kind === 'device') store.revoke(target.device)
              else store.revokeAll()
            }}
            style={{
              minHeight: '60px',
              borderRadius: '10px',
              background: 'var(--lg-red)',
              color: 'var(--lg-on-red)',
              fontSize: 'var(--fs-17)',
              fontWeight: 500,
            }}
          >
            {isEverything ? 'Revoke everything' : 'Revoke it'}
          </button>
          <SecondaryAction
            title={isEverything ? 'KEEP THEM PAIRED' : 'KEEP IT PAIRED'}
            onClick={() => (store.revokeTarget.value = null)}
          />
        </div>

        <Caps size="var(--fs-9)" tracking="0.12em" style={{ textAlign: 'center' }}>
          {`HOST WILL LOG: REVOKED · ${auditSubject} · ${auditNoun} DELETED`}
        </Caps>
      </div>
    </div>
  )
}
