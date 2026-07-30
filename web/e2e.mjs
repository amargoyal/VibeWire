/**
 * End-to-end check of the two host changes the web client needs:
 *   1. the query-string spelling of the socket challenge-response
 *   2. the built web bundle served off the same port
 *
 * Plus the failure paths that matter: a forged signature, a reused nonce, and path
 * traversal against the static server.
 *
 * Speaks the wire protocol the way a browser has to — raw Ed25519 keys, credentials
 * in the query string, one WebSocket — so a pass here means a browser will work,
 * without needing a browser to find out.
 *
 * Run it against a host that is showing a pairing code:
 *
 *     cd host && swift build
 *     (cd ../web && npm ci && npm run build)
 *     ./.build/debug/VibeWireHost --pair          # prints a six-digit code
 *     node ../web/e2e.mjs <code>
 *
 * Without a code it stops after the checks that need no pairing, which is still the
 * whole static-serving and rejection surface. `VIBEWIRE_ORIGIN` points it somewhere
 * other than 127.0.0.1:8787 — a tailnet name, or the Cloudflare tunnel.
 *
 * Note: the host reads device trust from the login keychain, and a freshly rebuilt
 * binary has a new signature, so the first run after a build raises a SecurityAgent
 * prompt. Choose "Always Allow" or the pairing half of this script will fail with
 * `bad_code` while the log says `keychain did not respond`.
 */

import { generateKeyPairSync, sign as nodeSign } from 'node:crypto'
import { connect } from 'node:net'

const ORIGIN = process.env.VIBEWIRE_ORIGIN ?? 'http://127.0.0.1:8787'
const CODE = process.argv[2]

let failures = 0
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures += 1
}

// ── keys ────────────────────────────────────────────────────────────────────
const { publicKey, privateKey } = generateKeyPairSync('ed25519')
// SPKI DER for Ed25519 is a 12-byte prefix then the 32-byte raw key.
const rawPublic = publicKey.export({ type: 'spki', format: 'der' }).subarray(12)
const publicKeyBase64 = rawPublic.toString('base64')

const signNonce = (nonceBase64) => {
  const payload = Buffer.concat([
    Buffer.from('vibewire-auth-v1', 'utf8'),
    Buffer.from(nonceBase64, 'base64'),
  ])
  return nodeSign(null, payload, privateKey).toString('base64')
}

// ── 1. health ───────────────────────────────────────────────────────────────
{
  const response = await fetch(`${ORIGIN}/v1/health`)
  const body = await response.json()
  check('GET /v1/health', response.status === 200 && body.ok === true && body.protocol === 1,
    JSON.stringify(body))
}

