// Order books as plain data.
//
// A side is an array of levels ordered best price first: [{ px, sz }], numbers only.
// A book is { bids, asks, time }. Everything here is pure so it runs in the browser
// and under `node --test` alike.

/** Parse a raw `l2Book` response ({ levels: [bids, asks] } with string fields). */
export function parseBook(raw) {
  const [bids = [], asks = []] = raw?.levels ?? []
  const side = (levels) => levels.map((l) => ({ px: Number(l.px), sz: Number(l.sz) }))
  return { bids: side(bids), asks: side(asks), time: raw?.time ?? null }
}

export function bestBid(book) {
  return book?.bids?.[0]?.px ?? null
}

export function bestAsk(book) {
  return book?.asks?.[0]?.px ?? null
}

export function midPrice(book) {
  const bid = bestBid(book)
  const ask = bestAsk(book)
  return bid != null && ask != null ? (bid + ask) / 2 : null
}

export function spreadBps(book) {
  const bid = bestBid(book)
  const ask = bestAsk(book)
  const mid = midPrice(book)
  return mid ? ((ask - bid) / mid) * 1e4 : null
}

/** Total size and quote notional resting on one side. */
export function sideDepth(levels) {
  let qty = 0
  let notional = 0
  for (const { px, sz } of levels) {
    qty += sz
    notional += px * sz
  }
  return { qty, notional }
}

/**
 * Sweep `qty` base units through `levels` like a market order would.
 * Returns the fill; `complete` is false when the visible book runs dry.
 */
export function walk(levels, qty) {
  let filled = 0
  let notional = 0
  let worstPx = null
  let levelsUsed = 0
  for (const { px, sz } of levels) {
    if (filled >= qty) break
    const take = Math.min(sz, qty - filled)
    filled += take
    notional += take * px
    worstPx = px
    levelsUsed++
  }
  return {
    qty,
    filled,
    notional,
    vwap: filled > 0 ? notional / filled : null,
    worstPx,
    levelsUsed,
    complete: qty > 0 && filled >= qty * (1 - 1e-9),
  }
}

/**
 * Extend a full-precision side (the API returns only 20 levels) with the tail of a
 * coarser `nSigFigs`-aggregated snapshot of the same side.
 *
 * Hyperliquid floors aggregated bid prices and ceils aggregated ask prices, so a
 * bucket's price is its worst edge: pricing hidden size at the bucket price is a
 * conservative (pessimistic) estimate. Buckets entirely inside the visible range are
 * skipped; the bucket straddling the visible edge contributes only its residual size.
 *
 * Work in "depth coordinates" d = px for asks and -px for bids, so deeper is always
 * larger d and bucket i spans (d[i-1], d[i]].
 */
export function stitchDepth(precise, coarse, side) {
  if (!coarse?.length) return precise
  if (!precise?.length) return coarse
  const d = side === 'asks' ? (px) => px : (px) => -px
  const edge = d(precise[precise.length - 1].px)
  const out = precise.slice()
  let lower = -Infinity
  for (const bucket of coarse) {
    const upper = d(bucket.px)
    if (upper > edge) {
      if (lower >= edge) {
        out.push({ px: bucket.px, sz: bucket.sz })
      } else {
        let visible = 0
        for (const level of precise) {
          const dl = d(level.px)
          if (dl > lower && dl <= edge) visible += level.sz
        }
        const residual = bucket.sz - visible
        if (residual > bucket.sz * 1e-9) out.push({ px: bucket.px, sz: residual })
      }
    }
    lower = upper
  }
  return out
}

/** Stitch both sides of a precise book with a coarse book (either may be null). */
export function deepBook(precise, coarse) {
  if (!coarse) return precise
  if (!precise) return coarse
  return {
    bids: stitchDepth(precise.bids, coarse.bids, 'bids'),
    asks: stitchDepth(precise.asks, coarse.asks, 'asks'),
    time: precise.time,
  }
}
