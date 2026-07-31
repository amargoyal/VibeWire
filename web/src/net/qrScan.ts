/**
 * Reading the Mac's pairing QR with the browser's own camera.
 *
 * The phone has `AVCaptureMetadataOutput` and can assume it. A browser can
 * assume none of it, and this module exists so the screen never offers a control
 * backed by a capability this engine has not got. Three separate things have to
 * be true before a SCAN row is honest, and each is missing on a real browser
 * somebody will open this page in:
 *
 *  1. **A barcode reader.** `BarcodeDetector` is Chromium's. Safari and Firefox
 *     have nothing equivalent, and shipping a QR decoder to make up the
 *     difference would be a few hundred kilobytes on a page whose whole job is
 *     to load on a phone that has just lost Wi-Fi.
 *  2. **A secure origin.** `getUserMedia` is gated on one, and the copy of this
 *     client the Mac serves at `http://<mac>:8787/` is deliberately not one —
 *     the host speaks plain HTTP by design. On that origin the camera is simply
 *     unavailable, and saying so is the only honest thing to do.
 *  3. **A camera, and permission for it.** Both refusable, separately, and by
 *     different parties.
 *
 * So `scannerSupport()` answers the question before anything is drawn, and
 * `QrScan` reports what happened after the user commits. Neither ever collapses
 * two of these into one message: a laptop with no camera, a permission the user
 * declined, and an engine with no reader are three different facts with three
 * different answers, and the one thing the user does next differs in each case.
 *
 * The payload is `vibewire://pair?host=…&port=…&code=…`, the same string the
 * iPhone's scanner hands to `apply(scanned:)`. This module does not parse it:
 * the screen owns that, so a scan and a paste go through the same reader and the
 * same handshake.
 */

/**
 * What `BarcodeDetector` looks like from here.
 *
 * It is not in `lib.dom`, and it is not going into the global namespace either —
 * a global declaration would tell the rest of the client the type exists on every
 * engine, which is the exact claim this module is here to stop making.
 */
interface DetectedBarcode {
  rawValue: string
}

interface BarcodeReader {
  detect(source: CanvasImageSource): Promise<DetectedBarcode[]>
}

interface BarcodeReaderConstructor {
  new (options?: { formats?: string[] }): BarcodeReader
  getSupportedFormats?(): Promise<string[]>
}

function barcodeReader(): BarcodeReaderConstructor | null {
  if (!('BarcodeDetector' in window)) return null
  return (window as unknown as { BarcodeDetector: BarcodeReaderConstructor }).BarcodeDetector
}

/** Why this browser cannot scan, when it cannot. Checked before anything is drawn. */
export type ScannerSupport = 'ok' | 'no-reader' | 'insecure-origin' | 'no-camera-api'

/**
 * Whether a SCAN control would be a working control here.
 *
 * The reader is checked first even though the origin is the fixable one, because
 * it is the deeper fact: on a Safari opened over plain HTTP both are missing, and
 * telling that reader to come back over HTTPS would send them round a detour to
 * the same dead end. The engine's missing decoder is the answer that stays true.
 */
export function scannerSupport(): ScannerSupport {
  if (!barcodeReader()) return 'no-reader'
  // `localhost` counts as secure, so `npm run dev` scans; `http://<mac>:8787`
  // does not, which is the tailnet copy and the common case.
  if (!window.isSecureContext) return 'insecure-origin'
  if (!navigator.mediaDevices?.getUserMedia) return 'no-camera-api'
  return 'ok'
}

/**
 * The row's two lines when scanning is unavailable: the fact, and what to do
 * instead. Written here rather than in the screen for the same reason
 * `describe()` in endpoint.ts is — the sentence is part of naming the condition,
 * and a condition with its explanation somewhere else drifts from it.
 */
