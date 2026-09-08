/**
 * Asks a host for a picture the way the browser client does, and reports what
 * came back: frames per second, keyframes, parameter sets, sizes, and the
 * videoConfig the host claimed. No decoder — this checks the bytes and the
 * flags, which is what a phone that will not draw is usually wrong about.
 *
 *     node scripts/stream-check.mjs <code> [seconds]
 *     VIBEWIRE_ORIGIN=http://127.0.0.1:8797 node scripts/stream-check.mjs 123456 8
 */
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto'

const ORIGIN = process.env.VIBEWIRE_ORIGIN ?? 'http://127.0.0.1:8797'
const CODE = process.argv[2]
const SECONDS = Number(process.argv[3] ?? 6)
if (!CODE) {
  console.error('usage: stream-check.mjs <pairing code> [seconds]')
  process.exit(2)
}

const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const rawPublic = publicKey.export({ type: 'spki', format: 'der' }).subarray(12)
const pair = await fetch(`${ORIGIN}/v1/pair`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code: CODE, deviceName: 'stream-check', deviceKind: 'browser', publicKey: rawPublic.toString('base64') }),
})
const paired = await pair.json()
if (!paired.deviceId) {
  console.error('pair failed', pair.status, paired)
  process.exit(1)
}
const nonce = (await (await fetch(`${ORIGIN}/v1/challenge?deviceId=${paired.deviceId}`)).json()).nonce
const sig = nodeSign(null, Buffer.concat([Buffer.from('vibewire-auth-v1'), Buffer.from(nonce, 'base64')]), privateKey).toString('base64')
const url = `${ORIGIN.replace(/^http/, 'ws')}/v1/socket?device=${encodeURIComponent(paired.deviceId)}&nonce=${encodeURIComponent(nonce)}&sig=${encodeURIComponent(sig)}`

const ws = new WebSocket(url)
ws.binaryType = 'arraybuffer'
const stats = { frames: 0, keyframes: 0, bytes: 0, spsOnKeys: 0, badMagic: 0, firstKey: null, resolutionChanged: 0, streams: new Set(), firstSize: null }
const seen = []
let displays = []
let startedAt = null

const nalTypes = (bytes) => {
  const types = []
  for (let i = 0; i + 3 < bytes.length && types.length < 6; i += 1) {
    if (bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 1) types.push(bytes[i + 3] & 0x1f)
  }
  return types
}

ws.onopen = () => ws.send(JSON.stringify({ t: 'ping', tMicros: 1, seq: 1 }))
ws.onmessage = (event) => {
  if (typeof event.data === 'string') {
    const message = JSON.parse(event.data)
    if (['hello', 'displays', 'videoConfig', 'streamState', 'error'].includes(message.t)) seen.push(message)
    if (message.t === 'displays') {
      displays = message.displays
      if (!startedAt) {
        const main = displays.find((d) => d.isMain) ?? displays[0]
        console.log('displays:', displays.map((d) => `${d.id} ${d.name} ${d.width}x${d.height}@${d.hz}`).join(' | '))
        ws.send(JSON.stringify({ t: 'startStream', displayIds: main ? [main.id] : [] }))
        startedAt = Date.now()
        setTimeout(finish, SECONDS * 1000)
      }
    }
    if (message.t === 'videoConfig') console.log('videoConfig:', JSON.stringify(message))
    if (message.t === 'streamState') console.log('streamState:', message.state, message.reason ?? '')
    if (message.t === 'error') console.log('error:', message.code, message.message)
    return
  }
  const view = new DataView(event.data)
  if (view.getUint8(0) !== 0xb1) { stats.badMagic += 1; return }
  const flags = view.getUint8(1)
  const bytes = new Uint8Array(event.data, 20)
  stats.frames += 1
  stats.bytes += event.data.byteLength
  stats.streams.add(view.getUint16(2))
  if (flags & 1) {
    stats.keyframes += 1
    const types = nalTypes(bytes)
    if (types.includes(7) && types.includes(8)) stats.spsOnKeys += 1
    if (stats.firstKey === null) {
      stats.firstKey = stats.frames
      const sps = (() => { for (let i = 0; i + 3 < bytes.length; i += 1) if (bytes[i] === 0 && bytes[i+1] === 0 && bytes[i+2] === 1 && (bytes[i+3] & 0x1f) === 7) return bytes.subarray(i + 3, i + 7); return null })()
      console.log('first keyframe at frame', stats.frames, 'nal types', types.join(','), 'codec', sps ? `avc1.${[1,2,3].map((k) => sps[k].toString(16).padStart(2, '0')).join('')}` : '?')
    }
  }
  if (flags & 4) stats.resolutionChanged += 1
}
ws.onclose = (event) => { console.log('closed', event.code); }
ws.onerror = () => { console.error('socket error'); process.exit(1) }

function finish() {
  const seconds = (Date.now() - startedAt) / 1000
  console.log(`\n${stats.frames} frames in ${seconds.toFixed(1)}s = ${(stats.frames / seconds).toFixed(1)} fps, ${(stats.bytes * 8 / seconds / 1e6).toFixed(2)} Mbps`)
  console.log(`keyframes ${stats.keyframes} (${stats.spsOnKeys} carried SPS+PPS), first key was frame ${stats.firstKey}, resolutionChanged ${stats.resolutionChanged}, streams ${[...stats.streams].join(',')}, bad magic ${stats.badMagic}`)
  const ok = stats.frames > 0 && stats.firstKey === 1 && stats.spsOnKeys === stats.keyframes && stats.badMagic === 0
  console.log(ok ? 'STREAM OK' : 'STREAM NOT OK')
  ws.send(JSON.stringify({ t: 'stopStream' }))
  setTimeout(() => { ws.close(); process.exit(ok ? 0 : 1) }, 300)
}
