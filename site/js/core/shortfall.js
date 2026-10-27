// Implementation shortfall: what a market order really costs versus the price at the
// moment you decided to trade (the arrival mid).
//
// Every leg is decomposed into
//   spread  crossing from mid to the touch                filled × |best − mid|
//   impact  walking the book past the touch               |Σ px·sz − filled × best|
//   fee     taker fee on the executed notional            notional × feeBps
// and expressed in quote currency and in bps of the leg's arrival value (qty × mid).
// Both legs of a hedge are sized to the same notional, so leg bps simply add up.

import { midPrice, walk, sideDepth } from './book.js'

/** Order sides for each leg of a delta-neutral position. */
export const PLANS = {
  // Long spot, short perp: earns positive funding. Needs only quote currency.
  carry: { spotEntry: 'buy', perpEntry: 'sell', spotExit: 'sell', perpExit: 'buy' },
  // Short spot, long perp: earns negative funding. Needs spot inventory to sell.
  reverse: { spotEntry: 'sell', perpEntry: 'buy', spotExit: 'buy', perpExit: 'sell' },
}

export const LEGS = ['spotEntry', 'perpEntry', 'spotExit', 'perpExit']

/**
 * Shortfall of one market order of `qty` base units against the arrival price `ref`
 * (the mid unless the caller knows better). Null when the book is not two-sided.
 */
export function legShortfall(book, side, qty, feeBps, ref = midPrice(book)) {
  if (!ref || !midPrice(book) || !(qty > 0)) return null
  const levels = side === 'buy' ? book.asks : book.bids
  const best = levels[0].px
  const sign = side === 'buy' ? 1 : -1
  const fill = walk(levels, qty)
  const arrival = qty * ref
  const spread = fill.filled * sign * (best - ref)
  const impact = sign * (fill.notional - fill.filled * best)
  const fee = (fill.notional * feeBps) / 1e4
  const total = spread + impact + fee
  const bps = (x) => (x / arrival) * 1e4
  return {
    side,
    qty,
    mid: ref, // arrival price
    best,
    vwap: fill.vwap,
    worstPx: fill.worstPx,
    filled: fill.filled,
    fillRatio: fill.filled / qty,
    complete: fill.complete,
    levelsUsed: fill.levelsUsed,
    arrival,
    cost: { spread, impact, fee, total },
    bps: { spread: bps(spread), impact: bps(impact), fee: feeBps, total: bps(total) },
  }
}

/** Spreads wider than this make a mid meaningless (e.g. a lone lowball bid at a listing). */
export const WIDE_SPREAD_BPS = 200

/**
 * Arrival price of a leg: the mid, unless the book is so wide that its mid says nothing
 * — then the fair price (e.g. the hedge leg's price) clamped into the quotes. Round-trip
 * cost does not depend on this choice (each leg's mid cancels between entry and exit);
 * it only keeps the sizing and the per-order attribution honest on broken books.
 */
export function arrivalPrice(book, fair) {
  const mid = midPrice(book)
  if (!mid || !(fair > 0) || ((book.asks[0].px - book.bids[0].px) / mid) * 1e4 <= WIDE_SPREAD_BPS) return mid
  return Math.min(book.asks[0].px, Math.max(book.bids[0].px, fair))
}

const opposite = (side) => (side === 'buy' ? 'sell' : 'buy')
const sideOf = (book, orderSide) => (orderSide === 'buy' ? book.asks : book.bids)

/**
 * Enter and later exit a two-leg hedge of `notional` per leg, assuming the exit meets a
 * book like today's. Each leg is
 *   { name, book, entry: 'buy' | 'sell', ref, feeBps, execute }
 * where `execute(book, side, qty, feeBps, ref)` prices one order (a market order by
 * default; core/execution.js supplies the maker alternative). Legs come back keyed
 * `${name}Entry` / `${name}Exit`, in the order entries first, then exits.
 */
export function hedgeTrip({ legs, notional }) {
  if (!(notional > 0)) return null
  const out = {}
  const qty = {}
  const order = []
  for (const leg of legs) {
    const ref = leg.ref ?? midPrice(leg.book)
    if (!ref || !midPrice(leg.book)) return null
    qty[leg.name] = notional / ref
  }
  for (const phase of ['Entry', 'Exit']) {
    for (const leg of legs) {
      const side = phase === 'Entry' ? leg.entry : opposite(leg.entry)
      const run = leg.execute ?? legShortfall
      const key = `${leg.name}${phase}`
      out[key] = run(leg.book, side, qty[leg.name], leg.feeBps, leg.ref ?? midPrice(leg.book))
      order.push(key)
    }
  }
  let costUsd = 0
  let complete = true
  let limiting = null
  for (const key of order) {
    const leg = out[key]
    costUsd += leg.cost.total
    if (!leg.complete) {
      complete = false
      if (!limiting || leg.fillRatio < out[limiting].fillRatio) limiting = key
    }
  }
  return { notional, legs: out, order, qty, costUsd, costBps: (costUsd / notional) * 1e4, complete, limiting }
}

/**
 * Largest notional the visible books can absorb for a full round trip: the thinnest of
 * the sides the trip has to cross, valued at each side's own prices.
 */
export function hedgeCapacity(legs) {
  return Math.min(...legs.flatMap((l) => [sideDepth(sideOf(l.book, l.entry)).notional, sideDepth(sideOf(l.book, opposite(l.entry))).notional]))
}

/** The spot/perp legs of a carry trade in `direction`. */
export function carryLegs({ spotBook, perpBook, direction, spotFeeBps, perpFeeBps, spotRef, perpRef, spotExecute, perpExecute }) {
  const plan = PLANS[direction]
  return [
    { name: 'spot', book: spotBook, entry: plan.spotEntry, ref: spotRef, feeBps: spotFeeBps, execute: spotExecute },
    { name: 'perp', book: perpBook, entry: plan.perpEntry, ref: perpRef, feeBps: perpFeeBps, execute: perpExecute },
  ]
}

/**
 * Enter and later exit a spot/perp hedge of `notional` per leg. Returns the four legs,
 * their summed cost, and whether the visible depth can absorb the size at all.
 * `spotRef`/`perpRef` default to the mids.
 */
export function roundTrip({ notional, direction, ...rest }) {
  const trip = hedgeTrip({ legs: carryLegs({ direction, ...rest }), notional })
  if (!trip) return null
  return { ...trip, direction, spotQty: trip.qty.spot, perpQty: trip.qty.perp }
}

/** Capacity of a spot/perp round trip. */
export function capacity({ spotBook, perpBook, direction }) {
  return hedgeCapacity(carryLegs({ spotBook, perpBook, direction }))
}
