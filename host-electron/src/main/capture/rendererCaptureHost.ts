import { BrowserWindow, MessageChannelMain, session, type DesktopCapturerSource, type MessagePortMain } from 'electron'
import { join } from 'node:path'
import { encodeVideoFrame } from '../../../../shared/frame'
import { Log, describeError } from '../core/log'
import type { SocketConnection } from '../net/socketConnection'
import { Outbound } from '../net/wireProtocol'
import type { Telemetry } from '../system/telemetry'
import type { CaptureHost, DisplayInfo, StreamFacts } from './captureHost'
import { DisplayCatalog } from './displayCatalog'
import type { FromRenderer, OpenStream, ToRenderer } from './protocol'
import { fit, qualityForLink, type Quality } from './quality'

/** What the ladder needs from the settings, read fresh each time. */
export type LadderSource = () => { maxHeight: number | null; capMbps: number | null }

/**
 * One display → encoded H.264 frames, the main-process half. The renderer
 * captures and encodes; this side owns the port, the sequence numbers, the
 * flags, the rate readings and the socket. Two can run at once for the
 * side-by-side mode on 03C, each with its own `streamId`.
 */
class Stream {
  sequence = 0
  quality: Quality
  encodedSize: { width: number; height: number }
  pendingResolutionFlag = false
  framesEncoded = 0
  measuredMbps = 0
  hardware = true
  codec = ''
  lastChunkAt = Date.now()
  private bytesThisSecond = 0
  private lastRateSample = Date.now()
  private configuredResolvers: ((ok: boolean) => void)[] = []
  private ended = false

  constructor(
    readonly streamId: number,
    readonly displayId: number,
    readonly source: { width: number; height: number },
    quality: Quality,
    readonly port: MessagePortMain,
  ) {
    this.quality = quality
    this.encodedSize = fit(source.width, source.height, quality.maxHeight)
  }

  post(message: ToRenderer): void {
    if (this.ended) return
    this.port.postMessage(message)
  }

  /** Resolves with the next `configured` (or false if the stream ended first). */
  nextConfigured(timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.configuredResolvers = this.configuredResolvers.filter((entry) => entry !== settle)
        resolve(false)
      }, timeoutMs)
      const settle = (ok: boolean) => {
        clearTimeout(timer)
        resolve(ok)
      }
      this.configuredResolvers.push(settle)
    })
  }

  settleConfigured(ok: boolean): void {
    const waiting = this.configuredResolvers
    this.configuredResolvers = []
    for (const resolve of waiting) resolve(ok)
  }

  noteBytes(count: number): void {
    this.bytesThisSecond += count
    const elapsed = (Date.now() - this.lastRateSample) / 1000
    if (elapsed >= 1) {
      this.measuredMbps = (this.bytesThisSecond * 8) / elapsed / 1_000_000
      this.bytesThisSecond = 0
      this.lastRateSample = Date.now()
    }
  }

  close(): void {
    if (this.ended) return
    this.ended = true
    this.settleConfigured(false)
    try {
      this.port.postMessage({ kind: 'stop' } satisfies ToRenderer)
    } catch {
      // the renderer may already be gone
    }
    this.port.close()
  }

  get isEnded(): boolean {
    return this.ended
  }
}

export class RendererCaptureHost implements CaptureHost {
  private readonly catalog = new DisplayCatalog()
  private window: BrowserWindow | null = null
  private windowReady: Promise<void> | null = null
  private live = new Map<number, Stream>()
  private socket: SocketConnection | null = null
  private lastKeyframeSnapshot: { data: Uint8Array; at: number } | null = null
  private pendingSource: DesktopCapturerSource | null = null
  private ladder: LadderSource = () => ({ maxHeight: null, capMbps: null })
  /** `VIBEWIRE_SYNTHETIC_CAPTURE=1`: a test pattern instead of the screen. */
  private readonly synthetic = process.env.VIBEWIRE_SYNTHETIC_CAPTURE === '1'

  constructor(
    private readonly telemetry: Telemetry,
    private readonly pageDir: string,
  ) {
    // Source selection without a picker: `captureHost` sets `pendingSource`
    // immediately before the renderer asks, and the handler hands it over.
    session.defaultSession.setDisplayMediaRequestHandler(
      (_request, callback) => {
        const source = this.pendingSource
        this.pendingSource = null
        if (!source) throw new Error('no display was selected for capture')
        callback({ video: source })
      },
      { useSystemPicker: false },
    )
  }

  bindLadder(source: LadderSource): void {
    this.ladder = source
  }

  setSocket(socket: SocketConnection | null): void {
    this.socket = socket
  }

  displays(force = false): Promise<DisplayInfo[]> {
    return this.catalog.refresh(force)
  }

  // MARK: The hidden renderer

