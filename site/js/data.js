// Live market data, kept fresh within Hyperliquid's per-IP weight budget.
//
// One refresh cycle costs roughly: perpDexs + spot meta (40) + one metaAndAssetCtxs per
// live perp dex (20 each) + one l2Book per leg (2 each). Coarse books (for depth past the
// 20 visible levels) and funding history are fetched on demand with lower priority.

import { createClient } from './core/api.js'
import { WeightLimiter } from './core/ratelimit.js'
import { parseBook, deepBook, sideDepth } from './core/book.js'
import { buildUniverse } from './core/universe.js'
import { matchPairs, UNBACKED_DEPLOYERS } from './core/matching.js'

const HOUR = 3_600_000
const COARSE_SIG_FIGS = 3
const FULL_SCAN_EVERY = 10 // cycles; also re-reads dexes without live markets
const DEPLOYER_CACHE = 'carry-desk-deployers'

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

export class LiveData extends EventTarget {
  constructor({ client = createClient({ limiter: new WeightLimiter({ budget: 1000 }) }) } = {}) {
    super()
    this.client = client
    this.universe = null
    this.pairs = []
    this.unbacked = [] // spot tokens excluded as unbacked mirrors
    this.deployers = loadDeployers() // tokenId → deployer address
    this.pendingDeployers = new Set()
    this.books = new Map() // coin → stitched book
    this.raw = new Map() // coin → { precise, coarse, preciseAt, coarseAt }
    this.history = new Map() // perp coin → [{ time, rate, premium }]
    this.historyAt = new Map()
    this.liveDexes = null
    this.cycle = 0
    this.updatedAt = null
    this.error = null
    this.busy = false
    this.pendingCoarse = new Set()
    this.pendingHistory = new Map() // coin → priority of the request in flight
    this.notifyTimer = null
  }

