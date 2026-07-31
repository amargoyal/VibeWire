/**
 * 05 · REMOTE — LIVE, 07 · TYPING, 08 · RECONNECTING, and 17 · STREAMING ON A
 * LAPTOP. The command drawer (06) is in `CommandDrawer.tsx`.
 * Mirrored by ios/VibeWire/Screens/RemoteView.swift.
 *
 * A 16:10 desktop inside a phone's glass leaves bands. They are used rather than
 * fought: the picture keeps every pixel it has, the chrome lives in the dark, and
 * the trackpad reaches past the video into the bands — so the first accidental
 * swipe in the dark area still moves the cursor, which is what teaches it.
 *
 * What Nightshift changed here is the control layer, not the glass. The thumb arc
 * is gone; its seven actions live in a labelled rail across the lower band and in
 * a drawer that stops short of the picture. The zoom slider that ran down the
 * right-hand edge is gone too — it was a control for a value nobody sets by hand,
 * and the scale it reported is now one word in the caption under the picture.
 *
 * What the browser adds over the phone, because the hardware is different:
 *
 *  - **Pointer capture.** Taking a Pointer Lock makes the Mac's cursor track the
 *    real one one-to-one, at whatever rate the device reports. Escape gives it
 *    back. This is the whole reason a laptop is a better VibeWire client than a
 *    phone.
 *  - **A real drag.** Captured, the mouse button is the Mac's mouse button: down,
 *    move, up is a drag. Uncaptured — and on touch — it is press-and-hold then
 *    move, because a finger sliding on a trackpad has always meant "move the
 *    pointer" and an uncaptured mouse is a trackpad.
 *  - **Wheel and ⌃wheel.** A scroll wheel scrolls the Mac; the pinch a trackpad
 *    reports as ⌃wheel zooms, the same as a two-finger pinch on glass.
 *
 * Uncaptured, a mouse is treated exactly as a finger: it steers only while its
 * button is down. Steering on hover was the first thing tried and it is wrong —
 * reaching for the STOP button dragged the Mac's cursor across the desktop on the
 * way.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'

import { bitrateMbps, store, type DisplayEntry } from '../app/store'
import {
  hostKeyName,
  modifiersFrom,
  releaseKeyboardLock,
  typedIntoBrowser,
} from '../app/keymap'
import {
  Announce,
  Caps,
  Card,
  conditionColor,
  CornerTicks,
  KeyCap,
  MODIFIERS,
  Segmented,
  Spinner,
  tapVerb,
  Tile,
  VideoCaption,
} from '../design/components'
import { CommandDrawer } from './CommandDrawer'
import { focusKeyboardField, isTouchPrimary, KeyboardBar, KeyboardField } from './KeyboardBar'
import { VideoSurface } from './VideoSurface'

type PadMode = 'pointer' | 'pan'

/** Below this a press is a tap, not a travel. */
const TAP_SLOP = 6
/** How long a finger has to stay put before a slide becomes a drag. */
const HOLD_TO_DRAG_MS = 450
/** The two keys that fire whatever the browser has focused. */
const ACTIVATION_CODES = new Set(['Space', 'Enter', 'NumpadEnter'])

/** Whether the keystroke landed on something the browser can activate. */
function focusedControl(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null
  return !!node?.closest?.('button, a[href], [role="button"], [tabindex]:not([tabindex="-1"])')
}

