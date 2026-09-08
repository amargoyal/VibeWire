/**
 * One binary frame on the socket, both directions of the codec, from the header
 * in PROTOCOL.md §2.1.
 *
 *  0        1        2        4                 8                 12
 *  +--------+--------+--------+-----------------+-----------------+----------
 *  | magic  | flags  | stream |  sequence (u32) |  ptsMicros(u64) | payload
 *  | 0xB1   |        |  (u16) |                 |                 | (Annex-B)
 *  +--------+--------+--------+-----------------+-----------------+----------
 *
 * Big-endian throughout, four reserved bytes after the timestamp so the payload
 * starts 4-byte aligned. Shared by the browser client (which only parses) and
 * the Electron host (which only encodes), so the two cannot disagree by a byte.
 */

import {
  FLAG_KEYFRAME,
  FLAG_PARAMETER_SETS,
  FLAG_RESOLUTION_CHANGED,
  VIDEO_HEADER_SIZE,
  VIDEO_MAGIC,
} from './protocol'

export interface VideoFrameHeader {
  streamId: number
  sequence: number
  ptsMicros: number
  isKeyframe: boolean
  carriesParameterSets: boolean
  resolutionChanged: boolean
  /** H.264 Annex-B, start codes intact. */
  payload: Uint8Array
}

export function parseVideoFrame(buffer: ArrayBuffer): VideoFrameHeader | null {
  if (buffer.byteLength <= VIDEO_HEADER_SIZE) return null
  const view = new DataView(buffer)
  if (view.getUint8(0) !== VIDEO_MAGIC) return null

  const flags = view.getUint8(1)
  // The presentation stamp is microseconds since the host started capturing, so
  // it outgrows 2^53 after about 285 years of uptime. `Number` is the right type
  // for it and `getBigUint64` would only add a conversion at every call site.
  const ptsMicros = view.getUint32(8) * 4294967296 + view.getUint32(12)

  return {
    streamId: view.getUint16(2),
    sequence: view.getUint32(4),
    ptsMicros,
    isKeyframe: (flags & FLAG_KEYFRAME) !== 0,
    carriesParameterSets: (flags & FLAG_PARAMETER_SETS) !== 0,
    resolutionChanged: (flags & FLAG_RESOLUTION_CHANGED) !== 0,
    payload: new Uint8Array(buffer, VIDEO_HEADER_SIZE),
  }
}

export interface FrameFields {
  streamId: number
  sequence: number
  ptsMicros: number
  keyframe: boolean
  parameterSets: boolean
  resolutionChanged: boolean
}

/** The 20-byte header alone. */
export function encodeFrameHeader(fields: FrameFields): Uint8Array {
  const header = new Uint8Array(VIDEO_HEADER_SIZE)
  const view = new DataView(header.buffer)
  let flags = 0
  if (fields.keyframe) flags |= FLAG_KEYFRAME
  if (fields.parameterSets) flags |= FLAG_PARAMETER_SETS
  if (fields.resolutionChanged) flags |= FLAG_RESOLUTION_CHANGED
  view.setUint8(0, VIDEO_MAGIC)
  view.setUint8(1, flags)
  view.setUint16(2, fields.streamId & 0xffff)
  view.setUint32(4, fields.sequence >>> 0)
  view.setUint32(8, Math.floor(fields.ptsMicros / 4294967296) >>> 0)
  view.setUint32(12, fields.ptsMicros % 4294967296 >>> 0)
  view.setUint32(16, 0)
  return header
}

/** Header plus payload in one allocation, ready for the socket. */
export function encodeVideoFrame(fields: FrameFields, payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(VIDEO_HEADER_SIZE + payload.byteLength)
  out.set(encodeFrameHeader(fields), 0)
  out.set(payload, VIDEO_HEADER_SIZE)
  return out
}

/**
 * Splits an Annex-B buffer into its NAL units.
 *
 * Written as a scan for 3- and 4-byte start codes rather than a naive split,
 * because the byte pattern can legitimately appear inside a payload only when
 * preceded by the emulation-prevention byte the encoder inserts — so scanning
 * start codes in order is both correct and cheap.
 *
 * The returned views alias the input rather than copying it: this runs per frame
 * at 60fps and the only consumer reads a handful of bytes off the front.
 */
export function nalUnits(data: Uint8Array): Uint8Array[] {
  const units: Uint8Array[] = []
  let index = 0
  let unitStart = -1

  const startCodeLength = (position: number): number => {
    if (
      position + 3 < data.length &&
      data[position] === 0 &&
      data[position + 1] === 0 &&
      data[position + 2] === 0 &&
      data[position + 3] === 1
    ) {
      return 4
    }
    if (
      position + 2 < data.length &&
      data[position] === 0 &&
      data[position + 1] === 0 &&
      data[position + 2] === 1
    ) {
      return 3
    }
    return 0
  }

  while (index < data.length) {
    const length = startCodeLength(index)
    if (length) {
      if (unitStart >= 0 && unitStart < index) units.push(data.subarray(unitStart, index))
      index += length
      unitStart = index
    } else {
      index += 1
    }
  }

  if (unitStart >= 0 && unitStart < data.length) units.push(data.subarray(unitStart))
  return units
}

/** NAL unit type lives in the low 5 bits of the first byte. */
export function nalType(unit: Uint8Array): number {
  return unit.length ? unit[0] & 0x1f : 0
}

export const NAL_SPS = 7
export const NAL_PPS = 8
export const NAL_IDR = 5

/**
 * The codec string `VideoDecoder.configure` needs, built from the SPS itself.
 *
 * `avc1.PPCCLL` — profile_idc, the constraint-set byte, level_idc, each two hex
 * digits. Guessing a common value instead (`avc1.42E01E`, baseline 3.0) is the
 * kind of thing that works on every clip you test with and then rejects the one
 * the host actually produces: the host's encoder is asked for High and picks its
 * own level from the frame size, so the three bytes are only knowable from the
 * stream.
 */
export function avcCodecString(sps: Uint8Array): string | null {
  // [0] is the NAL header — the start code is already stripped by `nalUnits`.
  if (sps.length < 4) return null
  const hex = (byte: number) => byte.toString(16).padStart(2, '0')
  return `avc1.${hex(sps[1])}${hex(sps[2])}${hex(sps[3])}`
}

/** Byte-for-byte equality, for spotting genuinely new parameter sets. */
export function sameBytes(a: Uint8Array | null, b: Uint8Array | null): boolean {
  if (!a || !b) return a === b
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false
  }
  return true
}
