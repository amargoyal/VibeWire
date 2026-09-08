import { isModifierName, normalizeModifier, type ModifierName } from '../../../../shared/keyNames'
import { Log } from '../core/log'
import type { GesturePhase, MouseButton } from '../net/wireProtocol'

/**
 * What the router asks of input. `LiveInputRouter` holds the platform-neutral
 * state from the Mac's `InputInjector` — cursor, drag, latched modifiers, the
 * scroll accumulator — and hands events to an `InputSink`; the sink is the
 * platform. `NoInput` is the honest answer where there is no sink.
 */
export interface InputRouter {
  update(sensitivity: number | null, naturalScrolling: boolean | null): void
  movePointer(dx: number, dy: number, display: number | null): void
  click(button: MouseButton, count: number, display: number | null): void
  drag(phase: GesturePhase, dx: number, dy: number, count: number): void
  scroll(dx: number, dy: number, momentum: boolean): void
  zoom(scale: number, locked: boolean): void
  setModifiers(held: ModifierName[]): void
  key(code: string, chars: string | null, down: boolean): void
  combo(keys: string[]): void
  type(text: string): void
  focus(display: number): void
  releaseAllModifiers(): void
  /** Whether this host can inject at all — false is a named condition, not a silent drop. */
  readonly available: boolean
}

export interface PhysicalRect {
  x: number
  y: number
  width: number
  height: number
  /** Physical pixels per DIP on that display. */
  scaleFactor: number
}

/** The platform half: absolute pointer placement in physical pixels, buttons,
 *  wheel notches, and keys by name. */
export interface InputSink {
  moveTo(x: number, y: number): void
  button(which: MouseButton, down: boolean): void
  /** Vertical and horizontal, in WHEEL_DELTA (120) units; fractional allowed. */
  wheel(vertical: number, horizontal: number): void
  /** False when the name has no key on this platform; the caller falls back to unicode. */
  key(name: string, down: boolean): boolean
  unicode(text: string): void
  modifier(name: ModifierName, down: boolean): void
  /** Modifiers down, the key down and up, modifiers up, as one atomic batch. */
  combo(modifiers: ModifierName[], key: string): boolean
  /** Ctrl + wheel, the platform's zoom, in notches. */
  zoom(steps: number): void
  displayBounds(displayId: number | null): PhysicalRect | null
  primaryDisplayId(): number
}

export class NoInput implements InputRouter {
  readonly available = false
  private warned = false

  private note(): void {
    if (this.warned) return
    this.warned = true
    Log.warn('input', 'input arrived, but this host has no injector on this platform')
  }

  update(): void {}
  movePointer(): void {
    this.note()
  }
  click(): void {
    this.note()
  }
  drag(): void {
    this.note()
  }
  scroll(): void {
    this.note()
  }
  zoom(): void {
    this.note()
  }
  setModifiers(): void {
    this.note()
  }
  key(): void {
    this.note()
  }
  combo(): void {
    this.note()
  }
  type(): void {
    this.note()
  }
  focus(): void {}
  releaseAllModifiers(): void {}
}

/** CSS pixels of finger travel that equal one wheel notch. Calibrated so a
 *  long swipe moves about a screen in Chrome and Explorer. */
const PIXELS_PER_NOTCH = 100

export class LiveInputRouter implements InputRouter {
  readonly available = true
  /** Absolute cursor position, kept here in physical pixels. Reading it back
   *  from the system every event would fight a physical mouse and make drags
   *  jittery; the Mac host learned the same. */
  private cursor = { x: 0, y: 0 }
  private activeDisplay: number
  private latched = new Set<ModifierName>()
  private dragging = false
  private dragClickCount = 1
  private sensitivity = 5
  private naturalScrolling = true
  private scrollAccumulator = { x: 0, y: 0 }

  constructor(private readonly sink: InputSink) {
    this.activeDisplay = sink.primaryDisplayId()
    const bounds = sink.displayBounds(this.activeDisplay)
    if (bounds) this.cursor = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
  }

  update(sensitivity: number | null, naturalScrolling: boolean | null): void {
    if (sensitivity !== null) this.sensitivity = Math.max(1, Math.min(8, sensitivity))
    if (naturalScrolling !== null) this.naturalScrolling = naturalScrolling
  }

  /** 07A says "1080PX / SWIPE" at tick 5. Linear in the tick so the readout
   *  stays honest; multiplied by the display's scale so a swipe covers the same
   *  share of a 150 % panel as of a 100 % one. */
  private gain(): number {
    return 0.6 + (this.sensitivity - 1) * 0.35
  }

  // MARK: Pointer

  movePointer(dx: number, dy: number, display: number | null): void {
    if (display !== null && display !== this.activeDisplay) this.focus(display)
    const bounds = this.sink.displayBounds(this.activeDisplay)
    const scale = bounds?.scaleFactor ?? 1
    let x = this.cursor.x + dx * this.gain() * scale
    let y = this.cursor.y + dy * this.gain() * scale
    if (bounds) {
      x = Math.max(bounds.x, Math.min(bounds.x + bounds.width - 1, x))
      y = Math.max(bounds.y, Math.min(bounds.y + bounds.height - 1, y))
    }
    this.cursor = { x, y }
    this.sink.moveTo(Math.round(x), Math.round(y))
  }