// ── 2. static bundle ────────────────────────────────────────────────────────
let assetPath = null
{
  const response = await fetch(`${ORIGIN}/`)
  const html = await response.text()
  const type = response.headers.get('content-type') ?? ''
  const csp = response.headers.get('content-security-policy') ?? ''
  check('GET / serves index.html',
    response.status === 200 && type.startsWith('text/html') && html.includes('<div id="root">'),
    `${response.status} ${type}`)
  check('GET / is uncacheable', (response.headers.get('cache-control') ?? '').includes('no-store'))
  check('GET / carries a CSP', csp.includes("script-src 'self'"), csp.slice(0, 40) + '…')

  const match = /src="([^"]*assets\/[^"]+\.js)"/.exec(html)
  assetPath = match?.[1]?.replace(/^\.?\//, '')
  check('index.html references a hashed script', Boolean(assetPath), String(assetPath))
}

if (assetPath) {
  const response = await fetch(`${ORIGIN}/${assetPath}`)
  const body = await response.arrayBuffer()
  check('GET the hashed script',
    response.status === 200 &&
      (response.headers.get('content-type') ?? '').startsWith('text/javascript') &&
      body.byteLength > 10_000,
    `${response.status} ${body.byteLength}B`)
  check('hashed asset is immutable',
    (response.headers.get('cache-control') ?? '').includes('immutable'))
}

// ── 3. traversal is refused ─────────────────────────────────────────────────
//
// Sent over a raw socket on purpose: `fetch` normalises `/../x` to `/x` before the
// request leaves, so going through it would test the client and not the host.
const rawGet = (target) =>
  new Promise((resolve, reject) => {
    const url = new URL(ORIGIN)
    const socket = connect({ host: url.hostname, port: Number(url.port || 80) }, () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: ${url.host}\r\nConnection: close\r\n\r\n`)
    })
    let text = ''
    let settle = null
    // The host answers every request with `Connection: keep-alive` regardless of
    // what was asked for, so waiting for `end` waits forever. Take whatever arrived
    // and stop.
    socket.setTimeout(4000, () => { socket.destroy(); reject(new Error('timeout')) })
    socket.on('data', (chunk) => {
      text += chunk.toString('latin1')
      if (settle) clearTimeout(settle)
      settle = setTimeout(() => { socket.destroy(); resolve(text) }, 250)
    })
    socket.on('end', () => resolve(text))
    socket.on('error', reject)
  })

for (const attempt of [
  '/../Package.swift',
  '/assets/../../Package.swift',
  '/../../../etc/passwd',
  '/%2e%2e/Package.swift',
  '/..%2fPackage.swift',
  '/./../host/Package.swift',
]) {
  const raw = await rawGet(attempt)
  const status = /^HTTP\/1\.1 (\d+)/.exec(raw)?.[1] ?? '???'
  const leaked = raw.includes('swift-tools-version') || raw.includes('root:*:0:0')
  check(`raw GET ${attempt} leaks nothing`, !leaked, `status ${status}`)
}

// ── 4. /v1/verify rejects a signature it never issued a nonce for ───────────
{
  const response = await fetch(
    `${ORIGIN}/v1/verify?device=00000000-0000-0000-0000-000000000000` +
      `&nonce=${encodeURIComponent(Buffer.alloc(32).toString('base64'))}` +
      `&sig=${encodeURIComponent(Buffer.alloc(64).toString('base64'))}`,
  )
  check('GET /v1/verify with a forged nonce → 401', response.status === 401, String(response.status))
}

// ── 5. pairing ──────────────────────────────────────────────────────────────
if (!CODE) {
  console.log('\nno pairing code given; stopping after the unauthenticated checks')
  process.exit(failures ? 1 : 0)
}

let deviceId = null
{
  const response = await fetch(`${ORIGIN}/v1/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      code: CODE,
      deviceName: 'E2E harness (web spelling)',
      deviceKind: 'browser',
      publicKey: publicKeyBase64,
    }),
  })
  const body = await response.json()
  deviceId = body.deviceId
  check('POST /v1/pair', response.status === 200 && typeof deviceId === 'string',
    `${response.status} ${JSON.stringify(body).slice(0, 120)}`)
}

if (!deviceId) process.exit(1)

const challenge = async () => {
  const response = await fetch(`${ORIGIN}/v1/challenge?deviceId=${encodeURIComponent(deviceId)}`)
  const body = await response.json()
  return body.nonce
}

// ── 6. /v1/verify accepts the real thing, in the query string ───────────────
{
  const nonce = await challenge()
  const sig = signNonce(nonce)
  // The signature is standard base64 and will contain + / = — the whole point of
  // this check is that percent-encoding survives the host's query parser.
  check('signature exercises the base64 alphabet', /[+/=]/.test(sig), sig.slice(-8))
  const response = await fetch(
    `${ORIGIN}/v1/verify?device=${encodeURIComponent(deviceId)}` +
      `&nonce=${encodeURIComponent(nonce)}&sig=${encodeURIComponent(sig)}`,
  )
  const body = await response.json().catch(() => ({}))
  check('GET /v1/verify with a real signature → 200',
    response.status === 200 && body.deviceId === deviceId,
    `${response.status} ${JSON.stringify(body)}`)
}

