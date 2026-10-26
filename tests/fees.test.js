import { test } from 'node:test'
import assert from 'node:assert/strict'
import { accountRates, takerFeeBps, hip3Scale, hip3DeployerShare } from '../site/js/core/fees.js'

const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`)
const base = accountRates()

test('base tier: 4.5 bps perp, 7 bps spot', () => {
  assert.deepEqual(base, { perp: 4.5, spot: 7 })
})

test('volume tier and staking discount compound', () => {
  const r = accountRates({ tier: 2, staking: 6 }) // > $25M, Diamond (−40 %)
  near(r.perp, 3.5 * 0.6)
  near(r.spot, 5 * 0.6)
})

test('main-dex perp pays the account rate', () => {
  assert.equal(takerFeeBps({ kind: 'perp', dex: '' }, base), 4.5)
})

test('HIP-3 deployer fee scale doubles the fee at 1.0, adds below 1', () => {
  assert.equal(hip3Scale(1), 2)
  near(hip3Scale(0.1111), 1.1111)
  assert.equal(hip3Scale(3), 6)
  near(hip3DeployerShare(1), 0.5)
  near(takerFeeBps({ kind: 'perp', dex: 'xyz', feeScale: 1, collateral: 'USDC' }, base), 9)
})

test('growth mode cuts the all-in HIP-3 fee by 90 %', () => {
  near(takerFeeBps({ kind: 'perp', dex: 'xyz', feeScale: 1, growthMode: 'enabled', collateral: 'USDC' }, base), 0.9)
})

test('aligned collateral discounts only the protocol part of a HIP-3 fee', () => {
  const aligned = new Set(['USDH'])
  // share 0.5 → (0.5 × 0.8 + 0.5) = 0.9 of 9 bps
  near(takerFeeBps({ kind: 'perp', dex: 'km', feeScale: 1, collateral: 'USDH' }, base, { aligned }), 8.1)
})

test('spot: stable pairs pay 20 %, aligned quotes 80 %', () => {
  const quotes = { aligned: new Set(['USDH']), stable: new Set(['USDC', 'USDH', 'USDT0']) }
  near(takerFeeBps({ kind: 'spot', base: { name: 'HYPE' }, quote: 'USDC' }, base, quotes), 7)
  near(takerFeeBps({ kind: 'spot', base: { name: 'HYPE' }, quote: 'USDH' }, base, quotes), 5.6)
  near(takerFeeBps({ kind: 'spot', base: { name: 'USDT0' }, quote: 'USDC' }, base, quotes), 1.4)
})
