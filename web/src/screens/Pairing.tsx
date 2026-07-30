/**
 * 01A · PAIRING · WAITING and 01B · PAIRING · EXCHANGING.
 * Ported from ios/VibeWire/Screens/PairingView.swift.
 *
 * A handshake, not a login: two named machines agreeing to trust each other. No
 * account, no password field, no branding.
 */

import { useEffect, useRef, useState } from 'preact/hooks'

import { store } from '../app/store'
import {
  Caps,
  Caret,
  Hairline,
  ScreenBody,
  Spinner,
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
  state: 'pending' | 'running' | 'done' | 'failed'
}

const INITIAL_STEPS: ExchangeStep[] = [
  { title: 'HOST VERIFIED', detail: '—', state: 'pending' },
  { title: 'KEYS EXCHANGED', detail: '—', state: 'pending' },
  { title: 'STORING TRUST IN THIS BROWSER', detail: '—', state: 'pending' },
  { title: 'FIRST FRAME', detail: 'QUEUED', state: 'pending' },
]

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
      return
    }
    if (blocked) {
      setErrorText(describe(endpoint))
      return
    }

    submitting.current = true
    setErrorText(null)
    setExchanging(true)
    setSteps(INITIAL_STEPS)

    const advance = (index: number, state: ExchangeStep['state'], detail?: string) => {
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

  return (
    <ScreenBody scrolls>
      <Caps size="var(--fs-13)" tracking="0.36em" weight={500} style={{ marginTop: '12px' }}>
        VibeWire
      </Caps>

      <MachinePair active={false} />

      <h1
        style={{
          fontSize: 'var(--fs-27)',
          fontWeight: 400,
          margin: '34px 0 0',
          lineHeight: 1.2,
        }}
      >
        Type the six digits
        <br />
        on your Mac.
      </h1>

      <div class="stack" style={{ gap: '2px', marginTop: '12px' }}>
        <Caps size="var(--fs-11)" tracking="0.04em">
          MENU BAR → VIBEWIRE → PAIR
        </Caps>
        <span class="row" style={{ gap: '4px' }}>
          <Caps size="var(--fs-11)" tracking="0.04em">
            CODE ROTATES EVERY
          </Caps>
          <Caps size="var(--fs-11)" tracking="0.04em" color="var(--lg-amber)">
            60S
          </Caps>
        </span>
      </div>

      {/* A single field owns the keyboard; the six boxes are only a rendering of
          its contents. That keeps paste and delete behaving the way they do
          everywhere else. */}
      <div style={{ position: 'relative', marginTop: '30px' }}>
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
            // Off-screen would stop iOS scrolling it into view; transparent and
            // in place keeps the caret where the boxes are.
            letterSpacing: '2em',
          }}
        />
        <div class="row" style={{ gap: '9px', pointerEvents: 'none' }} aria-hidden="true">
          {[0, 1, 2, 3, 4, 5].map((index) => {
            const active = index === Math.min(digits.length, 5) && focused
            return (
              <div
                key={index}
                style={{
                  // A maximum, not a fixed width. Six 48px boxes and five 9px gaps
                  // need 333px; a narrow phone offers 327px inside the gutter, so
                  // a fixed row overflowed the app's very first screen by 6px.
                  flex: '1 1 0',
                  maxWidth: '48px',
                  minHeight: '64px',
                  borderRadius: 'var(--radius-small)',
                  background: active
                    ? 'color-mix(in srgb, var(--lg-cyan) 8%, transparent)'
                    : 'var(--lg-panel)',
                  border: `1px solid ${active ? 'var(--lg-cyan)' : 'var(--lg-hairline)'}`,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                {digits[index] ? (
                  <span class="mono" style={{ fontSize: 'var(--fs-27)' }}>
                    {digits[index]}
                  </span>
                ) : active ? (
                  <Caret />
                ) : null}
              </div>
            )
          })}
        </div>
      </div>

      {errorText ? (
        <p
          class="wrap"
          role="alert"
          style={{
            fontSize: 'var(--fs-13)',
            color: 'var(--lg-red)',
            margin: '14px 0 0',
            textAlign: 'center',
            userSelect: 'text',
          }}
        >
          {errorText}
        </p>
      ) : null}

      <div style={{ marginTop: '26px' }}>
        <Hairline />
      </div>

      <button
        onClick={() => void applyLink()}
        disabled={pasting}
        style={{
          marginTop: '26px',
          display: 'flex',
          alignItems: 'center',
          gap: '14px',
          minHeight: '60px',
          paddingInline: '18px',
          background: 'var(--lg-panel)',
          border: '1px solid var(--lg-hairline)',
          borderRadius: 'var(--radius-medium)',
          textAlign: 'left',
        }}
        aria-label="Paste a pairing link"
      >
        <span
          aria-hidden="true"
          class="mono"
          style={{
            width: '30px',
            height: '30px',
            flex: '0 0 auto',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 'var(--radius-hairline)',
            background: 'color-mix(in srgb, var(--lg-text-secondary) 35%, transparent)',
            color: 'var(--lg-text-secondary)',
            fontSize: 'var(--fs-13)',
          }}
        >
          ⌘V
        </span>
        <span class="stack" style={{ gap: '3px' }}>
          <span style={{ fontSize: 'var(--fs-15)' }}>Paste the pairing link instead</span>
          <Caps size="var(--fs-10)">READS THE QR PAYLOAD · SAME HANDSHAKE</Caps>
        </span>
      </button>

      <div class="stack" style={{ gap: '8px', marginTop: '20px' }}>
        <Caps size="var(--fs-10)">MAC ADDRESS</Caps>
        <div class="row" style={{ gap: '8px' }}>
          <input
            value={address}
            placeholder="192.168.1.24, mac.tailnet.ts.net, or https://…"
            spellcheck={false}
            autocapitalize="none"
            autocorrect="off"
            inputMode="url"
            aria-label="The Mac’s address"
            onInput={(event) => setAddress(event.currentTarget.value)}
            class="mono"
            style={fieldStyle}
          />
          <input
            value={port}
            placeholder="8787"
            inputMode="numeric"
            aria-label="Port"
            onInput={(event) => setPort(event.currentTarget.value)}
            class="mono"
            style={{ ...fieldStyle, width: '68px', flex: '0 0 auto', textAlign: 'center' }}
          />
        </div>
      </div>

      {note ? (
        <p
          class="wrap"
          style={{
            marginTop: '16px',
            padding: '13px 14px',
            fontSize: 'var(--fs-13)',
            lineHeight: 1.45,
            color: 'var(--lg-on-amber-wash)',
            background: 'color-mix(in srgb, var(--lg-amber) 7%, transparent)',
            borderLeft: '2px solid var(--lg-amber)',
          }}
        >
          {note}
        </p>
      ) : null}

      <span class="spacer" style={{ minHeight: '12px' }} />

      <DiscoveryLine
        address={address}
        blocked={blocked}
        probeMillis={probeMillis}
        hostServed={isHostServed()}
      />
    </ScreenBody>
  )
}