  click(button: MouseButton, count: number, display: number | null): void {
    if (display !== null && display !== this.activeDisplay) this.focus(display)
    // Windows makes the double-click from the timing of two pairs.
    for (let index = 0; index < Math.max(1, count); index += 1) {
      this.sink.button(button, true)
      this.sink.button(button, false)
    }
  }

  /** `count` is the click the button goes down on: 1 is a press-and-drag, 2 a
   *  double-click that never let go — the gesture that selects a word and
   *  then stretches the selection. */
  drag(phase: GesturePhase, dx: number, dy: number, count: number): void {
    switch (phase) {
      case 'begin':
        this.dragging = true
        this.dragClickCount = Math.max(1, Math.min(3, count))
        for (let index = 1; index < this.dragClickCount; index += 1) {
          this.sink.button('left', true)
          this.sink.button('left', false)
        }
        this.sink.button('left', true)
        break
      case 'move':
        this.movePointer(dx, dy, null)
        break
      case 'end':
        this.dragging = false
        this.dragClickCount = 1
        this.sink.button('left', false)
        break
    }
  }

  get isDragging(): boolean {
    return this.dragging
  }

  // MARK: Scroll

  scroll(dx: number, dy: number, _momentum: boolean): void {
    // Accumulate sub-notch travel so slow two-finger drags still move, and
    // send fractional notches — every Chromium app, Office and Explorer honour
    // them — so the picture scrolls with the finger rather than in steps.
    const bounds = this.sink.displayBounds(this.activeDisplay)
    const notch = PIXELS_PER_NOTCH * (bounds?.scaleFactor ?? 1)
    this.scrollAccumulator.x += dx
    this.scrollAccumulator.y += dy
    const stepX = Math.trunc((this.scrollAccumulator.x / notch) * 120) / 120
    const stepY = Math.trunc((this.scrollAccumulator.y / notch) * 120) / 120
    this.scrollAccumulator.x -= stepX * notch
    this.scrollAccumulator.y -= stepY * notch
    if (stepX === 0 && stepY === 0) return
    // Same signs as the Mac host: natural scrolling moves the content with the
    // finger. A wheel rolled forward scrolls up; a finger moving down under
    // natural scrolling scrolls up too.
    const sign = this.naturalScrolling ? 1 : -1
    this.sink.wheel(stepY * sign, -stepX * sign)
  }

  /** Pinch on the phone maps to Ctrl+wheel, which is what most Windows apps
   *  treat as zoom — the same shape as the Mac's ⌘+scroll. */
  zoom(scale: number, _locked: boolean): void {
    const steps = Math.trunc((scale - 1) * 10)
    if (steps === 0) return
    this.sink.zoom(steps)
  }

  // MARK: Modifiers

  /** Latched modifiers survive taps, drags and the keyboard — that is the
   *  whole point of 04B: a two-hand chord becomes two one-hand taps. */
  setModifiers(held: ModifierName[]): void {
    const next = new Set(held)
    for (const name of ['cmd', 'shift', 'option', 'control', 'capsLock'] as ModifierName[]) {
      const was = this.latched.has(name)
      const is = next.has(name)
      if (was !== is) this.sink.modifier(name, is)
    }
    this.latched = next
  }

  releaseAllModifiers(): void {
    this.setModifiers([])
  }

  // MARK: Keys

  key(code: string, chars: string | null, down: boolean): void {
    if (this.sink.key(code, down)) return
    // Anything without a virtual key (emoji, accented text from the system
    // keyboard) goes through as a unicode payload.
    if (down && chars) this.sink.unicode(chars)
  }

  /** A tap of the chord key then S sends the chord and unlatches. */
  combo(keys: string[]): void {
    const modifiers: ModifierName[] = []
    const plain: string[] = []
    for (const raw of keys) {
      const normalised = normalizeModifier(raw)
      if (isModifierName(normalised)) modifiers.push(normalised)
      else plain.push(raw)
    }
    const last = plain[plain.length - 1]
    if (!last || !this.sink.combo(modifiers, last)) {
      this.setModifiers(modifiers)
    }
  }

  /** Batched text from the system keyboard, as unicode so autocorrect, emoji
   *  and non-Latin input work. */
  type(text: string): void {
    this.sink.unicode(text)
  }

  // MARK: Focus

  /** Called when the client selects a display, so the pointer arrives where
   *  the user is about to be looking: the centre, the one point that needs no
   *  explanation. Re-selecting the display already driven leaves it alone. */
  focus(display: number): void {
    const changed = this.activeDisplay !== display
    this.activeDisplay = display
    const bounds = this.sink.displayBounds(display)
    if (!bounds) return
    const inside =
      this.cursor.x >= bounds.x &&
      this.cursor.x < bounds.x + bounds.width &&
      this.cursor.y >= bounds.y &&
      this.cursor.y < bounds.y + bounds.height
    if (changed || !inside) this.cursor = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 }
    this.sink.moveTo(Math.round(this.cursor.x), Math.round(this.cursor.y))
  }
}
