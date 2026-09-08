/**
 * The ladder behind the AUTO / 1080 / 720 / 540 control on 07A, and behind
 * "WILL OPEN AT 540P" on the weak-link home screen. Ported verbatim from
 * `ScreenStream.Quality.forLink` so both hosts pick the same step.
 */
export interface Quality {
  maxHeight: number
  fps: number
  bitrate: number
}

export function qualityForLink(
  maxHeight: number | null,
  rttMillis: number,
  lossPercent: number,
  capMbps: number | null,
): Quality {
  let height: number
  if (maxHeight !== null) height = maxHeight
  else if (rttMillis > 250 || lossPercent > 3) height = 540
  else if (rttMillis > 120 || lossPercent > 1) height = 720
  else height = 1080

  const fps = height <= 540 ? 30 : 60

  // Rough but honest: enough for text to stay readable at each step.
  let bitrate: number
  if (height <= 540) bitrate = 1_500_000
  else if (height <= 720) bitrate = 3_000_000
  else bitrate = 6_000_000
  if (capMbps !== null) bitrate = Math.min(bitrate, Math.round(capMbps * 1_000_000))

  return { maxHeight: height, fps, bitrate }
}

/** The encoded size for a source, capped at `maxHeight` and rounded to even
 *  dimensions — H.264 wants them, and rounding to 2 avoids chroma artifacts. */
export function fit(sourceWidth: number, sourceHeight: number, maxHeight: number): { width: number; height: number } {
  if (sourceHeight <= 0) return { width: 1280, height: 720 }
  const scale = Math.min(1, maxHeight / sourceHeight)
  const width = Math.max(2, Math.round((sourceWidth * scale) / 2) * 2)
  const height = Math.max(2, Math.round((sourceHeight * scale) / 2) * 2)
  return { width, height }
}

/** The `avc1.PPCCLL` string to ask the encoder for: High profile, level from
 *  the frame size and rate, which is what the Mac's VideoToolbox picks. */
export function avcCodecFor(width: number, height: number, fps: number): string {
  const macroblocks = Math.ceil(width / 16) * Math.ceil(height / 16)
  const rate = macroblocks * fps
  // Level 4.0 carries 1080p30 (245760 MB/s); 4.2 carries 1080p60 (522240).
  const level = rate > 245_760 ? '2a' : rate > 108_000 ? '28' : '1f'
  return `avc1.6400${level}`
}