export function describeUnavailable(support: Exclude<ScannerSupport, 'ok'>): {
  fact: string
  caption: string
} {
  switch (support) {
    case 'no-reader':
      return {
        fact: 'This engine has no barcode reader.',
        caption: 'CHROME AND EDGE HAVE ONE · PASTE THE LINK INSTEAD',
      }
    case 'insecure-origin':
      return {
        fact: 'This page is on plain HTTP, so the browser will not hand it a camera.',
        caption: 'THE MAC SERVES THIS COPY OVER HTTP BY DESIGN',
      }
    case 'no-camera-api':
      return {
        fact: 'This browser gives this page no camera at all.',
        caption: 'NO MEDIA DEVICES ON THIS ORIGIN',
      }
  }
}

export type ScanEvent =
  /** The first frame has actually been drawn — not "the camera was asked for". */
  | { kind: 'live' }
  /** A QR was read. The text is raw; the screen decides whether it is ours. */
  | { kind: 'payload'; text: string }
  /** The scan cannot proceed, with the sentence that says why. */
  | { kind: 'failed'; sentence: string }

/** Four times a second. A QR held up to a camera is not a 60 Hz event, and a
 *  detect on every animation frame is a warm phone for no extra reads. */
const DETECT_INTERVAL_MS = 250

/** The detector wants a legible QR, not a 4K one, and a 4K `drawImage` every
 *  quarter second on a phone is heat the user pays for. */
const DETECT_MAX_EDGE = 960

/**
 * One camera, one detection loop, one `stop()` that is safe to call as often as
 * it takes.
 *
 * `stop()` being idempotent is the whole point of the shape: the screen calls it
 * on unmount, on a good payload, and when the sheet closes, and two of those
 * happen together every successful scan. A camera left running behind a paired
 * session is the kind of thing that gets noticed — by the operating system's
 * recording indicator, which is exactly where it should not be a surprise.
 */
export class QrScan {
  private stream: MediaStream | null = null
  private reader: BarcodeReader | null = null
  private canvas: HTMLCanvasElement | null = null
  private context: CanvasRenderingContext2D | null = null
  private timer: ReturnType<typeof setTimeout> | null = null
  private stopped = false
  private posted = false
  /** The last payload reported. A QR sits in frame for many ticks, and the same
   *  wrong code re-announcing itself four times a second would make the screen's
   *  one sentence flicker rather than sit still and be read. */
  private lastText: string | null = null

  constructor(
    private readonly video: HTMLVideoElement,
    private readonly onEvent: (event: ScanEvent) => void,
  ) {}

