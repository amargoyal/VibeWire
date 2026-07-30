/**
 * 03A–03D · REMOTE VIEW, with the control layer (04) and keyboard mode (05)
 * layered on top. Ported from ios/VibeWire/Screens/RemoteView.swift.
 *
 * A 16:10 desktop inside a phone's glass leaves bands. They are used rather than
 * fought: the picture keeps every pixel it has, the chrome lives in the dark, and
 * the trackpad reaches past the video into the bands — so the first accidental
 * swipe in the dark area still moves the cursor, which is what teaches it.
 *
 * What the browser adds over the phone, because the hardware is different:
 *
 *  - **Pointer capture.** CAPTURE POINTER takes a Pointer Lock and the Mac's cursor
 *    then tracks the real one one-to-one, at whatever rate the device reports.
 *    Escape gives it back. This is the whole reason a laptop is a better VibeWire
 *    client than a phone.
 *  - **A real drag.** Captured, the mouse button is the Mac's mouse button: down,
 *    move, up is a drag. Uncaptured — and on touch — it is press-and-hold then move,
 *    because a finger sliding on a trackpad has always meant "move the pointer" and
 *    an uncaptured mouse is a trackpad.
 *  - **Wheel and ⌃wheel.** A scroll wheel scrolls the Mac; the pinch a trackpad
 *    reports as ⌃wheel zooms, the same as a two-finger pinch on glass.
 *
 * Uncaptured, a mouse is treated exactly as a finger: it steers only while its button
 * is down. Steering on hover was the first thing tried and it is wrong — reaching for
 * the STOP button dragged the Mac's cursor across the desktop on the way.
 */

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks'

import { bitrateMbps, store, type DisplayEntry } from '../app/store'
import { hostKeyName, modifiersFrom, releaseKeyboardLock } from '../app/keymap'
import {
  Caps,
  ConditionDot,
  conditionColor,
  CornerTicks,
  KeyCap,
  MODIFIERS,
  Panel,
  Segmented,
  Spinner,
  VideoCaption,
} from '../design/components'
import { ControlHub } from './ControlHub'
import { focusKeyboardField, isTouchPrimary, KeyboardBar, KeyboardField } from './KeyboardBar'
import { VideoSurface } from './VideoSurface'

type PadMode = 'pointer' | 'pan'

