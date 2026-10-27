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
 * Cumulative size and notional of a side, computed once per levels array (books are
 * replaced, never mutated), so every sweep of it is a binary search.
 */
const prefixes = new WeakMap()
function prefix(levels) {
  let p = prefixes.get(levels)
  if (!p) {
    const qty = new Float64Array(levels.length)
    const notional = new Float64Array(levels.length)
    let q = 0
    let v = 0
    levels.forEach(({ px, sz }, i) => {
      q += sz
      v += sz * px
      qty[i] = q
      notional[i] = v
    })
    p = { qty, notional }
    prefixes.set(levels, p)
  }
  return p
}

/**
 * Sweep `qty` base units through `levels` like a market order would.
 * Returns the fill; `complete` is false when the visible book runs dry.
 */
export function walk(levels, qty) {
  const n = levels.length
  if (!(qty > 0) || !n) return { qty, filled: 0, notional: 0, vwap: null, worstPx: null, levelsUsed: 0, complete: false }
  const p = prefix(levels)
  let filled
  let notional
  let last
  if (p.qty[n - 1] <= qty) {
    filled = p.qty[n - 1]
    notional = p.notional[n - 1]
    last = n - 1
  } else {
    // First level whose cumulative size covers the order.
    let lo = 0
    let hi = n - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (p.qty[mid] >= qty) hi = mid
      else lo = mid + 1
    }
    last = lo
    const before = lo ? p.qty[lo - 1] : 0
    filled = qty
    notional = (lo ? p.notional[lo - 1] : 0) + (qty - before) * levels[lo].px
  }
  return {
    qty,
    filled,
    notional,
    vwap: filled > 0 ? notional / filled : null,
    worstPx: levels[last].px,
    levelsUsed: last + 1,
    complete: filled >= qty * (1 - 1e-9),
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
