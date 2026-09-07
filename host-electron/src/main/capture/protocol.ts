/**
 * The messages between the main process and the hidden capture renderer, one
 * `MessageChannel` per stream. Shared by both sides so a field cannot drift.
 */
export interface OpenStream {
  streamId: number
  displayId: number
  width: number
  height: number
  fps: number
  bitrate: number
  /** Draw a moving test pattern instead of capturing the display. For a host
   *  with no screen to capture — CI, a headless dev box — so the encoder and
   *  the framing can still be exercised end to end. */
  synthetic: boolean
}

export type ToRenderer =
  | { kind: 'reconfigure'; width: number; height: number; fps: number; bitrate: number }
  | { kind: 'keyframe' }
  | { kind: 'stop' }

export type FromRenderer =
  | { kind: 'configured'; width: number; height: number; fps: number; bitrate: number; codec: string; hardware: boolean }
  | { kind: 'chunk'; keyframe: boolean; ptsMicros: number; resolutionChanged: boolean; payload: ArrayBuffer }
  | { kind: 'stats'; framesIn: number; framesEncoded: number; framesDropped: number; encodeQueueSize: number; bytes: number }
  | { kind: 'ended'; reason: 'trackEnded' | 'encoderError' | 'noFrames' | 'captureFailed'; detail: string }
