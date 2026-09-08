import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseTarget } from '../src/main/net/request'

test('query values are percent-decoded and a plus stays a plus', () => {
  const { path, query } = parseTarget('/v1/verify?device=abc&sig=a%2Bb%2Fc%3D%3D&raw=x+y')
  assert.equal(path, '/v1/verify')
  assert.equal(query.device, 'abc')
  assert.equal(query.sig, 'a+b/c==')
  assert.equal(query.raw, 'x+y')
})

test('a value that will not decode is emptied, not guessed at; a key that will not is dropped', () => {
  const { query } = parseTarget('/x?good=1&bad=%E0%A4%A&%E0=x&other=2')
  assert.deepEqual(query, { good: '1', bad: '', other: '2' })
})

test('no query is an empty record', () => {
  assert.deepEqual(parseTarget('/v1/health'), { path: '/v1/health', query: {} })
})
