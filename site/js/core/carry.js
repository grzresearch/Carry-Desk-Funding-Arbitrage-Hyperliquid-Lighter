// Carry economics of a delta-neutral spot/perp position: funding earned versus the
// implementation shortfall paid to get in and out, and the size that maximises it.

import { roundTrip, capacity } from './shortfall.js'

export const HOURS_PER_YEAR = 24 * 365

/** Positive funding: longs pay shorts, so hold spot and short the perp. */
export function directionFor(hourlyRate) {
  return hourlyRate < 0 ? 'reverse' : 'carry'
}

/**
 * Basis of the perp over spot, in bps of the spot price. Prices are compared per unit
 * of underlying, so `perpUnits` converts perp contracts (e.g. kBONK = 1000 BONK).
 */
export function basisBps(spotMid, perpMid, perpUnits = 1) {
  if (!spotMid || !perpMid) return null
  return ((perpMid / perpUnits - spotMid) / spotMid) * 1e4
}

/**
 * Hold a round trip `trip` for `hours` at `hourlyRate` funding. The rate is signed: the
 * carry side earns it, the reverse side earns its negative — so a rate your own order
 * has pushed past zero shows up as a loss.
 *
 * basisMode 'hold'     exit basis equals entry basis: no basis P&L (conservative)
 * basisMode 'converge' basis closes to zero by exit: the carry side pockets a perp
 *                      premium, the reverse side a perp discount
 *
 * Capital is the spot leg plus the perp margin at `leverage`.
 */
export function carryEconomics({ trip, hourlyRate, hours, basis = 0, basisMode = 'hold', leverage = 1 }) {
  const { notional, costUsd, direction } = trip
  const rate = direction === 'carry' ? hourlyRate : -hourlyRate
  const fundingUsd = notional * rate * hours
  const captured = basisMode === 'converge' && basis != null ? (direction === 'carry' ? basis : -basis) : 0
  const basisUsd = (notional * captured) / 1e4
  const netUsd = fundingUsd + basisUsd - costUsd
  const capital = notional * (1 + 1 / leverage)
  const annualise = HOURS_PER_YEAR / hours
  const hourlyIncome = notional * rate
  return {
    notional,
    direction,
    hours,
    fundingUsd,
    basisUsd,
    costUsd,
    netUsd,
    netBps: (netUsd / notional) * 1e4,
    fundingApr: rate * HOURS_PER_YEAR,
    netApr: (netUsd / notional) * annualise,
    capital,
    capitalApr: (netUsd / capital) * annualise,
    breakEvenHours: hourlyIncome > 0 ? Math.max(0, (costUsd - basisUsd) / hourlyIncome) : Infinity,
    complete: trip.complete,
    profitable: trip.complete && netUsd > 0,
  }
}

/** Log-spaced grid of `steps` points from `lo` to `hi` inclusive. */
export function logGrid(lo, hi, steps) {
  if (!(hi > lo)) return [lo]
  const a = Math.log(lo)
  const b = Math.log(hi)
  return Array.from({ length: steps }, (_, i) => Math.exp(a + ((b - a) * i) / (steps - 1)))
}

/**
 * Funding scales linearly with size, shortfall super-linearly, so net carry over a
 * horizon is concave in size. Trace it across the visible depth and report the size
 * that earns the most and the largest size that still earns anything.
 */
export function sizeCurve({ spotBook, perpBook, direction, hourlyRate, rateAt, hours, spotFeeBps, perpFeeBps, spotRef, perpRef, basis, basisMode, leverage, minNotional = 50, steps = 56 }) {
  const cap = capacity({ spotBook, perpBook, direction })
  if (!(cap > minNotional)) return { capacity: cap, points: [], best: null, maxProfitable: null, depthLimited: false }
  // `rateAt(trip)` lets funding depend on size (your own order moves the premium).
  const netAt = (notional) => {
    const trip = roundTrip({ spotBook, perpBook, notional, direction, spotFeeBps, perpFeeBps, spotRef, perpRef })
    if (!trip?.complete) return null
    const rate = rateAt ? rateAt(trip) : hourlyRate
    const econ = carryEconomics({ trip, hourlyRate: rate, hours, basis, basisMode, leverage })
    return { notional, netUsd: econ.netUsd, costBps: trip.costBps, netApr: econ.netApr, fundingApr: econ.fundingApr }
  }
  const points = []
  for (const notional of logGrid(minNotional, cap, steps)) {
    const point = netAt(notional)
    if (!point) break
    points.push(point)
  }
  let best = null
  let maxProfitable = null
  for (const p of points) {
    if (p.netUsd > 0 && (!best || p.netUsd > best.netUsd)) best = p
    if (p.netUsd > 0) maxProfitable = p
  }
  // Grid points sit ~15 % apart: bisect to the real break-even size, so a profitable
  // chosen size never lies beyond the reported maximum.
  const next = maxProfitable && points[points.indexOf(maxProfitable) + 1]
  if (next) {
    let lo = maxProfitable.notional
    let hi = next.notional
    for (let k = 0; k < 30; k++) {
      const mid = Math.sqrt(lo * hi)
      if ((netAt(mid)?.netUsd ?? -1) > 0) lo = mid
      else hi = mid
    }
    maxProfitable = netAt(lo)
  }
  // Still rising at the last visible level: the true optimum lies beyond the data.
  const depthLimited = Boolean(best) && best === points[points.length - 1]
  return { capacity: cap, points, best, maxProfitable, depthLimited }
}