// ── 7. nonces are single use ────────────────────────────────────────────────
{
  const nonce = await challenge()
  const sig = signNonce(nonce)
  const query =
    `device=${encodeURIComponent(deviceId)}&nonce=${encodeURIComponent(nonce)}` +
    `&sig=${encodeURIComponent(sig)}`
  const first = await fetch(`${ORIGIN}/v1/verify?${query}`)
  const second = await fetch(`${ORIGIN}/v1/verify?${query}`)
  check('a nonce is burned after one use',
    first.status === 200 && second.status === 401,
    `${first.status} then ${second.status}`)
}

// ── 8. the socket, opened the way a browser has to ──────────────────────────
{
  const nonce = await challenge()
  const sig = signNonce(nonce)
  const url =
    `${ORIGIN.replace(/^http/, 'ws')}/v1/socket?device=${encodeURIComponent(deviceId)}` +
    `&nonce=${encodeURIComponent(nonce)}&sig=${encodeURIComponent(sig)}`

  const result = await new Promise((resolve) => {
    const socket = new WebSocket(url)
    socket.binaryType = 'arraybuffer'
    const seen = { hello: false, pong: false, status: false, settings: false, binary: 0 }
    const finish = (error) => {
      try { socket.close() } catch { /* already closing */ }
      resolve({ ...seen, error })
    }
    const timer = setTimeout(() => finish('timed out waiting for hello and pong'), 8000)

    socket.onopen = () => {
      socket.send(JSON.stringify({ t: 'ping', tMicros: 1_000_000, seq: 1 }))
    }
    socket.onmessage = (event) => {
      if (typeof event.data !== 'string') { seen.binary += 1; return }
      const message = JSON.parse(event.data)
      if (message.t === 'hello') seen.hello = true
      if (message.t === 'pong') seen.pong = message.tMicros === 1_000_000
      if (message.t === 'status') seen.status = true
      if (message.t === 'settings') seen.settings = true
      if (seen.hello && seen.pong && seen.status && seen.settings) {
        clearTimeout(timer)
        finish(null)
      }
    }
    socket.onerror = () => { clearTimeout(timer); finish('socket error — upgrade refused') }
    socket.onclose = (event) => {
      clearTimeout(timer)
      if (!seen.hello) finish(`closed before hello (code ${event.code})`)
    }
  })

  check('WS upgrade with query-string credentials', result.hello, result.error ?? '')
  check('host → hello', result.hello)
  check('host → status', result.status)
  check('host → settings', result.settings)
  check('ping/pong round trip', result.pong)
}

// ── 9. a bad signature does not get a socket ────────────────────────────────
{
  const nonce = await challenge()
  const forged = Buffer.alloc(64, 7).toString('base64')
  const url =
    `${ORIGIN.replace(/^http/, 'ws')}/v1/socket?device=${encodeURIComponent(deviceId)}` +
    `&nonce=${encodeURIComponent(nonce)}&sig=${encodeURIComponent(forged)}`
  const refused = await new Promise((resolve) => {
    const socket = new WebSocket(url)
    const timer = setTimeout(() => { try { socket.close() } catch {} ; resolve(false) }, 5000)
    socket.onopen = () => { clearTimeout(timer); try { socket.close() } catch {} ; resolve(false) }
    socket.onerror = () => { clearTimeout(timer); resolve(true) }
    socket.onclose = () => { clearTimeout(timer); resolve(true) }
  })
  check('WS upgrade with a forged signature refused', refused)
}

// This run left a real trust record on the Mac. Say so, with the name to look for,
// rather than leaving a mystery device in Settings → PAIRED.
console.log(`\nPaired a device for this run: ${deviceId}`)
console.log('Revoke it in Settings → PAIRED → "E2E harness (web spelling)".')
console.log(failures ? `\n${failures} check(s) failed` : '\nall checks passed')
process.exit(failures ? 1 : 0)
