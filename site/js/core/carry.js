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
 * Hold a round trip `trip` for `hours` at `hourlyRate` funding.
 *
 * basisMode 'hold'     exit basis equals entry basis: no basis P&L (conservative)
 * basisMode 'converge' basis closes to zero by exit: the carry side pockets a perp
 *                      premium, the reverse side a perp discount
 *
 * Capital is the spot leg plus the perp margin at `leverage`.
 */
export function carryEconomics({ trip, hourlyRate, hours, basis = 0, basisMode = 'hold', leverage = 1 }) {
  const { notional, costUsd, direction } = trip
  const rate = Math.abs(hourlyRate)
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
export function sizeCurve({ spotBook, perpBook, direction, hourlyRate, hours, spotFeeBps, perpFeeBps, basis, basisMode, leverage, minNotional = 50, steps = 56 }) {
  const cap = capacity({ spotBook, perpBook, direction })
  if (!(cap > minNotional)) return { capacity: cap, points: [], best: null, maxProfitable: null, depthLimited: false }
  const points = []
  for (const notional of logGrid(minNotional, cap, steps)) {
    const trip = roundTrip({ spotBook, perpBook, notional, direction, spotFeeBps, perpFeeBps })
    if (!trip?.complete) break
    const econ = carryEconomics({ trip, hourlyRate, hours, basis, basisMode, leverage })
    points.push({ notional, netUsd: econ.netUsd, costBps: trip.costBps, netApr: econ.netApr })
  }
  let best = null
  let maxProfitable = null
  for (const p of points) {
    if (p.netUsd > 0 && (!best || p.netUsd > best.netUsd)) best = p
    if (p.netUsd > 0) maxProfitable = p
  }
  // Still rising at the last visible level: the true optimum lies beyond the data.
  const depthLimited = Boolean(best) && best === points[points.length - 1]
  return { capacity: cap, points, best, maxProfitable, depthLimited }
}
