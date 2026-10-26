import { test } from 'node:test'
import assert from 'node:assert/strict'
import { carryEconomics, directionFor, basisBps, logGrid, sizeCurve, HOURS_PER_YEAR } from '../site/js/core/carry.js'
import { roundTrip } from '../site/js/core/shortfall.js'

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`)

const trip = { notional: 10_000, costUsd: 30, direction: 'carry', complete: true }

test('direction follows the sign of funding', () => {
  assert.equal(directionFor(0.0001), 'carry')
  assert.equal(directionFor(0), 'carry')
  assert.equal(directionFor(-0.0001), 'reverse')
})

test('basis is perp over spot per unit of underlying', () => {
  near(basisBps(100, 101), 100)
  near(basisBps(0.01, 10.1, 1000), 100)
  assert.equal(basisBps(null, 1), null)
})

test('carry economics: funding, cost, net, break-even', () => {
  // 0.00125 %/h ≈ 10.95 % APR, held one week
  const e = carryEconomics({ trip, hourlyRate: 0.0000125, hours: 168 })
  near(e.fundingUsd, 10_000 * 0.0000125 * 168)
  near(e.netUsd, e.fundingUsd - 30)
  near(e.fundingApr, 0.0000125 * HOURS_PER_YEAR)
  near(e.breakEvenHours, 30 / (10_000 * 0.0000125))
  assert.equal(e.profitable, e.netUsd > 0)
})

test('negative funding earns the same magnitude on the reverse side', () => {
  const e = carryEconomics({ trip: { ...trip, direction: 'reverse' }, hourlyRate: -0.0001, hours: 24 })
  near(e.fundingUsd, 24)
})

test('basis convergence credits a perp premium to the carry side only', () => {
  const carry = carryEconomics({ trip, hourlyRate: 0, hours: 24, basis: 50, basisMode: 'converge' })
  near(carry.basisUsd, 50)
  const reverse = carryEconomics({ trip: { ...trip, direction: 'reverse' }, hourlyRate: 0, hours: 24, basis: 50, basisMode: 'converge' })
  near(reverse.basisUsd, -50)
  const hold = carryEconomics({ trip, hourlyRate: 0, hours: 24, basis: 50, basisMode: 'hold' })
  near(hold.basisUsd, 0)
})

test('zero funding never breaks even', () => {
  assert.equal(carryEconomics({ trip, hourlyRate: 0, hours: 24 }).breakEvenHours, Infinity)
})

test('capital includes perp margin at the chosen leverage', () => {
  const e = carryEconomics({ trip, hourlyRate: 0.0001, hours: 24, leverage: 4 })
  near(e.capital, 12_500)
  near(e.capitalApr, (e.netUsd / 12_500) * (HOURS_PER_YEAR / 24))
})

test('an incomplete trip is never profitable', () => {
  const e = carryEconomics({ trip: { ...trip, complete: false }, hourlyRate: 0.01, hours: 24 })
  assert.equal(e.profitable, false)
})

test('logGrid spans its bounds', () => {
  const g = logGrid(10, 1000, 3)
  near(g[0], 10)
  near(g[1], 100, 1e-9)
  near(g[2], 1000, 1e-9)
})

test('sizeCurve finds an interior optimum when impact grows faster than funding', () => {
  // Thin, steep books: price worsens 1 % per unit.
  const levels = (start, step) => Array.from({ length: 40 }, (_, i) => ({ px: start + step * i, sz: 1 }))
  const spotBook = { bids: levels(99.95, -1), asks: levels(100.05, 1) }
  const perpBook = { bids: levels(99.95, -1), asks: levels(100.05, 1) }
  const curve = sizeCurve({ spotBook, perpBook, direction: 'carry', hourlyRate: 0.0005, hours: 168, spotFeeBps: 0, perpFeeBps: 0 })
  assert.ok(curve.points.length > 5)
  assert.ok(curve.best, 'expected a profitable size')
  const last = curve.points[curve.points.length - 1]
  assert.ok(curve.best.notional < last.notional, 'optimum should be interior')
  assert.ok(curve.maxProfitable.notional >= curve.best.notional)
  // Every evaluated point must match a direct round trip.
  const p = curve.points[3]
  const t = roundTrip({ spotBook, perpBook, notional: p.notional, direction: 'carry', spotFeeBps: 0, perpFeeBps: 0 })
  near(p.costBps, t.costBps)
})

test('sizeCurve flags an optimum that is only the end of the visible book', () => {
  const flat = (start, step) => Array.from({ length: 5 }, (_, i) => ({ px: start + step * i, sz: 1000 }))
  const book = { bids: flat(99.99, -0.01), asks: flat(100.01, 0.01) }
  const curve = sizeCurve({ spotBook: book, perpBook: book, direction: 'carry', hourlyRate: 0.001, hours: 720, spotFeeBps: 0, perpFeeBps: 0 })
  assert.equal(curve.depthLimited, true)
  assert.equal(curve.best, curve.points[curve.points.length - 1])
})
