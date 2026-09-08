import { test } from 'node:test'
import assert from 'node:assert/strict'
import { LiveInputRouter, type InputSink } from '../src/main/input/inputRouter'

function fakeSink() {
  const calls: string[] = []
  const sink: InputSink = {
    moveTo: (x, y) => void calls.push(`move ${x},${y}`),
    button: (which, down) => void calls.push(`${which} ${down ? 'down' : 'up'}`),
    wheel: (v, h) => void calls.push(`wheel ${v.toFixed(2)},${h.toFixed(2)}`),
    key: (name, down) => {
      calls.push(`key ${name} ${down ? 'down' : 'up'}`)
      return name !== 'nope'
    },
    unicode: (text) => void calls.push(`unicode ${text}`),
    modifier: (name, down) => void calls.push(`mod ${name} ${down ? 'down' : 'up'}`),
    combo: (modifiers, key) => {
      calls.push(`combo ${modifiers.join('+')}+${key}`)
      return key !== 'nope'
    },
    zoom: (steps) => void calls.push(`zoom ${steps}`),
    displayBounds: (id) => (id === 7 ? { x: 1000, y: 0, width: 800, height: 600, scaleFactor: 2 } : { x: 0, y: 0, width: 1000, height: 1000, scaleFactor: 1 }),
    primaryDisplayId: () => 1,
  }
  return { sink, calls }
}

test('the cursor starts at the centre, moves by the gain, and clamps to the display', () => {
  const { sink, calls } = fakeSink()
  const router = new LiveInputRouter(sink)
  router.movePointer(10, 0, null)
  // tick 5 → gain 2.0: 500 + 10 * 2 = 520
  assert.equal(calls.at(-1), 'move 520,500')
  router.movePointer(10_000, 10_000, null)
  assert.equal(calls.at(-1), 'move 999,999')
})

test('focusing another display recentres in its physical space and scales the gain', () => {
  const { sink, calls } = fakeSink()
  const router = new LiveInputRouter(sink)
  router.focus(7)
  assert.equal(calls.at(-1), 'move 1400,300')
  router.movePointer(10, 0, null)
  assert.equal(calls.at(-1), 'move 1440,300')
})

test('a double-tap-and-hold drag clicks once then holds; the end releases', () => {
  const { sink, calls } = fakeSink()
  const router = new LiveInputRouter(sink)
  router.drag('begin', 0, 0, 2)
  assert.deepEqual(calls.slice(-3), ['left down', 'left up', 'left down'])
  router.drag('end', 0, 0, 2)
  assert.equal(calls.at(-1), 'left up')
  assert.equal(router.isDragging, false)
})

test('scroll accumulates finger travel into fractional notches with the natural sign', () => {
  const { sink, calls } = fakeSink()
  const router = new LiveInputRouter(sink)
  router.scroll(0, 0.4, false)
  assert.ok(!calls.some((call) => call.startsWith('wheel')), 'sub-notch travel waits')
  router.scroll(0, 50, false)
  assert.equal(calls.at(-1), 'wheel 0.50,0.00')
  router.update(null, false)
  router.scroll(0, 100, false)
  assert.equal(calls.at(-1), 'wheel -1.00,0.00')
})

test('modifiers latch and only changes are sent; a combo with no plain key latches', () => {
  const { sink, calls } = fakeSink()
  const router = new LiveInputRouter(sink)
  router.setModifiers(['cmd', 'shift'])
  assert.deepEqual(calls.slice(-2), ['mod cmd down', 'mod shift down'])
  router.setModifiers(['cmd'])
  assert.equal(calls.at(-1), 'mod shift up')
  router.combo(['⌘', 'option'])
  assert.equal(calls.at(-1), 'mod option down')
  router.releaseAllModifiers()
  assert.deepEqual(calls.slice(-2), ['mod cmd up', 'mod option up'])
})

test('an unmapped key falls back to unicode; a mapped combo goes as one batch', () => {
  const { sink, calls } = fakeSink()
  const router = new LiveInputRouter(sink)
  router.key('nope', '🙂', true)
  assert.equal(calls.at(-1), 'unicode 🙂')
  router.combo(['cmd', 's'])
  assert.equal(calls.at(-1), 'combo cmd+s')
  router.zoom(1.35, false)
  assert.equal(calls.at(-1), 'zoom 3')
})
