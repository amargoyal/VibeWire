/**
 * 18 · KEYS ON THE MACHINE THIS IS RUNNING ON.
 *
 * Every control in this client is a target for a finger, and on a laptop that
 * meant reaching for a pointer to do things the keyboard is already under. The
 * phone has no equivalent and needs none — this whole layer is off on a touch
 * device, where a shortcut sheet would be a list of keys nobody has.
 *
 * The hard part is not the bindings, it is knowing whose keyboard it is. Three
 * states own the keys outright and this layer must not take a single one of them:
 *
 *  - **A pointer capture.** The machine's keyboard *is* the Mac's; that is the
 *    whole point of the capture.
 *  - **The keyboard bar.** Same deal, without the lock.
 *  - **A browser text field.** The Claude composer, the combo editor, the address
 *    box. A bare letter typed there is a letter, not a command.
 *
 * And modifiers are never claimed. ⌘R has to reload, ⌘L has to reach the address
 * bar, ⌥Tab has to do whatever the window manager does with it. Every binding
 * here is one bare key, which is also why they are one key: a shortcut worth
 * having is one that can be pressed without looking.
 */

import { useEffect } from 'preact/hooks'
import { signal } from '@preact/signals'

import { store } from './store'
import { keyboardLocked, releaseKeyboardLock, requestKeyboardLock, typedIntoBrowser } from './keymap'
import { Caps, Display, ScreenBody, SectionLabel, SheetDismiss, useSheet } from '../design/components'

/** Open only from `?`, and only on a machine with a keyboard to press it with. */
export const showShortcuts = signal(false)

interface Binding {
  key: string
  label: string
  /** Where it applies, for the sheet to group by. */
  where: 'anywhere' | 'picture'
  run: () => void
}

const BINDINGS: Binding[] = [
  {
    key: '?',
    label: 'This list',
    where: 'anywhere',
    run: () => (showShortcuts.value = !showShortcuts.value),
  },
  {
    key: 'c',
    label: 'Claude',
    where: 'anywhere',
    run: () => {
      const open = store.presented.value === 'claude'
      store.presented.value = open ? null : 'claude'
      if (!open) store.listClaudeSessions()
    },
  },
  {
    key: ',',
    label: 'Settings',
    where: 'anywhere',
    run: () => {
      store.presented.value = store.presented.value === 'settings' ? null : 'settings'
    },
  },
  {
    key: 'f',
    label: 'Fill the screen',
    where: 'anywhere',
    run: () => void toggleFullscreen(),
  },
  {
    key: 'k',
    label: 'Keys to the Mac',
    where: 'picture',
    run: () => (store.showKeyboard.value = true),
  },
  {
    key: 'd',
    label: 'Commands',
    where: 'picture',
    run: () => (store.showHub.value = !store.showHub.value),
  },
  {
    key: 's',
    label: 'Screenshot the Mac',
    where: 'picture',
    run: () => void store.hub('shot'),
  },
  {
    key: '0',
    label: 'Fit the picture',
    where: 'picture',
    run: () => store.resetZoom(),
  },
  {
    key: '1',
    label: 'First screen',
    where: 'picture',
    run: () => selectDisplay(0),
  },
  {
    key: '2',
    label: 'Second screen',
    where: 'picture',
    run: () => selectDisplay(1),
  },
  {
    key: 'b',
    label: 'Both screens',
    where: 'picture',
    run: () => {
      if (store.displays.value.length < 2) return
      store.selectBothDisplays()
      store.startStream()
    },
  },
]

/**
 * Fullscreen, and the one thing that only fullscreen can buy.
 *
 * The browser keeps ⌘W, ⌘T, ⌘N, ⌘Q and ⌘⇧W whatever this page does about it —
 * `preventDefault` cannot stop a tab closing — and the keyboard bar has always
 * had to name them as keys that stay behind. The Keyboard Lock API is the one
 * exception, and it is only offered in fullscreen. So the two are asked for
 * together: fill the screen, and the keys the browser was holding go to the Mac.
 *
 * The lock is Chromium-only and can resolve on engines that then deliver nothing,
 * so what the app reports is what came back, never what was asked for.
 */
async function toggleFullscreen(): Promise<void> {
  try {
    if (document.fullscreenElement) {
      await document.exitFullscreen()
      return
    }
    await document.documentElement.requestFullscreen()
  } catch {
    // Some engines refuse this outside a user gesture chain, and a keystroke is
    // one — but a refusal here is not worth a banner: the screen simply did not
    // change, which the reader can see.
  }
}

function selectDisplay(index: number): void {
  const display = store.displays.value[index]
  if (!display) return
  store.selectDisplay(display.id)
  store.startStream()
}

/** True where a keyboard exists to be shortcut with. */
export function hasKeyboard(): boolean {
  return matchMedia('(pointer: fine)').matches
}

