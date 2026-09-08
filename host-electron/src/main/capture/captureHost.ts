import type { SocketConnection } from '../net/socketConnection'
import { Outbound } from '../net/wireProtocol'

/**
 * What the router asks of the capture path. The renderer-backed implementation
 * arrives with the capture phase; until then `NoCaptureHost` answers every
 * request honestly rather than with a frozen picture.
 */
export interface DisplayInfo {
  id: number
  name: string
  width: number
  height: number
  hz: number
  isBuiltIn: boolean
  isMain: boolean
}

export interface StreamFacts {
  streamId: number
  displayId: number
  width: number
  height: number
  fps: number
  bitrate: number
  ladder: number
  measuredMbps: number
  framesEncoded: number
  hardware: boolean
}

export interface CaptureHost {
  /** The current display list, refreshed. */
  displays(force?: boolean): Promise<DisplayInfo[]>
  startStreams(displays: number[], maxHeight: number | null, fps: number | null, socket: SocketConnection): Promise<void>
  stopAll(): Promise<void>
  /** Retune on the measured link; `force` proceeds on optimistic defaults. */
  retune(force?: boolean): Promise<void>
  requestKeyframes(): void
  streams(): StreamFacts[]
  measuredMbps(): number
  lastKeyframe(): { data: Uint8Array; at: number } | null
  /** Whether a stream has gone quiet on the capture side, and for how long. */
  captureStalledMs(): number | null
  setSocket(socket: SocketConnection | null): void
}

export class NoCaptureHost implements CaptureHost {
  async displays(): Promise<DisplayInfo[]> {
    return []
  }

  async startStreams(_displays: number[], _maxHeight: number | null, _fps: number | null, socket: SocketConnection): Promise<void> {
    socket.sendJSON(Outbound.error('capture_unavailable', 'This host cannot capture its screen yet.'))
    socket.sendJSON({ t: 'streamState', state: 'stopped' })
  }

  async stopAll(): Promise<void> {}

  async retune(): Promise<void> {}

  requestKeyframes(): void {}

  streams(): StreamFacts[] {
    return []
  }

  measuredMbps(): number {
    return 0
  }

  lastKeyframe(): null {
    return null
  }

  captureStalledMs(): null {
    return null
  }

  setSocket(): void {}
}
