import { useEffect, useRef, useState } from 'preact/hooks'
import {
  exchangeProviderCode, providerAuthorizeUrl, providers, randomVerifier,
  sendEmailCode, verifyEmailCode, type Provider, type Session,
} from '../../src/net/account'
import { accountsConfigured } from '../../src/net/supabase'
import { ApiError, command } from './api'
import { facts, pane } from './store'

const PROVIDER_NAME: Record<Provider, string> = { google: 'Google', apple: 'Apple' }

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
  // Only providers the account server has switched on, and only on a host that
  // can take the browser's callback. A button that cannot work is not drawn.
  const [available, setAvailable] = useState<Provider[]>([])
  useEffect(() => {
    let live = true
    if (accountsConfigured && facts.value?.browserSignIn) void providers().then(list => live && setAvailable(list))
    return () => { live = false }
  }, [])
  async function finish(session: Session) {
    setVerified(session)
    await command({ do: 'setup.complete', accessToken: session.accessToken })
    pane.value = 'overview'
    if (facts.value) facts.value = { ...facts.value, setupCompleted: true }
  }
  // Bumped by every attempt and by Cancel, so a stale wait stops polling.
  const attempt = useRef(0)
  const [waiting, setWaiting] = useState<Provider | null>(null)
  useEffect(() => () => { attempt.current++ }, [])

  /**
   * Google and Apple refuse to sign in inside this window, so the Mac opens the
   * default browser and keeps the code it is sent back. The verifier stays
   * here, and only this window can turn that code into a session.
   */
  async function continueWith(provider: Provider) {
    if (busy) return
    const mine = ++attempt.current
    setBusy(true); setError(''); setWaiting(provider)
    try {
      const verifier = randomVerifier()
      const flow = randomVerifier()
      const redirect = `${location.origin}/account/callback?flow=${flow}`
      await command({ do: 'account.browser.begin', flow, url: await providerAuthorizeUrl(provider, redirect, verifier) })
      const code = await waitForBrowser(mine)
      if (code) await finish(await exchangeProviderCode(code, verifier))
    } catch (problem) {
      if (attempt.current === mine) setError(describe(problem))
    } finally {
      if (attempt.current === mine) { setBusy(false); setWaiting(null) }
    }
  }

  async function waitForBrowser(mine: number): Promise<string | null> {
    while (attempt.current === mine) {
      await new Promise(resolve => setTimeout(resolve, 1000))
      if (attempt.current !== mine) break
      const answer = await command({ do: 'account.browser.take' }) as { code?: string; error?: string }
      if (answer.code) return answer.code
      if (answer.error) throw new Error(answer.error)
    }
    return null
  }

  function cancelBrowser() {
    attempt.current++
    setBusy(false); setWaiting(null)
  }

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
        const session = (verified && verified.expiresAt > Date.now() / 1000 ? verified : null) ?? await verifyEmailCode(email.trim(), code.trim())
        await finish(session)
      }
    } catch (problem) {
      setError(describe(problem))
    } finally { setBusy(false) }
  }
  return <section class="setup-account">
    <h2>Sign in or create an account</h2>
    <p>{available.length > 0 ? 'Use an email code, or continue with ' + available.map(p => PROVIDER_NAME[p]).join(' or ') + '.' : 'One email, one code.'} New to VibeWire? We’ll create your account the first time you sign in.</p>
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
    {accountsConfigured && available.length > 0 && !sent && <div class="setup-account__providers">
      <p class="setup-account__or">or</p>
      {available.map(provider => <button key={provider} type="button" class="setup__button setup__button--quiet"
        disabled={busy} onClick={() => void continueWith(provider)}>Continue with {PROVIDER_NAME[provider]}</button>)}
      {waiting && <>
        <p role="status">Finish signing in with {PROVIDER_NAME[waiting]} in your browser. This window continues on its own.</p>
        <button type="button" class="setup__button setup__button--quiet" onClick={cancelBrowser}>Cancel</button>
      </>}
    </div>}
  </section>
}

function describe(problem: unknown): string {
  if (problem instanceof ApiError) {
    if (problem.code === 'permissions_required') return 'A Mac permission is missing. Go back to Permissions and enable both permissions.'
    if (problem.code === 'browser_sign_in_expired') return 'That sign-in took too long. Try again.'
    if (problem.code === 'no_browser_sign_in') return 'The browser sign-in was lost. Try again.'
    return 'The Mac could not verify your account. Check your connection and try Finish setup again.'
  }
  return problem instanceof Error ? problem.message : 'Could not reach the account server. Try again.'
}