  async start(): Promise<void> {
    const support = scannerSupport()
    if (support !== 'ok') {
      this.fail(describeUnavailable(support).fact)
      return
    }

    const constructor = barcodeReader()
    if (!constructor) {
      this.fail(describeUnavailable('no-reader').fact)
      return
    }

    // Chromium ships the constructor on platforms whose underlying library reads
    // no formats at all, where every `detect` rejects. Asking which formats are
    // real is the difference between "this engine cannot scan" said before the
    // camera light comes on and said after it.
    try {
      const formats = await constructor.getSupportedFormats?.()
      if (formats && !formats.includes('qr_code')) {
        this.fail('This engine’s barcode reader does not read QR codes.')
        return
      }
      this.reader = new constructor({ formats: ['qr_code'] })
    } catch {
      this.fail(describeUnavailable('no-reader').fact)
      return
    }
    if (this.stopped) return

    let stream: MediaStream
    try {
      // `facingMode` as a plain value is a preference, not `exact`: a laptop with
      // only a front camera should open that one rather than be told there is no
      // camera on a machine whose lens is looking straight at the user.
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      })
    } catch (error) {
      this.fail(cameraFailureSentence(error))
      return
    }

    // The permission prompt is modal to the page but not to this object: the
    // sheet can be dismissed while it is up, and the stream then arrives to a
    // screen that is gone.
    if (this.stopped) {
      for (const track of stream.getTracks()) track.stop()
      return
    }

    this.stream = stream
    this.video.srcObject = stream
    // Both are what stop iOS Safari taking the preview fullscreen, and a
    // fullscreen preview over this sheet would hide the way out of it.
    this.video.muted = true
    this.video.playsInline = true
    try {
      await this.video.play()
    } catch {
      // A rejected `play()` is not proof the track is dead — a re-render
      // interrupts one routinely. The first frame actually drawn is what says
      // the camera is live, and that is measured in the loop below rather than
      // claimed here.
    }

    this.tick()
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    if (this.timer != null) {
      clearTimeout(this.timer)
      this.timer = null
    }
    for (const track of this.stream?.getTracks() ?? []) track.stop()
    this.stream = null
    this.reader = null
    // Stopping the tracks is what turns the camera off; clearing the element is
    // what makes the browser's own recording indicator agree, and an indicator
    // that stays lit is indistinguishable from a camera that stayed on.
    this.video.pause()
    this.video.srcObject = null
  }

  private tick = (): void => {
    if (this.stopped) return
    void this.read().finally(() => {
      if (this.stopped) return
      this.timer = setTimeout(this.tick, DETECT_INTERVAL_MS)
    })
  }

  private async read(): Promise<void> {
    const reader = this.reader
    if (!reader || !this.drawFrame()) return

    if (!this.posted) {
      this.posted = true
      this.onEvent({ kind: 'live' })
    }

    let codes: DetectedBarcode[]
    try {
      codes = await reader.detect(this.canvas as HTMLCanvasElement)
    } catch {
      // A frame the detector could not make sense of is the ordinary case while
      // someone is still aiming. It is not a condition, and reporting it as one
      // would put a red sentence under a camera that is working.
      return
    }

    // A detect in flight when the sheet closes still resolves. Delivering its
    // payload would start a handshake the user has just backed out of.
    if (this.stopped) return

    const text = codes.find((code) => code.rawValue)?.rawValue
    if (!text || text === this.lastText) return
    this.lastText = text
    this.onEvent({ kind: 'payload', text })
  }

  /**
   * The current camera frame, on a canvas the detector can read.
   *
   * Drawing through a canvas rather than handing `detect` the `<video>` element
   * costs one copy and buys two things: a frame small enough that the detector's
   * work does not scale with the camera's megapixels, and a source that is never
   * mid-load — passing a video whose first frame has not arrived is what makes
   * `detect` reject on Chromium for reasons that have nothing to do with the QR.
   *
   * Returns false until the camera has produced a frame, which is what the `live`
   * event waits on.
   */
  private drawFrame(): boolean {
    const video = this.video
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return false
    const sourceWidth = video.videoWidth
    const sourceHeight = video.videoHeight
    if (!sourceWidth || !sourceHeight) return false

    const scale = Math.min(1, DETECT_MAX_EDGE / Math.max(sourceWidth, sourceHeight))
    const width = Math.round(sourceWidth * scale)
    const height = Math.round(sourceHeight * scale)

    let canvas = this.canvas
    if (!canvas) {
      canvas = document.createElement('canvas')
      this.canvas = canvas
      this.context = canvas.getContext('2d', { willReadFrequently: true })
    }
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width
      canvas.height = height
    }

    const context = this.context
    if (!context) return false
    context.drawImage(video, 0, 0, width, height)
    return true
  }

  private fail(sentence: string): void {
    if (this.stopped) return
    this.onEvent({ kind: 'failed', sentence })
    this.stop()
  }
}

/**
 * Which of the camera's refusals this was.
 *
 * `getUserMedia` puts the whole answer in the exception's name, and the four that
 * matter want four different things from the user: change a site setting, plug
 * something in, quit whatever else is holding the lens, or read an error nobody
 * anticipated. One sentence for all of them would be the defect this product has
 * already paid for once.
 */
function cameraFailureSentence(error: unknown): string {
  const name = error instanceof DOMException ? error.name : ''
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return (
        'Camera permission was refused. The browser will not ask again until the ' +
        'permission is cleared for this site.'
      )
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
      return 'No camera on this device.'
    case 'NotReadableError':
    case 'TrackStartError':
      return 'Something else on this machine is holding the camera.'
    default:
      return name
        ? `The camera would not start: ${name}.`
        : 'The camera would not start, and the browser gave no reason.'
  }
}
