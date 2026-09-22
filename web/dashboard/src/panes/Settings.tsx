import { Caps, Card, OutlinedAction, Segmented, Toggle } from '../../../src/design/components'
import { Kv, PaneHeading, RuledLabel } from '../parts'
import { bytes, fingerprint } from '../format'
import { send, type Facts } from '../store'
import { useState } from 'preact/hooks'
import { signOut } from '../../../src/net/account'

/**
 * 06 · SETTINGS.
 *
 * The same values `~/.config/vibewire/config.json` holds and the same path the
 * phone writes them through, so a change made here and a change made there
 * cannot end up disagreeing — both persist, both retune the encoder, and both
 * tell the attached phone the new value.
 *
 * Two rows are readouts rather than controls, and say so: the port needs a
 * restart to take effect, and Face ID governs the iPhone app, which is not this
 * process's to toggle on the phone's behalf mid-session.
 */
export function Settings({ state }: { state: Facts }) {
  const settings = state.settings
  if (!settings) {
    return (
      <div class="pane" data-screen-label="Settings">
        <Caps size="var(--fs-9)">THE HOST HAS NOT REPORTED ITS SETTINGS</Caps>
      </div>
    )
  }

  return (
    <div class="pane" data-screen-label="Settings">
      <PaneHeading
        title="Settings"
        caption="WRITTEN TO ~/.CONFIG/VIBEWIRE/CONFIG.JSON · PORT CHANGES NEED A RESTART"
      />

      <div class="settings-grid">
        <Section title="SERVING">
          <Row label="Port" value={`${settings.port} · RESTART TO CHANGE`} />
          <Row
            label="Relay over the internet"
            value="CLOUDFLARE TUNNEL · OFF BY DEFAULT"
            toggle={{
              on: settings.relayOverInternet,
              onChange: (on) => void send({ do: 'setting.set', key: 'relayOverInternet', value: on }),
            }}
          />
          <Row
            label="Web client"
            value={
              state.host.webBundle.present
                ? `SERVED · ${bytes(state.host.webBundle.bytes)}`
                : 'NOT BUILT ON THIS HOST'
            }
          />
        </Section>

        <Section title="PICTURE">
          <Row
            label="Quality ladder"
            value={settings.quality === 'auto' ? 'AUTO · CHOSEN FROM THE LINK' : `${settings.quality}P FIXED`}
          >
            <div class="settings-control">
              <Segmented
                label="Quality ladder"
                selection={settings.quality}
                options={[
                  { value: 'auto', label: 'AUTO' },
                  { value: '1080', label: '1080' },
                  { value: '720', label: '720' },
                  { value: '540', label: '540' },
                ]}
                onSelect={(value) => void send({ do: 'setting.set', key: 'quality', value })}
              />
            </div>
          </Row>
          <Row
            label="Cellular cap"
            value={`${settings.cellularCeilingMbps} MB/S CEILING · HONOURED ONLY WHEN THE PHONE SAYS IT IS ON CELLULAR`}
            toggle={{
              on: settings.capOnCellular,
              onChange: (on) => void send({ do: 'setting.set', key: 'capOnCellular', value: on }),
            }}
          />
          <Row label="Target frame rate" value={`${settings.targetFps} FPS`} />
        </Section>

        <Section title="INPUT">
          <Row label="Sensitivity" value={`${settings.sensitivity} OF 8`}>
            <div class="settings-control">
              <Segmented
                label="Sensitivity"
                selection={settings.sensitivity}
                options={[2, 4, 6, 8].map((tick) => ({ value: tick, label: String(tick) }))}
                onSelect={(value) => void send({ do: 'setting.set', key: 'sensitivity', value })}
              />
            </div>
          </Row>
          <Row
            label="Natural scrolling"
            value="MATCHES THE MAC'S OWN DIRECTION"
            toggle={{
              on: settings.naturalScrolling,
              onChange: (on) => void send({ do: 'setting.set', key: 'naturalScrolling', value: on }),
            }}
          />
        </Section>

        <Section title="UPDATES">
          <Row
            label="Check for a newer VibeWire"
            value={updateLine(state)}
            toggle={{
              on: settings.checkForUpdates,
              onChange: (on) => void send({ do: 'setting.set', key: 'checkForUpdates', value: on }),
            }}
          />
          <Row label="Releases" value={installLine(state)}>
            <div class="settings-actions">
              <div style={{ width: 150 }}>
                <OutlinedAction
                  title="CHECK NOW"
                  height={40}
                  onClick={() => void send({ do: 'update.check' })}
                />
              </div>
              {state.update?.available && state.update.canInstall && state.update.installable ? (
                <div style={{ width: 190 }}>
                  <OutlinedAction
                    title="UPDATE AND RESTART"
                    tint="var(--ns-accent)"
                    height={40}
                    onClick={() => void send({ do: 'update.install' })}
                  />
                </div>
              ) : null}
              <div style={{ width: 150 }}>
                <OutlinedAction
                  title="OPEN RELEASES"
                  height={40}
                  onClick={() => void send({ do: 'update.open' })}
                />
              </div>
            </div>
          </Row>
        </Section>

        {state.accountEmail !== undefined && <AccountSection email={state.accountEmail} />}

        <Section title="TRUST">
          <Row
            label="Face ID each session"
            value="GOVERNS THE iPHONE APP ONLY"
            toggle={{
              on: settings.requireBiometricEachSession,
              onChange: (on) =>
                void send({ do: 'setting.set', key: 'requireBiometricEachSession', value: on }),
            }}
          />
          {settings.accountsAvailable ? (
            <Row
              label="Require a signed-in browser"
              value={
                !settings.requireAccount
                  ? 'PAIRING ALONE IS ENOUGH'
                  : settings.accountOwnerEmail
                    ? `THIS COMPUTER BELONGS TO ${settings.accountOwnerEmail.toUpperCase()}`
                    : 'THE NEXT ACCOUNT TO SIGN IN CLAIMS THIS COMPUTER'
              }
              toggle={{
                on: settings.requireAccount,
                onChange: (on) =>
                  void send({ do: 'setting.set', key: 'requireAccount', value: on }),
              }}
            />
          ) : null}
          <Row
            label="Paired devices"
            value={
              state.devicesReadable === 'yes'
                ? `${state.devices.length} · LOGIN KEYCHAIN`
                : state.devicesReadable === 'asking'
                  ? 'ASKING THE KEYCHAIN'
                  : 'THE KEYCHAIN DID NOT ANSWER'
            }
          />
        </Section>

        <div class="stack" style={{ gap: 10 }}>
          <RuledLabel>PERMISSIONS</RuledLabel>
          <Card style={{ padding: '16px 18px' }}>
            <div class="stack" style={{ gap: 11 }}>
              <Permission
                label="SCREEN RECORDING"
                granted={state.permissions.screenRecording}
                loss="ScreenCaptureKit has no frames to send, so the phone shows an empty picture."
                onGrant={() => void send({ do: 'permission.request', which: 'screen' })}
              />
              <Permission
                label="ACCESSIBILITY"
                granted={state.permissions.accessibility}
                loss="Taps and keystrokes are posted and silently dropped. The pointer never moves."
                onGrant={() => void send({ do: 'permission.request', which: 'accessibility' })}
              />
            </div>
          </Card>
        </div>

        <div class="stack" style={{ gap: 10 }}>
          <RuledLabel>THIS HOST</RuledLabel>
          <Card style={{ padding: '16px 18px' }}>
            <div class="stack" style={{ gap: 4 }}>
              <Kv label="VERSION" value={state.host.version} />
              <Kv label="PROTOCOL" value={String(state.host.protocol)} />
              <Kv label="MACHINE" value={`${state.host.model} · MACOS ${state.host.os}`} />
              <Kv label="HOST KEY" value={fingerprint(state.host.hostKey)} color="var(--ns-text-secondary)" />
              <Kv
                label="WEB BUNDLE"
                value={
                  state.host.webBundle.present ? bytes(state.host.webBundle.bytes) : 'NOT BUILT'
                }
                color={state.host.webBundle.present ? 'var(--ns-green)' : 'var(--ns-text-tertiary)'}
              />
              <Kv
                label="THIS WINDOW"
                value={
                  state.host.dashboardBundle.present
                    ? bytes(state.host.dashboardBundle.bytes)
                    : 'NOT BUILT'
                }
                color="var(--ns-text-secondary)"
              />
              <Kv
                label="PUBLISHED SITE"
                value={state.addresses.publishedSite || null}
                color="var(--ns-text-secondary)"
              />
            </div>
          </Card>
        </div>
      </div>
    </div>
  )
}

