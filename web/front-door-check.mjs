/**
 * Checks that a host still answers while other connections sit idle.
 *
 * A phone's browser keeps its keep-alive connections open between requests, and a
 * phone that locks or leaves the network never closes them at all. The Mac host's
 * front door used to park two GCD threads on each one, and at 32 of them the pool
 * ran out: every connection after that was accepted and never answered, so the
 * next QR scan spun on the phone while the pairing steps on the Mac never ticked.
 *
 * This holds more idle connections than that, asks for one page, and lets them go.
 * No pairing code needed. Point it at a direct address, not the relay: the tunnel
 * does not carry one connection through to the host per connection opened here.
 *
 *     node web/front-door-check.mjs [idle connections, default 64]
 *     VIBEWIRE_ORIGIN=http://127.0.0.1:8797 node web/front-door-check.mjs 100
 */

import { connect } from 'node:net'

const ORIGIN = new URL(process.env.VIBEWIRE_ORIGIN ?? 'http://127.0.0.1:8787')
const IDLE = Number(process.argv[2] ?? 64)
const PORT = Number(ORIGIN.port || 80)

function open() {
  return new Promise((resolve, reject) => {
    const socket = connect(PORT, ORIGIN.hostname, () => resolve(socket))
    socket.once('error', reject)
  })
}

const held = []
for (let index = 0; index < IDLE; index++) held.push(await open())

const started = Date.now()
let status = null
try {
  // Any answer counts. The question is whether the host answers at all, and a
  // host with no web bundle answers this with a 404.
  const response = await fetch(`${ORIGIN.origin}/`, { signal: AbortSignal.timeout(5000) })
  status = response.status
} catch {
  // Left null: nothing came back in time.
}
const elapsed = Date.now() - started
for (const socket of held) socket.destroy()

if (status === null) {
  console.error(`FAIL: no answer in ${elapsed} ms with ${IDLE} idle connections open`)
  process.exit(1)
}
console.log(`ok: ${status} in ${elapsed} ms with ${IDLE} idle connections open`)
