import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluatePair, fundingRate } from '../site/js/core/evaluate.js'
import { accountRates } from '../site/js/core/fees.js'
import { premiumIndex, hourlyFunding, fundingParams } from '../site/js/core/funding.js'

const HOUR = 3_600_000
const deep = (mid, half, step, n = 30, sz = 50) => ({
  bids: Array.from({ length: n }, (_, i) => ({ px: mid - half - step * i, sz })),
  asks: Array.from({ length: n }, (_, i) => ({ px: mid + half + step * i, sz })),
})

const pair = {
  id: 'S|P',
  kind: 'bridged',
  perpUnits: 1,
  quoteUsd: 1,
  spot: { kind: 'spot', coin: 'S', base: { name: 'UX' }, quote: 'USDC', mid: 100, volume: 1e6 },
  perp: { kind: 'perp', coin: 'P', dex: '', collateral: 'USDC', funding: 0.0001, mid: 100.1, mark: 100.1 },
}
const settings = { notional: 1_000, hours: 24 * 30, fundingBasis: 'now', basisMode: 'hold', leverage: 2 }
const ctx = (books, extra = {}) => ({ books: new Map(Object.entries(books)), history: new Map(), settings, rates: accountRates(), quotes: { stable: new Set(['USDC']), aligned: new Set() }, ...extra })

test('fundingRate averages the requested window and falls back to the current rate', () => {
  const t0 = 1_700_000_000_000
  const history = Array.from({ length: 48 }, (_, i) => ({ time: t0 + i * HOUR, rate: i < 24 ? 0.0002 : 0.0001 }))
  assert.ok(Math.abs(fundingRate({ funding: 0.5 }, history, 'avg24').value - 0.0001) < 1e-12)
  assert.ok(Math.abs(fundingRate({ funding: 0.5 }, history, 'avg7d').value - 0.00015) < 1e-12)
  const fb = fundingRate({ funding: 0.5 }, [], 'avg7d')
  assert.equal(fb.value, 0.5)
  assert.equal(fb.fallback, true)
})

test('a pair is loading until both books arrive', () => {
  assert.equal(evaluatePair(pair, ctx({ S: deep(100, 0.05, 0.01) })).status, 'loading')
})

test('an empty spot book (pre-launch) reports nobook on the spot side', () => {
  const r = evaluatePair(pair, ctx({ S: { bids: [], asks: [] }, P: deep(100.1, 0.05, 0.01) }))
  assert.equal(r.status, 'nobook')
  assert.equal(r.missing, 'spot')
})

test('a book with asks but no bids is one-sided, not missing', () => {
  const r = evaluatePair(pair, ctx({ S: { bids: [], asks: [{ px: 101, sz: 5 }] }, P: deep(100.1, 0.05, 0.01) }))
  assert.equal(r.status, 'nobook')
  assert.equal(r.oneSided, true)
})

test('deep books and real funding make a profitable carry', () => {
  const r = evaluatePair(pair, ctx({ S: deep(100, 0.01, 0.01), P: deep(100.1, 0.01, 0.01) }))
  assert.equal(r.direction, 'carry')
  assert.equal(r.status, 'profit')
  assert.ok(r.econ.netUsd > 0)
  // fees: 7 bps spot + 4.5 bps perp, twice
  assert.ok(Math.abs(r.trip.legs.spotEntry.bps.fee - 7) < 1e-9)
  assert.ok(Math.abs(r.trip.legs.perpExit.bps.fee - 4.5) < 1e-9)
  assert.ok(r.basis > 9 && r.basis < 11, `basis ${r.basis}`)
})

test('the same funding cannot pay for a book that is too thin', () => {
  const thin = { bids: [{ px: 99, sz: 1 }], asks: [{ px: 101, sz: 1 }] }
  const r = evaluatePair(pair, ctx({ S: thin, P: deep(100.1, 0.01, 0.01) }))
  assert.equal(r.status, 'thin')
  assert.equal(r.trip.complete, false)
})

test('negative funding flips to the reverse direction', () => {
  const r = evaluatePair({ ...pair, perp: { ...pair.perp, funding: -0.0002 } }, ctx({ S: deep(100, 0.01, 0.01), P: deep(100.1, 0.01, 0.01) }))
  assert.equal(r.direction, 'reverse')
  assert.equal(r.trip.legs.spotEntry.side, 'sell')
})

test('proxies carry no basis; quotes are converted to USD for basis', () => {
  const books = { S: deep(100, 0.01, 0.01), P: deep(100, 0.01, 0.01) }
  assert.equal(evaluatePair({ ...pair, kind: 'proxy' }, ctx(books)).basis, null)
  const r = evaluatePair({ ...pair, quoteUsd: 0.998 }, ctx(books))
  assert.ok(Math.abs(r.basis - (100 / 99.8 - 1) * 1e4) < 1e-6)
})

test('a size the books cannot fill carries no economics', () => {
  const thin = { bids: [{ px: 99, sz: 1 }], asks: [{ px: 101, sz: 1 }] }
  const r = evaluatePair(pair, ctx({ S: thin, P: deep(100.1, 0.01, 0.01) }))
  assert.equal(r.status, 'thin')
  assert.equal(r.econ, null)
  assert.ok(r.trip)
})