/** Below this a press is a tap, not a travel. */
const TAP_SLOP = 6
/** How long a finger has to stay put before a slide becomes a drag. */
const HOLD_TO_DRAG_MS = 450

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
  // is wider than it is tall is landscape whatever the device claims to be, which
  // also covers a desktop window and a tablet in Split View without once asking
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

  const applyZoom = (scale: number, focal: { x: number; y: number }, fromZoom: number, fromPan: { x: number; y: number }) => {
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
        ? { x: event.clientX - (box.left + box.width / 2), y: event.clientY - (box.top + box.height / 2) }
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

  useEffect(() => {
    const wantsPhysical = captured || (store.showKeyboard.value && !isTouchPrimary())
    if (!wantsPhysical) return

    const onKeyDown = (event: KeyboardEvent) => {
      const name = hostKeyName(event.code)
      store.setModifiers(modifiersFrom(event))
      if (!name) return
      event.preventDefault()
      store.keyDown(name, event.key.length === 1 ? event.key : undefined)
    }
    const onKeyUp = (event: KeyboardEvent) => {
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
      class="stack"
      style={{
        position: 'fixed',
        inset: 0,
        background: 'var(--lg-deep)',
        // The pad is the glass: the browser must not claim these gestures for
        // scrolling or page zoom.
        touchAction: 'none',
        userSelect: 'none',
        cursor: captured ? 'none' : padMode === 'pan' ? 'grab' : 'default',
        overflow: 'hidden',
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
      <ZoomRail />
      {showZoomBadge ? <ZoomBadge /> : null}
      {stalled ? <ReconnectingOverlay seconds={stallSeconds} /> : null}
      {store.showHub.value ? <ControlHub /> : null}
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
          height: '40px',
          flex: '0 0 auto',
          paddingInline: '18px',
          marginTop: 'var(--safe-top)',
        }}
      >
        <StatusStrip />
      </div>

      {displays.length > 1 ? (
        <div style={{ paddingInline: '18px', marginTop: '6px', flex: '0 0 auto' }}>
          <DisplayTabs />
        </div>
      ) : null}

      <span class="spacer" />

      {store.sideBySide.value ? (
        <SideBySidePanes />
      ) : (
        <Picture pan={pan} pictureRef={pictureRef} captured={captured} dragging={dragging} />
      )}

      <div style={{ paddingInline: '18px', marginTop: '12px', flex: '0 0 auto' }}>
        <PadModeControl padMode={padMode} setPadMode={setPadMode} captured={captured} onCapture={onCapture} />
      </div>

      <span class="spacer" />

      {/* The hub's own arc and its "sweep the thumb" hint land on exactly this
          strip, so with both up the two captions overlapped and neither could be
          read. */}
      {showTeaching && live && !store.sideBySide.value && !store.showHub.value ? (
        <TeachingLegend />
      ) : null}

      <BottomBar />
    </>
  )
}

function StatusStrip() {
  const condition = store.condition.value
  const state = store.streamState.value
  const link = store.link.value
  const configs = Object.values(store.videoConfigs.value)

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

  return (
    <>
      <span class="row" style={{ gap: '7px' }}>
        <ConditionDot
          condition={condition}
          size={6}
          // Nothing decorative moves next to a live video feed.
          animated={state.kind !== 'live'}
        />
        <Caps size="var(--fs-10)" color={conditionColor[condition]}>
          {liveLabel}
        </Caps>
      </span>
      <span class="spacer" />
      <Caps size="var(--fs-10)">{codecLabel}</Caps>
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
    <Segmented
      label="Which display"
      options={options}
      selection={selection}
      onSelect={(value) => {
        if (value === -1) store.selectBothDisplays()
        else store.selectDisplay(value)
        store.startStream()
      }}
    />
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
    ? 'color-mix(in srgb, var(--lg-amber) 70%, transparent)'
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
  const display = store.selectedDisplay.value
  const tint = stallTint()
  const state = store.streamState.value
  const renderer = store.selectedRenderer()

  const caption = (() => {
    if (state.kind === 'stalled') return 'LAST GOOD FRAME'
    if (dragging) return 'DRAGGING · LIFT TO DROP'
    if (!display) return ''
    return `${display.name.toUpperCase()} · ${display.width} × ${display.height} · LIVE`
  })()

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
      <CornerTicks color={tint ?? 'color-mix(in srgb, var(--lg-cyan) 75%, transparent)'} />

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
            class="wrap video-chip"
            style={{
              margin: 0,
              maxWidth: '38ch',
              fontSize: 'var(--fs-13)',
              lineHeight: 1.45,
              color: 'var(--lg-on-amber-wash)',
              borderLeft: '2px solid var(--lg-amber)',
              padding: '12px 14px',
            }}
          >
            The Mac is sending video this browser cannot decode: {renderer.failure}
          </p>
        </div>
      ) : null}

      <div
        style={{
          position: 'absolute',
          left: '10px',
          bottom: '26px',
          opacity: store.showHub.value ? 0 : 1,
        }}
      >
        <VideoCaption color={tint ?? 'var(--lg-text-secondary)'}>{caption}</VideoCaption>
      </div>

      {captured ? (
        <div style={{ position: 'absolute', right: '10px', bottom: '26px' }}>
          <VideoCaption color="var(--lg-cyan)">POINTER CAPTURED · ESC RELEASES</VideoCaption>
        </div>
      ) : null}
    </div>
  )
}

// MARK: 03C — side by side