export function useShortcuts(): void {
  useEffect(() => {
    if (!hasKeyboard()) return

    const onKey = (event: KeyboardEvent) => {
      // Never a modified key. Those belong to the browser and to the system, and
      // taking one is how a client ends up unable to reload itself.
      if (event.metaKey || event.ctrlKey || event.altKey) return
      if (typedIntoBrowser(event.target)) return
      // The Mac's keyboard, in both of the states where it is the Mac's.
      if (store.showKeyboard.value || document.pointerLockElement) return

      const binding = BINDINGS.find((candidate) => candidate.key === event.key)
      if (!binding) return
      if (binding.where === 'picture' && store.route.value !== 'remote') return
      // Nothing but this list applies before there is a Mac: a Claude panel over
      // the pairing screen is a panel with nothing on the other end of it.
      if (binding.key !== '?' && store.route.value === 'pairing') return
      event.preventDefault()
      binding.run()
    }

    // The lock is granted to a fullscreen document and lost with it, so it is
    // taken and given back where fullscreen actually changes rather than where it
    // was requested — including when the reader leaves with the browser's own
    // Escape, which this page never sees as a keystroke.
    const onFullscreen = () => {
      if (document.fullscreenElement) void requestKeyboardLock()
      else releaseKeyboardLock()
    }

    window.addEventListener('keydown', onKey)
    document.addEventListener('fullscreenchange', onFullscreen)
    return () => {
      window.removeEventListener('keydown', onKey)
      document.removeEventListener('fullscreenchange', onFullscreen)
    }
  }, [])
}

/** 18 · KEYS — the list, which is the only way any of this is discoverable. */
export function ShortcutsSheet() {
  const sheet = useSheet<HTMLDivElement>(() => (showShortcuts.value = false))
  const groups: [string, Binding[]][] = [
    ['ANYWHERE', BINDINGS.filter((binding) => binding.where === 'anywhere')],
    ['ON THE PICTURE', BINDINGS.filter((binding) => binding.where === 'picture')],
  ]

  return (
    <div
      ref={sheet}
      class="sheet"
      role="dialog"
      aria-modal="true"
      aria-label="Keyboard shortcuts"
      style={{ zIndex: 66 }}
    >
      <ScreenBody scrolls>
        <div class="row" style={{ minHeight: '40px', marginTop: '16px', flex: '0 0 auto' }}>
          <SectionLabel>THIS MACHINE’S KEYBOARD</SectionLabel>
          <span class="spacer" />
          <SheetDismiss title="CLOSE" onClick={() => (showShortcuts.value = false)} />
        </div>

        <Display level={26} rank={2} style={{ marginTop: '14px', flex: '0 0 auto' }}>
          Keys that stay
          <br />
          on this side.
        </Display>

        <Caps size="var(--fs-9)" tracking="0.14em" style={{ marginTop: '12px', flex: '0 0 auto' }}>
          {'NOT SENT TO THE MAC · A CAPTURE OR THE KEYBOARD BAR TAKES THEM ALL BACK'}
        </Caps>

        {/* The one fact about this that is worth stating twice: what filling the
            screen actually buys is the five keys the browser otherwise keeps. */}
        <Caps
          size="var(--fs-9)"
          tracking="0.14em"
          color={keyboardLocked.value ? 'var(--ns-green)' : 'var(--ns-text-tertiary)'}
          style={{ marginTop: '8px', flex: '0 0 auto', lineHeight: 1.7 }}
        >
          {keyboardLocked.value
            ? 'FULL SCREEN · ⌘W ⌘T ⌘N ⌘Q ⌘⇧W ARE REACHING THE MAC'
            : 'FULL SCREEN IS WHAT LETS ⌘W ⌘T ⌘N ⌘Q ⌘⇧W REACH THE MAC · CHROMIUM ONLY'}
        </Caps>

        {groups.map(([title, bindings]) => (
          <div key={title} class="stack" style={{ gap: '9px', marginTop: '22px', flex: '0 0 auto' }}>
            <SectionLabel>{title}</SectionLabel>
            <div class="group">
              {bindings.map((binding) => (
                <div key={binding.key} class="group-row">
                  <span class="cap" style={{ flex: '0 0 auto', width: '46px', minHeight: '34px' }}>
                    <span class="mono" style={{ fontSize: 'var(--fs-14)' }}>
                      {binding.key}
                    </span>
                  </span>
                  <span style={{ fontSize: 'var(--fs-15)', fontWeight: 500 }}>{binding.label}</span>
                </div>
              ))}
            </div>
          </div>
        ))}

        <Caps
          size="var(--fs-9)"
          tracking="0.12em"
          color="var(--ns-text-faint)"
          style={{
            marginTop: '18px',
            paddingBottom: 'calc(30px + var(--safe-bottom))',
            lineHeight: 1.7,
            flex: '0 0 auto',
          }}
        >
          {'ESCAPE CLOSES WHATEVER IS ON TOP · NOTHING HERE USES ⌘, SO THE BROWSER KEEPS ITS OWN'}
        </Caps>
      </ScreenBody>
    </div>
  )
}