export function Remote() {
  const [padMode, setPadMode] = useState<PadMode>('pointer')
  const [pan, setPan] = useState({ x: 0, y: 0 })
  const [captured, setCaptured] = useState(false)
  const [showZoomBadge, setShowZoomBadge] = useState(false)
  const [dragging, setDragging] = useState(false)
  const [landscape, setLandscape] = useState(false)
  const [showTeaching] = useState(() => store.sessionCount.value <= 3)

  const glass = useRef<HTMLDivElement | null>(null)
  const picture = useRef<HTMLDivElement | null>(null)
  const pictureSize = useRef({ width: 0, height: 0 })

  const streamState = store.streamState.value
  const stalled = streamState.kind === 'stalled' || streamState.kind === 'reconnecting'
  const zoom = store.zoomScale.value

  // Orientation taken from the glass, not from a user-agent string. A window that
  // is wider than it is tall gets the dock whatever the device claims to be, which
  // also covers a laptop window and a tablet in Split View without once asking
  // what it is running on.
  useLayoutEffect(() => {
    const node = glass.current
    if (!node) return
    const apply = () => {
      const next = node.clientWidth > node.clientHeight
      setLandscape((current) => {
        if (current === next) return current
        // The picture is re-framed completely by the rotation, so a pan measured
        // against the old frame means nothing — recentre instead of carrying a
        // stale offset into a differently shaped glass.
        setPan({ x: 0, y: 0 })
        return next
      })
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])

  useLayoutEffect(() => {
    const node = picture.current
    if (!node) return
    const apply = () => {
      pictureSize.current = { width: node.clientWidth, height: node.clientHeight }
    }
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(node)
    return () => observer.disconnect()
  }, [landscape, store.sideBySide.value])

  const clampPan = (proposed: { x: number; y: number }) => {
    // Stops the picture being dragged off its own glass: the travel available is
    // exactly the overhang the zoom created.
    const scale = store.zoomScale.value
    const { width, height } = pictureSize.current
    if (scale <= 1 || !width || !height) return { x: 0, y: 0 }
    const slackX = (width * (scale - 1)) / 2
    const slackY = (height * (scale - 1)) / 2
    return {
      x: Math.min(Math.max(proposed.x, -slackX), slackX),
      y: Math.min(Math.max(proposed.y, -slackY), slackY),
    }
  }

  const resetView = () => {
    store.resetZoom()
    setPan({ x: 0, y: 0 })
  }

  const applyZoom = (
    scale: number,
    focal: { x: number; y: number },
    fromZoom: number,
    fromPan: { x: number; y: number },
  ) => {
    store.zoom(scale)
    // Keep whatever is under the fingers under the fingers, by moving the picture
    // rather than moving the scale origin. Anchoring the transform at the pinch
    // point instead looks right for one gesture and then traps you: the anchor is
    // also the point the offset is measured from, so panning away from it fights
    // the zoom and the picture springs back.
    const ratio = store.zoomScale.value / Math.max(fromZoom, 0.01)
    setPan(
      clampPan({
        x: focal.x - (focal.x - fromPan.x) * ratio,
        y: focal.y - (focal.y - fromPan.y) * ratio,
      }),
    )
    setShowZoomBadge(true)
  }

  // MARK: Pointer, touch and wheel

  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const gesture = useRef({
    startDistance: 0,
    startZoom: 1,
    startPan: { x: 0, y: 0 },
    centroid: { x: 0, y: 0 },
    travel: 0,
    holdTimer: 0 as unknown as ReturnType<typeof setTimeout> | 0,
    pinching: false,
    // The one-finger press that has not yet decided whether it is a tap.
    single: null as { id: number; type: string; x: number; y: number } | null,
    lastTapAt: 0,
  })

  const beginDrag = () => {
    if (dragging) return
    setDragging(true)
    store.drag('begin')
    navigator.vibrate?.(8)
  }

  const endDrag = () => {
    if (!dragging) return
    setDragging(false)
    store.drag('end')
  }

  const clearHold = () => {
    if (gesture.current.holdTimer) clearTimeout(gesture.current.holdTimer)
    gesture.current.holdTimer = 0
  }

  const centroidOf = () => {
    const all = [...pointers.current.values()]
    const sum = all.reduce((total, point) => ({ x: total.x + point.x, y: total.y + point.y }), {
      x: 0,
      y: 0,
    })
    return { x: sum.x / all.length, y: sum.y / all.length }
  }

  const distanceOf = () => {
    const all = [...pointers.current.values()]
    if (all.length < 2) return 0
    return Math.hypot(all[0].x - all[1].x, all[0].y - all[1].y)
  }

  const onPointerDown = (event: PointerEvent) => {
    // Controls layered on the glass keep their taps.
    if ((event.target as HTMLElement).closest('button, input, textarea, a, [data-nopad]')) return

    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })

    if (pointers.current.size === 2) {
      clearHold()
      gesture.current.pinching = true
      gesture.current.startDistance = distanceOf()
      gesture.current.startZoom = store.zoomScale.value
      gesture.current.startPan = pan
      gesture.current.centroid = centroidOf()
      gesture.current.single = null
      return
    }

    if (pointers.current.size !== 1) return

    gesture.current.travel = 0
    gesture.current.single = {
      id: event.pointerId,
      type: event.pointerType,
      x: event.clientX,
      y: event.clientY,
    }

    clearHold()
    gesture.current.holdTimer = setTimeout(() => {
      if (gesture.current.travel < TAP_SLOP && padMode === 'pointer') beginDrag()
    }, HOLD_TO_DRAG_MS)
  }

  const onPointerMove = (event: PointerEvent) => {
    const previous = pointers.current.get(event.pointerId)
    // A pointer we are not tracking is a mouse hovering with no button down, and it
    // steers nothing. Hover-steering was the obvious first cut and it is wrong:
    // reaching for the STOP button dragged the Mac's cursor across the desktop on
    // the way. Free steering is what pointer capture is for.
    if (!previous) return

    const dx = event.clientX - previous.x
    const dy = event.clientY - previous.y
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    gesture.current.travel += Math.hypot(dx, dy)

    if (pointers.current.size >= 2) {
      const distance = distanceOf()
      const centroid = centroidOf()
      // Two fingers scroll the Mac and pinch to zoom, and only that: moving the
      // picture belongs to the pad mode, which is a stated choice rather than a
      // gesture fighting the pinch for the same two fingers.
      const step = {
        x: centroid.x - gesture.current.centroid.x,
        y: centroid.y - gesture.current.centroid.y,
      }
      gesture.current.centroid = centroid
      if (step.x || step.y) store.scroll(step.x, step.y)

      if (gesture.current.startDistance > 8 && distance > 8) {
        const box = picture.current?.getBoundingClientRect()
        const focal = box
          ? {
              x: gesture.current.centroid.x - (box.left + box.width / 2),
              y: gesture.current.centroid.y - (box.top + box.height / 2),
            }
          : { x: 0, y: 0 }
        applyZoom(
          gesture.current.startZoom * (distance / gesture.current.startDistance),
          focal,
          gesture.current.startZoom,
          gesture.current.startPan,
        )
      }
      return
    }

    if (gesture.current.travel >= TAP_SLOP) clearHold()

    if (padMode === 'pan') {
      // The finger carries the picture, so it tracks the finger rather than
      // nudging it.
      setPan((current) => clampPan({ x: current.x + dx, y: current.y + dy }))
      return
    }

    if (dragging) store.drag('move', dx, dy)
    else store.movePointer(dx, dy)
  }

  const onPointerUp = (event: PointerEvent) => {
    const wasTracking = pointers.current.delete(event.pointerId)
    if (!wasTracking) return
    clearHold()

    if (pointers.current.size >= 1) {
      // Still a multi-touch gesture in progress; re-baseline what is left so the
      // remaining finger does not jump the picture.
      gesture.current.centroid = centroidOf()
      gesture.current.startDistance = distanceOf()
      gesture.current.startZoom = store.zoomScale.value
      gesture.current.startPan = pan
      return
    }

    const wasPinching = gesture.current.pinching
    gesture.current.pinching = false
    setShowZoomBadge(false)

    if (dragging) {
      endDrag()
      return
    }

    // A short press that did not travel is a click — unless two fingers were
    // pinching, where lifting them must not land a click, or the pad is moving the
    // view rather than the Mac's pointer.
    if (gesture.current.travel < TAP_SLOP && !wasPinching && padMode === 'pointer') {
      const now = performance.now()
      if (now - gesture.current.lastTapAt < 300) {
        gesture.current.lastTapAt = 0
        resetView()
        return
      }
      gesture.current.lastTapAt = now
      store.click()
      navigator.vibrate?.(5)
    }
  }

  const onWheel = (event: WheelEvent) => {
    event.preventDefault()
    if (event.ctrlKey) {
      // What a trackpad pinch looks like to a browser.
      const box = picture.current?.getBoundingClientRect()
      const focal = box
        ? {
            x: event.clientX - (box.left + box.width / 2),
            y: event.clientY - (box.top + box.height / 2),
          }
        : { x: 0, y: 0 }
      const from = store.zoomScale.value
      applyZoom(from * (1 - event.deltaY / 200), focal, from, pan)
      setTimeout(() => setShowZoomBadge(false), 700)
      return
    }
    store.scroll(-event.deltaX, -event.deltaY)
  }

  // MARK: Pointer lock

  const requestCapture = () => {
    if (!matchMedia('(pointer: fine)').matches) return
    const node = glass.current
    if (!node) return
    void node.requestPointerLock?.()
  }

  useEffect(() => {
    const onChange = () => setCaptured(document.pointerLockElement === glass.current)
    document.addEventListener('pointerlockchange', onChange)
    return () => document.removeEventListener('pointerlockchange', onChange)
  }, [])

  useEffect(() => {
    if (!captured) return
    const onMove = (event: MouseEvent) => {
      if (padMode !== 'pointer') return
      if (event.buttons > 0) {
        if (!dragging) beginDrag()
        store.drag('move', event.movementX, event.movementY)
      } else {
        if (dragging) endDrag()
        store.movePointer(event.movementX, event.movementY)
      }
    }
    const onDown = (event: MouseEvent) => {
      event.preventDefault()
      gesture.current.travel = 0
    }
    const onUp = (event: MouseEvent) => {
      event.preventDefault()
      if (dragging) {
        endDrag()
        return
      }
      store.click(1, event.button === 2 ? 'right' : 'left')
    }
    const onContext = (event: Event) => event.preventDefault()

    document.addEventListener('mousemove', onMove)
    document.addEventListener('mousedown', onDown)
    document.addEventListener('mouseup', onUp)
    document.addEventListener('contextmenu', onContext)
    return () => {
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('mouseup', onUp)
      document.removeEventListener('contextmenu', onContext)
    }
  }, [captured, padMode, dragging])

  // MARK: Physical keyboard
  //
  // A captured pointer means the hands are on the machine's own keyboard, so that
  // keyboard should be the Mac's. Held modifiers are mirrored from the event rather
  // than latched, because a real keyboard already reports what is down.
  //
  // Deliberately *not* installed on a touch device with the keyboard bar open: the
  // bar's hidden field owns the system keyboard there, and a `preventDefault` here
  // would swallow every character before the field ever saw it — the on-screen
  // keyboard would type nothing at all.
  //
  // Three keys are never taken, or the browser stops being operable from a keyboard
  // — which the WCAG people call a trap and everyone else calls a stuck app:
  //
  //  - **Anything typed into a browser field.** The combo editor, the Claude
  //    composer and the address box are the browser's own; only the hidden field
  //    that exists to feed the Mac is exempt, and it says so with an attribute.
  //  - **Escape.** It is the way out of both modes — it releases a capture, and it
  //    closes the bar. The Mac's own Escape is the `esc` cap in the bar, which is
  //    there precisely because the browser will not part with this one.
  //  - **Tab, Space and Return while uncaptured.** Focus still has to move and a
  //    focused button still has to fire. Under a capture there is no page to
  //    operate, so all three go to the Mac.

  useEffect(() => {
    const barOpen = store.showKeyboard.value && !isTouchPrimary()
    const wantsPhysical = captured || barOpen
    if (!wantsPhysical) return

    /** Keys this browser keeps, and what to do with them instead. */
    const browsersOwn = (event: KeyboardEvent): boolean => {
      if (typedIntoBrowser(event.target)) return true
      if (captured) return false
      if (event.code === 'Tab') return true
      if (ACTIVATION_CODES.has(event.code) && focusedControl(event.target)) return true
      return false
    }

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code === 'Escape') {
        // The browser is about to exit the pointer lock on its own; the bar is ours
        // to close. Either way this key never reaches the Mac from here.
        if (!captured) store.showKeyboard.value = false
        return
      }
      if (browsersOwn(event)) return
      const name = hostKeyName(event.code)
      store.setModifiers(modifiersFrom(event))
      if (!name) return
      event.preventDefault()
      store.keyDown(name, event.key.length === 1 ? event.key : undefined)
    }
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code === 'Escape' || browsersOwn(event)) return
      const name = hostKeyName(event.code)
      store.setModifiers(modifiersFrom(event))
      if (!name) return
      event.preventDefault()
      store.keyUp(name, event.key.length === 1 ? event.key : undefined)
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
      // Anything still held belongs to a keyboard nobody is watching any more.
      store.releaseModifiers()
      releaseKeyboardLock()
    }
  }, [captured, store.showKeyboard.value])

  const stallSeconds =
    streamState.kind === 'stalled' ? Math.floor(streamState.millis / 1000) : store.tick.value % 60

  const padHandlers = {
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
    onWheel,
  }

  return (
    <div
      ref={glass}
      class="remote"
      style={{
        flexDirection: landscape ? 'row' : 'column',
        // The pad is the glass: the browser must not claim these gestures for
        // scrolling or page zoom.
        touchAction: 'none',
        cursor: captured ? 'none' : padMode === 'pan' ? 'grab' : 'default',
      }}
      {...padHandlers}
    >
      {landscape ? (
        <LandscapeLayout
          pan={pan}
          padMode={padMode}
          setPadMode={setPadMode}
          pictureRef={picture}
          captured={captured}
          onCapture={requestCapture}
        />
      ) : (
        <PortraitLayout
          pan={pan}
          padMode={padMode}
          setPadMode={setPadMode}
          pictureRef={picture}
          showTeaching={showTeaching}
          captured={captured}
          onCapture={requestCapture}
          dragging={dragging}
        />
      )}

      {zoom > 1.02 ? <Minimap /> : null}
      {showZoomBadge ? <ZoomBadge /> : null}
      {stalled ? <ReconnectingCard seconds={stallSeconds} landscape={landscape} /> : null}
      {store.showHub.value ? <CommandDrawer /> : null}
      {store.showKeyboard.value ? <KeyboardBar /> : null}
      {/* Mounted for the whole session, not with the bar: iOS opens the keyboard only
          for a focus() that happens inside a tap handler, and a field that does not
          exist yet cannot be focused. */}
      <KeyboardField />
    </div>
  )
}

