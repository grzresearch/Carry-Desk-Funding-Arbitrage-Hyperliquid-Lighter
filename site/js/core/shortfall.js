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

/**
 * Enter and later exit a hedge of `notional` per leg, assuming the exit meets a book
 * like today's. Returns the four legs, their summed cost, and whether the visible
 * depth can absorb the size at all. `spotRef`/`perpRef` default to the mids.
 */
export function roundTrip({ spotBook, perpBook, notional, direction, spotFeeBps, perpFeeBps, spotRef = midPrice(spotBook), perpRef = midPrice(perpBook) }) {
  if (!spotRef || !perpRef || !midPrice(spotBook) || !midPrice(perpBook) || !(notional > 0)) return null
  const plan = PLANS[direction]
  const spotQty = notional / spotRef
  const perpQty = notional / perpRef
  const legs = {
    spotEntry: legShortfall(spotBook, plan.spotEntry, spotQty, spotFeeBps, spotRef),
    perpEntry: legShortfall(perpBook, plan.perpEntry, perpQty, perpFeeBps, perpRef),
    spotExit: legShortfall(spotBook, plan.spotExit, spotQty, spotFeeBps, spotRef),
    perpExit: legShortfall(perpBook, plan.perpExit, perpQty, perpFeeBps, perpRef),
  }
  let costUsd = 0
  let complete = true
  let limiting = null
  for (const key of LEGS) {
    const leg = legs[key]
    costUsd += leg.cost.total
    if (!leg.complete) {
      complete = false
      if (!limiting || leg.fillRatio < legs[limiting].fillRatio) limiting = key
    }
  }
  return {
    notional,
    direction,
    spotQty,
    perpQty,
    legs,
    costUsd,
    costBps: (costUsd / notional) * 1e4,
    complete,
    limiting,
  }
}

/**
 * Largest notional the visible books can absorb for a full round trip: the thinnest of
 * the four sides the plan has to cross, valued at each side's own prices.
 */
export function capacity({ spotBook, perpBook, direction }) {
  const plan = PLANS[direction]
  const sideOf = (book, orderSide) => (orderSide === 'buy' ? book.asks : book.bids)
  return Math.min(
    sideDepth(sideOf(spotBook, plan.spotEntry)).notional,
    sideDepth(sideOf(spotBook, plan.spotExit)).notional,
    sideDepth(sideOf(perpBook, plan.perpEntry)).notional,
    sideDepth(sideOf(perpBook, plan.perpExit)).notional,
  )
}
