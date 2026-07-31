/**
 * Renders the Mac's screen. The browser counterpart of
 * ios/VibeWire/Video/VideoSurface.swift.
 *
 * H.264 Annex-B arrives over the socket and goes straight into a WebCodecs
 * `VideoDecoder`, then to a `<canvas>`. Two differences from the phone, both in
 * the browser's favour:
 *
 *  - No AVCC rewrap. `AVSampleBufferDisplayLayer` needs length-prefixed NALs and
 *    a `CMFormatDescription` built from the parameter sets; `VideoDecoder`
 *    configured without a `description` takes Annex-B as it stands, which is
 *    exactly what the host already sends. The host re-sends SPS/PPS on every
 *    keyframe, so in-band parameter sets are always there.
 *
 *  - No timebase. `optimizeForLatency` plus drawing each frame the instant it is
 *    decoded. This is a remote control, not a video player: the newest frame is
 *    always the right frame, and buffering to smooth playback would be latency
 *    the user feels in the cursor.
 */

import {
  avcCodecString,
  nalType,
  nalUnits,
  NAL_PPS,
  NAL_SPS,
  sameBytes,
  type VideoFrameHeader,
} from './frame'

export type DecoderSupport = 'ok' | 'no-webcodecs'

export function decoderSupport(): DecoderSupport {
  return typeof globalThis.VideoDecoder === 'function' ? 'ok' : 'no-webcodecs'
}

export class VideoRenderer {
  readonly canvas: HTMLCanvasElement
  private readonly context: CanvasRenderingContext2D | null

  private decoder: VideoDecoder | null = null
  private sps: Uint8Array | null = null
  private pps: Uint8Array | null = null
  /**
   * Set when a frame arrives before any parameter set, which happens whenever the
   * client joins mid-stream. The host re-sends SPS/PPS on every keyframe, so this
   * resolves within a second rather than staying broken.
   */
  private waitingForKeyframe = true
  private parameterSetsChanged = false
  private reportedFailure = false

  framesRendered = 0
  framesDropped = 0
  lastFrameAt: number | null = null
  /** Set when the stream cannot be decoded at all, for the caption to say so. */
  failure: string | null = null

  constructor() {
    this.canvas = document.createElement('canvas')
    this.canvas.width = 1600
    this.canvas.height = 1000
    // `resizeAspect` on the phone. The canvas keeps its own pixel dimensions and
    // CSS fits it inside whatever box the layout gives it.
    this.canvas.style.display = 'block'
    this.canvas.style.width = '100%'
    this.canvas.style.height = '100%'
    this.canvas.style.objectFit = 'contain'
    // The Nightshift `deep`, so a canvas with nothing decoded into it yet is the
    // same colour as the band around it rather than a lighter rectangle
    // announcing that a picture failed to arrive.
    this.canvas.style.background = '#06070A'
    this.context = this.canvas.getContext('2d', { alpha: false, desynchronized: true })
  }

  reset(): void {
    this.closeDecoder()
    this.sps = null
    this.pps = null
    this.waitingForKeyframe = true
    // Both of these describe the spell that just ended, not the next one. Leaving
    // `reportedFailure` set meant a renderer logged its first failure and then
    // went quiet for the rest of the session, which is the opposite of what a
    // once-per-spell guard is for.
    this.parameterSetsChanged = false
    this.reportedFailure = false
    this.failure = null
  }

  enqueue(frame: VideoFrameHeader): void {
    const units = nalUnits(frame.payload)
    if (!units.length) return

    let hasPicture = false
    for (const unit of units) {
      switch (nalType(unit)) {
        case NAL_SPS:
          if (!sameBytes(this.sps, unit)) {
            // Copied, not aliased: the payload's backing buffer is the socket
            // message and will be recycled the moment this returns.
            this.sps = unit.slice()
            this.parameterSetsChanged = true
          }
          break
        case NAL_PPS:
          if (!sameBytes(this.pps, unit)) {
            this.pps = unit.slice()
            this.parameterSetsChanged = true
          }
          break
        default:
          hasPicture = true
      }
    }

    if (!hasPicture) return

    // Switching display restarts the stream at a different size, so new parameter
    // sets arrive. Handing a configured decoder a stream in a new format makes it
    // either throw or quietly emit nothing — a black picture with no error. Tear
    // it down and wait for the next keyframe before feeding it again.
    if (this.parameterSetsChanged) {
      this.parameterSetsChanged = false
      this.closeDecoder()
      this.waitingForKeyframe = true
    }

    const decoder = this.ensureDecoder()
    if (!decoder) {
      this.framesDropped += 1
      return
    }

    // Until a keyframe arrives there is nothing a decoder can do with the bytes;
    // drop them rather than feeding it garbage.
    if (this.waitingForKeyframe) {
      if (!frame.isKeyframe) {
        this.framesDropped += 1
        return
      }
      this.waitingForKeyframe = false
    }

    try {
      decoder.decode(
        new EncodedVideoChunk({
          type: frame.isKeyframe ? 'key' : 'delta',
          timestamp: frame.ptsMicros,
          // The whole Annex-B payload, parameter sets included. Splitting them out
          // would only mean putting them back.
          data: frame.payload,
        }),
      )
    } catch (error) {
      this.reportFailure(error)
      this.framesDropped += 1
      this.closeDecoder()
      this.waitingForKeyframe = true
    }
  }

