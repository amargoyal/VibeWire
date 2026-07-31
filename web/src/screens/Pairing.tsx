/**
 * 01 · PAIRING and 02 · EXCHANGING KEYS.
 * Mirrored by ios/VibeWire/Screens/PairingView.swift.
 *
 * A handshake, not a login: two named machines agreeing to trust each other. No
 * account, no password field, no branding.
 *
 * Nightshift restructured this screen more than any other. It used to be a
 * machine-pair graphic, six boxes, a paste button, two address fields and a
 * discovery line — five things competing to be read first, four of which are
 * usually already correct. It is now one hero and one target card: the six digits
 * are the whole top of the screen, and everything about *where* they are being
 * sent collapses into a single card that states the answer and offers EDIT. The
 * fields still exist; they are just no longer the first thing between the user and
 * the code they are holding in their head.
 *
 * OTHER WAYS IN carries two rows where the phone carries one. Both end in the
 * same call: the QR is a `vibewire://pair?…` link, so reading it with the camera
 * and reading it off the clipboard produce the same string, go through the same
 * `parseLink`, and run the same handshake. What differs is whether this engine can
 * do it at all — see `net/qrScan.ts` — and where it cannot, the row says which
 * part is missing rather than sitting there as a control that does nothing.
 */

import type { ComponentChildren, JSX } from 'preact'
import { useEffect, useRef, useState } from 'preact/hooks'

import { store } from '../app/store'
import {
  Announce,
  Caps,
  Caret,
  CornerTicks,
  Display,
  ScreenBody,
  SectionLabel,
  SheetDismiss,
  Spinner,
  TimelineMark,
  useSheet,
  type TimelineState,
} from '../design/components'
import {
  describe,
  isHostServed,
  parseEndpoint,
  reachability,
  suggestedAddress,
  type Endpoint,
} from '../net/endpoint'
import { describeUnavailable, QrScan, scannerSupport } from '../net/qrScan'

interface ExchangeStep {
  title: string
  detail: string
  state: TimelineState
}

const INITIAL_STEPS: ExchangeStep[] = [
  { title: 'HOST VERIFIED', detail: '—', state: 'pending' },
  { title: 'KEYS EXCHANGED', detail: '—', state: 'pending' },
  { title: 'STORING TRUST', detail: 'THIS BROWSER', state: 'pending' },
  { title: 'FIRST FRAME', detail: 'QUEUED', state: 'pending' },
]

/** The host rotates the pairing code on this cadence, and the dial reports it. */
const CODE_ROTATION_SECONDS = 60

