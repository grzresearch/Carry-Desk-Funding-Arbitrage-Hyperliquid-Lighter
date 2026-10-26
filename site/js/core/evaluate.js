// One pair, live books and the user's assumptions in; one row of economics out.

import { midPrice, spreadBps } from './book.js'
import { roundTrip } from './shortfall.js'
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
  const spotMid = midPrice(spotBook) ?? pair.spot.mid
  const perpMid = midPrice(perpBook) ?? pair.perp.mid ?? pair.perp.mark
  const q = pair.quoteUsd ?? 1
  // A proxy's price level depends on its scale, so its "basis" carries no signal.
  const basis = pair.kind === 'proxy' ? null : basisBps(spotMid && spotMid * q, perpMid, pair.perpUnits)
  const base = {
    pair,
    rate,
    direction,
    fees,
    basis,
    spotMid,
    perpMid,
    spread: { spot: spreadBps(spotBook), perp: spreadBps(perpBook) },
    fundingApr: rate.value * 24 * 365,
  }

  if (spotBook === undefined || perpBook === undefined) return { ...base, status: 'loading' }
  // One-sided books happen right at a listing: asks from the issuer, no bids yet.
  const oneSided = (book) => Boolean(book?.bids?.length || book?.asks?.length)
  if (!twoSided(spotBook)) return { ...base, status: 'nobook', missing: 'spot', oneSided: oneSided(spotBook) }
  if (!twoSided(perpBook)) return { ...base, status: 'nobook', missing: 'perp', oneSided: oneSided(perpBook) }

  const common = { spotBook, perpBook, direction, spotFeeBps: fees.spot, perpFeeBps: fees.perp }
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
  const status = !trip.complete ? 'thin' : econ.netUsd > 0 ? 'profit' : 'loss'
  return { ...base, trip, econ, curve, status }
}

/** Rank: earning rows first by net, then rows that cannot fill, then rows without books. */
export const STATUS_RANK = { profit: 0, loss: 1, thin: 2, nobook: 3, loading: 4 }