/**
 * What pressing UPDATE AND RESTART would do, said before it is pressed.
 *
 * The old line said NOTHING IS INSTALLED FOR YOU, which stopped being true.
 * What replaces it is not a promise: it names the two checks, because they are
 * the reason this is safe to press on a build Apple never notarized.
 */
function installLine(state: Facts): string {
  const update = state.update
  if (!update?.available) return 'THE CHECKSUM AND THE SIGNATURE ARE CHECKED BEFORE ANYTHING IS REPLACED'
  if (update.stage === 'failed') {
    return `LAST ATTEMPT FAILED · ${(update.problem ?? 'NO REASON GIVEN').toUpperCase()}`
  }
  if (!update.canInstall) return 'THIS COPY CANNOT REPLACE ITSELF · OPEN THE RELEASE INSTEAD'
  if (!update.installable) return 'THAT RELEASE HAS NO DISK IMAGE AND CHECKSUM · OPEN THE RELEASE INSTEAD'
  return 'REPLACES THIS APP AFTER CHECKING THE CHECKSUM AND THE SIGNATURE'
}

/** One line about updates, whichever of the four states the host is in. */
function updateLine(state: Facts): string {
  const update = state.update
  if (!update) return 'NOT ASKED'
  if (!update.enabled) return 'OFF · THIS HOST NEVER ASKS'
  if (update.stage && update.stage !== 'idle' && update.stage !== 'failed') {
    return `INSTALLING ${update.latest ?? ''} · ${update.stage.toUpperCase()}`
  }
  if (update.available && update.latest) return `${update.latest} IS OUT · RUNNING ${update.current}`
  if (update.problem) return `COULD NOT ASK · ${update.problem.toUpperCase()}`
  if (update.latest) return `UP TO DATE · ${update.current}`
  return 'ASKING GITHUB'
}

