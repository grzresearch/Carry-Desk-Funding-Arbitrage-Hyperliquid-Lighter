// Cross-venue perp/perp funding arbitrage: the same underlying on two venues, short
// where funding is higher, long where it is lower, pocketing the difference — minus the
// implementation shortfall of four market orders on two different books.

import { midPrice, spreadBps } from './book.js'
import { hedgeTrip, hedgeCapacity, arrivalPrice } from './shortfall.js'
import { carryEconomics, sizeCurve, HOURS_PER_YEAR } from './carry.js'
import { fundingRate, premiumFor, keyOf } from './evaluate.js'
import { fundingAtSize, persistence } from './funding.js'
import { takenQty } from './execution.js'
import { perpUnderlying, PROXY_CLASSES, COMMODITIES, FX } from './matching.js'

/**
 * Allowed price gap (per unit of underlying) before two same-named perps count as
 * different assets. Simultaneous snapshots agree within 0.2 % for crypto and listed
 * equities; more than `flag` is shown (synthetic pre-IPO markets drift apart).
 */
export const CROSS_TOLERANCE = { same: 0.05, proxy: 0.03, flag: 0.01 }

/**
 * Join key of a perp. Adapters name every perp in Hyperliquid's terms (`canonical`,
 * e.g. Lighter XAU → GOLD); contract sizes come from perpUnderlying (kPEPE = 1000 PEPE)
 * and equivalent exposure from the proxy classes (an ETF-scaled S&P perp against the
 * index level).
 */
function joinKey(perp) {
  const { underlying, units } = perpUnderlying({ symbol: perp.canonical ?? perp.symbol })
  const proxy = PROXY_CLASSES.find((c) => c.perps[underlying] != null)
  return proxy ? { key: proxy.key, underlying, units: proxy.perps[underlying] } : { key: underlying, underlying, units }
}

const priceOf = (p) => p.oracle ?? p.mid ?? p.mark

function categoryOf(key, a, b) {
  if (COMMODITIES.has(key)) return 'commodity'
  if (FX.has(key)) return 'fx'
  // Hyperliquid's own dex lists crypto only; real-world assets live on HIP-3 dexes.
  if (!a.dex) return 'crypto'
  if (b.category && b.category !== 'crypto') return b.category
  if (key === 'S&P 500' || key === 'Nasdaq-100' || a.growthMode === 'enabled') return 'equity'
  return 'crypto'
}

/**
 * Every perp of venue A × every perp of venue B on the same underlying, confirmed by
 * price: a shared ticker is not enough (QNT is a token on one venue and a stock on the
 * other). `units` converts prices: perp B price ≈ perp A price × units.
 */
export function matchCross(perpsA, perpsB) {
  const byKey = new Map()
  for (const b of perpsB) {
    const j = joinKey(b)
    if (!byKey.has(j.key)) byKey.set(j.key, [])
    byKey.get(j.key).push({ perp: b, ...j })
  }
  const pairs = []
  for (const a of perpsA) {
    const ja = joinKey(a)
    for (const jb of byKey.get(ja.key) ?? []) {
      const b = jb.perp
      const units = jb.units / ja.units
      // Same underlying (whatever the contract size) or merely equivalent exposure.
      const kind = ja.underlying === jb.underlying ? 'same' : 'proxy'
      const pa = priceOf(a)
      const pb = priceOf(b)
      const deviation = pa && pb ? pb / units / pa - 1 : null
      if (deviation == null || Math.abs(deviation) > CROSS_TOLERANCE[kind]) continue
      pairs.push({
        type: 'cross',
        id: `${a.key}|${b.key}`,
        key: ja.key,
        underlying: ja.key,
        a,
        b,
        units,
        kind,
        deviation,
        flagged: kind === 'same' && Math.abs(deviation) > CROSS_TOLERANCE.flag,
        category: categoryOf(ja.key, a, b),
      })
    }
  }
  return pairs
}

/**
 * Evaluate one cross pair. `ctxA`/`ctxB` are each venue's { books, history, fees,
 * funding, execute } and `settings` the shared assumptions.
 */
