// Carry economics of a delta-neutral position (spot/perp or perp/perp): funding earned
// versus the implementation shortfall paid to get in and out, and the size that
// maximises it.

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
 * Capital is the spot leg plus the perp margin at `leverage` (override with
 * `capitalPerNotional`, e.g. two perp margins for a perp/perp trade).
 */
export function carryEconomics({ trip, hourlyRate, hours, basis = 0, basisMode = 'hold', leverage = 1, capitalPerNotional = 1 + 1 / leverage }) {
  const { notional, costUsd, direction } = trip
  const rate = direction === 'carry' ? hourlyRate : -hourlyRate
  const fundingUsd = notional * rate * hours
  const captured = basisMode === 'converge' && basis != null ? (direction === 'carry' ? basis : -basis) : 0
  const basisUsd = (notional * captured) / 1e4
  const netUsd = fundingUsd + basisUsd - costUsd
  const capital = notional * capitalPerNotional
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
export function sizeCurve({ tripAt, capacity: cap, hourlyRate, rateAt, hours, basis, basisMode, leverage, capitalPerNotional, chosen = 0, minNotional = 50, steps = 56, ...spotPerp }) {
  // Spot/perp callers may pass books instead of a trip function.
  if (!tripAt) {
    tripAt = (notional) => roundTrip({ ...spotPerp, notional })
    cap = capacity(spotPerp)
  }
  if (!(cap > minNotional)) return { capacity: cap, points: [], best: null, maxProfitable: null, depthLimited: false }
  // `rateAt(trip)` lets funding depend on size (your own order moves the premium).
  const netAt = (notional) => {
    const trip = tripAt(notional)
    if (!trip?.complete) return null
    const rate = rateAt ? rateAt(trip) : hourlyRate
    const econ = carryEconomics({ trip, hourlyRate: rate, hours, basis, basisMode, leverage, capitalPerNotional })
    return { notional, netUsd: econ.netUsd, costBps: trip.costBps, netApr: econ.netApr, fundingApr: econ.fundingApr }
  }
  // The chosen size is always on the curve, so the optimum is never below it.
  const grid = logGrid(minNotional, cap, steps)
  if (chosen > minNotional && chosen < cap) grid.splice(grid.findIndex((n) => n > chosen), 0, chosen)
  const points = []
  for (const notional of grid) {
    const point = netAt(notional)
    if (!point) {
      // The book ran dry between two grid points: find the largest size that still fills.
      const prev = points[points.length - 1]
      if (prev) {
        let lo = prev.notional
        let hi = notional
        for (let k = 0; k < 12; k++) {
          const mid = Math.sqrt(lo * hi)
          if (netAt(mid)) lo = mid
          else hi = mid
        }
        if (lo > prev.notional * 1.001) points.push(netAt(lo))
      }
      break
    }
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
    for (let k = 0; k < 20; k++) {
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
