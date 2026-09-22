import { useEffect, useState } from 'preact/hooks'
import { sendEmailCode, verifyEmailCode, type Session } from '../../src/net/account'
import { accountsConfigured } from '../../src/net/supabase'
import { ApiError, command } from './api'
import { facts, pane } from './store'

export function AccountStep() {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [cooldown, setCooldown] = useState(0)
  useEffect(() => {
    if (cooldown <= 0) return
    const timer = setTimeout(() => setCooldown(cooldown - 1), 1000)
    return () => clearTimeout(timer)
  }, [cooldown])
  const [verified, setVerified] = useState<Session | null>(null)
  async function submit(event: Event) {
    event.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      if (!sent) {
        await sendEmailCode(email.trim(), 'https://amargoyal.github.io/VibeWire/')
        setSent(true)
        setCooldown(60)
      } else {
        const session = verified ?? await verifyEmailCode(email.trim(), code.trim())
        setVerified(session)
        await command({ do: 'setup.complete', accessToken: session.accessToken })
        pane.value = 'overview'
        if (facts.value) facts.value = { ...facts.value, setupCompleted: true }
      }
    } catch (problem) {
      setError(problem instanceof ApiError
        ? problem.code === 'permissions_required'
          ? 'A Mac permission is missing. Go back to Permissions and enable both permissions.'
          : 'The Mac could not verify your account. Check your connection and try Finish setup again.'
        : problem instanceof Error ? problem.message : 'Could not reach the account server. Try again.')
    } finally { setBusy(false) }
  }
  return <section class="setup-account">
    <h2>Sign in or create an account</h2>
    <p>One email, one code. New to VibeWire? We’ll create your account when you verify your email.</p>
    {!accountsConfigured ? <p role="alert">Account sign-in is not configured in this build. Install a configured VibeWire release to finish setup.</p> :
      <form onSubmit={submit} class="setup-account__form">
        <label htmlFor="setup-email">Email address</label>
        <input id="setup-email" type="email" autoComplete="email" required value={email}
          disabled={sent || busy} onInput={event => setEmail(event.currentTarget.value)} />
        {sent && <>
          <p role="status">Enter the code sent to {email}. Check your spam folder too.</p>
          <label htmlFor="setup-code">Email code</label>
          <input id="setup-code" inputMode="numeric" autoComplete="one-time-code" required
            pattern="[0-9]{6,10}" value={code} disabled={busy || !!verified}
            onInput={event => setCode(event.currentTarget.value.replace(/\D/g, ''))} />
        </>}
        {error && <p role="alert">{error}</p>}
        <button class="setup__button" disabled={busy} type="submit">
          {busy ? 'Please wait…' : sent ? 'Finish setup' : 'Send email code'}
        </button>
        {sent && <button class="setup__button setup__button--quiet" type="button" disabled={busy}
          onClick={() => { setSent(false); setCode(''); setVerified(null); setError('') }}>Change email</button>}
        {sent && <button class="setup__button setup__button--quiet" type="button" disabled={busy || cooldown > 0}
          onClick={async () => {
            setBusy(true); setError('')
            try {
              await sendEmailCode(email.trim(), 'https://amargoyal.github.io/VibeWire/')
              setCooldown(60); setCode(''); setVerified(null)
            } catch (problem) { setError(problem instanceof Error ? problem.message : 'Could not resend the code.') }
            finally { setBusy(false) }
          }}>{cooldown > 0 ? `Resend in ${cooldown}s` : 'Resend code'}</button>}
      </form>}
  </section>
}
