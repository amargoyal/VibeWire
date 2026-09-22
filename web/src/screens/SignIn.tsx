/**
 * 17 · SIGN IN — the last step of setup, and the first optional one.
 *
 * Everything this product does works before this screen and keeps working if it
 * is skipped: the picture, the pointer, the keyboard, Claude. What an account
 * adds is memory that outlives site data — the computers this person paired
 * with, the browsers they signed in from, the keyboard bar they built. So it is
 * asked at the end, once the wire is proven, and SKIP is a real answer that is
 * remembered.
 *
 * The exception is a host whose owner turned on "require an account". Then this
 * screen is the way in and says so, with the host's own name in the sentence,
 * because a refusal without an author is indistinguishable from a bug.
 *
 * Why a six-digit code first, ahead of the link in the same email: this bundle
 * is served from three kinds of address — the host's LAN IP over plain HTTP, a
 * Cloudflare hostname that changes every restart, and GitHub Pages — and a
 * redirect allowlist cannot be written for the middle one. A code needs no
 * redirect at all. It is also the gesture the pairing screen just taught.
 */

import { useEffect, useState } from 'preact/hooks'

import { store } from '../app/store'
import {
  AccountFailure,
  providers,
  sendEmailCode,
  startProviderSignIn,
  storageWorks,
  verifyEmailCode,
  type Provider,
} from '../net/account'
import {
  Caps,
  Card,
  CodeField,
  Display,
  FilledAction,
  OutlinedAction,
  ScreenBody,
  SectionLabel,
  Spinner,
} from '../design/components'

type Stage = 'address' | 'code'

const PROVIDER_LABEL: Record<Provider, string> = {
  google: 'Continue with Google',
  apple: 'Continue with Apple',
}

export function SignIn() {
  const [stage, setStage] = useState<Stage>('address')
  const [email, setEmail] = useState('')
  const [digits, setDigits] = useState('')
  const [busy, setBusy] = useState(false)
  const [errorText, setErrorText] = useState<string | null>(null)
  const [available, setAvailable] = useState<Provider[]>([])
  const [ephemeral, setEphemeral] = useState(false)

  const required = store.accountRequired.value
  const refusal = store.accountRefusal.value

  // Asked once, on the screen that would draw the buttons. A provider that is
  // not switched on in the project is a button that leads to an error page, and
  // the rule here is the same as everywhere else in this client: a control that
  // cannot work is not drawn.
  useEffect(() => {
    let live = true
    void providers().then((list) => live && setAvailable(list))
    void storageWorks().then((works) => live && setEphemeral(!works))
    return () => {
      live = false
    }
  }, [])

  async function requestCode(): Promise<void> {
    const address = email.trim()
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
      setErrorText('That does not look like an email address.')
      return
    }
    setBusy(true)
    setErrorText(null)
    try {
      await sendEmailCode(address)
      setDigits('')
      setStage('code')
    } catch (error) {
      setErrorText(messageFor(error))
    } finally {
      setBusy(false)
    }
  }

  async function submitCode(code: string): Promise<void> {
    setBusy(true)
    setErrorText(null)
    try {
      await verifyEmailCode(email.trim(), code)
      store.noteSignInAnswered()
      void store.rememberAccountContext()
      store.note('Signed in.')
      store.route.value = 'home'
      // A host that had been refusing this browser has no reason to now.
      if (required) {
        store.accountRefusal.value = null
        void store.connectIfPaired()
      }
    } catch (error) {
      setErrorText(messageFor(error))
      setDigits('')
    } finally {
      setBusy(false)
    }
  }

  function skip(): void {
    store.noteSignInAnswered()
    store.route.value = 'home'
  }

  return (
    <ScreenBody scrolls>
      <header class="row" style={{ minHeight: '34px', flex: '0 0 auto' }}>
        <Caps size="var(--fs-11)" tracking="0.32em" weight={500} color="var(--ns-text-secondary)">
          VibeWire
        </Caps>
        <span class="spacer" />
        <Caps size="var(--fs-9)" tracking="0.16em" color="var(--ns-text-faint)">
          {required ? 'REQUIRED BY THIS COMPUTER' : 'LAST STEP · OPTIONAL'}
        </Caps>
      </header>

      {stage === 'address' ? (
        <Address
          email={email}
          busy={busy}
          required={required}
          refusal={refusal}
          ephemeral={ephemeral}
          available={available}
          onEmail={setEmail}
          onContinue={() => void requestCode()}
          onProvider={(provider) => void startProviderSignIn(provider)}
          onSkip={skip}
        />
      ) : (
        <Code
          email={email.trim()}
          digits={digits}
          busy={busy}
          onDigits={setDigits}
          onComplete={(code) => void submitCode(code)}
          onResend={() => void requestCode()}
          onBack={() => {
            setErrorText(null)
            setDigits('')
            setStage('address')
          }}
        />
      )}

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

      <div style={{ height: 'calc(24px + var(--safe-bottom))', flex: '0 0 auto' }} />
    </ScreenBody>
  )
}

