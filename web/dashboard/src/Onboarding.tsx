import { useEffect, useRef, useState } from 'preact/hooks'
import { AccountStep } from './AccountStep'
import { pairOpen, reachability, send, type Facts } from './store'

const steps = ['Welcome', 'Permissions', 'Connect your phone', 'Your account']

export function Onboarding({ state }: { state: Facts }) {
  const [step, setStep] = useState(0)
  const heading = useRef<HTMLHeadingElement>(null)
  const ready = state.permissions.screenRecording && state.permissions.accessibility
  const live = reachability.value === 'live'
  useEffect(() => { heading.current?.focus() }, [step])
  return <div class="mac onboarding">
    <header class="mac__bar"><span class="mac__wordmark">VIBEWIRE</span></header>
    <main class="onboarding__main setup">
      <div class="onboarding__progress" aria-label="Setup progress">{steps.map((label, index) =>
        <span key={label} aria-current={index === step ? 'step' : undefined}>{index + 1}. {label}</span>)}</div>
      <h1 ref={heading} tabIndex={-1}>{steps[step]}</h1>
      {!live && <p role="alert">The host is not answering. Setup will resume when it reconnects.</p>}
      {step === 0 && <section>
        <h2>Your Mac. Within reach.</h2>
        <p>See your desktop, move the pointer, and keep working from your phone.</p>
        <div class="setup__route"><span>{state.host.name}</span><span aria-hidden="true">→</span><span>Your phone</span></div>
        <p>First, allow screen sharing and control on this Mac. Then connect your phone and finish with your VibeWire account.</p>
        <p class="setup__hint">Have your phone and access to your email ready. Your progress is checked as you go.</p>
      </section>}
      {step === 3 && <AccountStep />}
      <footer class="onboarding__footer">
        {step > 0 && <button class="setup__button setup__button--quiet" onClick={() => setStep(step - 1)}>Back</button>}
        {step < 3 && <button class="setup__button" disabled={!live || (step === 1 && !ready)}
          onClick={() => setStep(step + 1)}>{step === 0 ? 'Set up this Mac' : step === 2 ? 'Continue to account' : 'Continue'}</button>}
      </footer>
    </main>
  </div>
}
