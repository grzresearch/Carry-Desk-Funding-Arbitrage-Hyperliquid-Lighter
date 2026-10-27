// Live market data for one venue, kept fresh within that venue's rate limit.
//
// A cycle reloads the venue's universe (markets, funding, prices) and the books the
// active view needs (`want()`); deeper books, funding history and candles are fetched
// on demand with lower priority. Everything is keyed by `market.key`
// ("hl/BTC", "lt/1"), so venues never collide.

import { deepBook, sideDepth } from './core/book.js'
import { CANDLE_HOURS } from './core/execution.js'

const HOUR = 3_600_000
const HISTORY_TTL = 30 * 60_000
const CANDLES_TTL = 30 * 60_000

export class VenueData extends EventTarget {
  constructor(adapter) {
    super()
    this.adapter = adapter
    this.id = adapter.id
    this.universe = null
    this.markets = new Map() // key → market
    this.books = new Map() // key → stitched book
    this.raw = new Map() // key → { precise, coarse }
    this.history = new Map() // perp key → [{ time, rate, premium }]
    this.historyAt = new Map()
    this.candles = new Map() // key → [{ time, close, high, low, notional }]
    this.candlesAt = new Map()
    this.wanted = new Set()
    this.updatedAt = null
    this.error = null
    this.busy = false
    this.pending = { coarse: new Set(), history: new Map(), candles: new Set() }
    this.inflight = new Map() // `${key}|precise` / `${key}|coarse` → book request
    this.marketRefresh = null
    this.notifyTimer = null
    // A streaming venue pushes: pick up whatever books just arrived.
    adapter.onChange = () => {
      if (this.streaming) this.syncBooks(this.wanted)
      this.notify()
    }
  }

  /** Venues that stream their books (Lighter) are read, not polled. */
  get streaming() {
    return typeof this.adapter.peekBook === 'function'
  }

  /** Copy the live books of streaming markets; a book still on its way stays loading. */
  syncBooks(keys) {
    for (const key of keys) {
      const market = this.markets.get(key)
      const book = market && this.adapter.peekBook(market)
      if (book) this.books.set(key, book)
    }
  }

  get pairs() {
    return this.universe?.pairs ?? []
  }

  get unbacked() {
    return this.universe?.unbacked ?? []
  }