// MARK: - The address

function Address({
  email,
  busy,
  required,
  refusal,
  ephemeral,
  available,
  onEmail,
  onContinue,
  onProvider,
  onSkip,
}: {
  email: string
  busy: boolean
  required: boolean
  refusal: string | null
  ephemeral: boolean
  available: Provider[]
  onEmail: (value: string) => void
  onContinue: () => void
  onProvider: (provider: Provider) => void
  onSkip: () => void
}) {
  return (
    <>
      <Display style={{ marginTop: '40px', flex: '0 0 auto' }}>
        {required ? (
          <>
            {store.hostName.value} wants
            <br />
            to know who you are.
          </>
        ) : (
          <>
            Keep this
            <br />
            when the phone forgets.
          </>
        )}
      </Display>

      <p
        class="wrap"
        style={{
          margin: '16px 0 0',
          fontSize: 'var(--fs-15)',
          lineHeight: 1.6,
          color: 'var(--ns-text-secondary)',
          maxWidth: '68ch',
          flex: '0 0 auto',
        }}
      >
        {required
          ? `This computer has been set to accept only signed-in browsers. Pairing alone is not enough for it — sign in and this browser goes through.`
          : `An account carries the list of computers you have paired with, the browsers you use, and your keyboard bar between them. Clearing site data or picking up a second phone stops costing you the setup you just did.`}
      </p>

      {required ? null : <Keeps />}

      {refusal ? (
        <p
          class="wrap"
          style={{
            margin: '14px 0 0',
            padding: '14px 16px',
            background: 'var(--ns-raised)',
            borderLeft: '2px solid var(--ns-amber)',
            borderRadius: 'var(--radius-inner)',
            fontSize: 'var(--fs-13)',
            lineHeight: 1.5,
            color: 'var(--ns-text-secondary)',
            flex: '0 0 auto',
          }}
        >
          {refusal}
        </p>
      ) : null}

      <SectionLabel style={{ marginTop: '30px', flex: '0 0 auto' }}>EMAIL</SectionLabel>

      <input
        type="email"
        value={email}
        placeholder="you@example.com"
        inputMode="email"
        autoComplete="email"
        autoCapitalize="off"
        autoCorrect="off"
        spellcheck={false}
        aria-label="Email address"
        onInput={(event) => onEmail(event.currentTarget.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter') onContinue()
        }}
        style={{
          width: '100%',
          marginTop: '10px',
          fontSize: 'var(--fs-15)',
          paddingInline: '14px',
          minHeight: '56px',
          background: 'var(--ns-raised-2)',
          borderRadius: 'var(--radius-inner)',
          color: 'var(--ns-text)',
          flex: '0 0 auto',
        }}
      />

      <div style={{ marginTop: '12px', flex: '0 0 auto' }}>
        <FilledAction
          title={busy ? 'SENDING…' : 'SEND ME A CODE'}
          height={56}
          enabled={!busy}
          onClick={onContinue}
        />
      </div>

      <Caps
        size="var(--fs-9)"
        tracking="0.14em"
        color="var(--ns-text-faint)"
        style={{ marginTop: '12px', lineHeight: 1.7, flex: '0 0 auto' }}
      >
        {'ONE EMAIL, WITH SIX DIGITS AND A LINK.\nNO PASSWORD TO MAKE OR FORGET.'}
      </Caps>

      {available.length > 0 ? (
        <>
          <SectionLabel style={{ marginTop: '30px', flex: '0 0 auto' }}>OR</SectionLabel>
          {available.map((provider) => (
            <div key={provider} style={{ marginTop: '10px', flex: '0 0 auto' }}>
              <OutlinedAction
                title={PROVIDER_LABEL[provider].toUpperCase()}
                height={56}
                enabled={!busy}
                onClick={() => onProvider(provider)}
              />
            </div>
          ))}
        </>
      ) : null}

      {ephemeral ? (
        <Caps
          size="var(--fs-9)"
          tracking="0.14em"
          color="var(--ns-amber)"
          style={{ marginTop: '20px', lineHeight: 1.7, flex: '0 0 auto' }}
        >
          {'THIS BROWSER WILL NOT KEEP THE SESSION.\nPRIVATE WINDOWS SIGN OUT WHEN THEY CLOSE.'}
        </Caps>
      ) : null}

      {required ? null : (
        <div style={{ marginTop: '22px', flex: '0 0 auto' }}>
          <button
            class="setup__button setup__button--quiet"
            style={{ paddingInline: 0 }}
            onClick={onSkip}
          >
            Not now — go to {store.hostNoun}
          </button>
        </div>
      )}
    </>
  )
}

