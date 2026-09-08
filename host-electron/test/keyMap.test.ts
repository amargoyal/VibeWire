import { test } from 'node:test'
import assert from 'node:assert/strict'
import { modifierVirtualKey, unmappedKeyNames, virtualKey } from '../src/main/input/keyMap'

test('every key name the protocol promises has a Windows virtual key', () => {
  assert.deepEqual(unmappedKeyNames(), [])
})

test('letters, digits and function keys map to their ASCII and VK ranges', () => {
  assert.equal(virtualKey('a'), 0x41)
  assert.equal(virtualKey('Z'), 0x5a)
  assert.equal(virtualKey('0'), 0x30)
  assert.equal(virtualKey('f1'), 0x70)
  assert.equal(virtualKey('f12'), 0x7b)
  assert.equal(virtualKey('delete'), 0x08)
  assert.equal(virtualKey('forwardDelete'), 0x2e)
  assert.equal(virtualKey('☃'), null)
})

test('the four modifiers land on Ctrl, Shift, Alt and Win', () => {
  assert.equal(modifierVirtualKey('cmd'), 0x11)
  assert.equal(modifierVirtualKey('shift'), 0x10)
  assert.equal(modifierVirtualKey('option'), 0x12)
  assert.equal(modifierVirtualKey('control'), 0x5b)
  assert.equal(modifierVirtualKey('fn'), null)
})
