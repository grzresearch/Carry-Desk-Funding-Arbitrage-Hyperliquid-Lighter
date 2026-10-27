import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WeightLimiter } from '../site/js/core/ratelimit.js'
import { createClient } from '../site/js/core/api.js'

function fakeClock() {
  let t = 0
  const timers = []
  return {
    now: () => t,
    schedule: (fn, ms) => {
      const timer = { at: t + ms, fn }
      timers.push(timer)
      return timer
    },
    cancel: (timer) => {
      const i = timers.indexOf(timer)
      if (i >= 0) timers.splice(i, 1)
    },
    advance(ms) {
      const end = t + ms
      // Fire timers in order, letting each one schedule the next within the same advance.
      for (;;) {
        timers.sort((a, b) => a.at - b.at)
        if (!timers.length || timers[0].at > end) break
        const timer = timers.shift()
        t = timer.at
        timer.fn()
      }
      t = end
    },
  }
}

const flush = () => new Promise((r) => setImmediate(r))

test('spends immediately while budget remains, then waits for the window to roll', async () => {
  const clock = fakeClock()
  const limiter = new WeightLimiter({ budget: 40, windowMs: 1000, ...clock })
  const done = []
  limiter.take(20).then(() => done.push('a'))
  limiter.take(20).then(() => done.push('b'))
  limiter.take(20).then(() => done.push('c'))
  await flush()
  assert.deepEqual(done, ['a', 'b'])
  clock.advance(999)
  await flush()
  assert.deepEqual(done, ['a', 'b'])
  clock.advance(1)
  await flush()
  assert.deepEqual(done, ['a', 'b', 'c'])
})

test('no window ever holds more than the budget', async () => {
  const clock = fakeClock()
  const limiter = new WeightLimiter({ budget: 1000, windowMs: 60_000, ...clock })
  const released = []
  for (let i = 0; i < 200; i++) limiter.take(20).then(() => released.push(clock.now()))
  for (let step = 0; step <= 1800; step++) {
    await flush()
    clock.advance(100)
  }
  await flush()
  assert.equal(released.length, 200)
  for (const start of released) {
    const inWindow = released.filter((t) => t >= start && t < start + 60_000).length * 20
    assert.ok(inWindow <= 1000, `window from ${start} holds ${inWindow}`)
  }
})

test('lower priority numbers jump the queue', async () => {
  const clock = fakeClock()
  const limiter = new WeightLimiter({ budget: 10, windowMs: 1000, ...clock })
  const done = []
  await limiter.take(10)
  limiter.take(5, 5).then(() => done.push('slow'))
  limiter.take(5, 0).then(() => done.push('urgent'))
  clock.advance(1000)
  await flush()
  assert.deepEqual(done, ['urgent', 'slow'])
})

test('usage reports weight over the trailing window', async () => {
  const clock = fakeClock()
  const limiter = new WeightLimiter({ budget: 1000, windowMs: 60_000, ...clock })
  await limiter.take(20)
  limiter.charge(7)
  assert.equal(limiter.usage(), 27)
  clock.advance(61_000)
  assert.equal(limiter.usage(), 0)
})

test('backoff pauses everything once, however many 429s arrive', async () => {
  const clock = fakeClock()
  const limiter = new WeightLimiter({ budget: 1000, windowMs: 60_000, ...clock })
  limiter.backoff(5000)
  limiter.backoff(5000)
  let released = false
  limiter.take(2).then(() => (released = true))
  clock.advance(4999)
  await flush()
  assert.equal(released, false)
  clock.advance(1)
  await flush()
  assert.equal(released, true)
})

test('client retries a 429 through the limiter and pays for every attempt', async () => {
  const limiter = new WeightLimiter({ budget: 1000 })
  const backoffs = []
  limiter.backoff = (ms) => backoffs.push(ms)
  let calls = 0
  const fetchImpl = async () => (++calls === 1 ? { status: 429, ok: false } : { status: 200, ok: true, json: async () => ({ levels: [[], []] }) })
  const client = createClient({ fetchImpl, limiter })
  await client.l2Book('BTC')
  assert.equal(calls, 2)
  assert.deepEqual(backoffs, [2000])
  assert.equal(limiter.usage(), 4)
})

test('funding history reserves its per-item weight up front', async () => {
  const limiter = new WeightLimiter({ budget: 1000 })
  const rows = Array.from({ length: 168 }, () => ({}))
  const client = createClient({ fetchImpl: async () => ({ status: 200, ok: true, json: async () => rows }), limiter })
  await client.fundingHistory('BTC', Date.now() - 168 * 3_600_000)
  assert.equal(limiter.usage(), 28)
})

test('background work leaves headroom: an urgent request never waits out a full window', async () => {
  const clock = fakeClock()
  const limiter = new WeightLimiter({ budget: 100, windowMs: 60_000, ...clock })
  const log = []
  for (let i = 0; i < 10; i++) limiter.take(20, 8).then(() => log.push(`bg${i}`))
  await flush()
  // Background stops at 60 % of the budget …
  assert.deepEqual(log, ['bg0', 'bg1', 'bg2'])
  // … so a book request goes straight through.
  limiter.take(20, 3).then(() => log.push('book'))
  await flush()
  assert.equal(log.at(-1), 'book')
})
