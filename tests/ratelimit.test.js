import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WeightLimiter } from '../site/js/core/ratelimit.js'

function fakeClock() {
  let t = 0
  const timers = []
  return {
    now: () => t,
    schedule: (fn, ms) => timers.push({ at: t + ms, fn }),
    advance(ms) {
      t += ms
      for (const timer of timers.splice(0)) {
        if (timer.at <= t) timer.fn()
        else timers.push(timer)
      }
    },
  }
}

const flush = () => new Promise((r) => setImmediate(r))

test('spends immediately while budget remains, then waits for refill', async () => {
  const clock = fakeClock()
  const limiter = new WeightLimiter({ budget: 40, windowMs: 1000, ...clock })
  const done = []
  limiter.take(20).then(() => done.push('a'))
  limiter.take(20).then(() => done.push('b'))
  limiter.take(20).then(() => done.push('c'))
  await flush()
  assert.deepEqual(done, ['a', 'b'])
  clock.advance(499)
  await flush()
  assert.deepEqual(done, ['a', 'b'])
  clock.advance(2)
  await flush()
  assert.deepEqual(done, ['a', 'b', 'c'])
})

test('lower priority numbers jump the queue', async () => {
  const clock = fakeClock()
  const limiter = new WeightLimiter({ budget: 10, windowMs: 1000, ...clock })
  const done = []
  await limiter.take(10)
  limiter.take(5, 9).then(() => done.push('slow'))
  limiter.take(5, 0).then(() => done.push('urgent'))
  clock.advance(1000)
  await flush()
  assert.deepEqual(done, ['urgent', 'slow'])
})

test('usage reports weight over the trailing minute', async () => {
  const clock = fakeClock()
  const limiter = new WeightLimiter({ budget: 1000, windowMs: 60_000, ...clock })
  await limiter.take(20)
  limiter.charge(7)
  assert.equal(limiter.usage(), 27)
  clock.advance(61_000)
  assert.equal(limiter.usage(), 0)
})