export function Pairing() {
  const [digits, setDigits] = useState('')
  const [address, setAddress] = useState(suggestedAddress)
  const [port, setPort] = useState('8787')
  const [probeMillis, setProbeMillis] = useState<number | null>(null)
  const [exchanging, setExchanging] = useState(false)
  const [steps, setSteps] = useState(INITIAL_STEPS)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [focused, setFocused] = useState(false)
  const [pasting, setPasting] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [editingTarget, setEditingTarget] = useState(false)
  const field = useRef<HTMLInputElement | null>(null)
  // A paste can deliver six digits more than once, and the field submits the
  // moment it holds six. Pairing twice burns the code: the second attempt arrives
  // after the first has consumed it, and the host answers `code_expired` for a
  // code that was in fact correct.
  const submitting = useRef(false)

  const endpoint = tryEndpoint(address, port)
  const blocked = endpoint ? reachability(endpoint) === 'blocked' : false
  const note = endpoint ? describe(endpoint) : null

  // Discovery is worth a request every two seconds while someone is looking at
  // the address field. It is not worth one during the handshake, where the same
  // host is already answering on the same socket, and a probe landing mid-exchange
  // only competes with it.
  useEffect(() => {
    let cancelled = false
    const loop = async () => {
      while (!cancelled) {
        if (!exchanging && endpoint && !blocked) {
          const millis = await store.probe(endpoint)
          if (!cancelled) setProbeMillis(millis)
        } else if (!endpoint || blocked) {
          setProbeMillis(null)
        }
        await new Promise((resolve) => setTimeout(resolve, 2000))
      }
    }
    void loop()
    return () => {
      cancelled = true
    }
  }, [endpoint?.origin, exchanging, blocked])

  useEffect(() => {
    field.current?.focus()
  }, [])

  const submit = async (code: string) => {
    if (submitting.current) return
    if (!endpoint) {
      setErrorText('Enter the Mac’s address first.')
      setEditingTarget(true)
      return
    }
    if (blocked) {
      setErrorText(describe(endpoint))
      setEditingTarget(true)
      return
    }

    submitting.current = true
    setErrorText(null)
    setExchanging(true)
    setSteps(INITIAL_STEPS)

    const advance = (index: number, state: TimelineState, detail?: string) => {
      setSteps((current) =>
        current.map((step, at) =>
          at === index ? { ...step, state, detail: detail ?? step.detail } : step,
        ),
      )
    }

    advance(0, 'done', `${Math.round(probeMillis ?? 0)} MS`)
    advance(1, 'running')

    const failure = await store.completePairing(endpoint, code)
    submitting.current = false

    if (failure) {
      advance(1, 'failed', 'FAILED')
      setErrorText(failure)
      setExchanging(false)
      setDigits('')
      return
    }

    advance(1, 'done', 'ED25519')
    advance(2, 'running')
    await new Promise((resolve) => setTimeout(resolve, 280))
    advance(2, 'done', 'STORED')
    advance(3, 'running', '…')
  }

  /**
   * What a read `vibewire://pair?host=…&port=…&code=…` link does, whichever way
   * it arrived.
   *
   * The address and port are filled in whether or not a code came with them, so a
   * link that carries only an address still leaves the screen pointed at the right
   * Mac and the digits to type by hand.
   */
  const applyParsed = async (parsed: PairingLink) => {
    setAddress(parsed.host)
    if (parsed.port) setPort(parsed.port)
    if (!parsed.code) return
    setDigits(parsed.code)
    const target = tryEndpoint(parsed.host, parsed.port ?? port)
    if (!target) return
    setErrorText(null)
    await submitWith(target, parsed.code)
  }

  /**
   * `vibewire://pair?host=…&port=…&code=…` — what the Mac's QR encodes.
   *
   * A browser cannot register for a custom scheme, so aiming the phone's *system*
   * camera at that QR opens nothing. The two ways in that work are the row below
   * this one — the camera inside this page, where the engine has a barcode reader
   * — and this: the link is three fields and a code, and this reads all four out
   * of it. A plain `http://mac:8787/?host=…&code=…` works too, which is the form
   * to bookmark.
   */
  const applyLink = async () => {
    setPasting(true)
    try {
      const text = await navigator.clipboard.readText()
      const parsed = parseLink(text)
      if (!parsed) {
        setErrorText('That clipboard does not hold a VibeWire pairing link.')
        return
      }
      await applyParsed(parsed)
    } catch {
      setErrorText('The browser would not let this page read the clipboard.')
    } finally {
      setPasting(false)
    }
  }

  /** Same handshake as `submit`, against an endpoint the link supplied rather than
   *  the one the fields hold — which have not re-rendered yet. */
  const submitWith = async (target: Endpoint, code: string) => {
    if (submitting.current) return
    if (reachability(target) === 'blocked') {
      setErrorText(describe(target))
      return
    }
    submitting.current = true
    setExchanging(true)
    setSteps(INITIAL_STEPS)
    const failure = await store.completePairing(target, code)
    submitting.current = false
    if (failure) {
      setErrorText(failure)
      setExchanging(false)
      setDigits('')
    }
  }

  if (exchanging) return <Exchanging digits={digits} steps={steps} />

  // Nothing here knows when the Mac last turned the code over — the rotation
  // phase is not on the wire. What used to be drawn was this tab's own age modulo
  // sixty: a countdown to zero on a code that might have had fifty seconds left,
  // and a dial filling to match it. Both are claims about a phase this client
  // cannot see. The cadence is the fact, and it is the one the reader needs,
  // because it says how long to keep looking at the Mac.

  // Read at render rather than once at module load: this is a fact about the
  // engine and the origin, and the origin is the one thing on this screen that
  // can change under it — a client opened from Pages and then from the Mac is two
  // different answers to the same question.
  const scanner = scannerSupport()
  const noScan = scanner === 'ok' ? null : describeUnavailable(scanner)

  return (
    <>
      <ScreenBody scrolls>
        <header class="row" style={{ minHeight: '34px', flex: '0 0 auto' }}>
          <Caps size="var(--fs-11)" tracking="0.32em" weight={500} color="var(--ns-text-secondary)">
            VibeWire
          </Caps>
        </header>

        <Display style={{ marginTop: '44px', flex: '0 0 auto' }}>
          Six digits
          <br />
          from the menu bar.
        </Display>

        <Caps size="var(--fs-10)" tracking="0.16em" style={{ marginTop: '14px', flex: '0 0 auto' }}>
          MENU BAR → VIBEWIRE → PAIR
        </Caps>

        {/* A single field owns the keyboard; the six boxes are only a rendering of
            its contents. That keeps paste and delete behaving the way they do
            everywhere else. */}
        <div style={{ position: 'relative', marginTop: '34px', flex: '0 0 auto' }}>
          <input
            ref={field}
            value={digits}
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            aria-label="Pairing code, six digits"
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            onInput={(event) => {
              const filtered = (event.currentTarget.value.match(/\d/g) ?? []).join('').slice(0, 6)
              setDigits(filtered)
              if (filtered.length === 6) void submit(filtered)
            }}
            style={{
              position: 'absolute',
              inset: 0,
              width: '100%',
              opacity: 0.01,
              zIndex: 1,
              // Off-screen would stop iOS scrolling it into view; transparent and in
              // place keeps the caret where the boxes are.
              letterSpacing: '2em',
            }}
          />
          <div class="row" style={{ gap: '8px', pointerEvents: 'none' }} aria-hidden="true">
            {[0, 1, 2, 3, 4, 5].map((index) => {
              const active = index === Math.min(digits.length, 5) && focused
              const filled = digits[index] != null
              return (
                <div
                  key={index}
                  style={{
                    // A maximum, not a fixed width. Six boxes and five 8px gaps have
                    // to fit inside the gutter on the narrowest phone this app
                    // targets, and a fixed row overflowed the app's very first screen.
                    flex: '1 1 0',
                    minWidth: 0,
                    height: '84px',
                    borderRadius: 'var(--radius-control)',
                    background: active
                      ? 'color-mix(in srgb, var(--ns-accent) 12%, transparent)'
                      : filled
                        ? 'var(--ns-raised-2)'
                        : 'var(--ns-raised)',
                    boxShadow: active ? 'inset 0 0 0 1.5px var(--ns-accent)' : undefined,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {filled ? (
                    <span class="mono" style={{ fontSize: 'var(--fs-30)' }}>
                      {digits[index]}
                    </span>
                  ) : active ? (
                    <Caret height={30} />
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>

        <div class="row" style={{ gap: '9px', marginTop: '16px', flex: '0 0 auto' }}>
          <Caps size="var(--fs-9)" tracking="0.14em">
            {`THE MAC ROTATES THIS CODE EVERY ${CODE_ROTATION_SECONDS}S`}
          </Caps>
        </div>

        {errorText ? (
          <p
            class="wrap"
            role="alert"
            style={{
              fontSize: 'var(--fs-13)',
              lineHeight: 1.45,
              color: 'var(--ns-red)',
              margin: '16px 0 0',
              userSelect: 'text',
              flex: '0 0 auto',
            }}
          >
            {errorText}
          </p>
        ) : null}

        <TargetCard
          address={address}
          port={port}
          blocked={blocked}
          note={note}
          probeMillis={probeMillis}
          editing={editingTarget}
          onEdit={() => setEditingTarget((current) => !current)}
          onAddress={setAddress}
          onPort={setPort}
        />

        <SectionLabel style={{ marginTop: '26px', flex: '0 0 auto' }}>OTHER WAYS IN</SectionLabel>

        {/* Whichever of these actually works is listed first. Where the engine
            cannot scan, the scan row is a statement rather than a control, and a
            statement of absence sitting above the one working way in reads, for the
            length of a glance, as the way in. */}
        {noScan ? null : (
          <WayIn
            glyph={<QrGlyph />}
            title="Scan the QR on the Mac"
            caption="OPENS CAMERA · SAME HANDSHAKE"
            onClick={() => setScanning(true)}
            label="Scan the QR code"
          />
        )}

        <WayIn
          glyph="⌘V"
          title={pasting ? 'Reading the clipboard…' : 'Paste the pairing link'}
          caption="READS THE QR PAYLOAD · SAME HANDSHAKE"
          onClick={() => void applyLink()}
          disabled={pasting}
          faded={pasting}
          label="Paste a pairing link"
        />

        {noScan ? <WayIn glyph={<QrGlyph />} title={noScan.fact} caption={noScan.caption} /> : null}

        <span class="spacer" style={{ minHeight: '16px' }} />

        <Caps
          size="var(--fs-9)"
          tracking="0.14em"
          color="var(--ns-text-faint)"
          style={{ lineHeight: 1.8, paddingBottom: 'calc(20px + var(--safe-bottom))', flex: '0 0 auto' }}
        >
          {'NO ACCOUNT. NO PASSWORD.\nTHE MAC KEEPS A PUBLIC KEY AND NOTHING REPLAYABLE.'}
        </Caps>
      </ScreenBody>

      {scanning ? (
        <ScanSheet
          onClose={() => setScanning(false)}
          onLink={(parsed) => {
            // The sheet goes first, so the camera is already off by the time the
            // handshake screen replaces this one. `QrScan.stop()` has run by now;
            // unmounting runs it again, which is why it is safe to call twice.
            setScanning(false)
            void applyParsed(parsed)
          }}
        />
      ) : null}
    </>
  )
}

// MARK: - Other ways in

/**
 * The shape both OTHER WAYS IN rows take: a 34 pt glyph tile, one sentence, and a
 * mono-caps line under it.
 *
 * Written once because one of these rows is sometimes not a control at all. A
 * browser with no barcode reader gets the same row saying what is missing, and
 * the only honest way to draw that is as the same object with the tap taken out —
 * a disabled-looking button invites the tap it cannot answer, and a differently
 * shaped notice reads as an error the user caused.
 */
function WayIn({
  glyph,
  title,
  caption,
  onClick,
  disabled = false,
  faded = false,
  label,
}: {
  glyph: ComponentChildren
  title: string
  caption: string
  onClick?: () => void
  disabled?: boolean
  faded?: boolean
  label?: string
}) {
  const box: JSX.CSSProperties = {
    marginTop: '10px',
    display: 'flex',
    alignItems: 'center',
    gap: '14px',
    width: '100%',
    minHeight: 'var(--primary-action)',
    paddingInline: '18px',
    paddingBlock: '12px',
    background: 'var(--ns-raised)',
    borderRadius: 'var(--radius-card)',
    textAlign: 'left',
    flex: '0 0 auto',
    opacity: faded ? 0.6 : 1,
  }

  const face = (
    <>
      <span
        aria-hidden="true"
        class="mono"
        style={{
          width: '34px',
          height: '34px',
          flex: '0 0 auto',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 'var(--radius-inner)',
          background: 'var(--ns-raised-2)',
          // Disabled ink is for dormant indicator fills, and a tile on a row that
          // reports an absence is exactly that.
          color: onClick ? 'var(--ns-text-secondary)' : 'var(--ns-text-disabled)',
          fontSize: 'var(--fs-12)',
        }}
      >
        {glyph}
      </span>
      <span class="stack" style={{ gap: '4px', minWidth: 0 }}>
        <span
          class="wrap"
          style={{
            fontSize: 'var(--fs-15)',
            fontWeight: 500,
            letterSpacing: '-0.01em',
            lineHeight: 1.35,
            color: onClick ? undefined : 'var(--ns-text-secondary)',
          }}
        >
          {title}
        </span>
        <Caps size="var(--fs-9)" tracking="0.1em">
          {caption}
        </Caps>
      </span>
    </>
  )

  if (!onClick) return <div style={box}>{face}</div>

  return (
    <button onClick={onClick} disabled={disabled} aria-label={label} style={box}>
      {face}
    </button>
  )
}

/**
 * Three finder squares and four cells of data.
 *
 * Drawn rather than set in a face: no system font carries this shape, and the
 * only glyph close enough would be a filled square, which is what a dead
 * indicator looks like. Inherits its colour from the tile so the unavailable row
 * dims with the rest of itself.
 */
function QrGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 17 17" aria-hidden="true" style={{ display: 'block' }}>
      {[
        [0, 0],
        [10, 0],
        [0, 10],
      ].map(([x, y]) => (
        <rect
          key={`${x}-${y}`}
          x={x + 0.75}
          y={y + 0.75}
          width="5.5"
          height="5.5"
          fill="none"
          stroke="currentColor"
          stroke-width="1.5"
        />
      ))}
      {[
        [10, 10],
        [14.5, 10],
        [10, 14.5],
        [14.5, 14.5],
      ].map(([x, y]) => (
        <rect key={`d${x}-${y}`} x={x} y={y} width="2" height="2" fill="currentColor" />
      ))}
    </svg>
  )
}

/**
 * The camera, for exactly as long as it takes to read one QR.
 *
 * Everything that can go wrong here has its own sentence, because the four
 * failures want four different things from the person holding the phone: change a
 * site permission, find a machine with a lens, close whatever else is using it,
 * or point it at a different code. `net/qrScan.ts` owns which is which; this
 * screen owns where the sentence goes.
 *
 * A QR that reads cleanly but is not ours is deliberately not a failure of the
 * scan: something was read, correctly, and it belonged to somebody else. The
 * camera stays on and the sentence sits in amber, because the next thing put in
 * front of the lens is usually the right one.
 */
function ScanSheet({
  onClose,
  onLink,
}: {
  onClose: () => void
  onLink: (parsed: PairingLink) => void
}) {
  const sheet = useSheet<HTMLDivElement>(onClose)
  const preview = useRef<HTMLVideoElement | null>(null)
  const [live, setLive] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [foreign, setForeign] = useState<string | null>(null)
  // The effect runs once and must keep running against the current callback
  // without being re-run to get it. A second run is a second camera.
  const deliver = useRef(onLink)
  deliver.current = onLink

  useEffect(() => {
    const video = preview.current
    if (!video) return
    const scan = new QrScan(video, (event) => {
      if (event.kind === 'live') {
        setLive(true)
        return
      }
      if (event.kind === 'failed') {
        setFailure(event.sentence)
        return
      }
      // The same reader the clipboard goes through, so a scan and a paste cannot
      // disagree about what counts as a pairing link.
      const parsed = parseLink(event.text)
      if (!parsed) {
        setForeign('That QR code is not a VibeWire pairing link.')
        return
      }
      // Stopped here rather than left to the unmount below: the handshake takes a
      // second or two, and there is no reason for the lens to be open for any
      // of it.
      scan.stop()
      deliver.current(parsed)
    })
    void scan.start()
    return () => scan.stop()
  }, [])

  return (
    <div
      ref={sheet}
      class="sheet"
      role="dialog"
      aria-modal="true"
      aria-label="Scan the Mac’s QR code"
    >
      <ScreenBody scrolls>
        <Announce>
          {failure ??
            foreign ??
            (live ? 'Camera live. Point it at the QR on the Mac.' : 'Asking for the camera.')}
        </Announce>

        <div class="row" style={{ minHeight: '40px', marginTop: '12px', flex: '0 0 auto' }}>
          <Display level={26} rank={2}>
            Scan the QR
          </Display>
          <span class="spacer" />
          <SheetDismiss onClick={onClose} />
        </div>

        <Caps size="var(--fs-10)" tracking="0.16em" style={{ marginTop: '10px', flex: '0 0 auto' }}>
          MENU BAR → VIBEWIRE → PAIR
        </Caps>

        {/* `contain`, not `cover`. The detector reads the whole frame, and a
            preview cropped to fill the box would show less than is being read —
            which would make the corner ticks, whose one job is marking where the
            real pixels end, mark the wrong place. */}
        <div
          style={{
            position: 'relative',
            marginTop: '18px',
            flex: '1 1 auto',
            minHeight: '240px',
            background: 'var(--ns-deep)',
            borderRadius: 'var(--radius-card)',
            overflow: 'hidden',
          }}
        >
          <video
            ref={preview}
            muted
            playsInline
            autoPlay
            style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }}
          />
          {live ? <CornerTicks color="var(--ns-text-tertiary)" /> : null}
        </div>

        {/* No jade on a working camera. Jade, sodium and clay report the *Mac's*
            condition, and a lens on this device is not one of the things they are
            about — a green READING here would be the first place in the app where
            jade meant something other than "the Mac is reachable". A refusal takes
            clay because the path really is gone, and the spinner keeps its violet:
            waiting for a permission the user was just asked for is the user's own
            state, which is exactly what violet is for. */}
        <div class="row" style={{ gap: '9px', marginTop: '16px', minHeight: '20px', flex: '0 0 auto' }}>
          {failure || live ? null : <Spinner size={16} />}
          <Caps
            size="var(--fs-9)"
            tracking="0.14em"
            color={failure ? 'var(--ns-red)' : live ? 'var(--ns-text-secondary)' : undefined}
          >
            {failure ? 'CAMERA STOPPED' : live ? 'READING · POINT AT THE MAC' : 'ASKING FOR THE CAMERA'}
          </Caps>
        </div>

        {(failure ?? foreign) ? (
          <p
            class="wrap"
            role="alert"
            style={{
              margin: '12px 0 0',
              fontSize: 'var(--fs-13)',
              lineHeight: 1.45,
              color: failure ? 'var(--ns-red)' : 'var(--ns-on-amber-wash)',
              userSelect: 'text',
              flex: '0 0 auto',
            }}
          >
            {failure ?? foreign}
          </p>
        ) : null}

        <Caps
          size="var(--fs-9)"
          tracking="0.14em"
          color="var(--ns-text-faint)"
          style={{
            marginTop: '18px',
            lineHeight: 1.8,
            paddingBottom: 'calc(20px + var(--safe-bottom))',
            flex: '0 0 auto',
          }}
        >
          {'THE CAMERA STOPS THE MOMENT A CODE IS READ.\nFRAMES ARE READ IN THIS PAGE AND SENT NOWHERE.'}
        </Caps>
      </ScreenBody>
    </div>
  )
}

/**
 * Where the six digits are about to go.
 *
 * One card doing what a status line and two labelled fields used to do between
 * them. Discovery is reported in its own header — if the Mac were not there, this
 * says so rather than accepting six digits into a void — and the address is a
 * value to read, not a field to fill, until EDIT says otherwise. The fields are
 * one tap away and open by themselves when a submit fails for want of an address.
 */
function TargetCard({
  address,
  port,
  blocked,
  note,
  probeMillis,
  editing,
  onEdit,
  onAddress,
  onPort,
}: {
  address: string
  port: string
  blocked: boolean
  note: string | null
  probeMillis: number | null
  editing: boolean
  onEdit: () => void
  onAddress: (value: string) => void
  onPort: (value: string) => void
}) {
  const hostServed = isHostServed()

  const discovery = (() => {
    if (blocked) {
      return {
        color: 'var(--ns-amber)',
        text: 'BROWSER WILL NOT OPEN THAT SCHEME',
        square: false,
      }
    }
    if (probeMillis != null) {
      return {
        color: 'var(--ns-green)',
        text: `HOST FOUND · ${Math.round(probeMillis)} MS`,
        square: false,
      }
    }
    if (address.trim()) {
      return { color: 'var(--ns-red)', text: 'NOTHING ANSWERING', square: true }
    }
    return { color: 'var(--ns-text-tertiary)', text: 'NO ADDRESS YET', square: false }
  })()

  return (
    <div
      class="card"
      style={{
        marginTop: '30px',
        padding: '16px 18px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: '11px',
        flex: '0 0 auto',
      }}
    >
      <div class="row" style={{ gap: '9px' }}>
        <span
          class={discovery.square ? 'dot dot--square' : 'dot'}
          aria-hidden="true"
          style={{ width: '7px', height: '7px', background: discovery.color }}
        />
        <Caps size="var(--fs-9)" tracking="0.16em" color={discovery.color} weight={500}>
          {discovery.text}
        </Caps>
        <span class="spacer" style={{ minWidth: '8px' }} />
        <button
          onClick={onEdit}
          aria-expanded={editing}
          aria-label="Edit the Mac’s address"
          style={{
            minHeight: 'var(--target)',
            paddingInline: '10px',
            marginBlock: '-12px',
            marginInlineEnd: '-10px',
            display: 'flex',
            alignItems: 'center',
            flex: '0 0 auto',
          }}
        >
          <Caps size="var(--fs-9)" tracking="0.14em" color="var(--ns-accent)">
            {editing ? 'DONE' : 'EDIT'}
          </Caps>
        </button>
      </div>

      {editing ? (
        <div class="row" style={{ gap: '8px' }}>
          <input
            value={address}
            placeholder="192.168.1.24, mac.tailnet.ts.net, or https://…"
            spellcheck={false}
            autocapitalize="none"
            autocorrect="off"
            inputMode="url"
            aria-label="The Mac’s address"
            onInput={(event) => onAddress(event.currentTarget.value)}
            class="mono"
            style={fieldStyle}
          />
          <input
            value={port}
            placeholder="8787"
            inputMode="numeric"
            aria-label="Port"
            onInput={(event) => onPort(event.currentTarget.value)}
            class="mono"
            style={{ ...fieldStyle, width: '72px', flex: '0 0 auto', textAlign: 'center' }}
          />
        </div>
      ) : (
        <span
          class="mono ellipsis"
          style={{ fontSize: 'var(--fs-14)', letterSpacing: '-0.01em' }}
        >
          {address.trim() ? `${address}:${port}` : 'No address'}
        </span>
      )}

      {note ? (
        <p
          class="wrap"
          style={{
            margin: 0,
            fontSize: 'var(--fs-13)',
            lineHeight: 1.45,
            color: 'var(--ns-on-amber-wash)',
          }}
        >
          {note}
        </p>
      ) : (
        <Caps size="var(--fs-9)" tracking="0.1em" style={{ lineHeight: 1.5 }}>
          {hostServed
            ? 'THIS PAGE IS SERVED BY THE HOST · SAME ORIGIN'
            : 'THE CODE AND THE KEYS GO TO THIS ADDRESS ONLY'}
        </Caps>
      )}
    </div>
  )
}

const fieldStyle = {
  flex: '1 1 auto',
  minWidth: 0,
  fontSize: 'var(--fs-13)',
  paddingInline: '12px',
  minHeight: 'var(--target)',
  background: 'var(--ns-raised-2)',
  borderRadius: 'var(--radius-inner)',
  color: 'var(--ns-text)',
}

// MARK: 02 — exchanging

/**
 * Four named steps with real values rather than one indeterminate spinner. If step
 * three fails, the failure has an address.
 *
 * The digits stay on screen and go dim: the code has been accepted and is no
 * longer something to act on, but removing it mid-handshake makes the screen look
 * like it started over.
 */
function Exchanging({ digits, steps }: { digits: string; steps: ExchangeStep[] }) {
  // Which step the handshake is on, spoken once as it changes. The sixth digit
  // replaces the whole screen, so a reader who was typing lands here with the
  // field they were in gone and nothing said about where they are.
  const running = steps.find((step) => step.state === 'running')
  const failed = steps.find((step) => step.state === 'failed')

  return (
    <ScreenBody scrolls>
      <Announce>
        {failed
          ? `Handshake failed at ${failed.title.toLowerCase()}.`
          : running
            ? `Trading keys. ${running.title.toLowerCase()}.`
            : 'Trading keys.'}
      </Announce>
      <header class="row" style={{ minHeight: '34px', flex: '0 0 auto' }}>
        <Caps size="var(--fs-11)" tracking="0.32em" weight={500} color="var(--ns-text-secondary)">
          VibeWire
        </Caps>
      </header>

      <Display style={{ marginTop: '44px', flex: '0 0 auto' }}>Trading keys.</Display>

      <Caps size="var(--fs-10)" tracking="0.16em" style={{ marginTop: '14px', flex: '0 0 auto' }}>
        CODE ACCEPTED · KEEP BOTH MACHINES AWAKE
      </Caps>

      <div class="row" style={{ gap: '8px', marginTop: '34px', flex: '0 0 auto' }} aria-hidden="true">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <div
            key={index}
            style={{
              flex: '1 1 0',
              minWidth: 0,
              height: '84px',
              borderRadius: 'var(--radius-control)',
              background: 'var(--ns-raised)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <span
              class="mono"
              style={{ fontSize: 'var(--fs-30)', color: 'var(--ns-text-tertiary)' }}
            >
              {digits[index] ?? ''}
            </span>
          </div>
        ))}
      </div>

      <ol
        class="group"
        style={{ margin: '34px 0 0', padding: 0, listStyle: 'none', flex: '0 0 auto' }}
        aria-label="Handshake progress"
      >
          {steps.map((step) => (
            <li
              key={step.title}
              class="row"
              style={{
                gap: '14px',
                minHeight: '64px',
                paddingInline: '18px',
                background:
                  step.state === 'running'
                    ? 'color-mix(in srgb, var(--ns-accent) 10%, transparent)'
                    : 'var(--ns-raised)',
              }}
            >
              <StepMarker state={step.state} />
              <Caps
                size="var(--fs-11)"
                tracking="0.12em"
                color={
                  step.state === 'pending'
                    ? 'var(--ns-text-tertiary)'
                    : step.state === 'running'
                      ? 'var(--ns-text)'
                      : 'var(--ns-text-secondary)'
                }
              >
                {step.title}
              </Caps>
              <span class="spacer" style={{ minWidth: '8px' }} />
              <Caps size="var(--fs-10)" tracking="0" color={detailColor(step.state)}>
                {step.detail}
              </Caps>
            </li>
          ))}
      </ol>

      <span class="spacer" style={{ minHeight: '16px' }} />

      <Caps
        size="var(--fs-9)"
        tracking="0.14em"
        color="var(--ns-text-faint)"
        style={{ paddingBottom: 'calc(20px + var(--safe-bottom))', lineHeight: 1.8, flex: '0 0 auto' }}
      >
        {'PAIRING TRAFFIC STAYS ON THE PATH YOU CHOSE.\nYOU WILL NOT SEE THIS SCREEN AGAIN.'}
      </Caps>
    </ScreenBody>
  )
}

function detailColor(state: TimelineState): string {
  switch (state) {
    case 'running':
      return 'var(--ns-accent)'
    case 'failed':
      return 'var(--ns-red)'
    case 'done':
      return 'var(--ns-text-secondary)'
    default:
      return 'var(--ns-text-faint)'
  }
}

/** The step ring, sized for a 64px row rather than for a timeline rail. */
function StepMarker({ state }: { state: TimelineState }) {
  if (state === 'running') return <Spinner size={20} />
  return (
    <span style={{ position: 'relative', width: '20px', height: '20px', flex: '0 0 auto' }}>
      <span style={{ position: 'absolute', inset: 0 }}>
        <TimelineMark state={state} />
      </span>
    </span>
  )
}

// MARK: - Helpers

function tryEndpoint(address: string, port: string): Endpoint | null {
  if (!address.trim()) return null
  try {
    const fallback = Number(port)
    return parseEndpoint(address, Number.isFinite(fallback) && fallback > 0 ? fallback : 8787)
  } catch {
    return null
  }
}

/** The three fields the Mac's QR carries, once one has been read out of it. */
interface PairingLink {
  host: string
  port: string | null
  code: string | null
}

function parseLink(text: string): PairingLink | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  // `vibewire://pair?…` is not a hierarchical URL every engine will parse the same
  // way, so the query is taken off the end by hand.
  const questionMark = trimmed.indexOf('?')
  if (questionMark < 0) return null
  const parameters = new URLSearchParams(trimmed.slice(questionMark + 1))
  const code = parameters.get('code')

  // The Mac draws two QRs, and the one meant for a browser is an ordinary URL to
  // the host itself — `http://mac:8787/?code=482917`, with no `host` parameter,
  // because the address is the link. Refusing a payload with no `host` rejected
  // exactly the code this scanner was built to read, while the app's own
  // deep-link handler had always accepted it by falling back to the origin.
  const host = parameters.get('host') ?? hostFromURL(trimmed)
  if (!host) return null

  return {
    host,
    port: parameters.get('port') ?? portFromURL(trimmed),
    code: code && code.length === 6 ? code : null,
  }
}

/** The authority of a payload that is itself a URL to the Mac. */
function hostFromURL(text: string): string | null {
  try {
    const url = new URL(text)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.hostname : null
  } catch {
    return null
  }
}

function portFromURL(text: string): string | null {
  try {
    const url = new URL(text)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return url.port || (url.protocol === 'https:' ? '443' : '80')
  } catch {
    return null
  }
}
