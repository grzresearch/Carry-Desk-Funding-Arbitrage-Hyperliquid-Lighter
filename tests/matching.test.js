import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { buildUniverse } from '../site/js/core/universe.js'
import { matchPairs, spotCandidates, perpUnderlying } from '../site/js/core/matching.js'

const snapshot = JSON.parse(fs.readFileSync(new URL('./fixtures/universe.json', import.meta.url)))
const universe = buildUniverse(snapshot)
const pairs = matchPairs(universe)
const find = (spotName, perpCoin) => pairs.find((p) => p.spot.base.name === spotName && p.perp.coin === perpCoin && p.spot.quote === 'USDC')
const spotsOf = (spotName) => pairs.filter((p) => p.spot.base.name === spotName)

test('universe skips delisted perps and keeps every dex prefix', () => {
  assert.ok(universe.perps.every((p) => !p.coin.includes(':') || p.coin.startsWith(`${p.dex}:`)))
  assert.ok(!universe.perps.some((p) => p.coin === 'km:NVDA'), 'km dex is fully delisted in the fixture')
  const nvda = universe.perps.find((p) => p.coin === 'xyz:NVDA')
  assert.equal(nvda.symbol, 'NVDA')
  assert.equal(nvda.dex, 'xyz')
})

test('EQX tokenized equities join their HIP-3 perps, even before launch', () => {
  const nvda = find('EQNVDA', 'xyz:NVDA')
  assert.ok(nvda)
  assert.equal(nvda.issuer, 'EQX')
  assert.equal(nvda.kind, 'tokenized-equity')
  assert.equal(nvda.category, 'equity')
  // The full name says GOOGL although the token is EQGOOG.
  assert.ok(find('EQGOOG', 'xyz:GOOGL'))
  for (const t of ['EQTSLA', 'EQAAPL', 'EQMETA', 'EQMSFT', 'EQAMZN', 'EQMU', 'EQSPCX']) assert.ok(spotsOf(t).length, t)
})

test('xStocks strip their X suffix', () => {
  assert.equal(find('NVDAX', 'xyz:NVDA')?.issuer, 'xStocks')
  assert.ok(find('MUX', 'xyz:MU'))
  assert.ok(find('SKHYX', 'xyz:SKHY'))
})

test('Unit bridges resolve by symbol or by full name', () => {
  assert.equal(find('UBTC', 'BTC')?.issuer, 'Unit')
  assert.ok(find('UFART', 'FARTCOIN'), 'Unit Fartcoin → FARTCOIN')
  const bonk = find('UBONK', 'kBONK')
  assert.equal(bonk.perpUnits, 1000)
  assert.ok(Math.abs(bonk.deviation) < 0.02)
})

test('the same token pairs once per quote currency', () => {
  const quotes = new Set(spotsOf('HYPE').map((p) => p.spot.quote))
  for (const q of ['USDC', 'USDT0', 'USDE']) assert.ok(quotes.has(q), q)
})

test('proxy classes join ETF tokens to index perps with their price scale', () => {
  const sp = find('SPYX', 'xyz:SP500')
  assert.equal(sp.kind, 'proxy')
  assert.equal(sp.perpUnits, 10)
  assert.equal(sp.underlying, 'S&P 500')
  assert.ok(find('XAUT0', 'PAXG'), 'tokenised gold ↔ PAXG')
  assert.ok(find('XAUT0', 'xyz:GOLD'))
  assert.equal(find('XAUT0', 'PAXG').category, 'commodity')
})

test('liquid staking tokens and look-alikes are not hedges', () => {
  for (const t of ['KHYPE', 'HPEPE', 'HPUMP', 'HOP', 'HAR', 'QQQM', 'GLD', 'PEPE', 'PUMP', 'MON', 'FARM']) {
    assert.equal(spotsOf(t).length, 0, `${t} must not match`)
  }
})

test('bare tickers must be confirmed by price', () => {
  // Far off on the mid, but within 2×: kept only if the perp later sits inside the spot
  // bid/ask (these ticker tokens have books 10–120 % wide, so their mid means nothing).
  for (const t of ['AMZN', 'AVGO', 'META', 'TSLA', 'MU']) {
    const ps = spotsOf(t)
    assert.ok(ps.length && ps.every((p) => p.verify === 'bracket'), t)
  }
  // Close enough to count outright, but labelled as a weak match.
  const hood = find('HOOD', 'xyz:HOOD')
  assert.equal(hood.evidence, 'weak')
  assert.equal(hood.verify, null)
  // Squatters priced orders of magnitude away never match.
  for (const t of ['TRUMP', 'PEPE', 'PUMP', 'BERA', 'ANSEM', 'NEIRO']) assert.equal(spotsOf(t).length, 0, t)
})

test('research-backed overrides resolve', () => {
  assert.ok(spotsOf('WMNT').some((p) => p.perp.coin === 'MNT'))
  assert.ok(spotsOf('MMOVE').some((p) => p.perp.coin === 'MOVE'))
  assert.ok(spotsOf('LZCC').some((p) => p.perp.coin === 'CC'))
  assert.ok(spotsOf('USPYX').some((p) => p.underlying === 'S&P 500'))
})

test('quote tokens are discovered from the spot universe and priced in USD', () => {
  for (const q of ['USDC', 'USDT0', 'USDE', 'USDH']) assert.ok(universe.quotes.has(q), q)
  const hypeUsdt = pairs.find((p) => p.spot.base.name === 'HYPE' && p.spot.quote === 'USDT0')
  assert.ok(Math.abs(hypeUsdt.quoteUsd - 1) < 0.01)
})

test('stablecoins are quotes, never bases', () => {
  assert.ok(!pairs.some((p) => ['USDT0', 'USDE', 'USDH', 'FEUSD'].includes(p.spot.base.name)))
})

test('spotCandidates handles future listings by convention', () => {
  const eq = spotCandidates({ name: 'EQIBM', fullName: 'EQX Tokenized IBM' })
  assert.deepEqual(eq[0], { underlying: 'IBM', kind: 'tokenized-equity', issuer: 'EQX', evidence: 'strong' })
  const unit = spotCandidates({ name: 'UDOGE', fullName: 'Unit Dogecoin' }).map((c) => c.underlying)
  assert.deepEqual(unit.slice(0, 2), ['DOGE', 'DOGECOIN'])
  const x = spotCandidates({ name: 'COINX', fullName: 'Wrapped Coinbase xStock' })
  assert.equal(x[0].underlying, 'COIN')
  const near = spotCandidates({ name: 'ONEAR', fullName: 'NEAR Protocol' })
  assert.equal(near[0].underlying, 'NEAR')
  assert.equal(near[0].evidence, 'moderate')
  assert.deepEqual(spotCandidates({ name: 'KHYPE', fullName: 'Kinetiq Staked HYPE' }), [])
  assert.deepEqual(spotCandidates({ name: 'XHYPE', fullName: 'Some Staked HYPE' }), [])
})

test('perpUnderlying unwraps thousand-unit contracts', () => {
  assert.deepEqual(perpUnderlying({ symbol: 'kPEPE' }), { underlying: 'PEPE', units: 1000 })
  assert.deepEqual(perpUnderlying({ symbol: '1000PEPE' }), { underlying: 'PEPE', units: 1000 })
  assert.deepEqual(perpUnderlying({ symbol: 'NVDA' }), { underlying: 'NVDA', units: 1 })
})

test('every pair has a unique id', () => {
  assert.equal(new Set(pairs.map((p) => p.id)).size, pairs.length)
})