function Section({ title, children }: { title: string; children: preact.ComponentChildren }) {
  return (
    <div class="stack" style={{ gap: 10 }}>
      <RuledLabel>{title}</RuledLabel>
      <div class="group">{children}</div>
    </div>
  )
}

function Row({
  label,
  value,
  toggle,
  children,
}: {
  label: string
  value: string
  toggle?: { on: boolean; onChange: (on: boolean) => void }
  children?: preact.ComponentChildren
}) {
  return (
    <div class={`group-row settings-row${children ? " settings-row--control" : ""}`} style={{ minHeight: 62, gap: 14 }}>
      <span class="stack" style={{ gap: 4, minWidth: 0 }}>
        <span style={{ fontSize: 'var(--fs-15)', fontWeight: 500 }}>{label}</span>
        <Caps size="var(--fs-9)" class="settings-value" title={value}>
          {value}
        </Caps>
      </span>
      <span class="spacer" />
      {children}
      {toggle && <Toggle label={label} isOn={toggle.on} onChange={toggle.onChange} />}
    </div>
  )
}

/**
 * A permission that is granted is named and quiet; one that is not carries the
 * loss it causes and the way to fix it. Neither is a green tick — nothing here
 * is being congratulated.
 */
function Permission({
  label,
  granted,
  loss,
  onGrant,
}: {
  label: string
  granted: boolean
  loss: string
  onGrant: () => void
}) {
  if (granted) {
    return (
      <Caps size="var(--fs-9)" color="var(--ns-text-secondary)" weight={500}>
        {`${label} · GRANTED`}
      </Caps>
    )
  }
  return (
    <div class="stack" style={{ gap: 9 }}>
      <Caps size="var(--fs-9)" color="var(--ns-amber)" weight={500}>
        {`${label} · NOT GRANTED`}
      </Caps>
      <span style={{ fontSize: 'var(--fs-12)', lineHeight: 1.45, color: 'var(--ns-text-secondary)' }}>
        {loss}
      </span>
      <OutlinedAction title="GRANT…" tint="var(--ns-amber)" edge="var(--ns-amber)" onClick={onGrant} />
    </div>
  )
}

/**
 * Who this Mac is signed in as, and the way out.
 *
 * Signing out unpairs every device, so it asks once before doing it. The
 * second press is the confirmation, in place, rather than a dialog this
 * window's web view may not draw.
 */
function AccountSection({ email }: { email: string }) {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  async function signOutOfMac() {
    setBusy(true)
    await signOut()
    await send({ do: 'account.signOut' })
    setBusy(false)
    setConfirming(false)
  }

  return (
    <Section title="ACCOUNT">
      <Row
        label={email || 'Signed in'}
        value={confirming ? 'SIGNING OUT UNPAIRS EVERY DEVICE' : 'SIGNED IN ON THIS MAC'}
      >
        <span class="row" style={{ gap: 8 }}>
          {confirming && (
            <OutlinedAction title="CANCEL" height={40} enabled={!busy} onClick={() => setConfirming(false)} />
          )}
          <OutlinedAction
            title={confirming ? (busy ? 'SIGNING OUT…' : 'SIGN OUT AND UNPAIR') : 'SIGN OUT'}
            height={40}
            enabled={!busy}
            onClick={() => (confirming ? void signOutOfMac() : setConfirming(true))}
          />
        </span>
      </Row>
    </Section>
  )
}