function SideBySidePanes() {
  const displays = store.displays.value
  return (
    <div class="stack" style={{ gap: '10px', flex: '0 1 auto', minHeight: 0 }}>
      {displays.map((display, index) => {
        const focused = store.inputPane.value === index
        return (
          <div
            key={display.id}
            style={{ position: 'relative', flex: '1 1 0', minHeight: 0, display: 'flex' }}
            onClick={() => {
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
              <CornerTicks color="color-mix(in srgb, var(--lg-cyan) 80%, transparent)" />
            ) : null}
            <div
              class="row"
              style={{ position: 'absolute', left: '10px', bottom: '20px', gap: '8px' }}
            >
              {focused ? (
                <Caps
                  class="video-chip"
                  size="var(--fs-9)"
                  color="var(--lg-cyan)"
                  style={{
                    outline: '1px solid color-mix(in srgb, var(--lg-cyan) 50%, transparent)',
                  }}
                >
                  INPUT HERE
                </Caps>
              ) : null}
              <VideoCaption>
                {focused
                  ? `${display.name.toUpperCase()} · ${display.width} × ${display.height}`
                  : `${display.name.toUpperCase()} · TAP TO TAKE INPUT`}
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

function TeachingLegend() {
  return (
    <div
      class="stack"
      style={{
        gap: '12px',
        alignItems: 'center',
        paddingBottom: '24px',
        pointerEvents: 'none',
        flex: '0 0 auto',
      }}
      aria-hidden="true"
    >
      <span class="breathing" />
      <Caps
        size="var(--fs-10)"
        tracking="0.16em"
        style={{ textAlign: 'center', lineHeight: 1.9 }}
      >
        {matchMedia('(pointer: fine)').matches
          ? 'DRAG ANYWHERE ON THE GLASS · CAPTURE POINTER FREES IT\nWHEEL SCROLLS · ⌃WHEEL ZOOMS'
          : 'MOVE ANYWHERE ON THE GLASS\nTWO FINGERS SCROLL · PINCH ZOOMS'}
      </Caps>
      <style>{`
        /* The two whites here are outside the Longarm palette on purpose, and they
           are the iOS values verbatim (RemoteView.swift, BreathingRing). This ring
           sits on live video whose colour nobody controls, and it is not reporting a
           condition — a palette colour would say something about the Mac's state that
           "a touch happens here" does not mean. Neutral white at low alpha is the one
           mark in the app that belongs to the glass rather than to the machine. */
        .breathing {
          width: 30px;
          height: 30px;
          border-radius: 50%;
          border: 1px solid rgba(255,255,255,0.22);
          position: relative;
        }
        .breathing::after {
          content: '';
          position: absolute;
          inset: -1px;
          border-radius: 50%;
          border: 1px solid rgba(255,255,255,0.10);
          animation: lg-breathe 2.8s ease-out infinite;
        }
        /* Scaling out from a point is the textbook Reduce Motion trigger, so with
           the setting on the ring holds its outer position: two concentric circles
           that still read as "a touch happens here", with the legend beside them
           carrying the actual instruction. */
        @keyframes lg-breathe {
          from { transform: scale(1); opacity: 0.55; }
          to { transform: scale(1.7); opacity: 0; }
        }
        @media (prefers-reduced-motion: reduce) {
          .breathing::after { animation: none; transform: scale(1.45); opacity: 0.28; }
        }
      `}</style>
    </div>
  )
}

function ZoomRail() {
  const zoom = store.zoomScale.value
  const filled = Math.max(2, ((zoom - 1) / 5) * 128)
  return (
    <div
      class="row"
      aria-hidden="true"
      style={{
        position: 'absolute',
        right: 'calc(20px + var(--safe-right))',
        top: '50%',
        transform: 'translateY(-50%)',
        gap: '8px',
        pointerEvents: 'none',
      }}
    >
      <Caps
        size="var(--fs-10)"
        tracking="0.1em"
        color={zoom > 1.02 ? 'var(--lg-cyan)' : 'var(--lg-text-secondary)'}
      >
        {zoom > 1.02 ? `${zoom.toFixed(1)}×` : '1.0× FIT'}
      </Caps>
      <span style={{ position: 'relative', width: '11px', height: '128px' }}>
        <span
          style={{
            position: 'absolute',
            bottom: 0,
            left: '4px',
            width: '3px',
            height: '128px',
            borderRadius: 'var(--radius-pill)',
            background: '#1E242C',
          }}
        />
        <span
          style={{
            position: 'absolute',
            bottom: 0,
            left: '4px',
            width: '3px',
            height: `${filled}px`,
            borderRadius: 'var(--radius-pill)',
            background: 'color-mix(in srgb, var(--lg-cyan) 50%, transparent)',
          }}
        />
        <span
          style={{
            position: 'absolute',
            bottom: `${filled}px`,
            left: 0,
            width: '11px',
            height: '2px',
            background: 'var(--lg-cyan)',
          }}
        />
      </span>
    </div>
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
      <span class="mono" style={{ fontSize: 'var(--fs-46)', fontWeight: 500 }}>
        {store.zoomScale.value.toFixed(1)}×
      </span>
      <Caps size="var(--fs-10)" tracking="0.2em" color="var(--lg-cyan)">
        DOUBLE-TAP FITS
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
        top: 'calc(66px + var(--safe-top))',
        right: 'calc(20px + var(--safe-right))',
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
          background: 'color-mix(in srgb, var(--lg-deep) 80%, transparent)',
          border: '1px solid var(--lg-stroke)',
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
            background: 'color-mix(in srgb, var(--lg-cyan) 16%, transparent)',
            border: '1px solid var(--lg-cyan)',
          }}
        />
      </span>
      <Caps size="var(--fs-9)" tracking="0.12em">
        {display ? `${display.name.toUpperCase()} REGION` : 'REGION'}
      </Caps>
    </div>
  )
}

/** A stall looks like a stall: it says how old the picture is, that input is
 *  queued rather than lost, and when it will stop trying. */
function ReconnectingOverlay({ seconds }: { seconds: number }) {
  const rows: [string, string, string][] = [
    ['QUEUED INPUT', `${store.queuedInputCount.value} EVENTS`, 'var(--lg-text)'],
    ['DROPPING TO', '540P ON RESUME', 'var(--lg-amber)'],
    ['GIVING UP AT', '30S', 'var(--lg-text)'],
  ]
  return (
    <div
      role="status"
      style={{
        position: 'absolute',
        left: 0,
        right: 0,
        bottom: 'calc(108px + var(--safe-bottom))',
        paddingInline: '18px',
      }}
    >
      <Panel tint="var(--lg-amber)">
        <div class="stack" style={{ padding: '18px' }}>
          <div class="row">
            <Spinner size={16} color="var(--lg-amber)" />
            <Caps size="var(--fs-12)" color="var(--lg-amber)" weight={500}>
              RECONNECTING
            </Caps>
          </div>
          <p class="wrap" style={{ margin: '12px 0 0', fontSize: 'var(--fs-15)', lineHeight: 1.45 }}>
            The picture above is {seconds}.0 seconds old. Keys and taps are being held, not dropped.
          </p>
          <div class="stack" style={{ gap: '8px', marginTop: '14px' }}>
            {rows.map(([label, value, color]) => (
              <div key={label} class="row">
                <Caps size="var(--fs-10)" tracking="0.1em">
                  {label}
                </Caps>
                <span class="spacer" />
                <Caps size="var(--fs-10)" tracking="0.1em" color={color}>
                  {value}
                </Caps>
              </div>
            ))}
          </div>
        </div>
      </Panel>
    </div>
  )
}

// MARK: Pad mode

function PadModeControl({
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
  const fine = matchMedia('(pointer: fine)').matches
  return (
    <div class="row" style={{ gap: '8px' }} data-nopad>
      <PadModeButton
        mode="pointer"
        current={padMode}
        onSelect={setPadMode}
        glyph="⌖"
        label="POINTER"
        hint="One finger moves the Mac’s pointer"
      />
      <PadModeButton
        mode="pan"
        current={padMode}
        onSelect={setPadMode}
        glyph="✥"
        label="MOVE VIEW"
        hint="One finger moves the picture"
      />
      {fine && !captured ? (
        <button
          onClick={onCapture}
          title="Locks this machine’s pointer to the Mac’s. Escape releases it."
          style={{
            flex: '1 1 0',
            height: '40px',
            borderRadius: 'var(--radius-row)',
            border: '1px solid color-mix(in srgb, var(--lg-cyan) 50%, transparent)',
            background: 'color-mix(in srgb, var(--lg-cyan) 12%, transparent)',
          }}
        >
          <Caps size="var(--fs-9)" tracking="0.12em" color="var(--lg-cyan)">
            CAPTURE POINTER
          </Caps>
        </button>
      ) : null}
    </div>
  )
}

function PadModeButton({
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
      onClick={() => onSelect(mode)}
      aria-pressed={selected}
      aria-label={label}
      title={hint}
      style={{
        flex: '1 1 0',
        height: '40px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '7px',
        borderRadius: 'var(--radius-row)',
        border: `1px solid ${
          selected ? 'color-mix(in srgb, var(--lg-cyan) 50%, transparent)' : 'var(--lg-hairline)'
        }`,
        background: selected ? 'color-mix(in srgb, var(--lg-cyan) 12%, transparent)' : 'transparent',
        color: selected ? 'var(--lg-cyan)' : 'var(--lg-text-secondary)',
      }}
    >
      <span class="mono" aria-hidden="true" style={{ fontSize: 'var(--fs-13)' }}>
        {glyph}
      </span>
      <Caps
        size="var(--fs-9)"
        tracking="0.12em"
        color={selected ? 'var(--lg-cyan)' : 'var(--lg-text-secondary)'}
      >
        {label}
      </Caps>
    </button>
  )
}

// MARK: Bottom bar

function BottomBar() {
  const stalled = store.streamState.value.kind === 'stalled'
  return (
    <div
      class="row"
      data-nopad
      style={{
        height: '96px',
        flex: '0 0 auto',
        paddingInline: 'calc(20px + var(--safe-left))',
        paddingBottom: 'var(--safe-bottom)',
      }}
    >
      <button
        onClick={() => store.stopStream()}
        aria-label={stalled ? 'Stop trying to reconnect' : 'Stop streaming'}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '10px',
          height: 'var(--hub-button)',
          minWidth: 'var(--hub-button)',
          paddingInline: stalled ? '20px' : 0,
          borderRadius: 'var(--radius-pill)',
          background: 'color-mix(in srgb, var(--lg-chrome) 86%, transparent)',
          border: '1px solid var(--lg-hairline)',
          color: 'var(--lg-text-secondary)',
        }}
      >
        <span class="mono" aria-hidden="true" style={{ fontSize: 'var(--fs-17)' }}>
          ✕
        </span>
        {stalled ? (
          <Caps size="var(--fs-11)" tracking="0.12em" color="var(--lg-text-secondary)">
            STOP TRYING
          </Caps>
        ) : null}
      </button>

      <span class="spacer" />

      <button
        onClick={() => (store.showHub.value = !store.showHub.value)}
        aria-label="Control hub"
        aria-expanded={store.showHub.value}
        style={{
          width: 'var(--hub-button)',
          height: 'var(--hub-button)',
          borderRadius: '50%',
          background: 'color-mix(in srgb, var(--lg-chrome) 92%, transparent)',
          border: '1px solid var(--lg-stroke)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <span class="stack" style={{ gap: '4px' }} aria-hidden="true">
          {[0, 1, 2].map((row) => (
            <span key={row} class="row" style={{ gap: '4px' }}>
              {[0, 1, 2].map((column) => (
                <span
                  key={column}
                  class="dot"
                  style={{
                    width: '3px',
                    height: '3px',
                    background:
                      row === 2 || store.showHub.value ? 'var(--lg-cyan)' : 'var(--lg-text)',
                  }}
                />
              ))}
            </span>
          ))}
        </span>
      </button>
    </div>
  )
}

// MARK: - Landscape — a different instrument, not a stretched portrait

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

  return (
    <div class="row" style={{ flex: '1 1 auto', minHeight: 0, gap: 0, alignItems: 'stretch' }}>
      <div class="stack" style={{ flex: '1 1 auto', minWidth: 0 }}>
        <div
          ref={pictureRef}
          style={{ position: 'relative', flex: '1 1 auto', minHeight: 0, display: 'flex' }}
        >
          <VideoSurface
            renderer={store.selectedRenderer()}
            aspect={pictureAspect()}
            transform={`translate(${pan.x}px, ${pan.y}px) scale(${store.zoomScale.value})`}
          />
          <CornerTicks color="color-mix(in srgb, var(--lg-cyan) 75%, transparent)" />
          <div
            class="row"
            style={{
              position: 'absolute',
              left: 'calc(24px + var(--safe-left))',
              bottom: '22px',
              gap: '10px',
            }}
          >
            <span class="row video-chip" style={{ gap: '6px' }}>
              <ConditionDot condition={store.condition.value} size={5} animated={false} />
              <Caps size="var(--fs-9)" color={conditionColor[store.condition.value]}>
                {store.streamState.value.kind === 'live'
                  ? `LIVE ${store.link.value.rttMillis == null ? '—' : Math.round(store.link.value.rttMillis)}MS`
                  : store.streamState.value.kind.toUpperCase()}
              </Caps>
            </span>
            <VideoCaption color={tint ?? 'var(--lg-text-secondary)'}>
              {display
                ? `${display.name.toUpperCase()} · ${display.width} × ${display.height} · LIVE`
                : ''}
            </VideoCaption>
          </div>
          {captured ? (
            <div style={{ position: 'absolute', right: '18px', bottom: '22px' }}>
              <VideoCaption color="var(--lg-cyan)">POINTER CAPTURED · ESC RELEASES</VideoCaption>
            </div>
          ) : null}
        </div>

        <div
          style={{
            paddingInline: 'calc(24px + var(--safe-left))',
            paddingBottom: 'calc(12px + var(--safe-bottom))',
            flex: '0 0 auto',
          }}
        >
          <PadModeControl
            padMode={padMode}
            setPadMode={setPadMode}
            captured={captured}
            onCapture={onCapture}
          />
        </div>
      </div>

      <LandscapeDock />
    </div>
  )
}

function LandscapeDock() {
  const link = store.link.value
  return (
    <div
      class="stack"
      data-nopad
      style={{
        width: '231px',
        flex: '0 0 auto',
        gap: '14px',
        padding: '22px',
        paddingTop: 'calc(22px + var(--safe-top))',
        paddingBottom: 'calc(22px + var(--safe-bottom))',
        paddingRight: 'calc(22px + var(--safe-right))',
        borderLeft: '1px solid var(--lg-chrome)',
      }}
    >
      <div class="row">
        <Caps size="var(--fs-9)" tracking="0.2em">
          CONTROLS
        </Caps>
        <span class="spacer" />
        <Caps
          size="var(--fs-9)"
          color={store.scrollLock.value ? 'var(--lg-cyan)' : 'var(--lg-text-tertiary)'}
        >
          {store.scrollLock.value ? 'LOCK' : 'FREE'}
        </Caps>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
        <DockButton label="⌨ KEYS" spoken="Keyboard" onClick={() => {
            focusKeyboardField()
            store.showKeyboard.value = true
          }} />
        <DockButton label="⛶ SHOT" spoken="Screenshot the Mac" onClick={() => void store.hub('shot')} />
        <DockButton label="COPY ←" spoken="Copy from the Mac" onClick={() => void store.hub('copy')} />
        <DockButton label="PASTE →" spoken="Paste to the Mac" onClick={() => void store.hub('paste')} />
      </div>

      <div class="row" style={{ gap: '6px' }}>
        {MODIFIERS.map((spec) => (
          <KeyCap
            key={spec.name}
            glyph={spec.glyph}
            fontSize="var(--fs-13)"
            isHeld={store.heldModifiers.value.includes(spec.name)}
            onClick={() => store.toggleModifier(spec.name)}
          />
        ))}
      </div>

      <span class="spacer" />

      <div class="stack" style={{ gap: '9px' }}>
        <DockReadout label="RTT" value={link.rttMillis == null ? '—' : `${Math.round(link.rttMillis)} MS`} />
        <DockReadout label="RATE" value={`${link.downMbps.toFixed(1)} MB/S`} />
        <div class="hairline" style={{ background: 'var(--lg-chrome)' }} />
        <div class="row" style={{ gap: '8px' }}>
          <button
            onClick={() => {
              store.presented.value = 'claude'
              store.listClaudeSessions()
            }}
            style={{
              flex: '1 1 auto',
              height: '50px',
              borderRadius: 'var(--radius-row)',
              background: 'color-mix(in srgb, var(--lg-cyan) 10%, transparent)',
              border: '1px solid color-mix(in srgb, var(--lg-cyan) 40%, transparent)',
            }}
          >
            <Caps size="var(--fs-10)" tracking="0.12em" color="var(--lg-cyan)">
              CLAUDE
            </Caps>
          </button>
          <button
            onClick={() => store.stopStream()}
            aria-label="Stop streaming"
            style={{
              width: '50px',
              height: '50px',
              flex: '0 0 auto',
              borderRadius: 'var(--radius-row)',
              background: 'var(--lg-chrome)',
              border: '1px solid var(--lg-hairline)',
              color: 'var(--lg-text-secondary)',
            }}
          >
            <span class="mono" style={{ fontSize: 'var(--fs-15)' }}>
              ✕
            </span>
          </button>
        </div>
      </div>
    </div>
  )
}

function DockButton({
  label,
  spoken,
  onClick,
}: {
  label: string
  spoken: string
  onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      // The visible labels carry a glyph and a direction arrow — "⌨ KEYS",
      // "COPY ←" — which is legible and unspeakable.
      aria-label={spoken}
      style={{
        minHeight: '50px',
        borderRadius: 'var(--radius-row)',
        background: 'var(--lg-chrome)',
        border: '1px solid var(--lg-hairline)',
      }}
    >
      <Caps size="var(--fs-10)" tracking="0.08em" color="var(--lg-text)">
        {label}
      </Caps>
    </button>
  )
}

function DockReadout({ label, value }: { label: string; value: string }) {
  return (
    <div class="row">
      <Caps size="var(--fs-9)" tracking="0.12em">
        {label}
      </Caps>
      <span class="spacer" />
      <Caps size="var(--fs-9)" tracking="0.12em" color="var(--lg-text)">
        {value}
      </Caps>
    </div>
  )
}
