import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseAmount, usd, bps, pct, duration, price } from '../site/js/core/format.js'

test('parseAmount reads German and shorthand amounts', () => {
  assert.equal(parseAmount('10.000'), 10_000)
  assert.equal(parseAmount('1.250.000'), 1_250_000)
  assert.equal(parseAmount('1,5m'), 1_500_000)
  assert.equal(parseAmount('25k'), 25_000)
  assert.equal(parseAmount('$ 2 500'), 2500)
  assert.equal(parseAmount('12,5'), 12.5)
  assert.equal(parseAmount('abc'), null)
  assert.equal(parseAmount('0'), null)
})

test('formatters use German conventions and a true minus', () => {
  assert.equal(usd(1234.5), '$1.235')
  assert.equal(usd(-12.3), '−$12,30')
  assert.equal(usd(12, { sign: true }), '+$12,00')
  assert.equal(bps(12.345), '12,3')
  assert.equal(pct(0.1095), '10,95 %')
  assert.equal(duration(30), '30 h')
  assert.equal(duration(24 * 7), '7 T')
  assert.equal(duration(Infinity), '∞')
  assert.equal(usd(NaN), '–')
  assert.equal(price(80113.5), '80.113,5')
})
