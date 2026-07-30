/**
 * The root. Ported from ios/VibeWire/App/VibeWireApp.swift.
 *
 * Three routes and two sheets, and deliberately absent: light mode, a tab bar, an
 * onboarding tour. The whole application is the screens in `../screens`.
 */

import { useEffect, useRef, useState } from 'preact/hooks'

import { store } from './store'
import { Caps, Spinner } from '../design/components'
import { decoderSupport } from '../video/renderer'
import { ClaudePanel } from '../screens/ClaudePanel'
import { Home } from '../screens/Home'
import { Pairing } from '../screens/Pairing'
import { Remote } from '../screens/Remote'
import { Settings } from '../screens/Settings'

/**
 * How long a hidden tab keeps its socket.
 *
 * The phone's rule is "nothing is left running on the Mac when the app goes away",
 * and it applies here for the same reason — a backgrounded tab is a stream nobody is
 * watching, and browsers throttle its timers until the ping loop starves and the
 * host starts reporting a stall about a client that is fine. But a tab switch is not
 * the same act as closing an app: dropping the socket every time the user glances at
 * another tab would make the client unusable. So a grace period, and an immediate
 * teardown on `pagehide`, which is the event that actually means "going away".
 */
const HIDDEN_GRACE_MS = 30_000

export function App() {
  const [ready, setReady] = useState(false)
  const hiddenTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    void store.load().then(() => setReady(true))
    // `?host=…&port=…&code=…` on this page's own URL is the browser's stand-in for
    // the `vibewire://pair` link behind the Mac's QR.
    void store.handlePairingParams(location.search, location.hash)
  }, [])

  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenTimer.current = setTimeout(() => store.disconnect(), HIDDEN_GRACE_MS)
        return
      }
      if (hiddenTimer.current) clearTimeout(hiddenTimer.current)
      hiddenTimer.current = null
      void store.connectIfPaired()
    }
    const onPageHide = () => store.disconnect()

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
    }
  }, [])

  const route = store.route.value
  const presented = store.presented.value

  if (!ready) return <Booting />

  return (
    <>
      {route === 'pairing' ? <Pairing /> : route === 'home' ? <Home /> : <Remote />}

      {store.banner.value ? (
        <Banner text={store.banner.value} onDismiss={() => (store.banner.value = null)} />
      ) : null}

      {presented === 'settings' ? (
        <Settings onClose={() => (store.presented.value = null)} />
      ) : null}

      {presented === 'claude' ? (
        <ClaudePanel
          onClose={() => (store.presented.value = null)}
          // Half height over a live picture, full height over Home. Not a remembered
          // preference — a fact about what is underneath it.
          half={route === 'remote'}
        />
      ) : null}

      {store.screenshot.value ? <ScreenshotSheet /> : null}

      <UnsupportedNotice />
    </>
  )
}

/** Reading the stored identity out of IndexedDB is one await, and a flash of the
 *  pairing screen in front of an already-paired Mac is a lie about the state. */
function Booting() {
  return (
    <div
      class="stack"
      style={{
        minHeight: '100dvh',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '14px',
      }}
    >
      <Spinner size={20} />
      <Caps size="var(--fs-10)" tracking="0.2em">
        READING STORED TRUST
      </Caps>
    </div>
  )
}

/**
 * Errors are stated, not swallowed. Amber because a banner is always a degraded
 * condition, never a lost one — a lost condition gets a whole screen.
 */
function Banner({ text, onDismiss }: { text: string; onDismiss: () => void }) {
  return (
    <div
      role="alert"
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 70,
        paddingInline: 'var(--gutter)',
        paddingBottom: 'calc(20px + var(--safe-bottom))',
        animation: 'lg-rise var(--state-change) ease-out',
      }}
    >
      <div
        class="row row--top"
        style={{
          gap: '12px',
          maxWidth: 'var(--measure)',
          marginInline: 'auto',
          paddingLeft: '14px',
          background: 'color-mix(in srgb, var(--lg-amber) 7%, transparent)',
          borderLeft: '2px solid var(--lg-amber)',
          backdropFilter: 'blur(6px)',
        }}
      >
        <p
          class="wrap"
          style={{
            flex: '1 1 auto',
            margin: 0,
            paddingBlock: '13px',
            fontSize: 'var(--fs-13)',
            lineHeight: 1.45,
            color: 'var(--lg-on-amber-wash)',
          }}
        >
          {text}
        </p>
        <button
          onClick={onDismiss}
          aria-label="Dismiss message"
          style={{
            width: 'var(--target)',
            height: 'var(--target)',
            flex: '0 0 auto',
            color: 'var(--lg-text-secondary)',
          }}
        >
          <span class="mono" style={{ fontSize: 'var(--fs-13)' }}>
            ✕
          </span>
        </button>
      </div>
    </div>
  )
}

