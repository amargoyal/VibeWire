import type { ModifierName } from '../../../../shared/keyNames'
import { Log } from '../core/log'
import type { GesturePhase, MouseButton } from '../net/wireProtocol'

/**
 * What the router asks of input. The platform-neutral state machine and the
 * Win32 sink arrive with the platform phase; `NoInput` says so once and then
 * stays quiet.
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
