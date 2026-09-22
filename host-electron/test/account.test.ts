import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AccountVerifier } from '../src/main/pairing/accountVerifier'
import { Config } from '../src/main/core/config'
import { decodeInbound } from '../src/main/net/wireProtocol'

function configure(env: NodeJS.ProcessEnv = {}): void {
  Config.init({
    configDir: process.env.TMPDIR ?? '/tmp',
    checkoutRoot: null,
    resourcesPath: null,
    argv: [],
    env,
    version: '0.0.0-test',
  })
}

/** Replaces `fetch` for one test and puts the real one back afterwards. */
function withFetch(stub: typeof fetch, body: () => Promise<void>): Promise<void> {
  const real = globalThis.fetch
  globalThis.fetch = stub
  return body().finally(() => {
    globalThis.fetch = real
  })
}

function answer(status: number, payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('an account token arrives as its own message', () => {
  const { message } = decodeInbound(JSON.stringify({ t: 'account', token: 'abc' }))
  assert.equal(message.t, 'account')
  assert.equal(message.t === 'account' ? message.token : null, 'abc')
})

test('a message claiming to be an account without a token is refused', () => {
  assert.throws(() => decodeInbound(JSON.stringify({ t: 'account' })))
})

test('a confirmed token names its account, and is asked for only once', async () => {
  configure()
  let calls = 0
  await withFetch(
    async () => {
      calls += 1
      return answer(200, { id: 'user-1', email: 'someone@example.com' })
    },
    async () => {
      const verifier = new AccountVerifier()
      assert.deepEqual(await verifier.verify('token'), {
        id: 'user-1',
        email: 'someone@example.com',
      })
      // The second ask inside the cache window must not reach the network.
      assert.deepEqual(await verifier.verify('token'), {
        id: 'user-1',
        email: 'someone@example.com',
      })
      assert.equal(calls, 1)
    },
  )
})

test('a refused token is nobody, and is not remembered as an answer', async () => {
  configure()
  let calls = 0
  await withFetch(
    async () => {
      calls += 1
      return answer(401, { message: 'invalid claim' })
    },
    async () => {
      const verifier = new AccountVerifier()
      assert.equal(await verifier.verify('token'), null)
      assert.equal(await verifier.verify('token'), null)
      assert.equal(calls, 2)
    },
  )
})

test('an account server that cannot be reached is a refusal, not a pass', async () => {
  configure()
  await withFetch(
    async () => {
      throw new Error('offline')
    },
    async () => {
      assert.equal(await new AccountVerifier().verify('token'), null)
    },
  )
})

test('a build with no account server checks nothing', async () => {
  configure({ VIBEWIRE_ACCOUNT_URL: '', VIBEWIRE_ACCOUNT_KEY: '' })
  assert.equal(Config.accountsAvailable, false)
  await withFetch(
    async () => {
      throw new Error('nothing should be fetched')
    },
    async () => {
      assert.equal(await new AccountVerifier().verify('token'), null)
    },
  )
  configure()
})