// MARK: - Portrait

function PortraitLayout({
  pan,
  padMode,
  setPadMode,
  pictureRef,
  showTeaching,
  captured,
  onCapture,
  dragging,
}: {
  pan: { x: number; y: number }
  padMode: PadMode
  setPadMode: (mode: PadMode) => void
  pictureRef: { current: HTMLDivElement | null }
  showTeaching: boolean
  captured: boolean
  onCapture: () => void
  dragging: boolean
}) {
  const displays = store.displays.value
  const live = store.streamState.value.kind === 'live'

  return (
    <>
      <div
        class="row"
        style={{
          height: '44px',
          flex: '0 0 auto',
          gap: '10px',
          paddingInline: 'calc(14px + var(--safe-left)) calc(14px + var(--safe-right))',
          marginTop: 'var(--safe-top)',
        }}
      >
        <StopButton size={36} />
        <StatusStrip />
      </div>

      {displays.length > 1 ? (
        <div
          style={{
            paddingInline: 'calc(14px + var(--safe-left)) calc(14px + var(--safe-right))',
            marginTop: '6px',
            flex: '0 0 auto',
          }}
        >
          <DisplayTabs />
        </div>
      ) : null}

      <span class="spacer" />

      {store.sideBySide.value ? (
        <SideBySidePanes />
      ) : (
        <Picture pan={pan} pictureRef={pictureRef} captured={captured} dragging={dragging} />
      )}

      <PictureCaption dragging={dragging} />

      <span class="spacer" />

      <div
        class="stack"
        style={{
          gap: '10px',
          paddingBottom: 'calc(12px + var(--safe-bottom))',
          flex: '0 0 auto',
        }}
      >
        {showTeaching && live && !store.sideBySide.value && !store.showHub.value ? (
          <TeachingLegend />
        ) : null}
        <Rail padMode={padMode} setPadMode={setPadMode} captured={captured} onCapture={onCapture} />
      </div>
    </>
  )
}

