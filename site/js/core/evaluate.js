// One pair, live books and the user's assumptions in; one row of economics out.

import { midPrice, spreadBps } from './book.js'
import { roundTrip, arrivalPrice } from './shortfall.js'
import { TOLERANCE } from './matching.js'
import { carryEconomics, sizeCurve, basisBps, directionFor } from './carry.js'
import { takerFeeBps } from './fees.js'

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

const twoSided = (book) => Boolean(book?.bids?.length && book?.asks?.length)

/**
 * @param {object} pair      from matchPairs()
 * @param {object} ctx
 * @param {Map}    ctx.books    coin → book (already stitched with any coarse tail)
 * @param {Map}    ctx.history  perp coin → [{ time, rate }]
 * @param {object} ctx.settings { notional, hours, fundingBasis, basisMode, leverage }
 * @param {object} ctx.rates    accountRates()
 * @param {object} ctx.quotes   { aligned, stable } token sets for the fee model
 */
export function evaluatePair(pair, { books, history, settings, rates, quotes }) {
  const spotBook = books.get(pair.spot.coin)
  const perpBook = books.get(pair.perp.coin)
  const rate = fundingRate(pair.perp, history?.get(pair.perp.coin), settings.fundingBasis)
  const direction = directionFor(rate.value)
  const fees = { spot: takerFeeBps(pair.spot, rates, quotes), perp: takerFeeBps(pair.perp, rates, quotes) }
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

  const common = { spotBook, perpBook, direction, spotFeeBps: fees.spot, perpFeeBps: fees.perp, spotRef, perpRef }
  const trip = roundTrip({ ...common, notional: settings.notional })
  const econ = carryEconomics({
    trip,
    hourlyRate: rate.value,
    hours: settings.hours,
    basis,
    basisMode: settings.basisMode,
    leverage: settings.leverage,
  })
  const curve = sizeCurve({
    ...common,
    hourlyRate: rate.value,
    hours: settings.hours,
    basis,
    basisMode: settings.basisMode,
    leverage: settings.leverage,
  })
  // Economics of a size the books cannot fill would be fiction: only partial fills are
  // costed while funding accrues on the whole notional. Keep the trip, drop the econ.
  if (!trip.complete) return { ...base, trip, econ: null, curve, status: 'thin' }
  return { ...base, trip, econ, curve, status: econ.netUsd > 0 ? 'profit' : 'loss' }
}

/** Rank: earning rows first by net, then rows that cannot fill, then rows without books. */
export const STATUS_RANK = { profit: 0, loss: 1, thin: 2, nobook: 3, loading: 4, mismatch: 5 }
