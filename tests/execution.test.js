import { test } from 'node:test'
import assert from 'node:assert/strict'
import { erfc, gammaQ, hitProb, sigmaFromCandles, sideVolume, activityFrom, activityFallback, makerOrder, executorFor, takenQty, QUEUE_Y } from '../site/js/core/execution.js'
import { legShortfall, hedgeTrip } from '../site/js/core/shortfall.js'

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`)

test('erfc and the incomplete gamma match known values', () => {
  near(erfc(0), 1)
  near(erfc(0.5), 0.4795001222, 2e-7)
  near(erfc(2), 0.004677735, 2e-9)
  near(erfc(-1), 1.8427007929, 2e-7)
  near(gammaQ(1, 2), Math.exp(-2), 1e-12) // exponential tail
  near(gammaQ(2, 3), 4 * Math.exp(-3), 1e-12)
  near(gammaQ(0.5, 0.5), 0.3173105078629141, 1e-12) // = erfc(√½)
})

test('hit probability: reflection principle, certain at zero distance', () => {
  assert.equal(hitProb(0, 1e-4, 60), 1)
  near(hitProb(1e-4, 1e-4, 1), erfc(1 / Math.SQRT2), 1e-12)
  assert.equal(hitProb(Infinity, 1e-4, 60), 0)
})

const minutes = (n, f) => Array.from({ length: n }, (_, i) => ({ time: i * 60_000, ...f(i) }))

test('volatility from 5-minute steps of 1-minute closes', () => {
  const candles = minutes(61, (i) => ({ close: 100 * Math.exp(Math.floor(i / 5) % 2 ? 0.001 : 0), notional: 1 }))
  near(sigmaFromCandles(candles), 0.001 / Math.sqrt(300), 1e-12)
})

test('side volume: flow per second and a zero-inflated survival curve', () => {
  // A trade every other minute, $1 200 each: half of it per side.
  const v = sideVolume(minutes(240, (i) => ({ close: 1, notional: i % 2 ? 1200 : 0 })))
  near(v.flowUsd, 600 / 2 / 60, 1e-9)
  assert.equal(v.survival(0, 60), 1)
  // Within one minute about half the windows trade at all.
  const one = v.survival(100, 60)
  assert.ok(one > 0.4 && one < 0.6, `1 min ${one}`)
  // An hour carries ~$18 000 per side, practically always more than $1 000.
  assert.ok(v.survival(1000, 3600) > 0.99)
  assert.ok(v.survival(1e6, 3600) < 1e-6)
  assert.ok(v.survival(500, 120) >= v.survival(500, 60))
})

test('activity needs half an hour of candles; the fallback is flagged', () => {
  assert.equal(activityFrom(minutes(10, () => ({ close: 1, notional: 1 }))), null)
  const a = activityFallback({ volume: 86_400 * 2 * 1000 })
  near(a.flowUsd, 1000)
  assert.equal(a.estimated, true)
})

const book = {
  bids: [{ px: 99.95, sz: 10 }, { px: 99.9, sz: 50 }, { px: 99.5, sz: 500 }],
  asks: [{ px: 100.05, sz: 10 }, { px: 100.1, sz: 50 }, { px: 100.5, sz: 500 }],
}
const busy = { sigma: 1e-4, flowUsd: 20_000, survival: () => 1 }

test('maker order: cost components add up; spread is earned on fills', () => {
  const leg = makerOrder(book, 'buy', 5, { ref: 100, takerFeeBps: 4.5, makerFeeBps: 1.5, activity: busy, waitMin: 5 })
  const m = leg.maker
  assert.ok(m.filledShare > 0.5 && m.filledShare <= 1)
  assert.ok(m.fullFill <= m.filledShare + 1e-12)
  near(leg.cost.total, leg.cost.spread + leg.cost.impact + leg.cost.adverse + leg.cost.fee, 1e-9)
  // Joining the bid 5 bps under the mid: the filled share earns those 5 bps.
  assert.ok(leg.cost.spread < 0)
  // Adverse selection is at least the distance to the limit per filled unit.
  assert.ok(leg.cost.adverse >= 0.0005 * 500 * m.filledShare - 1e-9)
  near(m.takenQty, 5 * (1 - m.filledShare), 1e-9)
  assert.equal(takenQty(leg), m.takenQty)
  assert.ok(m.openSec > 0 && m.openSec <= 300)
})

test('single unit: fill probability is the closed form erfc(m / σ√2T)', () => {
  const tiny = 1e-9
  const leg = makerOrder(book, 'buy', tiny, { ref: 100, takerFeeBps: 0, makerFeeBps: 0, activity: busy, waitMin: 2 })
  const lambda = 20_000 / 100
  const m = 0.0005 + QUEUE_Y * 1e-4 * Math.sqrt(10 / lambda)
  near(leg.maker.filledShare, erfc(m / (1e-4 * Math.sqrt(240))), 1e-6)
})

test('more queue, less flow, less time, bigger size → fewer fills', () => {
  const run = (over = {}) => makerOrder(over.book ?? book, 'sell', over.qty ?? 5, { ref: 100, takerFeeBps: 4.5, makerFeeBps: 1.5, activity: over.activity ?? busy, waitMin: over.wait ?? 5 }).maker.filledShare
  const base = run()
  assert.ok(run({ book: { ...book, asks: [{ px: 100.05, sz: 1000 }, ...book.asks.slice(1)] } }) < base)
  assert.ok(run({ activity: { ...busy, flowUsd: 200 } }) < base)
  assert.ok(run({ wait: 1 }) < base)
  assert.ok(run({ qty: 400 }) < base)
})

test('a dead market never fills: the maker order is just a late market order', () => {
  const dead = { sigma: 1e-4, flowUsd: 0, survival: () => 0 }
  const leg = makerOrder(book, 'sell', 5, { ref: 100, takerFeeBps: 4.5, makerFeeBps: 1.5, activity: dead, waitMin: 15 })
  const taker = legShortfall(book, 'sell', 5, 4.5, 100)
  near(leg.maker.filledShare, 0)
  near(leg.cost.total, taker.cost.total, 1e-9)
})

test('the rest is averaged over the fill distribution, not taken at the mean', () => {
  // With a coin-flip fill (all or nothing), the rest is either q or 0: impact is convex,
  // so its expectation exceeds the impact of the expected rest.
  const leg = makerOrder(book, 'buy', 60, { ref: 100, takerFeeBps: 0, makerFeeBps: 0, activity: { sigma: 2e-4, flowUsd: 1e6, survival: () => 1 }, waitMin: 1 })
  const atMean = legShortfall(book, 'buy', 60 * (1 - leg.maker.filledShare), 0, 100)
  assert.ok(leg.cost.impact >= atMean.cost.impact - 1e-9)
})

test('executors plug into a round trip; legs without one stay market orders', () => {
  const candles = minutes(480, (i) => ({ close: 100 * (1 + (i % 10 < 5 ? 0 : 0.001)), notional: 50_000 }))
  const execute = executorFor({ market: { volume: 1e6 }, candles, waitMin: 5, makerFeeBps: 0, takerFeeBps: 4.5 })
  const trip = hedgeTrip({
    notional: 1_000,
    legs: [
      { name: 'spot', book, entry: 'buy', feeBps: 7, execute },
      { name: 'perp', book, entry: 'sell', feeBps: 4.5 },
    ],
  })
  assert.ok(trip.legs.spotEntry.maker && !trip.legs.spotEntry.maker.estimated)
  assert.ok(trip.legs.spotExit.maker)
  assert.equal(trip.legs.perpEntry.maker, undefined)
  assert.equal(takenQty(trip.legs.perpEntry), trip.legs.perpEntry.qty)
  assert.ok(Number.isFinite(trip.costBps))
})
