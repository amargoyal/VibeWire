/**
 * A stand-in for the account server, for checks that need a signed-in browser
 * without a real inbox or a real Google account.
 *
 * It answers the three things the host and the client ask of it: who a token
 * belongs to, an email code, and the code's verification. Any token that starts
 * with `test-` is a user whose id and email are derived from it, so `test-owner`
 * and `test-other` are two different accounts. Everything else is refused.
 *
 * Every answer waits a little first, because the real server is a network round
 * trip away and the bug this exists to catch only happens inside that wait.
 *
 *     node host/Tools/fake-account-server.mjs [port, default 9955] [delay ms, default 300]
 *
 * Point the host at it with VIBEWIRE_ACCOUNT_URL, and a web build with
 * VITE_SUPABASE_URL.
 */

import { createServer } from 'node:http'

const PORT = Number(process.argv[2] ?? 9955)
const DELAY = Number(process.argv[3] ?? 300)

function user(token) {
  if (!token?.startsWith('test-')) return null
  const name = token.slice('test-'.length)
  return { id: `00000000-0000-4000-8000-${Buffer.from(name).toString('hex').padStart(12, '0').slice(-12)}`, email: `${name}@example.test` }
}

function session(token) {
  const account = user(token)
  return {
    access_token: token,
    refresh_token: `refresh-${token}`,
    expires_in: 3600,
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    token_type: 'bearer',
    user: { ...account, user_metadata: {} },
  }
}

function reply(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'apikey, authorization, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, DELETE, OPTIONS',
  })
  response.end(body === undefined ? '' : JSON.stringify(body))
}

createServer((request, response) => {
  let raw = ''
  request.on('data', (chunk) => (raw += chunk))
  request.on('end', () => {
    setTimeout(() => {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const bearer = (request.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
      const body = raw ? JSON.parse(raw) : {}

      if (request.method === 'OPTIONS') return reply(response, 204)
      if (url.pathname === '/auth/v1/user' && request.method === 'GET') {
        const account = user(bearer)
        return account ? reply(response, 200, account) : reply(response, 401, { msg: 'invalid token' })
      }
      if (url.pathname === '/auth/v1/otp') return reply(response, 200, {})
      if (url.pathname === '/auth/v1/verify') {
        // The code is the account: 000001 signs in as test-owner, anything else
        // as test-other, so a check can choose either without a second knob.
        const token = body.token === '000001' ? 'test-owner' : 'test-other'
        return reply(response, 200, session(token))
      }
      if (url.pathname === '/auth/v1/token') {
        const token = String(body.refresh_token ?? '').replace(/^refresh-/, '')
        return user(token) ? reply(response, 200, session(token)) : reply(response, 400, {})
      }
      if (url.pathname === '/auth/v1/settings') return reply(response, 200, { external: {} })
      if (url.pathname === '/auth/v1/logout') return reply(response, 204)
      // Preferences and the rest of the database: nothing stored, nothing refused.
      if (url.pathname.startsWith('/rest/v1/')) return reply(response, 200, [])
      return reply(response, 404, { msg: 'not here' })
    }, DELAY)
  })
}).listen(PORT, '127.0.0.1', () => console.log(`fake account server on http://127.0.0.1:${PORT}`))