/**
 * What an account is actually for, as three facts rather than a paragraph.
 *
 * The value of signing in is not obvious here and cannot be assumed: the
 * product has already worked without one by the time this screen appears. So
 * the screen states what is kept, in the reader's own terms — the computers,
 * the browsers, the bar they built — and not one word about "syncing".
 */
function Keeps() {
  // Numbered rather than pictured. Three glyphs would have to carry "a
  // computer", "a browser" and "a keyboard row" at 13px on a phone, and the
  // ones that mean those things are exactly the ones a font may not have.
  const rows = [
    'The computers you have paired with, by name and address',
    'The browsers you are signed in from',
    'The keyboard bar you built, on every phone you use',
  ]

  return (
    <div style={{ marginTop: '22px', flex: '0 0 auto' }}>
      <Card style={{ padding: '4px 16px' }}>
        <div class="stack">
          {rows.map((text, index) => (
            <div
              key={text}
              class="row row--top"
              style={{
                gap: '14px',
                paddingBlock: '14px',
                borderTop: index === 0 ? 'none' : '1px solid var(--ns-hairline)',
              }}
            >
              <span
                class="mono"
                aria-hidden="true"
                style={{
                  flex: '0 0 auto',
                  width: '22px',
                  fontSize: 'var(--fs-13)',
                  color: 'var(--ns-accent)',
                  lineHeight: 1.5,
                }}
              >
                {index + 1}
              </span>
              <span
                class="wrap"
                style={{
                  flex: '1 1 auto',
                  minWidth: 0,
                  fontSize: 'var(--fs-13)',
                  lineHeight: 1.5,
                  color: 'var(--ns-text-secondary)',
                }}
              >
                {text}
              </span>
            </div>
          ))}
        </div>
      </Card>

      <Caps
        size="var(--fs-9)"
        tracking="0.14em"
        color="var(--ns-text-faint)"
        style={{ marginTop: '12px', lineHeight: 1.7 }}
      >
        {'NEVER A KEY, A CODE, A PICTURE OR A TRANSCRIPT.\nSIGNING IN DOES NOT PAIR ANYTHING.'}
      </Caps>
    </div>
  )
}

// MARK: - The code

function Code({
  email,
  digits,
  busy,
  onDigits,
  onComplete,
  onResend,
  onBack,
}: {
  email: string
  digits: string
  busy: boolean
  onDigits: (value: string) => void
  onComplete: (code: string) => void
  onResend: () => void
  onBack: () => void
}) {
  return (
    <>
      <Display style={{ marginTop: '40px', flex: '0 0 auto' }}>
        Six digits,
        <br />
        this time by email.
      </Display>

      <Caps
        size="var(--fs-10)"
        tracking="0.16em"
        style={{ marginTop: '14px', flex: '0 0 auto' }}
      >
        {`SENT TO ${email.toUpperCase()}`}
      </Caps>

      <div style={{ marginTop: '30px', flex: '0 0 auto' }}>
        <CodeField
          value={digits}
          label="Sign-in code, six digits"
          autoFocus
          onInput={onDigits}
          onComplete={onComplete}
        />
      </div>

      <div
        class="row"
        style={{ gap: '12px', marginTop: '16px', minHeight: '24px', flex: '0 0 auto' }}
      >
        {busy ? (
          <>
            <Spinner size={14} />
            <Caps size="var(--fs-9)" tracking="0.14em">
              CHECKING
            </Caps>
          </>
        ) : (
          <Caps size="var(--fs-9)" tracking="0.14em">
            THE CODE IS GOOD FOR ONE HOUR
          </Caps>
        )}
      </div>

      {/* The same message carries a link. Saying so here is the difference
          between a second way in and a person waiting for a second email. */}
      <p
        class="wrap"
        style={{
          margin: '22px 0 0',
          fontSize: 'var(--fs-13)',
          lineHeight: 1.6,
          color: 'var(--ns-text-secondary)',
          maxWidth: '68ch',
          flex: '0 0 auto',
        }}
      >
        The same email holds a link. Tapping it signs in whichever browser opens
        it, which is not always this one — so the digits are the surer of the two
        on a phone.
      </p>

      <div class="row" style={{ gap: '9px', marginTop: '20px', flex: '0 0 auto' }}>
        <span style={{ flex: '1 1 0', display: 'flex' }}>
          <OutlinedAction title="ANOTHER CODE" height={52} enabled={!busy} onClick={onResend} />
        </span>
        <span style={{ flex: '1 1 0', display: 'flex' }}>
          <OutlinedAction title="CHANGE EMAIL" height={52} enabled={!busy} onClick={onBack} />
        </span>
      </div>
    </>
  )
}

/** GoTrue's sentence where there is one, ours where there is not. */
function messageFor(error: unknown): string {
  if (error instanceof AccountFailure) return error.message
  return 'The account server could not be reached. Check the connection and try again.'
}
