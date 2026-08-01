import { useEffect, useRef, useState } from 'preact/hooks'
import { Caps, FilledAction, Group, OutlinedAction, Segmented } from '../../src/design/components'
import { Dial } from './parts'
import { qrURL } from './api'
import { pairOpen, send, type Facts } from './store'

/**
 * Pairing, in the window rather than in a window of its own.
 *
 * This is what replaces starting the host with `--pair` and reading a code out
 * of a terminal: press Create pair, and the six digits, both QRs and the
 * handshake are on the screen already in front of you.
 *
 * The four steps are measured, not animated. `PairingService` records the moment
 * the code was accepted, the moment the public key was found to be a well-formed
 * Ed25519 key, the moment the trust record was written, and — from a different
 * request seconds later — the moment a socket authenticated with that key. A
 * progress bar that advanced on a timer would be this window claiming to watch
 * something it was not watching.
 */
export function PairSheet({ state }: { state: Facts }) {
  const pairing = state.pairing
  const panel = useRef<HTMLDivElement>(null)
  const [name, setName] = useState(pairing.name ?? '')
  const [reusable, setReusable] = useState(pairing.reusable)
  const [qrTick, setQrTick] = useState(0)

  // A fresh code means fresh QR payloads. They are images fetched from the host,
  // so the only way to get new ones is to ask again.
  useEffect(() => {
    setQrTick((value) => value + 1)
  }, [pairing.code])

  // The sheet takes focus when it opens, so the keyboard and a screen reader
  // start inside it rather than behind the scrim.
  useEffect(() => {
    panel.current?.focus()
  }, [])

  function close() {
    pairOpen.value = false
    // Closing the sheet ends the pairing window. A code left live behind a
    // closed sheet is a code nobody is watching.
    void send({ do: 'pair.end' })
  }

  const digits = (pairing.code ?? '——————').split('')
  const spent = !pairing.open && pairing.step > 0
  const done = pairing.step >= 4
  const locked = pairing.lockoutSeconds !== undefined && pairing.lockoutSeconds !== null

  const countdown = locked
    ? `LOCKED ${pairing.lockoutSeconds}S · ${pairing.maxAttempts} WRONG`
    : spent
      ? 'PAIRED · CODE USED'
      : pairing.open
        ? `ROTATES IN ${pairing.secondsRemaining ?? 0}S`
        : 'NO CODE'

  const countdownTint = locked
    ? 'var(--ns-red)'
    : spent
      ? 'var(--ns-green)'
      : 'var(--ns-amber)'

  const subtitle = pairing.failure
    ? 'THE HANDSHAKE STOPPED · THE CODE WAS NOT THE PROBLEM'
    : done
    ? 'PAIRED · TRUST WRITTEN TO THE LOGIN KEYCHAIN · SOCKET OPEN'
    : pairing.step > 0
      ? 'A DEVICE TOOK THE CODE · COMPLETING THE HANDSHAKE'
      : pairing.open
        ? 'SHOW THIS ON THE PHONE · NOTHING IS STORED UNTIL IT COMPLETES'
        : 'PRESS SHOW A CODE TO OPEN A PAIRING WINDOW'

  return (
    <div class="mac-sheet">
      <div class="scrim" onClick={close} style={{ position: 'absolute', inset: 0 }} />
      <div
        ref={panel}
        class="mac-sheet__panel"
        role="dialog"
        aria-modal="true"
        aria-label="Create pair"
        tabIndex={-1}
        onKeyDown={(event) => {
          if (event.key === 'Escape') close()
        }}
      >
        <div class="row row--top" style={{ gap: 16 }}>
          <div class="stack" style={{ gap: 7, minWidth: 0 }}>
            <h2
              style={{
                margin: 0,
                fontSize: 'var(--fs-26)',
                fontWeight: 600,
                letterSpacing: 'var(--title-tracking)',
              }}
            >
              Create pair
            </h2>
            <Caps size="var(--fs-9)">{subtitle}</Caps>
          </div>
          <span class="spacer" />
          <div class="row" style={{ gap: 10, flex: '0 0 auto' }}>
            <Dial
              fraction={
                pairing.open && !spent
                  ? (pairing.secondsRemaining ?? 0) / pairing.rotateSeconds
                  : 0
              }
              tint={countdownTint}
            />
            <Caps size="var(--fs-9)" color={countdownTint}>
              {countdown}
            </Caps>
          </div>
          <button
            type="button"
            onClick={close}
            aria-label="Close"
            class="hoverable"
            style={{
              width: 34,
              height: 34,
              flex: '0 0 auto',
              borderRadius: 'var(--radius-inner)',
              background: 'var(--ns-raised)',
              display: 'grid',
              placeItems: 'center',
              fontFamily: 'var(--ns-mono)',
              color: 'var(--ns-text-secondary)',
            }}
          >
            ✕
          </button>
        </div>

        <div class="digits" style={{ marginTop: 20 }}>
          {digits.map((digit, index) => (
            <div key={index} class={`digit${spent || !pairing.open ? ' digit--spent' : ''}`}>
              {digit}
            </div>
          ))}
        </div>

        {!pairing.open && !spent ? (
          <div class="stack" style={{ gap: 14, marginTop: 14 }}>
            <div class="row" style={{ gap: 10 }}>
              <div
                class="row"
                style={{
                  flex: '1 1 auto',
                  minWidth: 0,
                  height: 44,
                  borderRadius: 'var(--radius-inner)',
                  background: 'var(--ns-raised-2)',
                  gap: 10,
                  paddingInline: 12,
                }}
              >
                <Caps size="var(--fs-9)" style={{ flex: '0 0 auto' }}>
                  NAME
                </Caps>
                <input
                  class="mono"
                  value={name}
                  onInput={(event) => setName((event.target as HTMLInputElement).value)}
                  placeholder="iPhone — bedside"
                  aria-label="Name for the device about to pair"
                  style={{ flex: '1 1 auto', minWidth: 0, fontSize: 'var(--fs-13)' }}
                />
              </div>
              <div style={{ width: 230, flex: '0 0 auto' }}>
                <Segmented
                  label="How many devices this code pairs"
                  selection={reusable ? 'reuse' : 'once'}
                  options={[
                    { value: 'once', label: 'ONE TIME' },
                    { value: 'reuse', label: 'REUSABLE' },
                  ]}
                  onSelect={(value) => setReusable(value === 'reuse')}
                />
              </div>
            </div>
            <Caps size="var(--fs-9)" style={{ lineHeight: 1.6 }}>
              {reusable
                ? 'REUSABLE · THE CODE SURVIVES A SUCCESSFUL PAIR AND KEEPS ROTATING UNTIL THIS SHEET CLOSES · ANY DEVICE THAT READS IT IN TIME PAIRS'
                : 'ONE TIME · THE FIRST DEVICE TO USE THE CODE SPENDS IT · THE NAME ABOVE OVERRIDES WHAT THE DEVICE CALLS ITSELF'}
            </Caps>
            <FilledAction
              title="Show a code"
              tint="var(--ns-accent)"
              ink="var(--ns-on-accent)"
              height={56}
              onClick={() => void send({ do: 'pair.begin', name, reusable })}
            />
          </div>
        ) : (
          <>
            <div class="row" style={{ gap: 14, marginTop: 14, alignItems: 'stretch' }}>
              <QrCard
                kind="app"
                tick={qrTick}
                caption="iPHONE APP"
                tint="var(--ns-accent)"
                blurb="Scan in VibeWire. Custom scheme — a browser cannot open it."
                available={pairing.open}
              />
              <QrCard
                kind="browser"
                tick={qrTick}
                caption={state.addresses.publishedSite ? 'ANY BROWSER · PUBLISHED SITE' : 'ANY BROWSER'}
                tint="var(--ns-green)"
                blurb={`Scan with the phone's own camera. Pairs on load. ${state.addresses.reach}`}
                available={pairing.open && (state.addresses.webBundlePresent || Boolean(state.addresses.publishedSite))}
                unavailableReason="No web build on this host — see web/README.md."
              />
            </div>

            <div class="row" style={{ gap: 10, marginTop: 20 }}>
              <Caps size="var(--fs-9)" tracking="var(--caps-tracking-wide)" color="var(--ns-text-faint)">
                EXCHANGE
              </Caps>
              <span class="dashed-rule spacer" />
            </div>

            <div style={{ marginTop: 10 }}>
              <Group>
                {[
                  ['Code accepted', 'SIX DIGITS'],
                  ['Keys exchanged', 'ED25519'],
                  ['Trust stored', 'LOGIN KEYCHAIN'],
                  ['Socket open', 'CHALLENGE SIGNED'],
                ].map(([title, detail], index) => {
                  const reached = pairing.step > index
                  const stalled = Boolean(pairing.failure) && pairing.step === index
                  const running =
                    !stalled && pairing.step === index && (pairing.open || pairing.step > 0)
                  return (
                    <div
                      key={title}
                      class="group-row"
                      style={{
                        minHeight: 50,
                        gap: 12,
                        background: running
                          ? 'color-mix(in srgb, var(--ns-accent) 10%, transparent)'
                          : 'var(--ns-raised)',
                      }}
                    >
                      <span
                        class={`dot${reached ? '' : ' dot--idle'}${running ? ' dot--pulse' : ''}`}
                        style={{
                          width: 15,
                          height: 15,
                          background: reached ? 'var(--ns-green)' : 'transparent',
                          boxShadow: reached
                            ? 'none'
                            : `inset 0 0 0 1px ${
                                stalled
                                  ? 'var(--ns-red)'
                                  : running
                                    ? 'var(--ns-accent)'
                                    : 'var(--ns-text-disabled)'
                              }`,
                        }}
                      />
                      <span
                        style={{
                          fontSize: 'var(--fs-14)',
                          fontWeight: 500,
                          color:
                            reached || running ? 'var(--ns-text)' : 'var(--ns-text-tertiary)',
                        }}
                      >
                        {title}
                      </span>
                      <span class="spacer" />
                      <Caps
                        size="var(--fs-9)"
                        color={
                          reached
                            ? 'var(--ns-green)'
                            : stalled
                              ? 'var(--ns-red)'
                              : running
                                ? 'var(--ns-accent)'
                                : 'var(--ns-text-disabled)'
                        }
                      >
                        {reached ? detail : stalled ? 'STOPPED' : running ? 'WORKING' : '—'}
                      </Caps>
                    </div>
                  )
                })}
              </Group>
            </div>

            <div class="row" style={{ gap: 12, marginTop: 18 }}>
              <Caps size="var(--fs-9)" style={{ lineHeight: 1.6 }}>
                {pairing.deviceName
                  ? `${pairing.deviceName.toUpperCase()} · ${state.addresses.listening}`
                  : state.addresses.listening}
              </Caps>
              <span class="spacer" />
              <div style={{ flex: '0 0 auto', minWidth: 130 }}>
                {done ? (
                  <FilledAction
                    title="Done"
                    tint="var(--ns-green)"
                    ink="var(--ns-on-green)"
                    height={44}
                    onClick={close}
                  />
                ) : (
                  <OutlinedAction title="CANCEL" height={44} onClick={close} />
                )}
              </div>
            </div>

            {pairing.failure && (
              <div
                class="card card--tinted"
                style={{ marginTop: 14, padding: 16, ['--tint' as string]: 'var(--ns-red)' }}
              >
                <div class="stack" style={{ gap: 9 }}>
                  <Caps size="var(--fs-9)" color="var(--ns-red)">
                    THE CODE WAS ACCEPTED · THE MAC COULD NOT FINISH
                  </Caps>
                  <span
                    style={{
                      fontSize: 'var(--fs-13)',
                      lineHeight: 1.45,
                      color: 'var(--ns-text-secondary)',
                      textWrap: 'pretty',
                    }}
                  >
                    {pairing.failure} Retyping the code will not help; the phone was told so
                    rather than being sent back to check its digits.
                  </span>
                </div>
              </div>
            )}

            {locked && (
              <Caps size="var(--fs-9)" color="var(--ns-red)" style={{ lineHeight: 1.6, marginTop: 12 }}>
                THE CODE ON SCREEN IS STILL CORRECT · THE HOST IS REFUSING EVERY ATTEMPT UNTIL THE
                LOCKOUT ENDS
              </Caps>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/**
 * One QR, and the sentence that says which is which — because a caption under a
 * QR is the thing nobody reads before scanning the wrong one.
 */
function QrCard({
  kind,
  tick,
  caption,
  tint,
  blurb,
  available,
  unavailableReason,
}: {
  kind: 'app' | 'browser'
  tick: number
  caption: string
  tint: string
  blurb: string
  available: boolean
  unavailableReason?: string
}) {
  const [failed, setFailed] = useState(false)

  return (
    <div class="card row row--top" style={{ flex: '1 1 0', padding: 14, gap: 14, minWidth: 0 }}>
      {available && !failed ? (
        <div class="qr-plate">
          <img src={qrURL(kind, tick)} alt="" onError={() => setFailed(true)} />
        </div>
      ) : (
        <div
          class="qr-plate"
          style={{
            background: 'var(--ns-raised-2)',
            display: 'grid',
            placeItems: 'center',
            padding: 8,
          }}
        >
          <Caps size="var(--fs-9)" style={{ textAlign: 'center' }}>
            NO CODE
          </Caps>
        </div>
      )}
      <div class="stack" style={{ gap: 7, minWidth: 0 }}>
        <Caps size="var(--fs-9)" color={tint}>
          {caption}
        </Caps>
        <span
          style={{
            fontSize: 'var(--fs-12)',
            lineHeight: 1.45,
            color: 'var(--ns-text-secondary)',
            textWrap: 'pretty',
          }}
        >
          {available && !failed ? blurb : (unavailableReason ?? blurb)}
        </span>
      </div>
    </div>
  )
}
