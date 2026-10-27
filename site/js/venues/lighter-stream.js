// One WebSocket to Lighter carries everything we need live: funding and price stats for
// every market, and full-depth order books.
//
// Stats tick every second for every market; we take a snapshot of them once per refresh
// cycle (subscribe, read, unsubscribe) rather than drinking the whole stream.
// REST would allow only 60 requests a minute for an anonymous client, too few to poll
// hundreds of books. A book subscription sends a full snapshot, then changed levels
// (absolute size, 0 = gone) every 50 ms. Keeping a few hundred books streaming costs
// hundreds of messages a second, so books are *sampled*: subscribe, take the snapshot,
// unsubscribe — rotating through the wanted books, most important first, like a poll.
// Only the books someone is looking at in detail are *followed* live; their updates
// name the nonce they continue from (`begin_nonce` = previous `nonce`), and any gap
// means a missed update: the book is re-subscribed for a fresh snapshot.
//
// Clients may send at most 200 messages a minute, so everything outgoing goes through
// a limiter (12 per 5 s), and the sampling interval stretches with the number of books.

import { WeightLimiter } from '../core/ratelimit.js'

export const STREAM_URL = 'wss://mainnet.zklighter.elliot.ai/stream?readonly=true'

const PING_MS = 60_000 // the server closes connections silent for 2 minutes
const RETRY_MS = [1_000, 2_000, 5_000, 10_000, 30_000]
// 12 per 5 s: never more than 144 in any minute, and no burst that then stalls a minute.
const MESSAGES_PER_WINDOW = 12
const MESSAGE_WINDOW_MS = 5_000
const SAMPLE_BUDGET = 120 // messages a minute for sampling (two per book)
const MIN_SAMPLE_MS = 60_000
const PARALLEL_SAMPLES = 4
const SNAPSHOT_TIMEOUT_MS = 15_000
const BOOK_RANGE = 0.1 // keep ±10 % of the touch
const BOOK_LEVELS = 400 // per side

const num = (x) => (x == null || x === '' ? null : Number(x))

/** A book as a pair of price → size maps, kept in sync from snapshot plus deltas. */
function applyLevels(map, levels) {
  for (const { price, size } of levels ?? []) {
    const px = Number(price)
    const sz = Number(size)
    if (sz > 0) map.set(px, sz)
    else map.delete(px)
  }
}

/** `…_stats/all` sends a map keyed by market id, `…_stats/<id>` a single record. */
const statsOf = (payload) => (payload?.market_id != null ? [payload] : Object.values(payload ?? {}))

export class LighterStream {
  constructor({ url = STREAM_URL, WebSocketImpl = globalThis.WebSocket, onChange = () => {}, now = () => Date.now(), schedule = (fn, ms) => setTimeout(fn, ms), clearSchedule = (t) => clearTimeout(t), limiter = new WeightLimiter({ budget: MESSAGES_PER_WINDOW, windowMs: MESSAGE_WINDOW_MS, now, schedule }) } = {}) {
    this.url = url
    this.WebSocketImpl = WebSocketImpl
    this.onChange = onChange
    this.now = now
    this.schedule = schedule
    this.clearSchedule = clearSchedule
    this.limiter = limiter // outgoing messages per minute
    this.ws = null
    this.open = false
    this.retries = 0
    this.stats = new Map() // perp market id → raw market_stats
    this.spotStats = new Map() // spot market id → raw spot_market_stats
    this.statsAt = null
    this.statsPending = false
    this.books = new Map() // market id → { bids: Map, asks: Map, nonce, time, ready }
    this.wanted = [] // market ids to sample, most important first
    this.followed = new Set() // market ids streamed live
    this.subscribed = new Map() // market id → time the subscription was sent
    this.waiters = new Map() // market id → [resolve]
    this.pingTimer = null
    this.sampleTimer = null
    this.generation = 0 // connection count: messages queued for a dead socket are dropped
  }

  get connected() {
    return this.open
  }

  connect() {
    if (this.ws || !this.WebSocketImpl) return
    const ws = new this.WebSocketImpl(this.url)
    this.ws = ws
    this.generation++
    ws.onopen = () => {
      this.open = true
      this.retries = 0
      this.subscribed.clear()
      this.statsPending = false
      this.requestStats()
      for (const id of this.followed) this.subscribe(id, 1)
      this.keepAlive()
      this.sample()
    }
    ws.onmessage = (event) => {
      let msg
      try {
        msg = JSON.parse(event.data)
      } catch {
        return
      }
      this.receive(msg)
    }
    ws.onclose = () => this.reconnect()
    ws.onerror = () => {} // onclose follows and retries
  }