/** Ends the session. The one control that is in the same place in every layout. */
function StopButton({ size, label }: { size: number; label?: string }) {
  const stalled = store.streamState.value.kind === 'stalled'
  return (
    <button
      onClick={() => store.stopStream()}
      aria-label={stalled ? 'Stop trying to reconnect' : 'Stop streaming'}
      style={{
        width: label ? undefined : `${size}px`,
        height: `${size}px`,
        flex: label ? '1 1 auto' : '0 0 auto',
        paddingInline: label ? '18px' : 0,
        borderRadius: 'var(--radius-inner)',
        background: 'var(--ns-chrome-2)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '9px',
        color: 'var(--ns-text-secondary)',
      }}
    >
      <span class="mono" aria-hidden="true" style={{ fontSize: 'var(--fs-14)' }}>
        ✕
      </span>
      {label ? (
        <Caps size="var(--fs-9)" tracking="0.14em" color="var(--ns-text-secondary)">
          {label}
        </Caps>
      ) : null}
    </button>
  )
}

function StatusStrip() {
  const condition = store.condition.value
  const state = store.streamState.value
  const link = store.link.value
  const configs = Object.values(store.videoConfigs.value)
  const reconnecting = state.kind === 'reconnecting' || state.kind === 'stalled'

  const liveLabel = (() => {
    switch (state.kind) {
      case 'live':
        return `LIVE ${link.rttMillis == null ? '—' : Math.round(link.rttMillis)}MS`
      case 'starting':
        return 'OPENING'
      case 'stalled':
        return `STALLED ${(state.millis / 1000).toFixed(1)}S`
      case 'reconnecting':
        return `RECONNECTING · TRY ${state.attempt}`
      case 'stopped':
        return 'STOPPED'
      case 'failed':
        return 'LOST'
    }
  })()

  const codecLabel = (() => {
    if (!configs.length) return '—'
    if (configs.length > 1) {
      const total = configs.reduce((sum, config) => sum + bitrateMbps(config), 0)
      return `${configs.length} STREAMS · ${total.toFixed(1)} MB/S`
    }
    const config = configs[0]
    return `H.264 · ${bitrateMbps(config).toFixed(1)} MB/S · ${config.fps}FPS`
  })()

  const tone = reconnecting ? 'var(--ns-amber)' : conditionColor[condition]

  // The kind of state, never the numbers in it: the RTT and the stall counter
  // change every second, and a live region would read them out every second.
  const spoken = {
    live: 'The picture is live.',
    starting: 'Opening the picture.',
    stalled: 'The picture has stalled.',
    reconnecting: 'Reconnecting to the Mac.',
    stopped: 'The picture is stopped.',
    failed: 'The connection to the Mac was lost.',
  }[state.kind]

  return (
    <>
      <Announce>{spoken}</Announce>
      <span class="row" style={{ gap: '7px' }}>
        <span
          class={
            reconnecting
              ? 'dot dot--pulse dot--pulse-fast'
              : state.kind === 'live'
                ? 'dot'
                : 'dot dot--pulse'
          }
          aria-hidden="true"
          // Nothing decorative moves next to a live video feed; a stall is not
          // decoration.
          style={{ width: '6px', height: '6px', background: tone }}
        />
        <Caps size="var(--fs-10)" tracking="0.14em" color={tone}>
          {liveLabel}
        </Caps>
      </span>
      <span class="spacer" />
      <Caps size="var(--fs-9)" tracking="0.1em">
        {reconnecting ? '—' : codecLabel}
      </Caps>
    </>
  )
}

function DisplayTabs() {
  const displays = store.displays.value
  const options = displays.map((display, index) => ({
    value: display.id,
    label: `MON ${index + 1}`,
    badge: null,
  }))
  if (displays.length > 1) options.push({ value: -1, label: 'BOTH', badge: null })

  const selection = store.sideBySide.value ? -1 : (store.selectedDisplay.value?.id ?? 0)

  return (
    <div data-nopad>
      <Segmented
        label="Which display"
        onGlass
        options={options}
        selection={selection}
        onSelect={(value) => {
          if (value === -1) store.selectBothDisplays()
          else store.selectDisplay(value)
          store.startStream()
        }}
      />
    </div>
  )
}

function pictureAspect(): number {
  const config = Object.values(store.videoConfigs.value)[0]
  if (!config || config.height <= 0) return 16 / 10
  return config.width / config.height
}

/** Amber ticks and caption while stalled: the frozen frame keeps its geometry but
 *  stops claiming to be live. */
function stallTint(): string | null {
  const kind = store.streamState.value.kind
  return kind === 'stalled' || kind === 'reconnecting'
    ? 'color-mix(in srgb, var(--ns-amber) 80%, transparent)'
    : null
}

