import test from 'node:test'
import assert from 'node:assert/strict'
import { build } from '../../node_modules/esbuild/lib/main.js'

const { outputFiles } = await build({
  entryPoints: ['web/src/net/account.ts'], bundle: true, write: false,
  platform: 'node', format: 'esm', define: { 'import.meta.env': '{}' },
})
const account = await import(`data:text/javascript;base64,${Buffer.from(outputFiles[0].text).toString('base64')}`)
globalThis.location = { origin: 'http://localhost', pathname: '/dashboard/secret-launch-key/' }

test('email sign-in uses the safe redirect and creates new accounts', async () => {
  globalThis.fetch = async (url, init) => {
    assert.equal(new URL(url).searchParams.get('redirect_to'), 'https://amargoyal.github.io/VibeWire/')
    assert.equal(String(url).includes('secret-launch-key'), false)
    assert.equal(JSON.parse(init.body).create_user, true)
    assert.ok(init.signal)
    return new Response('{}')
  }
  await account.sendEmailCode('test@example.com', 'https://amargoyal.github.io/VibeWire/')
})

test('invalid codes never create a session', async () => {
  globalThis.fetch = async () => new Response('{"msg":"Invalid code"}', { status: 403 })
  await assert.rejects(account.verifyEmailCode('test@example.com', '000000'))
  assert.equal(account.session(), null)
})

test('verified email codes produce the token the Mac must verify', async () => {
  globalThis.fetch = async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body), { type: 'email', email: 'test@example.com', token: '123456' })
    return Response.json({ access_token: 'verified-token', refresh_token: 'refresh-token',
      expires_in: 3600, user: { id: 'test-user', email: 'test@example.com' } })
  }
  const result = await account.verifyEmailCode('test@example.com', '123456')
  assert.equal(result.accessToken, 'verified-token')
  assert.equal(result.user.email, 'test@example.com')
})