  reconnect() {
    this.clearSchedule(this.pingTimer)
    this.clearSchedule(this.sampleTimer)
    this.sampleTimer = null
    this.open = false
    this.ws = null
    this.subscribed.clear()
    // Sampled books stay what they were: snapshots with a time. Followed books lost
    // their stream and get a fresh snapshot on reconnect.
    for (const id of this.followed) if (this.books.has(id)) this.books.get(id).ready = false
    this.onChange()
    const wait = RETRY_MS[Math.min(this.retries++, RETRY_MS.length - 1)]
    this.schedule(() => this.connect(), wait)
  }

  keepAlive() {
    this.clearSchedule(this.pingTimer)
    this.pingTimer = this.schedule(() => {
      if (!this.open) return
      this.send({ type: 'ping' }, 0)
      this.keepAlive()
    }, PING_MS)
  }

  async send(msg, priority = 5) {
    const generation = this.generation
    await this.limiter.take(1, priority)
    if (this.open && generation === this.generation && this.ws?.readyState === 1) this.ws.send(JSON.stringify(msg))
  }

  subscribe(id, priority = 3) {
    if (!this.open || this.subscribed.has(id)) return
    this.subscribed.set(id, this.now())
    this.send({ type: 'subscribe', channel: `order_book/${id}` }, priority)
  }

  /**
   * At the same priority as follow()'s subscribe: the limiter keeps FIFO order within a
   * priority, so an unsubscribe queued earlier never overtakes a later re-subscribe of the
   * same book (Lighter does not count subscriptions — the late unsubscribe would end the
   * new stream). Ahead of new samples, too.
   */
  unsubscribe(id) {
    if (!this.subscribed.delete(id)) return
    this.send({ type: 'unsubscribe', channel: `order_book/${id}` }, 1)
  }

  /** Books to keep fresh by sampling, most important first (starts right away). */
  watch(ids = []) {
    this.wanted = ids
    this.clearSchedule(this.sampleTimer)
    this.sampleTimer = null
    this.sample()
  }

  /** Books to stream live (the ones on screen in detail); the rest go back to sampling. */
  follow(ids = []) {
    const next = new Set(ids)
    for (const id of this.followed) if (!next.has(id)) this.unsubscribe(id)
    this.followed = next
    for (const id of next) this.subscribe(id, 1)
  }

  /** How long a sampled book may age: the rotation has to fit the message budget. */
  get sampleInterval() {
    return Math.max(MIN_SAMPLE_MS, ((this.wanted.length * 2) / SAMPLE_BUDGET) * 60_000)
  }

  /**
   * Start the next snapshots: books never seen first (in importance order), then the
   * oldest beyond the sampling interval. A few run in parallel; the limiter paces them.
   */
  sample() {
    if (!this.open || this.sampleTimer) return
    const t = this.now()
    // Snapshots that never came: give the slot back.
    for (const [id, at] of this.subscribed) if (!this.followed.has(id) && t - at > SNAPSHOT_TIMEOUT_MS) this.unsubscribe(id)
    let running = [...this.subscribed.keys()].filter((id) => !this.followed.has(id)).length
    const due = this.wanted
      .filter((id) => !this.followed.has(id) && !this.subscribed.has(id))
      .map((id) => ({ id, at: this.books.get(id)?.time ?? -Infinity }))
      .filter((x) => t - x.at >= this.sampleInterval)
    due.sort((a, b) => a.at - b.at) // never seen (−∞) first, stable in importance order
    for (const { id } of due) {
      if (running >= PARALLEL_SAMPLES) break
      this.subscribe(id, 4)
      running++
    }
    this.sampleTimer = this.schedule(() => {
      this.sampleTimer = null
      this.sample()
    }, 500)
  }

  /** Snapshot every market's stats: subscribe now, unsubscribe when they are in. */
  requestStats() {
    if (!this.open || this.statsPending) return
    this.statsPending = true
    this.send({ type: 'subscribe', channel: 'market_stats/all' }, 0)
    this.send({ type: 'subscribe', channel: 'spot_market_stats/all' }, 0)
  }

  /** Fresh stats for this cycle; resolves when they are in (or after `timeoutMs`). */
  async refreshStats(timeoutMs = 5_000) {
    this.connect()
    this.requestStats()
    const before = this.statsAt
    const start = this.now()
    while (this.statsAt === before && this.now() - start < timeoutMs) await new Promise((r) => this.schedule(r, 100))
    return this.stats.size > 0
  }

