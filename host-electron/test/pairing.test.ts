import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generateSeed, publicKeyFromSeed, signMessage } from '../src/main/pairing/ed25519'
import { PairError, PairingService } from '../src/main/pairing/pairingService'
import { MemoryStore } from '../src/main/pairing/secretStore'
import { TrustStore } from '../src/main/pairing/trustStore'
import { AUTH_CONTEXT } from '../../shared/protocol'

function harness() {
  let now = 1_000_000
  const clock = { now: () => now, advance: (ms: number) => (now += ms) }
  const trust = new TrustStore(new MemoryStore())
  const pairing = new PairingService(trust, { hostName: () => 'Test Host', now: clock.now })
  return { clock, trust, pairing }
}

test('no code is entertained while the window is closed', async () => {
  const { pairing } = harness()
  await assert.rejects(pairing.pair('000000', 'x', 'phone', publicKeyFromSeed(generateSeed())), (error: PairError) =>
    error.reason === 'notPairing',
  )
})

test('five wrong codes lock the host out for a minute', async () => {
  const { pairing, clock } = harness()
  const code = pairing.beginPairing()
  const wrong = code.value === '111111' ? '222222' : '111111'
  const key = publicKeyFromSeed(generateSeed())
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    await assert.rejects(pairing.pair(wrong, 'x', 'phone', key), (error: PairError) => error.reason === 'badCode')
  }
  await assert.rejects(pairing.pair(wrong, 'x', 'phone', key), (error: PairError) => error.reason === 'lockedOut')
  await assert.rejects(pairing.pair(code.value, 'x', 'phone', key), (error: PairError) => error.reason === 'lockedOut')
  assert.equal(pairing.lockoutRemaining, 60)
  clock.advance(61_000)
  assert.equal(pairing.lockoutRemaining, null)
})

test('a code expires after sixty seconds and rotates on the tick', async () => {
  const { pairing, clock } = harness()
  const first = pairing.beginPairing()
  clock.advance(60_001)
  assert.equal(pairing.currentCode(), null)
  await assert.rejects(pairing.pair(first.value, 'x', 'phone', publicKeyFromSeed(generateSeed())), (error: PairError) =>
    error.reason === 'codeExpired',
  )
  pairing.rotateIfNeeded()
  assert.ok(pairing.currentCode())
})

test('a right code stores trust, spends the window, and the device can then sign in once per nonce', async () => {
  const { pairing, trust } = harness()
  const code = pairing.beginPairing()
  const seed = generateSeed()
  const result = await pairing.pair(code.value, 'E2E', 'browser', publicKeyFromSeed(seed))
  assert.equal(result.hostName, 'Test Host')
  assert.equal(pairing.isPairing, false)
  assert.equal((await trust.all()).length, 1)

  const nonce = pairing.issueNonce()
  const payload = Buffer.concat([Buffer.from(AUTH_CONTEXT), Buffer.from(nonce, 'base64')])
  const signature = signMessage(seed, payload)
  assert.ok(await pairing.verify(result.device.id, nonce, signature))
  assert.equal(await pairing.verify(result.device.id, nonce, signature), null, 'nonce is single use')

  const forged = Buffer.alloc(64, 7)
  const fresh = pairing.issueNonce()
  assert.equal(await pairing.verify(result.device.id, fresh, forged), null)
})

test('a malformed public key is refused after the code was accepted', async () => {
  const { pairing } = harness()
  const code = pairing.beginPairing()
  await assert.rejects(pairing.pair(code.value, 'x', 'phone', Buffer.alloc(31)), (error: PairError) =>
    error.reason === 'badPublicKey',
  )
  assert.equal(pairing.currentProgress().codeAcceptedAt !== null, true)
})
