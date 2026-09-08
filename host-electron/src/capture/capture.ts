/**
 * The capture half of the host, in the one place Chromium lets a program own
 * the screen: a renderer. `getDisplayMedia` captures a display at the ladder
 * size, `MediaStreamTrackProcessor` hands over frames, and a WebCodecs
 * `VideoEncoder` produces H.264 in Annex-B — the same bytes the Mac host's
 * VideoToolbox produces after its own AVCC rewrite. Nothing here touches the
 * socket; framing, sequence numbers and flags stay in the main process.
 *
 * One `MessagePort` per stream, delivered by the preload as `capture:open`.
 */
import type { FromRenderer, OpenStream, ToRenderer } from '../main/capture/protocol'

// Chromium-only, not in lib.dom: the frame source for a MediaStreamTrack.
declare class MediaStreamTrackProcessor {
  constructor(init: { track: MediaStreamTrack })
  readonly readable: ReadableStream<VideoFrame>
}

const ANNEXB_START = [0, 0, 0, 1]

class StreamSession {
  private track: MediaStreamTrack | null = null
  private reader: ReadableStreamDefaultReader<VideoFrame> | null = null
  private encoder: VideoEncoder | null = null
  private target: { width: number; height: number; fps: number; bitrate: number }
  private configured: { width: number; height: number } | null = null
  private forceKey = true
  private framesSinceKey = 0
  private resolutionChanged = false
  private firstTimestamp: number | null = null
  private stopped = false
  private hardware = false
  private codec = ''
  private stats = { framesIn: 0, framesEncoded: 0, framesDropped: 0, bytes: 0 }
  private statsTimer: ReturnType<typeof setInterval> | null = null
  private lastFrameAt = performance.now()
  private readonly synthetic: boolean
  private pattern: { canvas: HTMLCanvasElement; timer: ReturnType<typeof setInterval> } | null = null

  constructor(
    private readonly port: MessagePort,
    open: OpenStream,
  ) {
    this.target = { width: open.width, height: open.height, fps: open.fps, bitrate: open.bitrate }
    this.synthetic = open.synthetic
    port.onmessage = (event: MessageEvent<ToRenderer>) => void this.handle(event.data)
    port.start()
    void this.start()
    this.statsTimer = setInterval(() => this.reportStats(), 1000)
  }

  private send(message: FromRenderer): void {
    if (this.stopped) return
    // Structured clone, never a transfer list: Electron's main-process port
    // does not take transferred ArrayBuffers, and a refused transfer left the
    // port silent for every message after it. A copy of a 60 fps H.264 stream
    // is a few megabytes a second, which is nothing.
    try {
      this.port.postMessage(message)
    } catch (error) {
      console.error('port.postMessage failed', String(error))
    }
  }

  private async handle(message: ToRenderer): Promise<void> {
    switch (message.kind) {
      case 'keyframe':
        this.forceKey = true
        break
      case 'reconfigure':
        await this.reconfigure(message)
        break
      case 'stop':
        this.stop()
        break
    }
  }

  private async start(): Promise<void> {
    try {
      await this.capture(this.target.width, this.target.height, this.target.fps)
    } catch (error) {
      this.send({ kind: 'ended', reason: 'captureFailed', detail: String(error) })
      this.stop()
    }
  }

  /** Opens the display at the asked-for size. Chromium scales the capture to
   *  the constraint, so the encoder sees the ladder size, not the panel's. */
  private async capture(width: number, height: number, fps: number): Promise<void> {
    const stream = this.synthetic
      ? this.patternStream(width, height, fps)
      : await navigator.mediaDevices.getDisplayMedia({
          video: {
            width: { ideal: width },
            height: { ideal: height },
            frameRate: { ideal: fps, max: fps },
          },
          audio: false,
        })
    const [track] = stream.getVideoTracks()
    if (!track) throw new Error('no video track')
    this.track = track
    track.onended = () => {
      if (!this.stopped) this.send({ kind: 'ended', reason: 'trackEnded', detail: 'the capture track ended' })
    }
    const processor = new MediaStreamTrackProcessor({ track })
    this.reader = processor.readable.getReader()
    void this.pump(this.reader)
  }

  /** A clock and a box that moves, so a decoded picture proves the whole path
   *  and a frozen one is visibly frozen. */
  private patternStream(width: number, height: number, fps: number): MediaStream {
    if (this.pattern) clearInterval(this.pattern.timer)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')!
    const startedAt = performance.now()
    const draw = () => {
      const t = (performance.now() - startedAt) / 1000
      context.fillStyle = '#0b0f14'
      context.fillRect(0, 0, width, height)
      context.fillStyle = '#39d98a'
      const x = ((t * 200) % (width + 120)) - 60
      context.fillRect(x, height * 0.4, 120, 120)
      context.fillStyle = '#e6edf3'
      context.font = `${Math.round(height / 12)}px monospace`
      context.fillText(`VibeWire test pattern ${t.toFixed(2)}s ${width}x${height}@${fps}`, 24, Math.round(height / 8))
    }
    draw()
    const timer = setInterval(draw, Math.round(1000 / fps))
    this.pattern = { canvas, timer }
    return canvas.captureStream(fps)
  }