  private ensureDecoder(): VideoDecoder | null {
    if (this.decoder && this.decoder.state === 'configured') return this.decoder
    if (this.decoder) this.closeDecoder()
    if (!this.sps || !this.pps) return null
    if (decoderSupport() !== 'ok') {
      this.failure = 'This browser has no WebCodecs video decoder.'
      return null
    }

    const codec = avcCodecString(this.sps)
    if (!codec) return null

    const decoder = new VideoDecoder({
      output: (frame) => this.draw(frame),
      error: (error) => {
        this.reportFailure(error)
        this.closeDecoder()
        this.waitingForKeyframe = true
      },
    })

    try {
      decoder.configure({
        codec,
        // Absent `description` is what selects Annex-B. Present, it would mean
        // AVCC and every frame would be rejected as malformed.
        optimizeForLatency: true,
        hardwareAcceleration: 'no-preference',
      })
    } catch (error) {
      this.reportFailure(error)
      try {
        decoder.close()
      } catch {
        /* already dead */
      }
      return null
    }

    this.decoder = decoder
    return decoder
  }

  private draw(frame: VideoFrame): void {
    try {
      const width = frame.displayWidth
      const height = frame.displayHeight
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width
        this.canvas.height = height
      }
      this.context?.drawImage(frame, 0, 0, width, height)
      this.framesRendered += 1
      this.lastFrameAt = performance.now()
      this.failure = null
    } finally {
      // A `VideoFrame` holds a GPU buffer. Missing this stalls the decoder within
      // a second — WebCodecs stops emitting once the pool is exhausted — which
      // looks exactly like the Mac having gone quiet.
      frame.close()
    }
  }

  private closeDecoder(): void {
    const decoder = this.decoder
    this.decoder = null
    if (!decoder) return
    try {
      if (decoder.state !== 'closed') decoder.close()
    } catch {
      /* closing a dead decoder is not an error worth reporting */
    }
  }

  /**
   * A decode failure used to be indistinguishable from "the Mac's screen is
   * simply dark". Reported once per spell of failure rather than per frame, which
   * at 60fps would be a torrent.
   */
  private reportFailure(error: unknown): void {
    const detail = error instanceof Error ? error.message : String(error)
    this.failure = detail
    if (this.reportedFailure) return
    this.reportedFailure = true
    console.warn('[VibeWire] video decode failed:', detail)
  }
}

/**
 * One renderer per stream, vended by stream id.
 *
 * A single renderer cannot serve two displays: the host sends an independent
 * H.264 elementary stream per display, each with its own SPS/PPS and its own
 * reference frames. Feeding both into one decoder makes it decode monitor 2's
 * slices against monitor 1's references — which is the green confetti and the
 * grey mush, not a network problem. Keyed by stream id so the demux is exactly
 * the one the wire header already carries.
 */
export class RendererPool {
  private byStream = new Map<number, VideoRenderer>()

  renderer(streamId: number): VideoRenderer {
    let existing = this.byStream.get(streamId)
    if (!existing) {
      existing = new VideoRenderer()
      this.byStream.set(streamId, existing)
    }
    return existing
  }

  resetAll(): void {
    for (const renderer of this.byStream.values()) renderer.reset()
  }

  /**
   * Drops every renderer. The host renumbers streams on each start — a stream id
   * is a position in the selection, not a stable identity — so after a restart the
   * surviving objects belong to the previous numbering and vending one hands a
   * view a decoder that will never be fed again.
   */
  removeAll(): void {
    for (const renderer of this.byStream.values()) renderer.reset()
    this.byStream.clear()
  }

  /**
   * Drops renderers for streams the host is no longer sending, so a stale picture
   * cannot be mistaken for a live one after a display change.
   */
  keepOnly(streamIds: Set<number>): void {
    for (const [streamId, renderer] of [...this.byStream]) {
      if (streamIds.has(streamId)) continue
      renderer.reset()
      this.byStream.delete(streamId)
    }
  }
}