  notify() {
    if (this.notifyTimer) return
    // Streamed snapshots land a few a second: batch them into fewer renders.
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null
      this.dispatchEvent(new Event('change'))
    }, this.streaming ? 400 : 120)
  }

  /**
   * Markets whose books the active view needs on every cycle. Books never fetched are
   * loaded right away (a new tab, a market that just listed), not a cycle later.
   */
  want(keys) {
    this.wanted = new Set(keys)
    // Streaming venues subscribe to exactly these (and may drop the rest).
    this.adapter.watch?.(keys.map((k) => this.markets.get(k)).filter(Boolean))
    if (this.streaming) return this.syncBooks(keys)
    const missing = keys.filter((k) => this.markets.has(k) && !this.books.has(k) && !this.inflight.has(`${k}|precise`))
    if (missing.length) this.refreshBooks(missing).then(() => this.notify())
  }

  async refresh() {
    if (this.busy) return
    this.busy = true
    this.notify()
    try {
      await this.refreshUniverse()
      const keys = [...this.wanted].filter((k) => this.markets.has(k))
      if (this.streaming) this.syncBooks(keys)
      const failed = this.streaming ? 0 : await this.refreshBooks(keys, 3)
      // Old books must not pass for live ones: a mostly failed cycle is an error.
      if (keys.length && failed > keys.length / 2) throw new Error(`${this.adapter.name}: ${failed} von ${keys.length} Büchern fehlgeschlagen`)
      this.updatedAt = Date.now()
      this.error = null
    } catch (err) {
      this.error = err
      console.error(err)
    } finally {
      this.busy = false
      this.notify()
    }
  }

  async refreshUniverse() {
    this.universe = await this.adapter.loadUniverse()
    this.markets = new Map([...this.universe.spot, ...this.universe.perps].map((m) => [m.key, m]))
  }

  /** Fetch one book; a request already in flight for it is shared, not repeated. */
  fetchBook(key, { coarse = false, priority = 3 } = {}) {
    const id = `${key}|${coarse ? 'coarse' : 'precise'}`
    if (this.inflight.has(id)) return this.inflight.get(id)
    const market = this.markets.get(key)
    if (!market) return Promise.resolve()
    const job = this.adapter
      .fetchBook(market, { coarse, priority })
      .then((book) => {
        const entry = this.raw.get(key) ?? {}
        entry[coarse ? 'coarse' : 'precise'] = book
        this.raw.set(key, entry)
        this.books.set(key, deepBook(entry.precise ?? null, entry.coarse ?? null) ?? book)
      })
      .finally(() => this.inflight.delete(id))
    this.inflight.set(id, job)
    return job
  }

  /** Refresh precise books (and the tails we rely on). Returns how many failed. */
  async refreshBooks(keys, priority = 3) {
    let failed = 0
    await Promise.all(
      keys.map((key) =>
        this.fetchBook(key, { priority })
          .then(() => this.notify())
          .catch((err) => {
            failed++
            console.warn(this.id, 'book', key, err.message)
            if (!this.books.has(key)) this.books.set(key, { bids: [], asks: [], time: null })
          }),
      ),
    )
    if (this.adapter.supportsCoarse) {
      const tails = keys.filter((k) => this.raw.get(k)?.coarse)
      await Promise.all(tails.map((key) => this.fetchBook(key, { coarse: true, priority: 4 }).catch(() => {})))
    }
    return failed
  }

  /** Visible depth on the thinner side of a market's precise book. */
  preciseDepth(key) {
    const p = this.raw.get(key)?.precise
    if (!p) return 0
    return Math.min(sideDepth(p.bids).notional, sideDepth(p.asks).notional)
  }

  /** Ask for the coarse tail of books whose visible levels cannot hold `notional`. */
  wantDepth(keys, notional) {
    if (!this.adapter.supportsCoarse) return
    for (const key of keys) {
      const entry = this.raw.get(key)
      if (!entry?.precise || entry.coarse || this.pending.coarse.has(key)) continue
      if (this.preciseDepth(key) >= notional * 1.2) continue
      this.pending.coarse.add(key)
      this.fetchBook(key, { coarse: true, priority: 4 })
        .then(() => this.notify())
        .catch(() => {})
        .finally(() => this.pending.coarse.delete(key))
    }
  }

  /** Funding history (7 days, hourly) for perps, most important first. */
  wantHistory(keys, priority = 8) {
    for (const key of keys) {
      const perp = this.markets.get(key)
      if (!perp || perp.kind !== 'perp') continue
      const at = this.historyAt.get(key)
      if (at && Date.now() - at < HISTORY_TTL) continue
      // A request already queued at the same or a more urgent priority will do.
      const queued = this.pending.history.get(key)
      if (queued != null && queued <= priority) continue
      this.pending.history.set(key, priority)
      this.adapter
        .fetchFundingHistory(perp, Date.now() - 7 * 24 * HOUR, { priority })
        .then((rows) => {
          this.history.set(key, rows)
          this.historyAt.set(key, Date.now())
          this.notify()
        })
        .catch((err) => console.warn(this.id, 'fundingHistory', key, err.message))
        .finally(() => {
          if (this.pending.history.get(key) === priority) this.pending.history.delete(key)
        })
    }
  }

  /** Recent 1-minute candles: the maker model's flow and volatility inputs. */
  wantCandles(keys, priority = 9) {
    for (const key of keys) {
      const market = this.markets.get(key)
      if (!market || this.pending.candles.has(key)) continue
      const at = this.candlesAt.get(key)
      if (at && Date.now() - at < CANDLES_TTL) continue
      this.pending.candles.add(key)
      this.adapter
        .fetchCandles(market, Date.now() - CANDLE_HOURS * HOUR, { priority })
        .then((rows) => {
          this.candles.set(key, rows)
          this.candlesAt.set(key, Date.now())
          this.notify()
        })
        .catch((err) => console.warn(this.id, 'candles', key, err.message))
        .finally(() => this.pending.candles.delete(key))
    }
  }

  /** Stream these markets live, if the venue can (the legs of an open detail view). */
  follow(keys) {
    this.adapter.follow?.(keys.map((k) => this.markets.get(k)).filter(Boolean))
  }

  /** Keep the legs of an open detail view fresh, including their tails. */
  async refreshMarkets(keys) {
    if (this.streaming) {
      this.syncBooks(keys)
      return this.notify()
    }
    // Never stack refreshes: if the last one is still queued, skip this tick.
    if (this.marketRefresh) return this.marketRefresh
    this.marketRefresh = Promise.all(
      keys.flatMap((key) => [
        this.fetchBook(key, { priority: 1 }).catch(() => {}),
        this.adapter.supportsCoarse ? this.fetchBook(key, { coarse: true, priority: 2 }).catch(() => {}) : null,
      ]),
    ).finally(() => {
      this.marketRefresh = null
      this.notify()
    })
    return this.marketRefresh
  }

  usage() {
    return this.adapter.limiter.usage()
  }
}