const fieldStyle = {
  flex: '1 1 auto',
  minWidth: 0,
  fontSize: 'var(--fs-13)',
  paddingInline: '12px',
  minHeight: 'var(--target)',
  background: 'var(--lg-panel)',
  border: '1px solid var(--lg-hairline)',
  borderRadius: 'var(--radius-small)',
  color: 'var(--lg-text)',
}

/**
 * Discovery is reported before the user types. If the Mac were not there, this
 * line says so instead of accepting six digits into a void.
 */
function DiscoveryLine({
  address,
  blocked,
  probeMillis,
  hostServed,
}: {
  address: string
  blocked: boolean
  probeMillis: number | null
  hostServed: boolean
}) {
  let color = 'var(--lg-text-disabled)'
  let text = 'ENTER THE MAC’S ADDRESS TO BEGIN'
  let inkColor = 'var(--lg-text-tertiary)'

  if (blocked) {
    color = 'var(--lg-amber)'
    inkColor = 'var(--lg-amber)'
    text = 'THE BROWSER WILL NOT OPEN THAT SCHEME FROM THIS PAGE'
  } else if (probeMillis != null) {
    color = 'var(--lg-green)'
    text = hostServed
      ? `THIS PAGE IS SERVED BY THE HOST · ${Math.round(probeMillis)} MS`
      : `HOST FOUND · ${Math.round(probeMillis)} MS`
  } else if (address.trim()) {
    color = 'var(--lg-red)'
    inkColor = 'var(--lg-red)'
    text = 'NOTHING ANSWERING AT THAT ADDRESS'
  }

  return (
    <div class="row" style={{ gap: '10px', paddingBottom: 'calc(20px + var(--safe-bottom))' }}>
      <span class="dot" aria-hidden="true" style={{ width: '6px', height: '6px', background: color }} />
      <Caps size="var(--fs-10)" tracking="0.12em" color={inkColor}>
        {text}
      </Caps>
    </div>
  )
}

