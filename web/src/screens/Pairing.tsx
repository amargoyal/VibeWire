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
 */

import { useEffect, useRef, useState } from 'preact/hooks'

import { store } from '../app/store'
import {
  Caps,
  Caret,
  Display,
  RotatesIn,
  ScreenBody,
  SectionLabel,
  Spinner,
  TimelineMark,
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
   * `vibewire://pair?host=…&port=…&code=…` — what the Mac's QR encodes.
   *
   * A browser cannot register for a custom scheme, so scanning that QR with a
   * phone camera opens nothing here. Pasting it does the same job: the link is
   * three fields and a code, and this reads all four out of it. A plain
   * `http://mac:8787/?host=…&code=…` works too, which is the form to bookmark.
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
      setAddress(parsed.host)
      if (parsed.port) setPort(parsed.port)
      if (parsed.code) {
        setDigits(parsed.code)
        const target = tryEndpoint(parsed.host, parsed.port ?? port)
        if (target) {
          setErrorText(null)
          await submitWith(target, parsed.code)
        }
      }
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

  // The dial is driven off the store's one-second tick rather than a timer of its
  // own. It reports the host's rotation cadence, not a countdown this client
  // started — nothing here knows when the Mac last turned the code over, so the
  // dial says "there is about this much of a window left", which is the only
  // honest version of the fact.
  const secondsLeft = CODE_ROTATION_SECONDS - (store.tick.value % CODE_ROTATION_SECONDS)

  return (
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
        <RotatesIn fraction={secondsLeft / CODE_ROTATION_SECONDS} />
        <Caps size="var(--fs-9)" tracking="0.14em">
          ROTATES IN
        </Caps>
        <Caps size="var(--fs-9)" tracking="0.14em" color="var(--ns-amber)">
          {`${secondsLeft}S`}
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

      <button
        onClick={() => void applyLink()}
        disabled={pasting}
        style={{
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
          opacity: pasting ? 0.6 : 1,
        }}
        aria-label="Paste a pairing link"
      >
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
            color: 'var(--ns-text-secondary)',
            fontSize: 'var(--fs-12)',
          }}
        >
          ⌘V
        </span>
        <span class="stack" style={{ gap: '4px', minWidth: 0 }}>
          <span style={{ fontSize: 'var(--fs-15)', fontWeight: 500, letterSpacing: '-0.01em' }}>
            {pasting ? 'Reading the clipboard…' : 'Paste the pairing link'}
          </span>
          <Caps size="var(--fs-9)" tracking="0.1em">
            READS THE QR PAYLOAD · SAME HANDSHAKE
          </Caps>
        </span>
      </button>

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
  return (
    <ScreenBody scrolls>
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

function parseLink(text: string): { host: string; port: string | null; code: string | null } | null {
  const trimmed = text.trim()
  if (!trimmed) return null
  // `vibewire://pair?…` is not a hierarchical URL every engine will parse the same
  // way, so the query is taken off the end by hand.
  const questionMark = trimmed.indexOf('?')
  if (questionMark < 0) return null
  const parameters = new URLSearchParams(trimmed.slice(questionMark + 1))
  const host = parameters.get('host')
  if (!host) return null
  const code = parameters.get('code')
  return {
    host,
    port: parameters.get('port'),
    code: code && code.length === 6 ? code : null,
  }
}
