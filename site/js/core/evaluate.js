// One pair, live books and the user's assumptions in; one row of economics out.

import { midPrice, spreadBps } from './book.js'
import { roundTrip, arrivalPrice, PLANS } from './shortfall.js'
import { fundingParams, premiumShift, hyperliquidImpact, fundingAtSize, persistence } from './funding.js'
import { hyperliquidFees } from './fees.js'
import { TOLERANCE } from './matching.js'
import { carryEconomics, sizeCurve, basisBps, directionFor } from './carry.js'
import { takenQty } from './execution.js'

const HOUR = 3_600_000

/**
 * The hourly funding rate to plan with. Averages need history; until it has loaded the
 * current rate stands in and the row says so.
 */
export function fundingRate(perp, history, basis) {
  if (basis !== 'now' && history?.length) {
    const span = basis === 'avg24' ? 24 : 168
    const cutoff = history[history.length - 1].time - span * HOUR
    const recent = history.filter((h) => h.time > cutoff)
    if (recent.length) {
      const value = recent.reduce((s, h) => s + h.rate, 0) / recent.length
      return { value, source: basis, samples: recent.length, fallback: false }
    }
  }
  return { value: perp.funding, source: 'now', samples: 1, fallback: basis !== 'now' }
}

/** Premium index matching the funding basis: the latest sample or the window average. */
export function premiumFor(perp, history, rate) {
  if (rate.source === 'now') return perp.premium
  const span = rate.source === 'avg24' ? 24 : 168
  const cutoff = history[history.length - 1].time - span * HOUR
  const recent = history.filter((h) => h.time > cutoff && Number.isFinite(h.premium))
  return recent.length ? recent.reduce((s, h) => s + h.premium, 0) / recent.length : perp.premium
}

const twoSided = (book) => Boolean(book?.bids?.length && book?.asks?.length)

/** Venue-neutral defaults: Hyperliquid's fee and funding models. */
const HL_FUNDING = {
  params: fundingParams,
  premiumShift: (book, side, qty, perp, ref) => premiumShift(book, side, qty, perp.oracle ?? ref, hyperliquidImpact(perp)),
}

export const keyOf = (market) => market.key ?? market.coin

/**
 * @param {object} pair      a spot/perp pair from a venue's matcher
 * @param {object} ctx
 * @param {Map}    ctx.books    market key → book (already stitched with any coarse tail)
 * @param {Map}    ctx.history  perp key → [{ time, rate, premium }]
 * @param {object} ctx.settings { notional, hours, fundingBasis, basisMode, leverage, fundingImpact }
 * @param {object} ctx.fees     the venue's fee model: { taker(market), maker(market) }
 * @param {object} ctx.funding  the venue's funding model: { params(perp), premiumShift(...) }
 * @param {object} ctx.execute  per-leg order pricing { spot, perp } (core/execution.js);
 *                              a leg without one is a market order
 */
export function evaluatePair(pair, { books, history, settings, fees: feeModel = hyperliquidFees(), funding = HL_FUNDING, execute = {} }) {
  const spotBook = books.get(keyOf(pair.spot))
  const perpBook = books.get(keyOf(pair.perp))
  const perpHistory = history?.get(keyOf(pair.perp))
  const rate = fundingRate(pair.perp, perpHistory, settings.fundingBasis)
  const direction = directionFor(rate.value)
  const fees = { spot: feeModel.taker(pair.spot), perp: feeModel.taker(pair.perp) }
  const q = pair.quoteUsd ?? 1
  const perpMid = midPrice(perpBook) ?? pair.perp.mid ?? pair.perp.mark
  const perpRef = arrivalPrice(perpBook, pair.perp.oracle) ?? perpMid
  // The perp's fair price per spot token, in the spot's quote currency.
  const spotFair = perpRef ? perpRef / pair.perpUnits / q : null
  const spotRef = arrivalPrice(spotBook, spotFair) ?? pair.spot.mid
  // A proxy's price level depends on its scale, so its "basis" carries no signal.
  const basis = pair.kind === 'proxy' ? null : basisBps(spotRef && spotRef * q, perpRef, pair.perpUnits)
  const base = {
    pair,
    rate,
    direction,
    fees,
    basis,
    spotMid: spotRef,
    perpMid: perpRef,
    spread: { spot: spreadBps(spotBook), perp: spreadBps(perpBook) },
    fundingApr: rate.value * 24 * 365,
  }

  if (spotBook === undefined || perpBook === undefined) return { ...base, status: 'loading' }
  // One-sided books happen right at a listing: asks from the issuer, no bids yet.
  const oneSided = (book) => Boolean(book?.bids?.length || book?.asks?.length)
  if (!twoSided(spotBook)) return { ...base, status: 'nobook', missing: 'spot', oneSided: oneSided(spotBook) }
  if (!twoSided(perpBook)) return { ...base, status: 'nobook', missing: 'perp', oneSided: oneSided(perpBook) }
  // Matched by issuer convention despite a skewed context mid: the real quotes decide.
  if (pair.verify === 'book' && (spotFair < spotBook.bids[0].px * (1 - TOLERANCE.strong) || spotFair > spotBook.asks[0].px * (1 + TOLERANCE.strong))) {
    return { ...base, status: 'mismatch' }
  }

  // Your perp order eats into the book the premium is read from. Through the funding
  // formula that lowers the rate you earn — only above the interest baseline — for as
  // long as the consumed liquidity stays missing (see persistence in core/funding.js).
  const params = funding.params(pair.perp)
  const basePremium = premiumFor(pair.perp, perpHistory, rate)
  const perpSide = PLANS[direction].perpEntry
  const impact = settings.fundingImpact ?? 'real'
  const rateAt = (trip) => {
    if (impact === 'off') return rate.value
    // Only what takes liquidity moves the premium: a maker leg's filled share rests.
    const shift = funding.premiumShift(perpBook, perpSide, takenQty(trip.legs.perpEntry), pair.perp, perpRef)
    const kept = persistence(trip.notional, pair.perp, impact)
    return fundingAtSize({ baseRate: rate.value, basePremium, shift: shift == null ? null : shift * kept, params })
  }

  const common = { spotBook, perpBook, direction, spotFeeBps: fees.spot, perpFeeBps: fees.perp, spotRef, perpRef, spotExecute: execute.spot, perpExecute: execute.perp }
  const trip = roundTrip({ ...common, notional: settings.notional })
  const rateAtSize = rateAt(trip)
  const econ = carryEconomics({
    trip,
    hourlyRate: rateAtSize,
    hours: settings.hours,
    basis,
    basisMode: settings.basisMode,
    leverage: settings.leverage,
  })
  const curve = sizeCurve({
    ...common,
    rateAt,
    hours: settings.hours,
    basis,
    basisMode: settings.basisMode,
    leverage: settings.leverage,
  })
  // Economics of a size the books cannot fill would be fiction: only partial fills are
  // costed while funding accrues on the whole notional. Keep the trip, drop the econ.
  const atSize = { rate: rateAtSize, apr: rateAtSize * 24 * 365 * (direction === 'carry' ? 1 : -1), premium: basePremium }
  if (!trip.complete) return { ...base, trip, econ: null, curve, atSize, status: 'thin' }
  return { ...base, trip, econ, curve, atSize, status: econ.netUsd > 0 ? 'profit' : 'loss' }
}

/** Rank: earning rows first by net, then rows that cannot fill, then rows without books. */
export const STATUS_RANK = { profit: 0, loss: 1, thin: 2, nobook: 3, loading: 4, mismatch: 5 }
