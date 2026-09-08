import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeVideoFrame, nalType, nalUnits, parseVideoFrame } from '../../shared/frame'

test('a frame survives the round trip through the header', () => {
  const payload = new Uint8Array([0, 0, 0, 1, 0x67, 1, 2, 0, 0, 0, 1, 0x68, 3, 0, 0, 1, 0x65, 9, 9])
  const framed = encodeVideoFrame(
    { streamId: 1, sequence: 123456, ptsMicros: 5_000_000_123, keyframe: true, parameterSets: true, resolutionChanged: false },
    payload,
  )
  const parsed = parseVideoFrame(framed.buffer.slice(framed.byteOffset, framed.byteOffset + framed.byteLength) as ArrayBuffer)!
  assert.equal(parsed.streamId, 1)
  assert.equal(parsed.sequence, 123456)
  assert.equal(parsed.ptsMicros, 5_000_000_123)
  assert.equal(parsed.isKeyframe, true)
  assert.equal(parsed.carriesParameterSets, true)
  assert.equal(parsed.resolutionChanged, false)
  assert.deepEqual([...parsed.payload], [...payload])
  const units = nalUnits(parsed.payload)
  assert.deepEqual(units.map(nalType), [7, 8, 5])
})

test('a frame with the wrong magic is not a frame', () => {
  const bad = new Uint8Array(40)
  bad[0] = 0x00
  assert.equal(parseVideoFrame(bad.buffer as ArrayBuffer), null)
})
