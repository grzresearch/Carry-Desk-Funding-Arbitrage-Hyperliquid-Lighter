// Hyperliquid as a venue: spot and every perp dex (main + HIP-3) through the public
// info API, inside its per-IP weight budget.
//
// Every venue adapter exposes the same surface (see data.js):
//   loadUniverse()                 → { spot, perps, pairs, unbacked, quotes }
//   fetchBook(market, { coarse })  → { bids, asks, time }, best first — or, for a venue
//                                    that streams its books, watch / follow / peekBook
//   fetchFundingHistory(perp, ms)  → [{ time, rate (hourly), premium }]
//   fetchCandles(market, ms)       → [{ time, close, high, low, notional }] (1 min)
//   fees(settings)                 → { taker(market), maker(market) } in bps
//   funding                        → own-order premium model (core/funding.js)

import { createClient } from '../core/api.js'
import { WeightLimiter } from '../core/ratelimit.js'
import { parseBook } from '../core/book.js'
import { buildUniverse } from '../core/universe.js'
import { matchPairs, UNBACKED_DEPLOYERS } from '../core/matching.js'
import { hyperliquidFees } from '../core/fees.js'
import { fundingParams, premiumShift, hyperliquidImpact } from '../core/funding.js'

const COARSE_SIG_FIGS = 3
const FULL_SCAN_EVERY = 10 // cycles; also re-reads dexes without live markets
const DEPLOYER_CACHE = 'carry-desk-deployers'
// Aligned quote assets (AQAv1) get 20 % off taker fees. There is no API flag; USDH is
// aligned per the docs and verified on live fills.
const ALIGNED_QUOTES = new Set(['USDH'])

/** Token deployers never change, so they are cached across visits (if storage works). */
function loadDeployers() {
  try {
    return new Map(Object.entries(JSON.parse(localStorage.getItem(DEPLOYER_CACHE) ?? '{}')))
  } catch {
    return new Map()
  }
}

function saveDeployers(map) {
  try {
    localStorage.setItem(DEPLOYER_CACHE, JSON.stringify(Object.fromEntries(map)))
  } catch {
    // Private mode or blocked storage: the lookup simply repeats next visit.
  }
}

const keyed = (market) => Object.assign(market, { venue: 'hl', key: `hl/${market.coin}` })

export function createHyperliquid({ client = createClient({ limiter: new WeightLimiter({ budget: 1000 }) }), onChange = () => {} } = {}) {
  let cycle = 0
  let liveDexes = null
  let lastPerps = null
  let universe = null
  let quotes = new Set(['USDC'])
  const deployers = loadDeployers() // tokenId → deployer address
  const pendingDeployers = new Set()
  let matched = { pairs: [], unbacked: [] }

  function rematch() {
    matched = matchPairs(universe, { deployers })
    for (const p of matched.pairs) Object.assign(p, { venue: 'hl', id: `${p.spot.key}|${p.perp.key}` })
  }

  /**
   * Matches without an issuer convention rest on ticker and price. Look up who deployed
   * those tokens once, and drop any that come from a known unbacked-mirror deployer.
   */
  function checkDeployers() {
    const tokens = new Set()
    for (const p of matched.pairs) if (p.evidence !== 'strong') tokens.add(p.spot.base.tokenId)
    for (const tokenId of tokens) {
      if (!tokenId || deployers.has(tokenId) || pendingDeployers.has(tokenId)) continue
      pendingDeployers.add(tokenId)
      client
        .tokenDetails(tokenId)
        .then((details) => {
          if (!details || typeof details !== 'object') return // transient: retry next cycle
          // Genesis tokens (HYPE, PURR) have no deployer; remember that too.
          const deployer = details.deployer ?? null
          deployers.set(tokenId, deployer)
          saveDeployers(deployers)
          if (UNBACKED_DEPLOYERS.has(deployer)) {
            rematch()
            onChange()
          }
        })
        .catch((err) => console.warn('tokenDetails', tokenId, err.message))
        .finally(() => pendingDeployers.delete(tokenId))
    }
  }

  return {
    id: 'hl',
    name: 'Hyperliquid',
    short: 'HL',
    limiter: client.limiter,
    budget: 1200,
    supportsCoarse: true,

    async loadUniverse() {
      const full = !liveDexes || cycle % FULL_SCAN_EVERY === 0
      cycle++
      const [dexes, spot] = await Promise.all([client.perpDexs(), client.spotMetaAndAssetCtxs()])
      const names = ['', ...dexes.filter(Boolean).map((d) => d.name)].filter((n) => full || liveDexes.has(n))
      const failed = new Set()
      const fetched = await Promise.all(
        names.map((dex) =>
          client
            .metaAndAssetCtxs(dex)
            .then(([meta, ctxs]) => ({ dex, meta, ctxs }))
            .catch(() => {
              failed.add(dex)
              return null
            }),
        ),
      )
      let perps = fetched.filter(Boolean)
      if (lastPerps) {
        // Keep dexes skipped this cycle (nothing live there) and dexes whose fetch failed
        // from the last read; a full scan drops only dexes that really disappeared.
        const seen = new Set(perps.map((p) => p.dex))
        perps = perps.concat(lastPerps.filter((p) => !seen.has(p.dex) && (!full || failed.has(p.dex))))
      }
      lastPerps = perps
      if (full) {
        // A dex that failed is unknown, not dead: keep polling it.
        const live = perps.filter((p) => p.meta.universe.some((a) => !a.isDelisted)).map((p) => p.dex)
        liveDexes = new Set([...live, ...failed])
      }
      universe = buildUniverse({ dexes, spot, perps })
      universe.spot.forEach(keyed)
      universe.perps.forEach(keyed)
      quotes = universe.quotes
      rematch()
      checkDeployers()
      return { spot: universe.spot, perps: universe.perps, quotes, get pairs() { return matched.pairs }, get unbacked() { return matched.unbacked } }
    },

    async fetchBook(market, { coarse = false, priority = 3 } = {}) {
      return parseBook(await client.l2Book(market.coin, { nSigFigs: coarse ? COARSE_SIG_FIGS : null, priority }))
    },

    async fetchFundingHistory(perp, startMs, { priority = 8 } = {}) {
      const rows = await client.fundingHistory(perp.coin, startMs, { priority })
      return rows.map((r) => ({ time: r.time, rate: Number(r.fundingRate), premium: Number(r.premium) })).sort((a, b) => a.time - b.time)
    },

    /** 1-minute candles: volume per side and volatility for the maker model. */
    async fetchCandles(market, startMs, { priority = 9 } = {}) {
      const rows = await client.candleSnapshot(market.coin, '1m', startMs, { minutes: 1, priority })
      return rows.map((c) => ({ time: c.t, close: Number(c.c), high: Number(c.h), low: Number(c.l), notional: Number(c.v) * Number(c.c) })).sort((a, b) => a.time - b.time)
    },

    fees(settings) {
      return hyperliquidFees(settings, { aligned: ALIGNED_QUOTES, stable: quotes })
    },

    funding: {
      params: fundingParams,
      premiumShift: (book, side, qty, perp, ref) => premiumShift(book, side, qty, perp.oracle ?? ref, hyperliquidImpact(perp)),
    },

    tradeUrl(market) {
      return market.kind === 'spot'
        ? `https://app.hyperliquid.xyz/trade/${market.base.name}/${market.quote}`
        : `https://app.hyperliquid.xyz/trade/${market.coin}`
    },
  }
}
