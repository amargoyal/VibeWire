/**
 * Pairs with a host and sends JSON messages from the command line, printing
 * everything that comes back for a few seconds. For poking at one message
 * type without a phone.
 *
 *     VIBEWIRE_ORIGIN=http://127.0.0.1:8797 node scripts/socket.mjs <code> '{"t":"claude","sub":"listSessions"}' [seconds]
 */
import { generateKeyPairSync, sign as nodeSign } from 'node:crypto'

const ORIGIN = process.env.VIBEWIRE_ORIGIN ?? 'http://127.0.0.1:8797'
const [CODE, MESSAGE, SECONDS = '4'] = process.argv.slice(2)
if (!CODE || !MESSAGE) {
  console.error('usage: socket.mjs <code> <json message> [seconds]')
  process.exit(2)
}
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
const rawPublic = publicKey.export({ type: 'spki', format: 'der' }).subarray(12)
const paired = await (await fetch(`${ORIGIN}/v1/pair`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ code: CODE, deviceName: 'socket.mjs', deviceKind: 'browser', publicKey: rawPublic.toString('base64') }),
})).json()
if (!paired.deviceId) { console.error('pair failed', paired); process.exit(1) }
const nonce = (await (await fetch(`${ORIGIN}/v1/challenge?deviceId=${paired.deviceId}`)).json()).nonce
const sig = nodeSign(null, Buffer.concat([Buffer.from('vibewire-auth-v1'), Buffer.from(nonce, 'base64')]), privateKey).toString('base64')
const ws = new WebSocket(`${ORIGIN.replace(/^http/, 'ws')}/v1/socket?device=${encodeURIComponent(paired.deviceId)}&nonce=${encodeURIComponent(nonce)}&sig=${encodeURIComponent(sig)}`)
ws.binaryType = 'arraybuffer'
ws.onopen = () => { ws.send(MESSAGE); setTimeout(() => { ws.close(); process.exit(0) }, Number(SECONDS) * 1000) }
ws.onmessage = (event) => {
  if (typeof event.data !== 'string') { console.log(`<binary ${event.data.byteLength} bytes>`); return }
  const text = event.data.length > 600 ? event.data.slice(0, 600) + '…' : event.data
  console.log(text)
}
ws.onerror = () => { console.error('socket error'); process.exit(1) }
