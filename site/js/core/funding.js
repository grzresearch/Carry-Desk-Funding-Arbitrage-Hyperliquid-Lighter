// Funding as the exchanges compute it, and how much your own perp order moves it.
//
// The hourly rate is m · (P + clamp(I − P, −c, c)) / 8 on Hyperliquid: the premium
// index P plus an interest rate I it is clamped towards. While P stays within ±c of I,
// funding sits exactly at the interest rate (10,95 % p.a. on the main dex) whatever the
// premium — only funding above that baseline comes from the premium, and only that part
// is what a short pushes away. Lighter uses the same shape, but scales only the premium
// and the clamp by its multiplier, not the interest rate, and caps per market.
//
// P is read from the book: impact prices are the VWAPs of trading a small notional
// ($6k; $20k for BTC/ETH on Hyperliquid, $500 of margin on Lighter) on each side. A
// market order of ours removes liquidity, so the impact price on that side moves and
// with it the premium.
//
// How long that lasts depends on how fast the book refills. Assuming it never does is
// an upper bound ('max'). The realistic estimate ('real') weights the shift by your
// size relative to the perp's hourly volume: a market that trades many times your
// order each hour has refilled long before the funding hour is averaged.

import { walk } from './book.js'

/** Funding is capped at 4 % per hour on every market. */
export const FUNDING_CAP = 0.04

const MAIN = { m: 1, I: 0.0001, c: 0.0005 }
const HIP3 = { m: 1, I: 0.0001, c: 0.0003 }

/** Funding parameters of a perp: multiplier, 8h interest rate, clamp (HIP-3 per asset). */
export function fundingParams(perp) {
  if (!perp.dex) return MAIN
  return {
    m: perp.fundingMultiplier ?? HIP3.m,
    I: perp.fundingInterest ?? HIP3.I,
    c: perp.fundingClamp ?? HIP3.c,
  }
}

/** Notional Hyperliquid uses for impact prices. */
export function impactNotional(perp) {
  return !perp.dex && (perp.symbol === 'BTC' || perp.symbol === 'ETH') ? 20_000 : 6_000
}

/** How Hyperliquid reads the premium of a perp: HIP-3 dexes use the impact mid. */
export function hyperliquidImpact(perp) {
  return { hip3: Boolean(perp.dex), impactUsd: impactNotional(perp) }
}

/**
 * Hourly funding for a premium index P: (m·P + clamp(i − m·P, ±m·c)) / 8, capped.
 * Hyperliquid scales the interest rate too (i = m·I, which is m · (P + clamp(I − P, ±c)));
 * Lighter does not (`scaleInterest: false`, i = I) and caps at its own big clamp.
 */
export function hourlyFunding(P, { m, I, c, scaleInterest = true, cap = FUNDING_CAP }) {
  const premium = m * P
  const interest = scaleInterest ? m * I : I
  const f8 = premium + Math.min(m * c, Math.max(-m * c, interest - premium))
  return Math.max(-cap, Math.min(cap, f8 / 8))
}

/** VWAP of trading `usd` notional into `levels`; a dry book fills the rest at `fallback`. */
function impactPrice(levels, usd, fallback) {
  let qty = 0
  let notional = 0
  for (const { px, sz } of levels) {
    const take = Math.min(sz, (usd - notional) / px)
    qty += take
    notional += take * px
    if (notional >= usd * (1 - 1e-9)) return notional / qty
  }
  if (!(fallback > 0)) return qty ? notional / qty : null
  const rest = (usd - notional) / fallback
  return (notional + rest * fallback) / (qty + rest)
}

/**
 * Premium index of a book. Hyperliquid's main dex and Lighter count only impact prices
 * beyond the oracle; HIP-3 dexes use the mid of the impact prices.
 */
export function premiumIndex(book, oracle, { hip3, impactUsd, fallback = {} }) {
  const ib = impactPrice(book.bids, impactUsd, fallback.bids)
  const ia = impactPrice(book.asks, impactUsd, fallback.asks)
  if (ib == null || ia == null || !(oracle > 0)) return null
  if (hip3) return (ib + ia) / 2 / oracle - 1
  return (Math.max(ib - oracle, 0) - Math.max(oracle - ia, 0)) / oracle
}

/** The book after a market order of `qty` has taken liquidity from one side. */
export function afterOrder(book, side, qty) {
  const key = side === 'buy' ? 'asks' : 'bids'
  const rest = []
  let left = qty
  for (const level of book[key]) {
    if (left <= 0) rest.push(level)
    else if (level.sz > left) {
      rest.push({ px: level.px, sz: level.sz - left })
      left = 0
    } else left -= level.sz
  }
  return { ...book, [key]: rest }
}

/**
 * How much a market order of `qty` moves the premium index (signed). A book the order
 * empties is priced at the order's worst fill. `opts` says how the venue reads the
 * premium: { hip3, impactUsd }.
 */
export function premiumShift(book, side, qty, oracle, opts) {
  const before = premiumIndex(book, oracle, opts)
  const worst = walk(side === 'buy' ? book.asks : book.bids, qty).worstPx
  const after = premiumIndex(afterOrder(book, side, qty), oracle, { ...opts, fallback: { [side === 'buy' ? 'asks' : 'bids']: worst } })
  return before == null || after == null ? null : after - before
}

/**
 * Share of the immediate premium shift that persists: 1 in 'max' mode, else your
 * notional over the perp's hourly volume (capped at 1; unknown volume counts as thin).
 */
export function persistence(notional, perp, mode = 'real') {
  if (mode === 'max') return 1
  const hourly = (perp.volume ?? 0) / 24
  return hourly > 0 ? Math.min(1, notional / hourly) : 1
}

/**
 * The funding rate to expect with your position on: the base rate (current or an
 * average) moved by what your order does to the premium, through the funding formula.
 */
export function fundingAtSize({ baseRate, basePremium, shift, params }) {
  if (basePremium == null || shift == null || !Number.isFinite(basePremium)) return baseRate
  return baseRate + hourlyFunding(basePremium + shift, params) - hourlyFunding(basePremium, params)
}