function Picture({
  pan,
  pictureRef,
  captured,
  dragging,
}: {
  pan: { x: number; y: number }
  pictureRef: { current: HTMLDivElement | null }
  captured: boolean
  dragging: boolean
}) {
  const tint = stallTint()
  const state = store.streamState.value
  const renderer = store.selectedRenderer()

  return (
    <div
      ref={pictureRef}
      style={{ position: 'relative', flex: '0 1 auto', minHeight: 0, display: 'flex' }}
    >
      <VideoSurface
        renderer={renderer}
        aspect={pictureAspect()}
        transform={`translate(${pan.x}px, ${pan.y}px) scale(${store.zoomScale.value})`}
      />

      {/* Corner ticks stay forever — they mark the edge of the real pixels so a
          zoomed picture never looks like a cropped one. */}
      <CornerTicks color={tint ?? 'color-mix(in srgb, var(--ns-accent) 75%, transparent)'} />

      {state.kind === 'starting' ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Spinner size={24} />
        </div>
      ) : null}

      {renderer.failure ? (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '24px',
          }}
        >
          <p
            class="wrap"
            style={{
              margin: 0,
              maxWidth: '38ch',
              padding: '14px 16px',
              borderRadius: 'var(--radius-control)',
              fontSize: 'var(--fs-13)',
              lineHeight: 1.45,
              color: 'var(--ns-on-amber-wash)',
              background: 'color-mix(in srgb, var(--ns-deep) 92%, transparent)',
              boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--ns-amber) 34%, transparent)',
            }}
          >
            The Mac is sending video this browser cannot decode: {renderer.failure}
          </p>
        </div>
      ) : null}

      {captured ? (
        <div style={{ position: 'absolute', right: '14px', bottom: '14px' }}>
          <VideoCaption color="var(--ns-accent)">POINTER CAPTURED · ESC RELEASES</VideoCaption>
        </div>
      ) : null}

      {dragging ? (
        <div style={{ position: 'absolute', left: '14px', bottom: '14px' }}>
          <VideoCaption color="var(--ns-accent)">DRAGGING · LIFT TO DROP</VideoCaption>
        </div>
      ) : null}
    </div>
  )
}

/**
 * What is on screen and at what scale, stated in the band rather than over the
 * picture. This is where the zoom rail's reading went: a slider nobody drags is
 * not worth 128px of the right-hand edge, but the number it carried is.
 */
function PictureCaption({ dragging }: { dragging: boolean }) {
  const display = store.selectedDisplay.value
  const state = store.streamState.value
  const zoom = store.zoomScale.value
  const tint = stallTint()

  const left = (() => {
    if (state.kind === 'stalled' || state.kind === 'reconnecting') return 'LAST GOOD FRAME'
    if (dragging) return 'DRAGGING · LIFT TO DROP'
    if (!display) return ''
    return `${display.name.toUpperCase()} · ${display.width} × ${display.height}`
  })()

  return (
    <div
      class="row"
      style={{
        paddingInline: 'calc(14px + var(--safe-left)) calc(14px + var(--safe-right))',
        paddingTop: '12px',
        flex: '0 0 auto',
      }}
    >
      {left ? <VideoCaption color={tint ?? 'var(--ns-text-secondary)'}>{left}</VideoCaption> : null}
      <span class="spacer" />
      <Caps
        size="var(--fs-9)"
        tracking="0.1em"
        color={zoom > 1.02 ? 'var(--ns-accent)' : 'var(--ns-text-tertiary)'}
      >
        {zoom > 1.02 ? `${zoom.toFixed(1)}×` : '1.0× FIT'}
      </Caps>
    </div>
  )
}

// MARK: — side by side

function SideBySidePanes() {
  const displays = store.displays.value
  return (
    <div class="stack" style={{ gap: '10px', flex: '0 1 auto', minHeight: 0 }}>
      {displays.map((display, index) => {
        const focused = store.inputPane.value === index
        return (
          <div
            key={display.id}
            // A pane is a control: it decides which screen the trackpad and the
            // keyboard are pointed at. It was the one thing on the page a keyboard
            // could not reach, on the layout most likely to be driven by one.
            role="button"
            tabIndex={0}
            aria-pressed={focused}
            aria-label={`Send input to ${display.name}`}
            style={{ position: 'relative', flex: '1 1 0', minHeight: 0, display: 'flex' }}
            onClick={() => {
              store.inputPane.value = index
              store.selectDisplay(display.id)
            }}
            onKeyDown={(event) => {
              if (event.key !== 'Enter' && event.key !== ' ') return
              event.preventDefault()
              store.inputPane.value = index
              store.selectDisplay(display.id)
            }}
          >
            <VideoSurface
              renderer={store.renderer(display.id)}
              aspect={paneAspect(display)}
              style={{ opacity: focused ? 1 : 0.55 }}
            />
            {focused ? (
              <CornerTicks color="color-mix(in srgb, var(--ns-accent) 80%, transparent)" />
            ) : null}
            <div
              class="row"
              style={{ position: 'absolute', left: '14px', bottom: '14px', gap: '8px' }}
            >
              {focused ? (
                <Caps
                  class="video-chip"
                  size="var(--fs-9)"
                  tracking="0.1em"
                  color="var(--ns-accent)"
                  style={{
                    boxShadow: 'inset 0 0 0 1px color-mix(in srgb, var(--ns-accent) 50%, transparent)',
                  }}
                >
                  INPUT HERE
                </Caps>
              ) : null}
              <VideoCaption>
                {focused
                  ? `${display.name.toUpperCase()} · ${display.width} × ${display.height}`
                  : `${display.name.toUpperCase()} · ${tapVerb()} TO TAKE INPUT`}
              </VideoCaption>
            </div>
          </div>
        )
      })}
    </div>
  )
}

function paneAspect(display: DisplayEntry): number {
  const config = Object.values(store.videoConfigs.value).find(
    (entry) => entry.displayId === display.id,
  )
  if (config && config.height > 0) return config.width / config.height
  if (display.height <= 0) return 16 / 10
  return display.width / display.height
}

// MARK: Overlays

/**
 * What the glass does, said once, in the band under the picture.
 *
 * The breathing ring that used to sit above this text is gone with the arc: it
 * marked a place to touch, and now that the whole glass is the pad and the
 * controls are labelled, the sentence is the whole instruction.
 */