// MARK: 01B — exchanging

function Exchanging({ digits, steps }: { digits: string; steps: ExchangeStep[] }) {
  return (
    <ScreenBody scrolls>
      <Caps size="var(--fs-13)" tracking="0.36em" weight={500} style={{ marginTop: '12px' }}>
        VibeWire
      </Caps>

      <MachinePair active />

      <h1 style={{ fontSize: 'var(--fs-27)', fontWeight: 400, margin: '34px 0 0' }}>
        Trading keys.
      </h1>

      <Caps size="var(--fs-11)" tracking="0.04em" style={{ marginTop: '12px' }}>
        CODE ACCEPTED · KEEP BOTH MACHINES AWAKE
      </Caps>

      <div class="row" style={{ gap: '9px', marginTop: '30px' }} aria-hidden="true">
        {[0, 1, 2, 3, 4, 5].map((index) => (
          <div
            key={index}
            style={{
              flex: '1 1 0',
              maxWidth: '48px',
              minHeight: '64px',
              borderRadius: 'var(--radius-small)',
              background: 'var(--lg-chrome)',
              border: '1px solid var(--lg-stroke)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <span class="mono" style={{ fontSize: 'var(--fs-27)' }}>
              {digits[index] ?? ''}
            </span>
          </div>
        ))}
      </div>

      {/* Four named steps with real values rather than one indeterminate spinner.
          If step three fails, the failure has an address. */}
      <ol class="stack" style={{ marginTop: '34px', padding: 0, listStyle: 'none' }}>
        {steps.map((step, index) => (
          <li
            key={step.title}
            class="row"
            style={{
              gap: '14px',
              minHeight: '52px',
              borderBottom: index === steps.length - 1 ? 'none' : '1px solid var(--lg-hairline-dim)',
            }}
          >
            <StepMarker state={step.state} />
            <Caps
              size="var(--fs-12)"
              color={
                step.state === 'pending' ? 'var(--lg-text-tertiary)' : 'var(--lg-text-secondary)'
              }
            >
              {step.title}
            </Caps>
            <span class="spacer" />
            <Caps size="var(--fs-11)" tracking="0" color={detailColor(step.state)}>
              {step.detail}
            </Caps>
          </li>
        ))}
      </ol>

      <span class="spacer" />

      <Caps
        size="var(--fs-10)"
        tracking="0.12em"
        style={{ paddingBottom: 'calc(20px + var(--safe-bottom))', lineHeight: 1.7 }}
      >
        {'PAIRING TRAFFIC STAYS ON THE PATH YOU CHOSE.\nYOU WILL NOT SEE THIS SCREEN AGAIN.'}
      </Caps>
    </ScreenBody>
  )
}

function detailColor(state: ExchangeStep['state']): string {
  switch (state) {
    case 'running':
      return 'var(--lg-cyan)'
    case 'failed':
      return 'var(--lg-red)'
    default:
      return 'var(--lg-text-tertiary)'
  }
}

function StepMarker({ state }: { state: ExchangeStep['state'] }) {
  const shell = {
    width: '18px',
    height: '18px',
    flex: '0 0 auto',
    borderRadius: '50%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 'var(--fs-11)',
  }
  switch (state) {
    case 'done':
      return (
        <span
          aria-hidden="true"
          style={{ ...shell, border: '1px solid var(--lg-green)', color: 'var(--lg-green)' }}
        >
          ✓
        </span>
      )
    case 'running':
      return <Spinner size={18} />
    case 'failed':
      return (
        <span
          aria-hidden="true"
          style={{ ...shell, border: '1px solid var(--lg-red)', color: 'var(--lg-red)' }}
        >
          ✕
        </span>
      )
    default:
      return (
        <span
          aria-hidden="true"
          style={{ ...shell, border: '1px dashed var(--lg-stroke)' }}
        />
      )
  }
}

/**
 * The two named machines and the wire between them.
 *
 * The travelling dot is the only motion on the waiting screen, and it is the one
 * piece that crosses the whole width — so it is the one Reduce Motion most clearly
 * means. Travel is replaced by a dot resting at the midpoint: the wire is still
 * drawn, the machines are still joined, and the discovery line underneath was
 * always the part that said in words whether anything answered.
 */
function MachinePair({ active }: { active: boolean }) {
  const ink = active ? 'var(--lg-cyan)' : 'var(--lg-text-secondary)'
  return (
    <div class="row" style={{ gap: '10px', marginTop: '46px' }} aria-hidden="true">
      <MachineTile caption="THIS" active={active} width={16} height={26} radius={3} ink={ink} />
      <div style={{ flex: '1 1 auto', position: 'relative', height: '6px' }}>
        <div
          style={{
            position: 'absolute',
            top: '2px',
            left: 0,
            right: 0,
            height: '1px',
            background: active
              ? 'var(--lg-cyan)'
              : 'repeating-linear-gradient(to right, var(--lg-stroke) 0 5px, transparent 5px 10px)',
          }}
        />
        {active ? null : (
          <span
            class="dot travelling"
            style={{ width: '5px', height: '5px', background: 'var(--lg-green)' }}
          />
        )}
      </div>
      <MachineTile caption="MAC" active={active} width={30} height={20} radius={2} ink={ink} />
      <style>{`
        .travelling {
          position: absolute;
          top: 0;
          animation: lg-travel 2.2s linear infinite;
        }
        @keyframes lg-travel {
          0% { left: 0; opacity: 0; }
          6% { opacity: 1; }
          94% { opacity: 1; }
          100% { left: 100%; opacity: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .travelling { left: 50%; opacity: 1; animation: none; }
        }
      `}</style>
    </div>
  )
}

function MachineTile({
  caption,
  active,
  width,
  height,
  radius,
  ink,
}: {
  caption: string
  active: boolean
  width: number
  height: number
  radius: number
  ink: string
}) {
  return (
    <div
      class="stack"
      style={{
        width: '64px',
        height: '64px',
        flex: '0 0 auto',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '5px',
        borderRadius: 'var(--radius-large)',
        background: active
          ? 'color-mix(in srgb, var(--lg-cyan) 10%, transparent)'
          : 'var(--lg-chrome)',
        border: `1px solid ${active ? 'var(--lg-cyan)' : 'var(--lg-stroke)'}`,
      }}
    >
      <span
        style={{
          width: `${width}px`,
          height: `${height}px`,
          borderRadius: `${radius}px`,
          border: `1px solid ${ink}`,
        }}
      />
      <Caps
        size="var(--fs-9)"
        tracking="0.08em"
        color={active ? 'var(--lg-cyan)' : 'var(--lg-text-tertiary)'}
      >
        {caption}
      </Caps>
    </div>
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
