import { test } from 'node:test'
import assert from 'node:assert/strict'
import { matchCross, evaluateCross } from '../site/js/core/cross.js'
import { spreadHistory } from '../site/js/ui/cross-detail.js'
import { canonicalSymbol, LIGHTER_FUNDING } from '../site/js/venues/lighter.js'
import { hyperliquidFees } from '../site/js/core/fees.js'
import { fundingParams, premiumShift, hyperliquidImpact } from '../site/js/core/funding.js'

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`)

const hl = (symbol, oracle, extra = {}) => ({ kind: 'perp', venue: 'hl', key: `hl/${extra.dex ? `${extra.dex}:` : ''}${symbol}`, coin: `${extra.dex ? `${extra.dex}:` : ''}${symbol}`, symbol, dex: '', oracle, funding: 0.0000125, collateral: 'USDC', volume: 1e9, ...extra })
const lt = (symbol, oracle, extra = {}) => ({ kind: 'perp', venue: 'lt', key: `lt/${symbol}`, coin: symbol, symbol, canonical: canonicalSymbol(symbol), dex: '', oracle, funding: 0.0000125, volume: 1e9, ...extra })

test('cross matching: same tickers, contract sizes, aliases, proxies; collisions rejected by price', () => {
  const pairs = matchCross(
    [hl('BTC', 80_000), hl('kPEPE', 0.009), hl('GOLD', 4000, { dex: 'xyz' }), hl('US500', 760, { dex: 'mkts' }), hl('QNT', 35, { dex: 'xyz' })],
    [lt('BTC', 80_050), lt('1000PEPE', 0.009), lt('XAU', 3990), lt('SPY', 765), lt('US500', 7650), lt('QNT', 209)],
  )
  const find = (a, b) => pairs.find((p) => p.a.coin === a && p.b.symbol === b)
  assert.equal(find('BTC', 'BTC').kind, 'same')
  assert.equal(find('kPEPE', '1000PEPE').units, 1)
  assert.equal(find('xyz:GOLD', 'XAU').kind, 'same')
  assert.equal(find('xyz:GOLD', 'XAU').category, 'commodity')
  // mkts:US500 is SPY-scaled: the same as Lighter's SPY perp, a proxy of the index level.
  assert.equal(find('mkts:US500', 'SPY').kind, 'same')
  assert.equal(find('mkts:US500', 'US500').kind, 'proxy')
  near(find('mkts:US500', 'US500').units, 10.03)
  // QNT is a token on Lighter and a stock on Hyperliquid's xyz dex.
  assert.equal(find('xyz:QNT', 'QNT'), undefined)
})

test('a main-dex Hyperliquid perp is crypto whatever the other venue calls it', () => {
  const [pair] = matchCross([hl('XTEN', 0.5)], [lt('XTEN', 0.5, { category: 'equity' })])
  assert.equal(pair.category, 'crypto')
  const [stock] = matchCross([hl('NVDA', 180, { dex: 'xyz' })], [lt('NVDA', 180, { category: 'equity' })])
  assert.equal(stock.category, 'equity')
})

test('growth mode does not make a HIP-3 token a stock when Lighter prices it as crypto', () => {
  const [token] = matchCross([hl('PRL', 1.76, { dex: 'io', growthMode: 'enabled' })], [lt('PRL', 1.76, { category: 'crypto' })])
  assert.equal(token.category, 'crypto')
  // Without Lighter's class, growth mode still hints at a real-world asset.
  const [unknown] = matchCross([hl('NBIS', 90, { dex: 'io', growthMode: 'enabled' })], [lt('NBIS', 90)])
  assert.equal(unknown.category, 'equity')
})

const book = (mid, half, step, n = 40, sz = 5) => ({
  bids: Array.from({ length: n }, (_, i) => ({ px: mid - half - step * i, sz })),
  asks: Array.from({ length: n }, (_, i) => ({ px: mid + half + step * i, sz })),
})

function ctxs(rateA, rateB, books) {
  const a = hl('ETH', 2000, { funding: rateA, premium: 0 })
  const b = lt('ETH', 2000, { funding: rateB, premium: 0, fundingParams: { m: 1, I: 0.0001, c: 0.0005, scaleInterest: false, cap: 0.005 }, impactUsd: 25_000 })
  const pair = matchCross([a], [b])[0]
  const settings = { notional: 10_000, hours: 24 * 30, fundingBasis: 'now', basisMode: 'hold', leverage: 2, fundingImpact: 'off' }
  const hlFunding = { params: fundingParams, premiumShift: (bk, side, qty, perp, ref) => premiumShift(bk, side, qty, perp.oracle ?? ref, hyperliquidImpact(perp)) }
  return {
    pair,
    settings,
    a: { books: new Map([[a.key, books.a]]), history: new Map(), fees: hyperliquidFees(), funding: hlFunding },
    b: { books: new Map([[b.key, books.b]]), history: new Map(), fees: { taker: () => 0, maker: () => 0 }, funding: LIGHTER_FUNDING },
  }
}

test('cross evaluation: short the higher rate, earn the difference, pay four orders', () => {
  const { pair, settings, a, b } = ctxs(0.0001, 0.00002, { a: book(2000, 0.05, 0.1), b: book(2000, 0.05, 0.1) })
  const r = evaluateCross(pair, { a, b, settings })
  assert.equal(r.short, 'a')
  assert.equal(r.direction, 'shortA')
  near(r.rate.value, 0.00008)
  near(r.fundingApr, 0.00008 * 8760)
  assert.deepEqual(r.trip.order, ['aEntry', 'bEntry', 'aExit', 'bExit'])
  assert.equal(r.trip.legs.aEntry.side, 'sell')
  assert.equal(r.trip.legs.bEntry.side, 'buy')
  // HL taker 4,5 bps on both HL orders, Lighter free.
  near(r.trip.legs.aEntry.bps.fee, 4.5)
  near(r.trip.legs.bExit.bps.fee, 0)
  // Funding: $10k × 0,008 %/h × 720 h = $576, minus costs.
  near(r.econ.fundingUsd, 10_000 * 0.00008 * 720)
  assert.ok(r.econ.netUsd < r.econ.fundingUsd && r.econ.netUsd > 0)
  // Margin on both venues.
  near(r.econ.capital, 10_000)
  assert.equal(r.status, 'profit')
})

test('cross evaluation: the other way round when Lighter pays more', () => {
  const { pair, settings, a, b } = ctxs(-0.00005, 0.0001, { a: book(2000, 0.05, 0.1), b: book(2000, 0.05, 0.1) })
  const r = evaluateCross(pair, { a, b, settings })
  assert.equal(r.short, 'b')
  near(r.rate.value, 0.00015)
  assert.equal(r.trip.legs.bEntry.side, 'sell')
})

test('cross evaluation: a missing book names its venue', () => {
  const { pair, settings, a, b } = ctxs(0.0001, 0, { a: book(2000, 0.05, 0.1), b: { bids: [], asks: [] } })
  const r = evaluateCross(pair, { a, b, settings })
  assert.equal(r.status, 'nobook')
  assert.equal(r.missing, 'b')
})

test('cross evaluation: converging prices pay the side that sold the richer perp', () => {
  // Lighter 10 bps over HL; shorting Lighter captures it when prices converge.
  const { pair, settings, a, b } = ctxs(0, 0.0001, { a: book(2000, 0.05, 0.1), b: book(2002, 0.05, 0.1) })
  const r = evaluateCross(pair, { a, b, settings: { ...settings, basisMode: 'converge' } })
  assert.equal(r.short, 'b')
  assert.ok(r.basis > 9 && r.basis < 11, `basis ${r.basis}`)
  assert.ok(r.econ.basisUsd > 9)
})

test('spread history lines up both venues by hour and signs it for the chosen side', () => {
  const H = 3_600_000
  const a = [{ time: 10 * H, rate: 0.0003 }, { time: 11 * H, rate: 0.0001 }, { time: 12 * H, rate: 0.0002 }]
  const b = [{ time: 11 * H + 1000, rate: 0.00005 }, { time: 12 * H, rate: 0.0003 }]
  const s = spreadHistory(a, b, 'a')
  assert.equal(s.length, 2)
  near(s[0].rate, 0.00005)
  near(s[1].rate, -0.0001)
  assert.equal(spreadHistory(a, null, 'a'), null)
})

test('who pays: shorts receive a positive rate and pay a negative one, longs the reverse', async () => {
  const { fundingFlow } = await import('../site/js/ui/cross-detail.js')
  assert.equal(fundingFlow(true, 0.0001).verb, 'erhält')
  assert.equal(fundingFlow(true, -0.0001).verb, 'zahlt')
  assert.equal(fundingFlow(false, 0.0001).verb, 'zahlt')
  assert.equal(fundingFlow(false, -0.0001).verb, 'erhält')
})

test('one funding basis for both legs while either history is still loading', () => {
  const { pair, settings, a, b } = ctxs(0.0001, 0.00002, { a: book(2000, 0.05, 0.1), b: book(2000, 0.05, 0.1) })
  const H = 3_600_000
  // Lighter has a week of −0,01 %/h; Hyperliquid's history has not arrived yet.
  b.history.set(pair.b.key, Array.from({ length: 168 }, (_, i) => ({ time: i * H, rate: -0.0001 })))
  const r = evaluateCross(pair, { a, b, settings: { ...settings, fundingBasis: 'avg7d' } })
  assert.equal(r.rates.a.source, 'now')
  assert.equal(r.rates.b.source, 'now')
  near(r.rates.b.value, 0.00002)
  assert.equal(r.rate.fallback, true)
})