  private ensureWindow(): Promise<void> {
    if (this.window && !this.window.isDestroyed() && this.windowReady) return this.windowReady
    const window = new BrowserWindow({
      show: false,
      width: 320,
      height: 200,
      webPreferences: {
        preload: join(this.pageDir, '..', 'preload', 'capture.js'),
        contextIsolation: true,
        sandbox: false,
        nodeIntegration: false,
        backgroundThrottling: false,
      },
    })
    window.webContents.on('render-process-gone', (_event, details) => {
      Log.error('capture', `capture renderer gone: ${details.reason}`)
      this.abandonAll(`capture renderer gone: ${details.reason}`)
      this.window = null
      this.windowReady = null
    })
    window.webContents.on('console-message', (event) => {
      if (event.message.includes('Electron Security Warning')) return
      Log.debug('capture', `renderer: ${event.message}`)
    })
    this.window = window
    this.windowReady = window.loadFile(join(this.pageDir, 'index.html')).then(() => {
      Log.info('capture', 'capture renderer ready')
    })
    return this.windowReady
  }

  private abandonAll(detail: string): void {
    for (const stream of this.live.values()) stream.close()
    this.live.clear()
    this.socket?.sendJSON(Outbound.error('capture_failed', detail, true))
    this.socket?.sendJSON({ t: 'streamState', state: 'stopped' })
  }

  // MARK: Streams

  async startStreams(displays: number[], maxHeight: number | null, fps: number | null, socket: SocketConnection): Promise<void> {
    await this.stopAll()
    socket.sendJSON({ t: 'streamState', state: 'starting' })

    const verdict = this.telemetry.linkVerdict()
    const ladder = this.ladder()
    const quality = qualityForLink(maxHeight ?? ladder.maxHeight, verdict?.rtt ?? 20, verdict?.loss ?? 0, ladder.capMbps)
    if (fps !== null) quality.fps = fps

    try {
      await this.ensureWindow()
    } catch (error) {
      socket.sendJSON(Outbound.error('capture_failed', describeError(error), true))
      socket.sendJSON({ t: 'streamState', state: 'stopped' })
      return
    }

    await this.catalog.refresh(true)
    let index = 0
    for (const displayId of displays) {
      const streamId = index
      index += 1
      const display = this.catalog.display(displayId)
      const source = display ? this.synthetic ? syntheticSource(displayId) : await this.catalog.source(displayId) : null
      if (!display || !source) {
        Log.error('capture', `display ${displayId} is not available for capture`)
        socket.sendJSON(Outbound.error('capture_failed', `display ${displayId} is no longer available`, true))
        continue
      }
      const stream = await this.open(streamId, display, source, quality)
      if (stream) this.live.set(streamId, stream)
      else socket.sendJSON(Outbound.error('capture_failed', `display ${displayId} did not start`, true))
    }

    socket.sendJSON({ t: 'streamState', state: this.live.size ? 'live' : 'stopped' })
  }

  private async open(streamId: number, display: DisplayInfo, source: DesktopCapturerSource, quality: Quality): Promise<Stream | null> {
    const window = this.window
    if (!window || window.isDestroyed()) return null
    const channel = new MessageChannelMain()
    const stream = new Stream(streamId, display.id, { width: display.width, height: display.height }, quality, channel.port1)
    channel.port1.on('message', (event) => this.receive(stream, event.data as FromRenderer))
    channel.port1.start()

    const open: OpenStream = {
      streamId,
      displayId: display.id,
      width: stream.encodedSize.width,
      height: stream.encodedSize.height,
      fps: quality.fps,
      bitrate: quality.bitrate,
      synthetic: this.synthetic,
    }
    this.pendingSource = source
    const configured = stream.nextConfigured(10_000)
    window.webContents.postMessage('capture:open', open, [channel.port2])
    if (!(await configured)) {
      Log.error('capture', `stream ${streamId} on display ${display.id} did not configure in time`)
      stream.close()
      return null
    }
    Log.info(
      'capture',
      `stream ${streamId} started on display ${display.id} at ${stream.encodedSize.width}x${stream.encodedSize.height}@${quality.fps}`,
    )
    return stream
  }

  private receive(stream: Stream, message: FromRenderer): void {
    if (stream.isEnded) return
    switch (message.kind) {
      case 'configured': {
        stream.encodedSize = { width: message.width, height: message.height }
        stream.hardware = message.hardware
        stream.codec = message.codec
        stream.settleConfigured(true)
        // Emitted from what the encoder reports, never from what was asked.
        this.socket?.sendJSON({
          t: 'videoConfig',
          streamId: stream.streamId,
          displayId: stream.displayId,
          width: message.width,
          height: message.height,
          fps: message.fps,
          bitrate: message.bitrate,
          ladder: String(stream.quality.maxHeight),
          hardware: message.hardware,
        })
        if (!message.hardware) Log.warn('capture', `stream ${stream.streamId} is on a software encoder (${message.codec})`)
        break
      }
      case 'chunk':
        this.emit(stream, message)
        break
      case 'stats':
        stream.framesEncoded = message.framesEncoded
        Log.debug(
          'capture',
          `stream ${stream.streamId} stats: in ${message.framesIn} encoded ${message.framesEncoded} dropped ${message.framesDropped} queue ${message.encodeQueueSize} bytes ${message.bytes}`,
        )
        break
      case 'ended':
        Log.error('capture', `stream ${stream.streamId} ended: ${message.reason} — ${message.detail}`)
        stream.close()
        this.live.delete(stream.streamId)
        this.socket?.sendJSON(Outbound.error('capture_failed', message.detail, true))
        if (this.live.size === 0) this.socket?.sendJSON({ t: 'streamState', state: 'stopped' })
        break
    }
  }