  notify() {
    if (this.notifyTimer) return
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null
      this.dispatchEvent(new Event('change'))
    }, 120)
  }

  /** Market metadata + contexts for every dex, then books for every matched leg. */
  async refresh() {
    if (this.busy) return
    this.busy = true
    this.notify()
    try {
      await this.refreshUniverse()
      await this.refreshBooks(this.legCoins(), 3)
      this.updatedAt = Date.now()
      this.error = null
    } catch (err) {
      this.error = err
      console.error(err)
    } finally {
      this.busy = false
      this.cycle++
      this.notify()
    }
  }

  async refreshUniverse() {
    const full = !this.liveDexes || this.cycle % FULL_SCAN_EVERY === 0
    const [dexes, spot] = await Promise.all([this.client.perpDexs(), this.client.spotMetaAndAssetCtxs()])
    const names = ['', ...dexes.filter(Boolean).map((d) => d.name)].filter((n) => full || this.liveDexes.has(n))
    const fetched = await Promise.all(
      names.map((dex) =>
        this.client
          .metaAndAssetCtxs(dex)
          .then(([meta, ctxs]) => ({ dex, meta, ctxs }))
          .catch(() => null),
      ),
    )
    let perps = fetched.filter(Boolean)
    if (!full && this.lastPerps) {
      // Keep dexes we skipped this cycle (nothing live there) from the last full scan.
      const seen = new Set(perps.map((p) => p.dex))
      perps = perps.concat(this.lastPerps.filter((p) => !seen.has(p.dex)))
    }
    this.lastPerps = perps
    if (full) {
      this.liveDexes = new Set(perps.filter((p) => p.meta.universe.some((a) => !a.isDelisted)).map((p) => p.dex))
    }
    this.universe = buildUniverse({ dexes, spot, perps })
    this.rematch()
    this.checkDeployers()
  }

  rematch() {
    const { pairs, unbacked } = matchPairs(this.universe, { deployers: this.deployers })
    this.pairs = pairs
    this.unbacked = unbacked
  }

  /**
   * Matches without an issuer convention rest on ticker and price. Look up who deployed
   * those tokens once, and drop any that come from a known unbacked-mirror deployer.
   */
  checkDeployers() {
    const tokens = new Map()
    for (const p of this.pairs) if (p.evidence !== 'strong') tokens.set(p.spot.base.tokenId, p.spot.base)
    for (const [tokenId] of tokens) {
      if (!tokenId || this.deployers.has(tokenId) || this.pendingDeployers.has(tokenId)) continue
      this.pendingDeployers.add(tokenId)
      this.client
        .tokenDetails(tokenId)
        .then((details) => {
          if (!details?.deployer) return
          this.deployers.set(tokenId, details.deployer)
          saveDeployers(this.deployers)
          if (UNBACKED_DEPLOYERS.has(details.deployer)) {
            this.rematch()
            this.notify()
          }
        })
        .catch((err) => console.warn('tokenDetails', tokenId, err.message))
        .finally(() => this.pendingDeployers.delete(tokenId))
    }
  }

  legCoins() {
    const coins = new Set()
    for (const p of this.pairs) {
      coins.add(p.spot.coin)
      coins.add(p.perp.coin)
    }
    return [...coins]
  }

  async fetchBook(coin, { nSigFigs = null, priority = 3 } = {}) {
    const raw = await this.client.l2Book(coin, { nSigFigs, priority })
    const book = parseBook(raw)
    const entry = this.raw.get(coin) ?? {}
    if (nSigFigs) {
      entry.coarse = book
      entry.coarseAt = Date.now()
    } else {
      entry.precise = book
      entry.preciseAt = Date.now()
    }
    this.raw.set(coin, entry)
    this.books.set(coin, deepBook(entry.precise ?? null, entry.coarse ?? null) ?? book)
  }

  async refreshBooks(coins, priority = 3) {
    await Promise.all(
      coins.map((coin) =>
        this.fetchBook(coin, { priority })
          .then(() => this.notify())
          .catch((err) => {
            console.warn('l2Book', coin, err.message)
            if (!this.books.has(coin)) this.books.set(coin, { bids: [], asks: [], time: null })
          }),
      ),
    )
    // Refresh tails we already rely on so they do not go stale.
    const tails = coins.filter((c) => this.raw.get(c)?.coarse)
    await Promise.all(tails.map((coin) => this.fetchBook(coin, { nSigFigs: COARSE_SIG_FIGS, priority: 4 }).catch(() => {})))
  }

  /** Visible depth on the thinner side of a coin's precise book. */
  preciseDepth(coin) {
    const p = this.raw.get(coin)?.precise
    if (!p) return 0
    return Math.min(sideDepth(p.bids).notional, sideDepth(p.asks).notional)
  }

  /** Ask for the coarse tail of books whose 20 visible levels cannot hold `notional`. */
  wantDepth(coins, notional) {
    for (const coin of coins) {
      const entry = this.raw.get(coin)
      if (!entry?.precise || entry.coarse || this.pendingCoarse.has(coin)) continue
      if (this.preciseDepth(coin) >= notional * 1.2) continue
      this.pendingCoarse.add(coin)
      this.fetchBook(coin, { nSigFigs: COARSE_SIG_FIGS, priority: 4 })
        .then(() => this.notify())
        .catch(() => {})
        .finally(() => this.pendingCoarse.delete(coin))
    }
  }

  /** Funding history (7 days, hourly) for perps, most important first. */
  wantHistory(perpCoins, priority = 8) {
    for (const coin of perpCoins) {
      const at = this.historyAt.get(coin)
      if (at && Date.now() - at < 30 * 60_000) continue
      // A request already queued at the same or a more urgent priority will do.
      if (this.pendingHistory.has(coin) && this.pendingHistory.get(coin) <= priority) continue
      this.pendingHistory.set(coin, priority)
      this.client
        .fundingHistory(coin, Date.now() - 7 * 24 * HOUR, { priority })
        .then((rows) => {
          this.history.set(
            coin,
            rows.map((r) => ({ time: r.time, rate: Number(r.fundingRate), premium: Number(r.premium) })).sort((a, b) => a.time - b.time),
          )
          this.historyAt.set(coin, Date.now())
          this.notify()
        })
        .catch((err) => console.warn('fundingHistory', coin, err.message))
        .finally(() => {
          if (this.pendingHistory.get(coin) === priority) this.pendingHistory.delete(coin)
        })
    }
  }

  /** Keep the two legs of an open detail view fresh, including their tails. */
  async refreshPair(pair) {
    const coins = [pair.spot.coin, pair.perp.coin]
    await Promise.all(
      coins.flatMap((coin) => [
        this.fetchBook(coin, { priority: 1 }).catch(() => {}),
        this.fetchBook(coin, { nSigFigs: COARSE_SIG_FIGS, priority: 2 }).catch(() => {}),
      ]),
    )
    this.notify()
  }

  usage() {
    return this.client.limiter.usage()
  }
}
