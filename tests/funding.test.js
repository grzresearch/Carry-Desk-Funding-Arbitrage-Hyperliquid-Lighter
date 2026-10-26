import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hourlyFunding, premiumIndex, premiumShift, fundingAtSize, fundingParams, afterOrder, persistence, FUNDING_CAP } from '../site/js/core/funding.js'

const near = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`)
const MAIN = fundingParams({ dex: '' })

test('inside the clamp band funding is the interest rate, whatever the premium', () => {
  for (const P of [-0.0004, 0, 0.0003, 0.0006]) near(hourlyFunding(P, MAIN), 0.0001 / 8)
})

test('beyond the band the premium passes through', () => {
  near(hourlyFunding(0.002, MAIN), (0.002 - 0.0005) / 8)
  near(hourlyFunding(-0.002, MAIN), (-0.002 + 0.0005) / 8)
})

test('HIP-3 applies multiplier and its own clamp; funding is capped at 4 %/h', () => {
  const p = fundingParams({ dex: 'xyz', fundingMultiplier: 0.5 })
  near(hourlyFunding(0, p), (0.5 * 0.0001) / 8) // xyz baseline 5,48 % p.a.
  near(hourlyFunding(0.001, p), (0.5 * (0.001 - 0.0003)) / 8)
  assert.equal(hourlyFunding(10, MAIN), FUNDING_CAP)
})

// Live check 2026-10-26: these books reproduce ctx.premium exactly.
test('premium index follows the exchange formulas', () => {
  // HIP-3: mid of impact prices vs oracle (mkts:US500: −0.00014938)
  const hip3 = { bids: [{ px: 762.875, sz: 1000 }], asks: [{ px: 763.177, sz: 1000 }] }
  near(premiumIndex(hip3, 763.14, { hip3: true, impactUsd: 6000 }), 0.5 * (762.875 + 763.177) / 763.14 - 1)
  // main: only impact prices beyond the oracle count (XMR: +0.00021929)
  const main = { bids: [{ px: 592.96, sz: 1000 }], asks: [{ px: 592.97, sz: 1000 }] }
  near(premiumIndex(main, 592.83, { hip3: false, impactUsd: 6000 }), (592.96 - 592.83) / 592.83)
})

test('afterOrder removes exactly the consumed liquidity', () => {
  const book = { bids: [{ px: 10, sz: 1 }, { px: 9, sz: 2 }], asks: [{ px: 11, sz: 1 }] }
  assert.deepEqual(afterOrder(book, 'sell', 2).bids, [{ px: 9, sz: 1 }])
  assert.deepEqual(afterOrder(book, 'sell', 2).asks, book.asks)
})

test('a short into a thin book pushes the premium down; a deep book barely moves', () => {
  const thin = { bids: Array.from({ length: 20 }, (_, i) => ({ px: 1.01 - i * 0.01, sz: 2000 })), asks: [{ px: 1.02, sz: 1e6 }] }
  const perp = { dex: 'para', symbol: 'X' }
  const shift = premiumShift(thin, 'sell', 20_000, 1, perp)
  assert.ok(shift < -0.03, `shift ${shift}`)
  const deep = { bids: [{ px: 1.01, sz: 1e9 }], asks: [{ px: 1.02, sz: 1e9 }] }
  assert.ok(Math.abs(premiumShift(deep, 'sell', 20_000, 1, perp)) < 1e-12)
})

test('fundingAtSize only removes funding above the baseline', () => {
  // Rich premium (0,4 % per 8h): a 0,2 % premium drop costs 0,2 %/8 per hour.
  near(fundingAtSize({ baseRate: (0.004 - 0.0005) / 8, basePremium: 0.004, shift: -0.002, params: MAIN }), (0.002 - 0.0005) / 8)
  // Baseline funding with the premium mid-band: a small shift changes nothing.
  near(fundingAtSize({ baseRate: 0.0001 / 8, basePremium: 0.0001, shift: -0.0003, params: MAIN }), 0.0001 / 8)
  // Without a premium reading the base rate stands.
  assert.equal(fundingAtSize({ baseRate: 0.001, basePremium: null, shift: -1, params: MAIN }), 0.001)
})

test('persistence: full in max mode, size over hourly volume otherwise', () => {
  assert.equal(persistence(10_000, { volume: 24 * 1e6 }, 'max'), 1)
  assert.equal(persistence(10_000, { volume: 24 * 1e6 }), 0.01)
  assert.equal(persistence(10_000, { volume: 24 * 5_000 }), 1)
  assert.equal(persistence(10_000, { volume: 0 }), 1)
})