  private async pump(reader: ReadableStreamDefaultReader<VideoFrame>): Promise<void> {
    for (;;) {
      let result: ReadableStreamReadResult<VideoFrame>
      try {
        result = await reader.read()
      } catch {
        return
      }
      if (result.done) return
      const frame = result.value
      if (this.stopped || reader !== this.reader) {
        frame.close()
        continue
      }
      this.stats.framesIn += 1
      this.lastFrameAt = performance.now()
      try {
        await this.encode(frame)
      } finally {
        frame.close()
      }
    }
  }

  private async encode(frame: VideoFrame): Promise<void> {
    const width = frame.codedWidth
    const height = frame.codedHeight
    if (!this.encoder || !this.configured || this.configured.width !== width || this.configured.height !== height) {
      await this.configure(width, height)
    }
    const encoder = this.encoder
    if (!encoder || encoder.state !== 'configured') return
    // The safety valve for a slow encoder: a frame that would queue behind two
    // others is a frame that would arrive late, and a late frame is worse than
    // no frame on a live picture.
    if (encoder.encodeQueueSize > 2) {
      this.stats.framesDropped += 1
      return
    }
    if (this.firstTimestamp === null) this.firstTimestamp = frame.timestamp
    const gop = this.target.fps * 2
    const keyFrame = this.forceKey || this.framesSinceKey >= gop
    this.forceKey = false
    this.framesSinceKey = keyFrame ? 0 : this.framesSinceKey + 1
    try {
      encoder.encode(frame, { keyFrame })
    } catch (error) {
      console.error('encode threw', String(error))
      throw error
    }
    if (this.stats.framesIn === 1) console.log('first frame encoded', frame.codedWidth, frame.codedHeight, frame.format, 'ts', frame.timestamp)
  }

  private async configure(width: number, height: number): Promise<void> {
    const encoder = this.encoder ?? this.createEncoder()
    const fps = this.target.fps
    const preferred: VideoEncoderConfig = {
      codec: avcCodecFor(width, height, fps),
      width,
      height,
      bitrate: this.target.bitrate,
      framerate: fps,
      latencyMode: 'realtime',
      hardwareAcceleration: 'prefer-hardware',
      bitrateMode: 'constant',
      avc: { format: 'annexb' },
    }
    let config = preferred
    let hardware = true
    let support = await VideoEncoder.isConfigSupported(preferred)
    if (!support.supported) {
      // Software OpenH264 knows Baseline only, and does not mind being asked.
      config = { ...preferred, codec: 'avc1.42E01F', hardwareAcceleration: 'no-preference' }
      hardware = false
      support = await VideoEncoder.isConfigSupported(config)
      if (!support.supported) throw new Error(`no H.264 encoder for ${width}x${height}@${fps}`)
    }
    if (encoder.state === 'configured') await encoder.flush()
    encoder.configure(config)
    this.encoder = encoder
    this.configured = { width, height }
    this.hardware = hardware
    this.codec = config.codec
    this.forceKey = true
    this.send({ kind: 'configured', width, height, fps, bitrate: this.target.bitrate, codec: config.codec, hardware })
  }

  private createEncoder(): VideoEncoder {
    const encoder = new VideoEncoder({
      output: (chunk, metadata) => this.emit(chunk, metadata),
      error: (error) => {
        this.send({ kind: 'ended', reason: 'encoderError', detail: error.message })
        this.stop()
      },
    })
    this.encoder = encoder
    return encoder
  }

  private emit(chunk: EncodedVideoChunk, metadata?: EncodedVideoChunkMetadata): void {
    if (this.stopped) return
    if (this.stats.framesEncoded === 0) console.log('first chunk', chunk.type, chunk.byteLength, 'ts', chunk.timestamp)
    let payload: Uint8Array = new Uint8Array(chunk.byteLength)
    chunk.copyTo(payload)
    const keyframe = chunk.type === 'key'
    if (keyframe && !carriesParameterSets(payload)) {
      // Every keyframe on the wire promises SPS/PPS. Chromium puts them in-band
      // in Annex-B mode; if an encoder ever does not, they are still in the
      // decoder config it handed over, and go on the front here.
      const description = metadata?.decoderConfig?.description
      if (description) {
        const sets = parameterSetsFromAvcC(toBytes(description))
        if (sets) payload = concat(sets, payload)
      }
    }
    this.stats.framesEncoded += 1
    this.stats.bytes += payload.byteLength
    const ptsMicros = Math.max(0, chunk.timestamp - (this.firstTimestamp ?? chunk.timestamp))
    const resolutionChanged = keyframe && this.resolutionChanged
    if (resolutionChanged) this.resolutionChanged = false
    const buffer = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer
    this.send({ kind: 'chunk', keyframe, ptsMicros, resolutionChanged, payload: buffer })
  }