test('a lowball bid at a listing does not skew sizing: the arrival price is the fair price', () => {
  // EQX-style launch: one stale bid at 2, the first fair ask at 101.
  const listing = { bids: [{ px: 2, sz: 1000 }], asks: [{ px: 101, sz: 1000 }, { px: 102, sz: 1000 }] }
  const r = evaluatePair(pair, ctx({ S: listing, P: deep(100.1, 0.01, 0.01) }))
  assert.ok(Math.abs(r.spotMid - 100.1) < 0.2, `arrival ${r.spotMid}`)
  assert.ok(Math.abs(r.trip.spotQty - 1000 / 100.1) < 0.1)
  assert.ok(Math.abs(r.basis) < 30)
})

test('a strong match the real quotes contradict is dropped as a mismatch', () => {
  const far = { bids: [{ px: 0.3, sz: 1000 }], asks: [{ px: 0.31, sz: 1000 }] }
  const r = evaluatePair({ ...pair, verify: 'book' }, ctx({ S: far, P: deep(100.1, 0.01, 0.01) }))
  assert.equal(r.status, 'mismatch')
  const ok = evaluatePair({ ...pair, verify: 'book' }, ctx({ S: deep(100, 0.01, 0.01), P: deep(100.1, 0.01, 0.01) }))
  assert.notEqual(ok.status, 'mismatch')
})

test('your own perp short compresses a rich premium and shrinks the optimal size', () => {
  // Thin perp trading 0,4 % over the oracle: $1k per 10 bps step. Deep spot.
  const perpBook = {
    bids: Array.from({ length: 40 }, (_, i) => ({ px: 100.4 - i * 0.1, sz: 10 })),
    asks: Array.from({ length: 40 }, (_, i) => ({ px: 100.41 + i * 0.1, sz: 10 })),
  }
  // The exchange reads the premium from this same book.
  const premium = premiumIndex(perpBook, 100, { hip3: false, impactUsd: 6000 })
  const perp = { ...pair.perp, dex: '', symbol: 'X', oracle: 100, premium, funding: hourlyFunding(premium, fundingParams({ dex: '' })) }
  const books = { S: deep(100, 0.01, 0.01, 40, 1e4), P: perpBook }
  const on = evaluatePair({ ...pair, perp }, ctx(books, { settings: { ...settings, notional: 20_000, fundingImpact: 'max' } }))
  const off = evaluatePair({ ...pair, perp }, ctx(books, { settings: { ...settings, notional: 20_000, fundingImpact: 'off' } }))
  assert.equal(off.atSize.rate, perp.funding)
  assert.ok(on.atSize.rate < perp.funding * 0.8, `rate at size ${on.atSize.rate} vs ${perp.funding}`)
  assert.ok(on.econ.fundingUsd < off.econ.fundingUsd)
  assert.ok(on.curve.best.notional < off.curve.best.notional, 'optimum must shrink once funding reacts to size')
  // On the main dex a short can at most push funding back to the interest baseline.
  assert.ok(on.atSize.rate >= 0.0001 / 8 - 1e-15)
})

test('baseline funding inside the clamp band is untouched by a big order', () => {
  const perp = { ...pair.perp, dex: '', symbol: 'X', oracle: 100.1, premium: 0.0001, funding: 0.0001 / 8 }
  const r = evaluatePair({ ...pair, perp }, ctx({ S: deep(100, 0.01, 0.01, 40, 1e4), P: deep(100.1, 0.01, 0.01, 40, 1e4) }, { settings: { ...settings, notional: 100_000 } }))
  assert.equal(r.atSize.rate, perp.funding)
})

test('realistic mode scales the funding hit by size relative to hourly volume', () => {
  const perpBook = {
    bids: Array.from({ length: 40 }, (_, i) => ({ px: 100.4 - i * 0.1, sz: 10 })),
    asks: Array.from({ length: 40 }, (_, i) => ({ px: 100.41 + i * 0.1, sz: 10 })),
  }
  const premium = premiumIndex(perpBook, 100, { hip3: false, impactUsd: 6000 })
  const base = { ...pair.perp, dex: '', symbol: 'X', oracle: 100, premium, funding: hourlyFunding(premium, fundingParams({ dex: '' })) }
  const books = { S: deep(100, 0.01, 0.01, 40, 1e4), P: perpBook }
  const at = (volume, mode) => evaluatePair({ ...pair, perp: { ...base, volume } }, ctx(books, { settings: { ...settings, notional: 5_000, fundingImpact: mode } })).atSize.rate
  const max = at(1e6, 'max')
  const liquid = at(24 * 1e6, 'real') // $1M an hour: a $5k footprint is gone fast
  const thin = at(24 * 2_000, 'real') // $2k an hour: the footprint stays
  assert.ok(max < base.funding)
  assert.ok(liquid > max && Math.abs(liquid - base.funding) < (base.funding - max) * 0.01)
  assert.equal(thin, max)
})