function TeachingLegend() {
  return (
    <Caps
      size="var(--fs-9)"
      tracking="0.16em"
      style={{
        textAlign: 'center',
        lineHeight: 1.8,
        paddingInline: '14px',
        pointerEvents: 'none',
      }}
    >
      {matchMedia('(pointer: fine)').matches
        ? 'DRAG ANYWHERE ON THE GLASS · ESC RELEASES A CAPTURE\nWHEEL SCROLLS · ⌃WHEEL ZOOMS · ? LISTS THE KEYS'
        : 'MOVE ANYWHERE ON THE GLASS\nTWO FINGERS SCROLL · PINCH ZOOMS'}
    </Caps>
  )
}

/** The scale reads out big in the middle, where the eye already is. */
function ZoomBadge() {
  return (
    <div
      class="stack"
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        alignItems: 'center',
        justifyContent: 'center',
        gap: '6px',
        pointerEvents: 'none',
      }}
    >
      <span class="mono" style={{ fontSize: 'var(--fs-46)', fontWeight: 500, letterSpacing: '-0.03em' }}>
        {store.zoomScale.value.toFixed(1)}×
      </span>
      <Caps size="var(--fs-10)" tracking="0.2em" color="var(--ns-accent)">
        {`DOUBLE-${tapVerb()} FITS`}
      </Caps>
    </div>
  )
}

/** Only appears above 1.0×. It answers "where am I", which is the only question
 *  zoom creates. */
function Minimap() {
  const zoom = store.zoomScale.value
  const display = store.selectedDisplay.value
  return (
    <div
      class="stack"
      aria-hidden="true"
      style={{
        position: 'absolute',
        top: 'calc(62px + var(--safe-top))',
        right: 'calc(16px + var(--safe-right))',
        gap: '6px',
        alignItems: 'flex-end',
        pointerEvents: 'none',
      }}
    >
      <span
        style={{
          position: 'relative',
          width: '78px',
          height: '49px',
          borderRadius: 'var(--radius-small)',
          background: 'color-mix(in srgb, var(--ns-deep) 88%, transparent)',
          boxShadow: 'inset 0 0 0 1px var(--ns-stroke)',
          display: 'block',
        }}
      >
        <span
          style={{
            position: 'absolute',
            top: '50%',
            left: '50%',
            transform: 'translate(-50%, -50%)',
            width: `${78 / zoom}px`,
            height: `${49 / zoom}px`,
            background: 'color-mix(in srgb, var(--ns-accent) 18%, transparent)',
            boxShadow: 'inset 0 0 0 1px var(--ns-accent)',
          }}
        />
      </span>
      <Caps size="var(--fs-9)" tracking="0.12em">
        {display ? `${display.name.toUpperCase()} REGION` : 'REGION'}
      </Caps>
    </div>
  )
}

/**
 * A stall looks like a stall: it says how old the picture is, that input is queued
 * rather than lost, and when it will stop trying.
 *
 * It sits above the rail rather than over the picture, because the frozen frame is
 * the thing being explained and covering it is what made this banner confusing on
 * the phone.
 */
function ReconnectingCard({ seconds, landscape }: { seconds: number; landscape: boolean }) {
  const rows: [string, string, string][] = [
    ['QUEUED INPUT', `${store.queuedInputCount.value} EVENTS`, 'var(--ns-text)'],
    ['DROPPING TO', '540P ON RESUME', 'var(--ns-amber)'],
    ['GIVING UP AT', '30S', 'var(--ns-text)'],
  ]
  return (
    <div
      // Not a live region. The sentence inside it counts the seconds since the
      // last frame, and announcing "the picture above is 4.0 seconds old" once a
      // second for thirty seconds is not a report, it is a metronome. The state
      // itself is announced once, by the status strip.
      data-nopad
      style={{
        position: 'absolute',
        left: 'calc(14px + var(--safe-left))',
        right: landscape
          ? 'calc(min(276px, 38vw) + 14px)'
          : 'calc(14px + var(--safe-right))',
        bottom: landscape
          ? 'calc(88px + var(--safe-bottom))'
          : 'calc(78px + var(--safe-bottom))',
        maxWidth: 'var(--measure)',
      }}
    >
      <Card tint="var(--ns-amber)" style={{ padding: '16px 18px 18px' }}>
        <div class="stack" style={{ gap: '13px' }}>
          <div class="row" style={{ gap: '10px' }}>
            <Spinner size={16} color="var(--ns-amber)" />
            <Caps size="var(--fs-11)" tracking="0.16em" color="var(--ns-amber)" weight={500}>
              RECONNECTING
            </Caps>
          </div>
          <p class="prose wrap">
            The picture above is {seconds}.0 seconds old. Keys and taps are being held, not dropped.
          </p>
          <div class="stack" style={{ gap: '8px' }}>
            {rows.map(([label, value, color]) => (
              <div key={label} class="row">
                <Caps size="var(--fs-9)" tracking="0.1em">
                  {label}
                </Caps>
                <span class="spacer" />
                <Caps size="var(--fs-9)" tracking="0.1em" color={color}>
                  {value}
                </Caps>
              </div>
            ))}
          </div>
        </div>
      </Card>
    </div>
  )
}

// MARK: - The rail

/**
 * The control layer, in the lower letterbox band.
 *
 * Four things, left to right: what one finger does, the keyboard, the Command key,
 * and everything else. The first is the only one that is a mode, so it is the only
 * one drawn as a segmented control; the other three are 52px squares in the order
 * they are reached for.
 *
 * ⌘ latches Command directly rather than opening the drawer to it. It is the
 * modifier a Mac actually needs — ⌘Tab, ⌘Space, ⌘W — and putting it one tap away
 * instead of two is the difference between using it and not.
 */
