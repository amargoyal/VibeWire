import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WebAssets } from '../src/main/net/webAssets'

function bundle(): { root: string; secretAbove: string } {
  const base = mkdtempSync(join(tmpdir(), 'vw-web-'))
  const root = join(base, 'dist')
  mkdirSync(join(root, 'assets'), { recursive: true })
  writeFileSync(join(root, 'index.html'), '<div id="root"></div>')
  writeFileSync(join(root, 'assets', 'index-abc.js'), 'console.log(1)')
  writeFileSync(join(base, 'Package.swift'), 'swift-tools-version')
  return { root, secretAbove: join(base, 'Package.swift') }
}

test('serves the document uncacheable with a CSP, and assets immutable', () => {
  const web = WebAssets.open(bundle().root)!
  const index = web.response('/')!
  assert.equal(index.status, 200)
  assert.equal(index.headers['Cache-Control'], 'no-store')
  assert.match(index.headers['Content-Security-Policy'], /script-src 'self'/)
  const asset = web.response('/assets/index-abc.js')!
  assert.equal(asset.status, 200)
  assert.match(asset.headers['Cache-Control'], /immutable/)
  assert.match(asset.headers['Content-Type'], /^text\/javascript/)
})

test('an extensionless path is the client, a missing asset is a 404', () => {
  const web = WebAssets.open(bundle().root)!
  assert.equal(web.response('/somewhere')!.status, 200)
  assert.equal(web.response('/assets/missing.js')!.status, 404)
})

test('traversal is refused before disk in every spelling', () => {
  const web = WebAssets.open(bundle().root)!
  for (const attempt of [
    '/../Package.swift',
    '/assets/../../Package.swift',
    '/%2e%2e/Package.swift',
    '/..%2fPackage.swift',
    '/a\\..\\..\\Package.swift',
    '/index.html::$DATA',
  ]) {
    const response = web.response(attempt)!
    assert.ok(response.status === 403 || response.status === 404, `${attempt} → ${response.status}`)
    assert.ok(!response.body.toString().includes('swift-tools-version'), `${attempt} leaked`)
  }
})

test('the protocol prefix is never served from disk', () => {
  const web = WebAssets.open(bundle().root)!
  assert.equal(web.response('/v1/anything'), null)
})