  private async reconfigure(message: { width: number; height: number; fps: number; bitrate: number }): Promise<void> {
    const sizeChanged = message.width !== this.target.width || message.height !== this.target.height
    const fpsChanged = message.fps !== this.target.fps
    this.target = { width: message.width, height: message.height, fps: message.fps, bitrate: message.bitrate }
    if (sizeChanged || fpsChanged) {
      // A new size is a new capture: the constraint is what scales the frames.
      // The encoder reconfigures itself on the first frame of the new size.
      this.resolutionChanged = sizeChanged
      const previous = this.track
      this.reader = null
      previous?.stop()
      try {
        await this.capture(message.width, message.height, message.fps)
      } catch (error) {
        this.send({ kind: 'ended', reason: 'captureFailed', detail: String(error) })
        this.stop()
      }
      return
    }
    if (this.encoder && this.configured) {
      await this.configure(this.configured.width, this.configured.height)
    }
  }

  private reportStats(): void {
    if (this.stopped) return
    this.send({
      kind: 'stats',
      framesIn: this.stats.framesIn,
      framesEncoded: this.stats.framesEncoded,
      framesDropped: this.stats.framesDropped,
      encodeQueueSize: this.encoder?.encodeQueueSize ?? 0,
      bytes: this.stats.bytes,
    })
    if (performance.now() - this.lastFrameAt > 5000 && this.stats.framesIn === 0) {
      this.send({ kind: 'ended', reason: 'noFrames', detail: 'no frames arrived in 5 s' })
    }
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.statsTimer) clearInterval(this.statsTimer)
    if (this.pattern) clearInterval(this.pattern.timer)
    void this.reader?.cancel().catch(() => {})
    this.reader = null
    this.track?.stop()
    this.track = null
    try {
      this.encoder?.close()
    } catch {
      // already closed
    }
    this.encoder = null
    this.port.close()
  }

  get isHardware(): boolean {
    return this.hardware
  }

  get codecString(): string {
    return this.codec
  }
}

/** The `avc1.PPCCLL` to ask for: High profile, level from size and rate. Kept
 *  in step with `quality.ts`; duplicated because this bundle is a browser one. */
function avcCodecFor(width: number, height: number, fps: number): string {
  const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16)
  const rate = macroblocks * fps
  const level = rate > 245_760 ? '2a' : rate > 108_000 ? '28' : '1f'
  return `avc1.6400${level}`
}

function carriesParameterSets(payload: Uint8Array): boolean {
  // Scan the first few NAL units for an SPS (type 7).
  let index = 0
  let seen = 0
  while (index + 4 < payload.length && seen < 4) {
    if (payload[index] === 0 && payload[index + 1] === 0 && payload[index + 2] === 1) {
      if ((payload[index + 3] & 0x1f) === 7) return true
      seen += 1
      index += 3
    } else {
      index += 1
    }
  }
  return false
}

function toBytes(description: AllowSharedBufferSource): Uint8Array {
  if (description instanceof ArrayBuffer) return new Uint8Array(description)
  const view = description as ArrayBufferView
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength)
}

/** SPS and PPS out of an avcC record, each with a 4-byte start code. */
function parameterSetsFromAvcC(avcc: Uint8Array): Uint8Array | null {
  if (avcc.length < 7 || avcc[0] !== 1) return null
  const parts: Uint8Array[] = []
  let offset = 5
  const spsCount = avcc[offset] & 0x1f
  offset += 1
  for (let i = 0; i < spsCount; i += 1) {
    const length = (avcc[offset] << 8) | avcc[offset + 1]
    offset += 2
    parts.push(new Uint8Array(ANNEXB_START), avcc.subarray(offset, offset + length))
    offset += length
  }
  const ppsCount = avcc[offset]
  offset += 1
  for (let i = 0; i < ppsCount; i += 1) {
    const length = (avcc[offset] << 8) | avcc[offset + 1]
    offset += 2
    parts.push(new Uint8Array(ANNEXB_START), avcc.subarray(offset, offset + length))
    offset += length
  }
  return parts.length ? concat(...parts) : null
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.byteLength, 0)
  const out = new Uint8Array(total)
  let offset = 0
  for (const part of parts) {
    out.set(part, offset)
    offset += part.byteLength
  }
  return out
}

// MARK: - Entry

const sessions = new Map<number, StreamSession>()

window.addEventListener('message', (event: MessageEvent) => {
  const message = event.data as { kind?: string; data?: OpenStream } | null
  if (!message || message.kind !== 'capture:open' || !message.data) return
  const port = event.ports[0]
  if (!port) return
  const open = message.data
  sessions.get(open.streamId)?.stop()
  sessions.set(open.streamId, new StreamSession(port, open))
})