function Rail({
  padMode,
  setPadMode,
  captured,
  onCapture,
}: {
  padMode: PadMode
  setPadMode: (mode: PadMode) => void
  captured: boolean
  onCapture: () => void
}) {
  const stalled = store.streamState.value.kind === 'stalled'
  const fine = matchMedia('(pointer: fine)').matches
  const cmdHeld = store.heldModifiers.value.includes('cmd')

  if (stalled) {
    return (
      <div class="remote__rail" data-nopad>
        <StopButton size={52} label="STOP TRYING" />
        <button
          class="rail-button"
          disabled
          aria-label="Keyboard, unavailable while reconnecting"
          style={{ color: 'var(--ns-text-disabled)' }}
        >
          <span class="mono" style={{ fontSize: 'var(--fs-15)' }}>
            ⌨
          </span>
        </button>
        <DrawerButton />
      </div>
    )
  }

  return (
    <div class="remote__rail" data-nopad>
      <div
        class="segmented segmented--onGlass"
        role="tablist"
        aria-label="What one finger does"
        style={{ flex: '1 1 auto', height: '52px', borderRadius: 'var(--radius-control)' }}
      >
        <PadModeTab
          mode="pointer"
          current={padMode}
          onSelect={setPadMode}
          glyph="⌖"
          label="POINTER"
          hint="One finger moves the Mac’s pointer"
        />
        <PadModeTab
          mode="pan"
          current={padMode}
          onSelect={setPadMode}
          glyph="✥"
          label="VIEW"
          hint="One finger moves the picture"
        />
      </div>

      {fine && !captured ? (
        <button
          class="rail-button"
          onClick={onCapture}
          aria-label="Capture the pointer"
          title="Locks this machine’s pointer to the Mac’s. Escape releases it."
        >
          <span class="mono" style={{ fontSize: 'var(--fs-15)', color: 'var(--ns-accent)' }}>
            ⌖
          </span>
        </button>
      ) : (
        <button
          class="rail-button"
          onClick={() => {
            focusKeyboardField()
            store.showKeyboard.value = true
          }}
          aria-label="Keyboard"
        >
          <span class="mono" style={{ fontSize: 'var(--fs-15)' }}>
            ⌨
          </span>
        </button>
      )}

      <button
        class={cmdHeld ? 'rail-button rail-button--held' : 'rail-button'}
        onClick={() => store.toggleModifier('cmd')}
        aria-label="Command"
        aria-pressed={cmdHeld}
        title={cmdHeld ? 'Command is held. Activate to release.' : 'Latch Command'}
      >
        <span class="mono" style={{ fontSize: 'var(--fs-15)', color: 'inherit' }}>
          ⌘
        </span>
      </button>

      <DrawerButton />
    </div>
  )
}

function DrawerButton() {
  return (
    <button
      class="rail-button rail-button--accent"
      onClick={() => (store.showHub.value = !store.showHub.value)}
      aria-label="Commands"
      aria-expanded={store.showHub.value}
    >
      <span class="mono" style={{ fontSize: 'var(--fs-15)' }}>
        ⋯
      </span>
    </button>
  )
}

function PadModeTab({
  mode,
  current,
  onSelect,
  glyph,
  label,
  hint,
}: {
  mode: PadMode
  current: PadMode
  onSelect: (mode: PadMode) => void
  glyph: string
  label: string
  hint: string
}) {
  const selected = mode === current
  return (
    <button
      role="tab"
      aria-selected={selected}
      aria-label={label}
      title={hint}
      onClick={() => onSelect(mode)}
      style={{ minHeight: '46px', borderRadius: 'var(--radius-inner)' }}
    >
      <span
        class="mono"
        aria-hidden="true"
        style={{
          fontSize: 'var(--fs-13)',
          color: selected ? 'var(--ns-accent)' : 'var(--ns-text-tertiary)',
        }}
      >
        {glyph}
      </span>
      <Caps
        size="var(--fs-9)"
        tracking="0.1em"
        color={selected ? 'var(--ns-accent)' : 'var(--ns-text-tertiary)'}
      >
        {label}
      </Caps>
    </button>
  )
}

// MARK: - Landscape and the laptop — a different instrument, not a stretched portrait

function LandscapeLayout({
  pan,
  padMode,
  setPadMode,
  pictureRef,
  captured,
  onCapture,
}: {
  pan: { x: number; y: number }
  padMode: PadMode
  setPadMode: (mode: PadMode) => void
  pictureRef: { current: HTMLDivElement | null }
  captured: boolean
  onCapture: () => void
}) {
  const display = store.selectedDisplay.value
  const tint = stallTint()
  const zoom = store.zoomScale.value
  const fine = matchMedia('(pointer: fine)').matches

  return (
    <>
      <div class="remote__stage">
        <div
          class="row"
          style={{
            height: '52px',
            flex: '0 0 auto',
            gap: '12px',
            paddingInline: 'calc(22px + var(--safe-left)) 22px',
            marginTop: 'var(--safe-top)',
          }}
        >
          <StopButton size={34} />
          <StatusStrip />
        </div>

        <div
          ref={pictureRef}
          style={{
            position: 'relative',
            flex: '1 1 auto',
            minHeight: 0,
            display: 'flex',
            paddingInline: 'calc(22px + var(--safe-left)) 22px',
          }}
        >
          <VideoSurface
            renderer={store.selectedRenderer()}
            aspect={pictureAspect()}
            transform={`translate(${pan.x}px, ${pan.y}px) scale(${zoom})`}
          />
          <CornerTicks color={tint ?? 'color-mix(in srgb, var(--ns-accent) 75%, transparent)'} />
          <div
            class="row"
            style={{
              position: 'absolute',
              left: 'calc(36px + var(--safe-left))',
              bottom: '14px',
              gap: '10px',
            }}
          >
            <VideoCaption color={tint ?? 'var(--ns-text-secondary)'}>
              {display ? `${display.name.toUpperCase()} · ${display.width} × ${display.height}` : ''}
            </VideoCaption>
          </div>
          {captured ? (
            <div style={{ position: 'absolute', right: '36px', bottom: '14px' }}>
              <VideoCaption color="var(--ns-accent)">POINTER CAPTURED · ESC RELEASES</VideoCaption>
            </div>
          ) : null}
        </div>

        <div
          class="row"
          data-nopad
          style={{
            height: '64px',
            flex: '0 0 auto',
            gap: '10px',
            paddingInline: 'calc(22px + var(--safe-left)) 22px',
            paddingBottom: 'var(--safe-bottom)',
          }}
        >
          <div
            class="segmented segmented--onGlass"
            role="tablist"
            aria-label="What the pointer does"
            style={{ height: '44px', borderRadius: 'var(--radius-inner)', flex: '0 0 auto' }}
          >
            <PadModeTab
              mode="pointer"
              current={padMode}
              onSelect={setPadMode}
              glyph="⌖"
              label="POINTER"
              hint="Drag moves the Mac’s pointer"
            />
            <PadModeTab
              mode="pan"
              current={padMode}
              onSelect={setPadMode}
              glyph="✥"
              label="VIEW"
              hint="Drag moves the picture"
            />
          </div>
          {fine && !captured ? (
            <button
              class="outlined"
              onClick={onCapture}
              title="Locks this machine’s pointer to the Mac’s. Escape releases it."
              style={
                {
                  width: 'auto',
                  paddingInline: '16px',
                  minHeight: '44px',
                  flex: '0 0 auto',
                  '--edge': 'color-mix(in srgb, var(--ns-accent) 45%, transparent)',
                } as Record<string, string>
              }
            >
              <Caps size="var(--fs-9)" tracking="0.12em" color="var(--ns-accent)">
                CAPTURE POINTER
              </Caps>
            </button>
          ) : null}
          <span class="spacer" />
          <Caps size="var(--fs-9)" tracking="0.12em" class="ellipsis">
            {`${
              fine ? 'WHEEL SCROLLS · ⌃WHEEL ZOOMS' : 'TWO FINGERS SCROLL · PINCH ZOOMS'
            } · ${zoom > 1.02 ? `${zoom.toFixed(1)}×` : '1.0× FIT'}`}
          </Caps>
        </div>
      </div>

      <Dock />
    </>
  )
}

