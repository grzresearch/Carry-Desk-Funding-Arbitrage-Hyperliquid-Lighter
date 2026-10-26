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

/** Shortfall of one market order of `qty` base units. Null when the book has no mid. */
export function legShortfall(book, side, qty, feeBps) {
  const mid = midPrice(book)
  if (!mid || !(qty > 0)) return null
  const levels = side === 'buy' ? book.asks : book.bids
  const best = levels[0].px
  const sign = side === 'buy' ? 1 : -1
  const fill = walk(levels, qty)
  const arrival = qty * mid
  const spread = fill.filled * sign * (best - mid)
  const impact = sign * (fill.notional - fill.filled * best)
  const fee = (fill.notional * feeBps) / 1e4
  const total = spread + impact + fee
  const bps = (x) => (x / arrival) * 1e4
  return {
    side,
    qty,
    mid,
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

/**
 * Enter and later exit a hedge of `notional` per leg, assuming the exit meets a book
 * like today's. Returns the four legs, their summed cost, and whether the visible
 * depth can absorb the size at all.
 */
export function roundTrip({ spotBook, perpBook, notional, direction, spotFeeBps, perpFeeBps }) {
  const spotMid = midPrice(spotBook)
  const perpMid = midPrice(perpBook)
  if (!spotMid || !perpMid || !(notional > 0)) return null
  const plan = PLANS[direction]
  const spotQty = notional / spotMid
  const perpQty = notional / perpMid
  const legs = {
    spotEntry: legShortfall(spotBook, plan.spotEntry, spotQty, spotFeeBps),
    perpEntry: legShortfall(perpBook, plan.perpEntry, perpQty, perpFeeBps),
    spotExit: legShortfall(spotBook, plan.spotExit, spotQty, spotFeeBps),
    perpExit: legShortfall(perpBook, plan.perpExit, perpQty, perpFeeBps),
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
