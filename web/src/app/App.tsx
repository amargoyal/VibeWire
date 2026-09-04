/**
 * The root, and 15 · SCREENSHOT FROM THE MAC.
 * Mirrored by ios/VibeWire/App/VibeWireApp.swift.
 *
 * Three routes and two sheets, and deliberately absent: light mode, a tab bar, an
 * onboarding tour. The whole application is the screens in `../screens`.
 */

import { useEffect, useRef, useState } from 'preact/hooks'

import { store, type Banner } from './store'
import {
  Caps,
  Display,
  FilledAction,
  ScreenBody,
  SectionLabel,
  SheetDismiss,
  Spinner,
  useSheet,
} from '../design/components'
import { decoderSupport } from '../video/renderer'
import { ClaudePanel } from '../screens/ClaudePanel'
import { Home } from '../screens/Home'
import { Pairing } from '../screens/Pairing'
import { Remote } from '../screens/Remote'
import { Settings } from '../screens/Settings'
import { showShortcuts, ShortcutsSheet, useShortcuts } from './shortcuts'
import { watchTabCondition } from './tabIndicator'

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

  // The tab strip is a surface too, and the one the laptop client is most often
  // looked at from: eleven tabs, and the question is whether this one still has a
  // Mac on the end of it.
  useEffect(() => watchTabCondition(), [])

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
    // The other half of `pagehide`, and the reason a phone needed it. Swiping
    // the browser away and coming back restores this page from the back/forward
    // cache, and a restored page is not a new one: no reload runs, and the
    // `visibilitychange` that would otherwise reconnect is not guaranteed to
    // fire. Without this the tab came back to a socket that had been closed on
    // the way out and nothing asking for another.
    const onPageShow = () => {
      if (hiddenTimer.current) clearTimeout(hiddenTimer.current)
      hiddenTimer.current = null
      void store.connectIfPaired()
    }

    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    window.addEventListener('pageshow', onPageShow)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
      window.removeEventListener('pageshow', onPageShow)
    }
  }, [])

  useShortcuts()

  const route = store.route.value
  const presented = store.presented.value

  if (!ready) return <Booting />

  return (
    <>
      {route === 'pairing' ? <Pairing /> : route === 'home' ? <Home /> : <Remote />}

      {store.banner.value ? (
        <BannerView banner={store.banner.value} onDismiss={() => (store.banner.value = null)} />
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

      {store.clipboardOffer.value != null ? <ClipboardSheet /> : null}

      {showShortcuts.value ? <ShortcutsSheet /> : null}

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
function BannerView({ banner, onDismiss }: { banner: Banner; onDismiss: () => void }) {
  return (
    <div
      role="alert"
      style={{
        position: 'fixed',
        left: 0,
        right: 0,
        bottom: 0,
        zIndex: 70,
        paddingInline: 'calc(var(--gutter) + var(--safe-left)) calc(var(--gutter) + var(--safe-right))',
        paddingBottom: 'calc(20px + var(--safe-bottom))',
        animation: 'ns-rise var(--state-change) ease-out',
      }}
    >
      <div
        class="row row--top card card--tinted"
        style={
          {
            '--tint': 'var(--ns-amber)',
            gap: '12px',
            maxWidth: 'var(--measure)',
            marginInline: 'auto',
            paddingLeft: '16px',
            background: 'color-mix(in srgb, var(--ns-raised) 92%, transparent)',
            backdropFilter: 'blur(8px)',
          } as Record<string, string>
        }
      >
        <p
          class="wrap"
          style={{
            flex: '1 1 auto',
            margin: 0,
            paddingBlock: '14px',
            fontSize: 'var(--fs-13)',
            lineHeight: 1.45,
            color: 'var(--ns-on-amber-wash)',
          }}
        >
          {banner.text}
        </p>

        {/* Only where the host said so. It marks its own errors — a capture that
            failed is worth trying again, a refused request is not — and offering
            a retry for something that cannot succeed is worse than offering
            nothing, because it costs a tap to find that out. */}
        {banner.retriable ? (
          <button
            onClick={() => {
              store.banner.value = null
              store.retry()
            }}
            style={{
              minHeight: 'var(--target)',
              paddingInline: '12px',
              flex: '0 0 auto',
              display: 'flex',
              alignItems: 'center',
            }}
          >
            <Caps size="var(--fs-9)" tracking="0.14em" color="var(--ns-amber)">
              TRY AGAIN
            </Caps>
          </button>
        ) : null}
        <button
          onClick={onDismiss}
          aria-label="Dismiss message"
          style={{
            width: 'var(--target)',
            height: 'var(--target)',
            flex: '0 0 auto',
            color: 'var(--ns-text-secondary)',
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
 * 15 · The screenshot the Mac sent.
 *
 * The phone put it straight on the pasteboard and said nothing, which a browser
 * cannot do: writing an image to the clipboard needs a permission that is refused
 * more often than granted, and refused silently. So the shot is shown, with the two
 * things that can actually be done with it — and the footnote says which of the two
 * is likely to fail before it is tried.
 */
function ScreenshotSheet() {
  const sheet = useSheet<HTMLDivElement>(() => (store.screenshot.value = null))
  const source = store.screenshot.value
  if (!source) return null

  const display = store.selectedDisplay.value

  return (
    <div
      ref={sheet}
      class="sheet"
      role="dialog"
      aria-modal="true"
      aria-label="Screenshot of the Mac"
      style={{ zIndex: 65 }}
    >
      <ScreenBody>
        <div class="row" style={{ minHeight: '40px', marginTop: '16px', flex: '0 0 auto' }}>
          <SectionLabel>SCREENSHOT</SectionLabel>
          <span class="spacer" />
          <SheetDismiss onClick={() => (store.screenshot.value = null)} />
        </div>

        <Display level={26} rank={2} style={{ marginTop: '14px', flex: '0 0 auto' }}>
          The Mac’s screen,
          <br />
          a moment ago.
        </Display>

        <Caps size="var(--fs-9)" tracking="0.14em" style={{ marginTop: '10px', flex: '0 0 auto' }}>
          {display ? `${display.name.toUpperCase()} · ${display.width} × ${display.height} · PNG` : 'PNG'}
        </Caps>

        <div
          style={{
            flex: '1 1 auto',
            minHeight: 0,
            marginTop: '18px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: 'var(--ns-deep)',
            borderRadius: 'var(--radius-card)',
            overflow: 'hidden',
          }}
        >
          <img
            src={source}
            alt="The Mac’s screen at the moment the shot was taken"
            style={{
              maxWidth: '100%',
              maxHeight: '100%',
              objectFit: 'contain',
              display: 'block',
            }}
          />
        </div>

        <div class="row" style={{ gap: '9px', marginTop: '16px', flex: '0 0 auto' }}>
          <a
            href={source}
            download="vibewire-screenshot.png"
            class="outlined"
            style={{ flex: '1 1 0', minHeight: '56px', textDecoration: 'none' }}
          >
            <Caps size="var(--fs-10)" tracking="0.14em" color="var(--ns-text-secondary)">
              SAVE PNG
            </Caps>
          </a>
          <span style={{ flex: '1 1 0', display: 'flex' }}>
            <FilledAction title="COPY IMAGE" height={56} onClick={() => void copyImage(source)} />
          </span>
        </div>

        <Caps
          size="var(--fs-9)"
          tracking="0.12em"
          color="var(--ns-text-faint)"
          style={{
            marginTop: '12px',
            paddingBottom: 'calc(16px + var(--safe-bottom))',
            lineHeight: 1.7,
            flex: '0 0 auto',
          }}
        >
          {'A BROWSER USUALLY REFUSES A CLIPBOARD IMAGE WRITE.\nIF IT DOES, SAVE THE PNG INSTEAD.'}
        </Caps>
      </ScreenBody>
    </div>
  )
}

/**
 * 16 · WHAT THE MAC COPIED, when this browser would not take it.
 *
 * The clipboard write happens seconds after the tap that asked for it, with no
 * user gesture behind it, and most browsers refuse that outright. COPY used to
 * fail exactly this silently: the tile flashed, nothing reached the clipboard, and
 * the Mac's text was in a signal nothing rendered.
 *
 * A button inside this sheet *is* a gesture, so the same write succeeds from here.
 * The text is selectable either way, because a browser that refuses twice still
 * leaves the reader able to select it themselves.
 */
function ClipboardSheet() {
  const text = store.clipboardOffer.value
  const sheet = useSheet<HTMLDivElement>(() => (store.clipboardOffer.value = null))
  if (text == null) return null

  return (
    <div
      ref={sheet}
      class="sheet sheet--half"
      role="dialog"
      aria-modal="true"
      aria-label="Text copied from the Mac"
      style={{ zIndex: 65 }}
    >
      <ScreenBody>
        <div class="row" style={{ minHeight: '40px', marginTop: '16px', flex: '0 0 auto' }}>
          <SectionLabel>FROM THE MAC</SectionLabel>
          <span class="spacer" />
          <SheetDismiss title="CLOSE" onClick={() => (store.clipboardOffer.value = null)} />
        </div>

        <Caps size="var(--fs-9)" tracking="0.14em" style={{ marginTop: '12px', flex: '0 0 auto' }}>
          {`THIS BROWSER REFUSED THE CLIPBOARD · ${text.length} CHARACTERS`}
        </Caps>

        <pre
          class="code"
          style={{
            flex: '1 1 auto',
            minHeight: 0,
            overflow: 'auto',
            marginTop: '16px',
            whiteSpace: 'pre-wrap',
            userSelect: 'text',
          }}
        >
          {text}
        </pre>

        <div style={{ marginTop: '16px', paddingBottom: 'calc(16px + var(--safe-bottom))', flex: '0 0 auto' }}>
          <FilledAction
            title="COPY IT"
            height={56}
            onClick={() => {
              // Same reason as the store's own copy path: an optional chain here
              // swallows the whole call where the API is absent, and this button
              // is the answer to that very case.
              if (!navigator.clipboard?.writeText) {
                store.banner.value = { text: 'This browser has no clipboard here. Select the text and copy it.' }
                return
              }
              void navigator.clipboard
                .writeText(text)
                .then(() => {
                  store.clipboardOffer.value = null
                  store.note('Copied.')
                })
                .catch(() => {
                  store.banner.value = { text: 'Still refused. Select the text and copy it.' }
                })
            }}
          />
        </div>
      </ScreenBody>
    </div>
  )
}

async function copyImage(dataUrl: string): Promise<void> {
  try {
    const blob = await (await fetch(dataUrl)).blob()
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
  } catch {
    store.banner.value = {
        text: 'This browser would not put an image on the clipboard. Save the PNG instead.',
      }
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
    <BannerView
      banner={{
        text: "This browser has no WebCodecs H.264 decoder, so the Mac's picture will not appear. Pointer, keyboard, clipboard and Claude all still work. Chrome, Edge and Safari 17+ can show the picture.",
      }}
      onDismiss={() => setDismissed(true)}
    />
  )
}
