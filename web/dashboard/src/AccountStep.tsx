import { useState } from 'preact/hooks'
import { sendEmailCode, verifyEmailCode, type Session } from '../../src/net/account'
import { accountsConfigured } from '../../src/net/supabase'
import { command } from './api'
import { facts, pane } from './store'

export function AccountStep() {
  const [email, setEmail] = useState('')
  const [code, setCode] = useState('')
  const [sent, setSent] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
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
      } else {
        const session = verified ?? await verifyEmailCode(email.trim(), code.trim())
        setVerified(session)
        await command({ do: 'setup.complete', accessToken: session.accessToken })
        pane.value = 'overview'
        if (facts.value) facts.value = { ...facts.value, setupCompleted: true }
      }
    } catch (problem) {
      setError(problem instanceof Error ? problem.message : 'Could not reach the account server. Try again.')
    } finally { setBusy(false) }
  }
  return <section class="setup-account">
    <h2>Sign in or create an account</h2>
    <p>One email, one code. New to VibeWire? We’ll create your account when you verify your email.</p>
  </section>
}
