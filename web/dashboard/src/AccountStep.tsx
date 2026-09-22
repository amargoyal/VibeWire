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
  return <section class="setup-account">
    <h2>Sign in or create an account</h2>
    <p>One email, one code. New to VibeWire? We’ll create your account when you verify your email.</p>
  </section>
}