/**
 * The screenshot the Mac sent.
 *
 * The phone put it straight on the pasteboard and said nothing, which a browser
 * cannot do: writing an image to the clipboard needs a permission that is refused
 * more often than granted, and refused silently. So the shot is shown, with the two
 * things that can actually be done with it.
 */
function ScreenshotSheet() {
  const source = store.screenshot.value
  if (!source) return null

  return (
    <div class="sheet" role="dialog" aria-label="Screenshot of the Mac" style={{ zIndex: 65 }}>
      <div class="column" style={{ paddingBlock: 'var(--safe-top) 0' }}>
        <div class="row" style={{ marginTop: '24px', flex: '0 0 auto' }}>
          <Caps size="var(--fs-10)" tracking="0.2em">
            SCREENSHOT
          </Caps>
          <span class="spacer" />
          <button
            onClick={() => (store.screenshot.value = null)}
            style={{
              minHeight: 'var(--target)',
              paddingInline: '12px',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <Caps size="var(--fs-11)" color="var(--lg-text-secondary)">
              DONE
            </Caps>
          </button>
        </div>

        <div
          style={{
            flex: '1 1 auto',
            minHeight: 0,
            marginTop: '14px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--lg-deep)',
            border: '1px solid var(--lg-hairline-dim)',
            borderRadius: 'var(--radius-row)',
            overflow: 'hidden',
          }}
        >
          <img
            src={source}
            alt="The Mac’s screen at the moment the shot was taken"
            style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain', display: 'block' }}
          />
        </div>

        <div
          class="row"
          style={{
            gap: '9px',
            paddingBlock: '16px',
            paddingBottom: 'calc(16px + var(--safe-bottom))',
            flex: '0 0 auto',
          }}
        >
          <a
            href={source}
            download="vibewire-screenshot.png"
            style={{
              flex: '1 1 0',
              minHeight: '52px',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: 'var(--radius-row)',
              border: '1px solid var(--lg-hairline)',
              textDecoration: 'none',
            }}
          >
            <Caps size="var(--fs-11)" color="var(--lg-text-secondary)">
              SAVE PNG
            </Caps>
          </a>
          <button
            onClick={() => void copyImage(source)}
            style={{
              flex: '1 1 0',
              minHeight: '52px',
              borderRadius: 'var(--radius-row)',
              border: '1px solid color-mix(in srgb, var(--lg-cyan) 45%, transparent)',
            }}
          >
            <Caps size="var(--fs-11)" color="var(--lg-cyan)">
              COPY IMAGE
            </Caps>
          </button>
        </div>
      </div>
    </div>
  )
}

async function copyImage(dataUrl: string): Promise<void> {
  try {
    const blob = await (await fetch(dataUrl)).blob()
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  } catch {
    store.banner.value =
      'This browser would not put an image on the clipboard. Save the PNG instead.'
  }
}

/**
 * The one thing this client cannot work around, said once, where it will be read.
 *
 * Everything else degrades honestly — no Network Information API means the radio is
 * reported as unknown, no Ed25519 in WebCrypto means a weaker key store — but
 * without a WebCodecs decoder there is no picture, and a black rectangle with no
 * explanation is exactly the failure this product refuses to ship.
 */
function UnsupportedNotice() {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed || decoderSupport() === 'ok') return null

  return (
    <Banner
      text="This browser has no WebCodecs H.264 decoder, so the Mac's picture will not appear. Pointer, keyboard, clipboard and Claude all still work. Chrome, Edge and Safari 17+ can show the picture."
      onDismiss={() => setDismissed(true)}
    />
  )
}