  receive(msg) {
    const type = msg.type ?? ''
    if (type.endsWith('/market_stats')) {
      for (const s of statsOf(msg.market_stats)) this.stats.set(s.market_id, s)
      if (type.startsWith('subscribed')) {
        this.statsAt = this.now()
        this.statsPending = false
        this.send({ type: 'unsubscribe', channel: 'market_stats/all' }, 0)
      }
    } else if (type.endsWith('/spot_market_stats')) {
      for (const s of statsOf(msg.spot_market_stats)) this.spotStats.set(s.market_id, s)
      if (type.startsWith('subscribed')) this.send({ type: 'unsubscribe', channel: 'spot_market_stats/all' }, 0)
    } else if (type.endsWith('/order_book')) {
      this.receiveBook(msg, type.startsWith('subscribed'))
    }
  }

  receiveBook(msg, snapshot) {
    const id = Number(msg.channel?.split(':')[1])
    const ob = msg.order_book ?? {}
    if (!snapshot && !this.followed.has(id)) return // a sample still unsubscribing
    let book = this.books.get(id)
    if (snapshot) {
      book = { bids: new Map(), asks: new Map(), nonce: null, time: null, ready: false }
      this.books.set(id, book)
    } else if (!book?.ready) {
      return // waiting for a fresh snapshot: deltas until then are meaningless
    } else if (ob.begin_nonce !== book.nonce) {
      // Missed an update: drop the book and ask for a fresh snapshot, once.
      book.ready = false
      this.subscribed.delete(id)
      this.send({ type: 'unsubscribe', channel: `order_book/${id}` }, 1)
      this.subscribe(id, 1)
      return
    }
    applyLevels(book.bids, ob.bids)
    applyLevels(book.asks, ob.asks)
    book.nonce = ob.nonce
    book.time = msg.timestamp ?? this.now()
    if (snapshot) {
      book.ready = true
      // A sample is done once its snapshot is in.
      if (!this.followed.has(id)) this.unsubscribe(id)
      for (const resolve of this.waiters.get(id) ?? []) resolve()
      this.waiters.delete(id)
      this.onChange()
    }
  }

  /**
   * The current book, best levels first, or null until a snapshot has arrived. Sorted
   * once per update (nonce), however often it is read.
   */
  book(id) {
    const book = this.books.get(id)
    if (!book?.ready) return null
    if (book.sorted?.nonce !== book.nonce) {
      const sorted = (map, dir) => [...map].sort((a, b) => dir * (a[0] - b[0]))
      const bids = sorted(book.bids, -1)
      const asks = sorted(book.asks, 1)
      // Full depth reaches absurd prices (stub quotes at 0.01 or 1 000 000): keep what a
      // hedge could realistically walk into, within ±BOOK_RANGE of the touch.
      const lo = bids.length ? bids[0][0] * (1 - BOOK_RANGE) : 0
      const hi = asks.length ? asks[0][0] * (1 + BOOK_RANGE) : Infinity
      const trim = (levels, keep) => levels.filter(([px], i) => i < BOOK_LEVELS && keep(px)).map(([px, sz]) => ({ px, sz }))
      book.sorted = { nonce: book.nonce, value: { bids: trim(bids, (px) => px >= lo), asks: trim(asks, (px) => px <= hi), time: book.time } }
    }
    return book.sorted.value
  }

  /** Resolves with the book once its snapshot is in (or null after `timeoutMs`). */
  whenBook(id, timeoutMs = 10_000) {
    if (this.books.get(id)?.ready) return Promise.resolve(this.book(id))
    return new Promise((resolve) => {
      const done = () => resolve(this.book(id))
      if (!this.waiters.has(id)) this.waiters.set(id, [])
      this.waiters.get(id).push(done)
      this.schedule(done, timeoutMs)
    })
  }

  /** Funding and price stats of a perp, numbers parsed; null before the first message. */
  perpStats(id) {
    const s = this.stats.get(id)
    if (!s) return null
    return {
      index: num(s.index_price),
      mark: num(s.mark_price),
      mid: num(s.mid_price),
      // Percent per hour, as Lighter prints them.
      fundingPct: num(s.current_funding_rate),
      lastFundingPct: num(s.funding_rate),
      premiumPct: num(s.premium),
      volume: num(s.daily_quote_token_volume),
    }
  }

  spot(id) {
    const s = this.spotStats.get(id)
    if (!s) return null
    return { index: num(s.index_price), mid: num(s.mid_price), volume: num(s.daily_quote_token_volume) }
  }

}
