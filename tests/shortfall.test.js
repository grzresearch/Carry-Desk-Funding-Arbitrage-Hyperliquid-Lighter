import { test } from 'node:test'
import assert from 'node:assert/strict'
import { legShortfall, roundTrip, capacity } from '../site/js/core/shortfall.js'

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`)

// mid 100, half spread 1 (100 bps), then 1 unit deeper per level
const book = {
  bids: [{ px: 99, sz: 1 }, { px: 98, sz: 1 }, { px: 97, sz: 10 }],
  asks: [{ px: 101, sz: 1 }, { px: 102, sz: 1 }, { px: 103, sz: 10 }],
}

test('buy shortfall splits into spread, impact and fee', () => {
  const leg = legShortfall(book, 'buy', 2, 10)
  assert.equal(leg.mid, 100)
  assert.equal(leg.vwap, 101.5)
  near(leg.cost.spread, 2) // 2 units × (101 − 100)
  near(leg.cost.impact, 1) // (101 + 102) − 2 × 101
  near(leg.cost.fee, 0.203) // 203 × 10 bps
  near(leg.bps.total, ((2 + 1 + 0.203) / 200) * 1e4)
  assert.equal(leg.complete, true)
})

test('sell shortfall is positive cost too', () => {
  const leg = legShortfall(book, 'sell', 2, 0)
  near(leg.cost.spread, 2)
  near(leg.cost.impact, 1)
  near(leg.bps.total, 150)
})

test('shortfall is zero-impact for a fill at the touch', () => {
  const leg = legShortfall(book, 'buy', 0.5, 0)
  near(leg.cost.impact, 0)
  near(leg.bps.spread, 100)
})

test('legShortfall returns null without a two-sided book', () => {
  assert.equal(legShortfall({ bids: [], asks: book.asks }, 'buy', 1, 0), null)
})

test('roundTrip sizes both legs to equal notional and sums four legs', () => {
  const perpBook = {
    bids: [{ px: 199, sz: 100 }],
    asks: [{ px: 201, sz: 100 }],
  }
  const trip = roundTrip({ spotBook: book, perpBook, notional: 100, direction: 'carry', spotFeeBps: 0, perpFeeBps: 0 })
  near(trip.spotQty, 1)
  near(trip.perpQty, 0.5)
  assert.equal(trip.legs.spotEntry.side, 'buy')
  assert.equal(trip.legs.perpEntry.side, 'sell')
  assert.equal(trip.legs.spotExit.side, 'sell')
  assert.equal(trip.legs.perpExit.side, 'buy')
  // spot: 1 unit at 101 / 99 → 100 bps each; perp: half spread 1/200 → 50 bps each
  near(trip.costBps, 100 + 100 + 50 + 50)
  assert.equal(trip.complete, true)
})

test('roundTrip reverse flips every side', () => {
  const trip = roundTrip({ spotBook: book, perpBook: book, notional: 100, direction: 'reverse', spotFeeBps: 7, perpFeeBps: 4.5 })
  assert.equal(trip.legs.spotEntry.side, 'sell')
  assert.equal(trip.legs.perpEntry.side, 'buy')
})

test('roundTrip names the limiting leg when depth runs out', () => {
  const thin = { bids: [{ px: 99, sz: 0.1 }], asks: [{ px: 101, sz: 50 }] }
  const trip = roundTrip({ spotBook: thin, perpBook: book, notional: 500, direction: 'carry', spotFeeBps: 0, perpFeeBps: 0 })
  assert.equal(trip.complete, false)
  assert.equal(trip.limiting, 'spotExit')
})

test('capacity is the thinnest side the plan crosses', () => {
  const thin = { bids: [{ px: 99, sz: 0.1 }], asks: [{ px: 101, sz: 50 }] }
  near(capacity({ spotBook: thin, perpBook: book, direction: 'carry' }), 9.9)
})