export function evaluateCross(pair, { a: ctxA, b: ctxB, settings }) {
  const bookA = ctxA.books.get(keyOf(pair.a))
  const bookB = ctxB.books.get(keyOf(pair.b))
  const histA = ctxA.history?.get(keyOf(pair.a))
  const histB = ctxB.history?.get(keyOf(pair.b))
  // One basis for both legs: while either venue's history is still loading, both use the
  // current rate — one leg's now against the other's week matches no assumption.
  let rateA = fundingRate(pair.a, histA, settings.fundingBasis)
  let rateB = fundingRate(pair.b, histB, settings.fundingBasis)
  if (rateA.fallback !== rateB.fallback) {
    rateA = { ...fundingRate(pair.a, histA, 'now'), fallback: true }
    rateB = { ...fundingRate(pair.b, histB, 'now'), fallback: true }
  }
  // Longs pay shorts at a positive rate: short where it is higher, long where it is lower.
  const short = rateA.value >= rateB.value ? 'a' : 'b'
  const earned = Math.abs(rateA.value - rateB.value)
  const fees = { a: ctxA.fees.taker(pair.a), b: ctxB.fees.taker(pair.b) }
  const refA = arrivalPrice(bookA, pair.a.oracle) ?? midPrice(bookA) ?? priceOf(pair.a)
  const refB = arrivalPrice(bookB, refA ? refA * pair.units : pair.b.oracle) ?? midPrice(bookB) ?? priceOf(pair.b)
  // Perp B over perp A per unit of underlying, in bps. Proxies carry no basis signal.
  const basis = pair.kind === 'proxy' || !refA || !refB ? null : ((refB / pair.units - refA) / refA) * 1e4
  const base = {
    pair,
    type: 'cross',
    rates: { a: rateA, b: rateB },
    rate: { value: earned, source: rateA.source, fallback: rateA.fallback || rateB.fallback },
    short,
    direction: short === 'a' ? 'shortA' : 'shortB',
    fundingApr: earned * HOURS_PER_YEAR,
    fees,
    basis,
    spotMid: refA, // leg A's reference (UI reuses the spot slot for the first leg)
    perpMid: refB,
    spread: { a: spreadBps(bookA), b: spreadBps(bookB) },
  }
  const twoSided = (book) => Boolean(book?.bids?.length && book?.asks?.length)
  if (bookA === undefined || bookB === undefined) return { ...base, status: 'loading' }
  if (!twoSided(bookA)) return { ...base, status: 'nobook', missing: 'a' }
  if (!twoSided(bookB)) return { ...base, status: 'nobook', missing: 'b' }

  const legs = [
    { name: 'a', book: bookA, entry: short === 'a' ? 'sell' : 'buy', ref: refA, feeBps: fees.a, execute: ctxA.execute },
    { name: 'b', book: bookB, entry: short === 'b' ? 'sell' : 'buy', ref: refB, feeBps: fees.b, execute: ctxB.execute },
  ]
  const tripAt = (notional) => {
    const trip = hedgeTrip({ legs, notional })
    return trip && { ...trip, direction: 'carry' }
  }

  // Each order moves its own venue's premium: the short pushes the rate it earns down,
  // the long pushes the rate it pays up. Both shrink the spread you collect.
  const premA = premiumFor(pair.a, histA, rateA)
  const premB = premiumFor(pair.b, histB, rateB)
  const impact = settings.fundingImpact ?? 'real'
  const rateAt = (trip) => {
    if (impact === 'off') return earned
    const at = (leg, perp, ctx, book, rate, prem) => {
      const shift = ctx.funding.premiumShift(book, leg.entry, takenQty(trip.legs[`${leg.name}Entry`]), perp, leg.ref)
      const kept = persistence(trip.notional, perp, impact)
      return fundingAtSize({ baseRate: rate.value, basePremium: prem, shift: shift == null ? null : shift * kept, params: ctx.funding.params(perp) })
    }
    const rA = at(legs[0], pair.a, ctxA, bookA, rateA, premA)
    const rB = at(legs[1], pair.b, ctxB, bookB, rateB, premB)
    return short === 'a' ? rA - rB : rB - rA
  }
  // Converging prices pay the side that sold the richer perp.
  const capture = basis == null ? null : short === 'b' ? basis : -basis
  const capitalPerNotional = 2 / settings.leverage
  const common = { hours: settings.hours, basis: capture, basisMode: settings.basisMode, leverage: settings.leverage, capitalPerNotional }
  const trip = tripAt(settings.notional)
  const rateAtSize = rateAt(trip)
  const econ = carryEconomics({ trip, hourlyRate: rateAtSize, ...common })
  const curve = sizeCurve({ tripAt, capacity: hedgeCapacity(legs), rateAt, chosen: settings.notional, ...common })
  const atSize = { rate: rateAtSize, apr: rateAtSize * HOURS_PER_YEAR }
  if (!trip.complete) return { ...base, trip, econ: null, curve, atSize, status: 'thin' }
  return { ...base, trip, econ, curve, atSize, status: econ.netUsd > 0 ? 'profit' : 'loss' }
}