  private emit(stream: Stream, chunk: Extract<FromRenderer, { kind: 'chunk' }>): void {
    const payload = toBytes(chunk.payload)
    if (stream.sequence === 0) Log.debug('capture', `stream ${stream.streamId} first chunk: ${payload.byteLength} bytes, key ${chunk.keyframe}`)
    stream.sequence = (stream.sequence + 1) >>> 0
    stream.framesEncoded += 1
    stream.lastChunkAt = Date.now()

    const resolutionChanged = chunk.resolutionChanged || stream.pendingResolutionFlag
    if (chunk.keyframe) stream.pendingResolutionFlag = false

    const framed = encodeVideoFrame(
      {
        streamId: stream.streamId,
        sequence: stream.sequence,
        ptsMicros: chunk.ptsMicros,
        keyframe: chunk.keyframe,
        parameterSets: chunk.keyframe,
        resolutionChanged: chunk.keyframe && resolutionChanged,
      },
      payload,
    )
    this.socket?.sendBinary(framed)
    if (chunk.keyframe) this.lastKeyframeSnapshot = { data: framed, at: Date.now() }
    stream.noteBytes(framed.byteLength)
  }

  async stopAll(): Promise<void> {
    const live = [...this.live.values()]
    this.live.clear()
    for (const stream of live) {
      stream.close()
      Log.info('capture', `stream ${stream.streamId} stopped`)
    }
  }

  /** Called on the heartbeat and whenever settings change. This is what makes
   *  the picture drop to 540p on a thin link instead of stuttering at 1080p. */
  async retune(force = false): Promise<void> {
    const measured = this.telemetry.linkVerdict()
    const verdict = measured ?? (force ? { rtt: 20, loss: 0 } : null)
    if (!verdict || this.live.size === 0) return
    const ladder = this.ladder()
    const quality = qualityForLink(ladder.maxHeight, verdict.rtt, verdict.loss, ladder.capMbps)
    for (const stream of this.live.values()) {
      if (stream.quality.maxHeight === quality.maxHeight && stream.quality.bitrate === quality.bitrate) continue
      const target = fit(stream.source.width, stream.source.height, quality.maxHeight)
      const sizeChanged = target.width !== stream.encodedSize.width || target.height !== stream.encodedSize.height
      stream.quality = quality
      if (sizeChanged) stream.pendingResolutionFlag = true
      stream.post({ kind: 'reconfigure', width: target.width, height: target.height, fps: quality.fps, bitrate: quality.bitrate })
      Log.info('capture', `stream ${stream.streamId} retuned to ${target.height}p @${quality.fps} ${Math.round(quality.bitrate / 1000)}kbps`)
    }
  }

  requestKeyframes(): void {
    for (const stream of this.live.values()) stream.post({ kind: 'keyframe' })
  }

  private sorted(): Stream[] {
    return [...this.live.values()].sort((a, b) => a.streamId - b.streamId)
  }

  streams(): StreamFacts[] {
    return this.sorted().map((stream) => ({
      streamId: stream.streamId,
      displayId: stream.displayId,
      width: stream.encodedSize.width,
      height: stream.encodedSize.height,
      fps: stream.quality.fps,
      bitrate: stream.quality.bitrate,
      ladder: stream.quality.maxHeight,
      measuredMbps: stream.measuredMbps,
      framesEncoded: stream.framesEncoded,
      hardware: stream.hardware,
    }))
  }

  measuredMbps(): number {
    return this.sorted().reduce((sum, stream) => sum + stream.measuredMbps, 0)
  }

  lastKeyframe(): { data: Uint8Array; at: number } | null {
    return this.lastKeyframeSnapshot
  }

  captureStalledMs(): number | null {
    let worst: number | null = null
    for (const stream of this.live.values()) {
      const quiet = Date.now() - stream.lastChunkAt
      if (quiet > 2000 && (worst === null || quiet > worst)) worst = quiet
    }
    return worst
  }
}

/** Stands in for a capture source when the renderer will draw its own picture. */
function syntheticSource(displayId: number): DesktopCapturerSource {
  return { id: `screen:${displayId}:0`, name: 'Test pattern', display_id: String(displayId) } as DesktopCapturerSource
}

function toBytes(payload: ArrayBuffer | ArrayBufferView): Uint8Array {
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload)
  return new Uint8Array(payload.buffer, payload.byteOffset, payload.byteLength)
}