/**
 * The rail, unrolled.
 *
 * A landscape window has height to spare on the right and no thumb reaching around
 * the corner, so the four tiles that live in a drawer on a phone are simply on
 * screen, the modifiers are a permanent row, and the three readings that a phone
 * has no room for — RTT, rate, and which window has focus — are stated at the
 * bottom. FRONTMOST is the one that stops a typed command going into the wrong
 * window, and it is the reason this dock is worth its 276px.
 */
function Dock() {
  const link = store.link.value
  const held = store.heldModifiers.value

  return (
    <div class="remote__dock" data-nopad>
      <div class="row">
        <Caps size="var(--fs-9)" tracking="var(--caps-tracking-wide)">
          CONTROLS
        </Caps>
        <span class="spacer" />
        <Caps size="var(--fs-9)" tracking="0.14em">
          {held.length ? `${held.length} HELD` : ''}
        </Caps>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
        <Tile
          glyph="⌨"
          caption="KEYS"
          spoken="Keyboard"
          onClick={() => {
            focusKeyboardField()
            store.showKeyboard.value = true
          }}
        />
        <Tile
          glyph="⛶"
          caption="SHOT"
          spoken="Screenshot the Mac"
          onClick={() => void store.hub('shot')}
        />
        <Tile
          glyph="←"
          caption="COPY"
          glyphSize="var(--fs-13)"
          spoken="Copy from the Mac"
          onClick={() => void store.hub('copy')}
        />
        <Tile
          glyph="→"
          caption="PASTE"
          glyphSize="var(--fs-13)"
          spoken="Paste to the Mac"
          onClick={() => void store.hub('paste')}
        />
        {/* The two the drawer has always had and this dock did not, which made the
            landscape window the one place a command could be missing from. */}
        <Tile
          glyph="⏎"
          caption="ENTER"
          spoken="Press Return on the Mac"
          onClick={() => store.key('return')}
        />
        <Tile
          glyph="⏻"
          caption="LOCK"
          spoken="Lock the Mac’s screen"
          onClick={() => void store.hub('lock')}
        />
      </div>

      {/* Which screen, which was reachable in portrait and nowhere in landscape —
          so a laptop with two monitors could only see the one it opened with. */}
      {store.displays.value.length > 1 ? (
        <div class="stack" style={{ gap: '8px' }}>
          <Caps size="var(--fs-9)" tracking="var(--caps-tracking-wide)">
            SCREEN
          </Caps>
          <DisplayTabs />
        </div>
      ) : null}

      <div class="row" style={{ gap: '6px' }}>
        {MODIFIERS.map((spec) => (
          <KeyCap
            key={spec.name}
            glyph={spec.glyph}
            fontSize="var(--fs-14)"
            height={46}
            isHeld={held.includes(spec.name)}
            onClick={() => store.toggleModifier(spec.name)}
          />
        ))}
        {/* Latched modifiers are the one state that outlives the tap that set it,
            so the way out of it belongs next to the way in. */}
        <button
          class="outlined"
          onClick={() => store.releaseModifiers()}
          disabled={held.length === 0}
          style={{ width: '76px', minHeight: '46px', flex: '0 0 auto', opacity: held.length ? 1 : 0.45 }}
        >
          <Caps size="var(--fs-9)" tracking="0.1em" color="var(--ns-text-secondary)">
            RELEASE
          </Caps>
        </button>
      </div>

      <span class="spacer" />

      <div class="stack" style={{ gap: '11px' }}>
        <DockReadout
          label="RTT"
          value={link.rttMillis == null ? '—' : `${Math.round(link.rttMillis)} MS`}
        />
        <DockReadout label="RATE" value={`${link.downMbps.toFixed(1)} MB/S`} />
        <DockReadout label="FRONTMOST" value={link.frontmostApp || '—'} />
      </div>

      <div class="row" style={{ gap: '8px' }}>
        <button
          class="outlined"
          onClick={() => {
            store.presented.value = 'claude'
            store.listClaudeSessions()
          }}
          style={
            {
              flex: '1 1 auto',
              minHeight: '50px',
              background: 'color-mix(in srgb, var(--ns-accent) 12%, transparent)',
              '--edge': 'color-mix(in srgb, var(--ns-accent) 40%, transparent)',
            } as Record<string, string>
          }
        >
          <Caps size="var(--fs-10)" tracking="0.14em" color="var(--ns-accent)">
            CLAUDE
          </Caps>
        </button>
        <button
          class="rail-button"
          onClick={() => store.stopStream()}
          aria-label="Stop streaming"
          style={{ width: '50px', height: '50px', background: 'var(--ns-raised)' }}
        >
          <span class="mono" style={{ fontSize: 'var(--fs-14)', color: 'var(--ns-text-secondary)' }}>
            ✕
          </span>
        </button>
      </div>
    </div>
  )
}

function DockReadout({ label, value }: { label: string; value: string }) {
  return (
    <div class="row">
      <Caps size="var(--fs-9)" tracking="0.14em">
        {label}
      </Caps>
      <span class="spacer" style={{ minWidth: '8px' }} />
      <Caps size="var(--fs-11)" tracking="0" color="var(--ns-text)" class="ellipsis">
        {value}
      </Caps>
    </div>
  )
}
