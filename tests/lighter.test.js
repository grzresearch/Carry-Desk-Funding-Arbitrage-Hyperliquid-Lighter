import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { LighterStream } from '../site/js/venues/lighter-stream.js'
import { buildLighterUniverse, matchLighter, canonicalSymbol, lighterFees, truncateRate, LIGHTER_FUNDING, LIGHTER_ACCOUNTS } from '../site/js/venues/lighter.js'
import { hourlyFunding } from '../site/js/core/funding.js'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/lighter.json', import.meta.url)))
const near = (a, b, eps = 1e-12) => assert.ok(Math.abs(a - b) < eps, `${a} ≉ ${b}`)

/** A socket that records what the client sends and lets the test push messages. */
function fakeSocket() {
  const sockets = []
  class FakeSocket {
    constructor(url) {
      this.url = url
      this.sent = []
      this.readyState = 0
      sockets.push(this)
    }
    send(data) {
      this.sent.push(JSON.parse(data))
    }
    open() {
      this.readyState = 1
      this.onopen?.()
    }
    push(msg) {
      this.onmessage?.({ data: JSON.stringify(msg) })
    }
    close() {
      this.readyState = 3
      this.onclose?.()
    }
  }
  return { FakeSocket, sockets }
}

const tick = () => new Promise((r) => setImmediate(r))

function streamWith() {
  const { FakeSocket, sockets } = fakeSocket()
  const timers = []
  let t = 0
  const stream = new LighterStream({
    WebSocketImpl: FakeSocket,
    now: () => t,
    schedule: (fn, ms) => timers.push({ fn, ms }) && timers.length,
    clearSchedule: () => {},
  })
  stream.connect()
  sockets[0].open()
  return { stream, socket: sockets[0], sockets, timers, advance: (ms) => (t += ms) }
}

const level = (price, size) => ({ price: String(price), size: String(size) })
const bookMsg = (type, id, { bids = [], asks = [], nonce, begin = 0, timestamp = 1 }) => ({
  type: `${type}/order_book`,
  channel: `order_book:${id}`,
  timestamp,
  order_book: { bids, asks, nonce, begin_nonce: begin },
})
const channelsOf = (socket, type) => socket.sent.filter((m) => m.type === type).map((m) => m.channel)

test('stats channels on open; wanted books are sampled a few at a time, most important first', async () => {
  const { stream, socket } = streamWith()
  stream.watch([5, 6, 7, 8, 9, 10])
  await tick()
  assert.deepEqual(channelsOf(socket, 'subscribe').slice(0, 2), ['market_stats/all', 'spot_market_stats/all'])
  assert.deepEqual(channelsOf(socket, 'subscribe').slice(2), ['order_book/5', 'order_book/6', 'order_book/7', 'order_book/8'])
})

test('a sample unsubscribes once its snapshot is in, and is not re-taken before the interval', async () => {
  const { stream, socket, advance } = streamWith()
  stream.watch([7])
  await tick()
  socket.push(bookMsg('subscribed', 7, { bids: [level(99, 1)], asks: [level(101, 1)], nonce: 10, timestamp: 0 }))
  await tick()
  assert.deepEqual(channelsOf(socket, 'unsubscribe'), ['order_book/7'])
  // Late updates of the sample are ignored; the snapshot stands.
  socket.push(bookMsg('update', 7, { bids: [level(99, 5)], nonce: 11, begin: 10 }))
  assert.deepEqual(stream.book(7).bids, [{ px: 99, sz: 1 }])
  stream.sampleTimer = null
  stream.sample()
  await tick()
  assert.equal(channelsOf(socket, 'subscribe').filter((c) => c === 'order_book/7').length, 1)
  advance(stream.sampleInterval)
  stream.sampleTimer = null
  stream.sample()
  await tick()
  assert.equal(channelsOf(socket, 'subscribe').filter((c) => c === 'order_book/7').length, 2)
})

test('the sampling interval stretches so the rotation fits the message budget', () => {
  const { stream } = streamWith()
  stream.wanted = Array.from({ length: 30 }, (_, i) => i)
  assert.equal(stream.sampleInterval, 60_000)
  stream.wanted = Array.from({ length: 180 }, (_, i) => i)
  assert.equal(stream.sampleInterval, 180_000) // 360 messages at 120 a minute
})

test('a followed book streams: snapshot plus deltas; size 0 removes a level', async () => {
  const { stream, socket } = streamWith()
  stream.follow([7])
  socket.push(bookMsg('subscribed', 7, { bids: [level(99, 1), level(98, 2)], asks: [level(101, 1), level(102, 3)], nonce: 10 }))
  socket.push(bookMsg('update', 7, { bids: [level(99, 0), level(99.5, 4)], asks: [level(101, 2)], nonce: 12, begin: 10 }))
  await tick()
  assert.deepEqual(channelsOf(socket, 'unsubscribe'), [])
  const book = stream.book(7)
  assert.deepEqual(book.bids, [{ px: 99.5, sz: 4 }, { px: 98, sz: 2 }])
  assert.deepEqual(book.asks, [{ px: 101, sz: 2 }, { px: 102, sz: 3 }])
  // Unfollowing ends the stream.
  stream.follow([])
  await tick()
  assert.deepEqual(channelsOf(socket, 'unsubscribe'), ['order_book/7'])
})

test('a nonce gap drops a followed book and asks for a fresh snapshot', async () => {
  const { stream, socket } = streamWith()
  stream.follow([7])
  socket.push(bookMsg('subscribed', 7, { bids: [level(99, 1)], asks: [level(101, 1)], nonce: 10 }))
  socket.push(bookMsg('update', 7, { bids: [level(99, 5)], nonce: 20, begin: 15 })) // missed 10 → 15
  assert.equal(stream.book(7), null)
  await tick()
  assert.deepEqual(socket.sent.slice(-2), [{ type: 'unsubscribe', channel: 'order_book/7' }, { type: 'subscribe', channel: 'order_book/7' }])
  socket.push(bookMsg('subscribed', 7, { bids: [level(99, 5)], asks: [level(101, 1)], nonce: 30 }))
  assert.deepEqual(stream.book(7).bids, [{ px: 99, sz: 5 }])
})

test('a reconnect keeps sampled snapshots and re-subscribes followed books', async () => {
  const { stream, socket, sockets, timers } = streamWith()
  stream.watch([2])
  stream.follow([3])
  socket.push(bookMsg('subscribed', 2, { bids: [level(1, 1)], asks: [level(2, 1)], nonce: 1 }))
  socket.push(bookMsg('subscribed', 3, { bids: [level(1, 1)], asks: [level(2, 1)], nonce: 1 }))
  socket.close()
  assert.ok(stream.book(2))
  assert.equal(stream.book(3), null)
  timers.find((t) => t.ms === 1_000).fn() // retry after 1 s
  sockets[1].open()
  await tick()
  assert.ok(channelsOf(sockets[1], 'subscribe').includes('order_book/3'))
})

test('stats: one snapshot per request, parsed in percent, then unsubscribed', async () => {
  const { stream, socket } = streamWith()
  socket.push({ type: 'subscribed/market_stats', channel: 'market_stats:all', market_stats: fixture.market_stats })
  await tick()
  const eth = stream.perpStats(0)
  assert.equal(eth.fundingPct, 0.0012)
  assert.ok(eth.index > 1000)
  assert.ok(channelsOf(socket, 'unsubscribe').includes('market_stats/all'))
  stream.requestStats()
  await tick()
  assert.equal(channelsOf(socket, 'subscribe').filter((c) => c === 'market_stats/all').length, 2)
})

function universe() {
  const stream = new LighterStream({ WebSocketImpl: null })
  stream.receive({ type: 'subscribed/market_stats', market_stats: fixture.market_stats })
  stream.receive({ type: 'subscribed/spot_market_stats', spot_market_stats: fixture.spot_market_stats })
  return buildLighterUniverse(fixture, stream)
}

test('universe: units converted from percent, IMF and multiplier', () => {
  const { perps, spot } = universe()
  const btc = perps.find((p) => p.symbol === 'BTC')
  near(btc.funding, 0.0012 / 100)
  assert.equal(btc.key, 'lt/1')
  assert.equal(btc.fundingParams.m, 1)
  near(btc.fundingParams.I, 0.0001)
  near(btc.fundingParams.cap, 0.04 / 8)
  assert.equal(btc.maxLeverage, 50)
  assert.equal(btc.impactUsd, 500 / 0.02) // margin at maximum leverage (2 %)
  const xau = perps.find((p) => p.symbol === 'XAU')
  assert.equal(xau.canonical, 'GOLD')
  assert.equal(xau.category, 'commodity')
  assert.equal(xau.fundingParams.m, 0.5)
  assert.equal(perps.find((p) => p.symbol === 'NVDA').category, 'equity')
  assert.equal(perps.find((p) => p.symbol === 'EURUSD').category, 'fx')
  assert.equal(perps.find((p) => p.symbol === 'OPENAI').category, 'equity')
  assert.ok(spot.every((s) => s.quote === 'USDC' && s.key.startsWith('lt/')))
})

test('a token listed with a small premium multiplier stays crypto; reduced interest marks real-world assets', () => {
  const eth = fixture.order_book_details.find((d) => d.symbol === 'ETH')
  const details = { order_book_details: [
    { ...eth, symbol: 'XTEN', market_id: 900, funding_premium_multiplier: 1 },
    { ...eth, symbol: 'OURA', market_id: 901, funding_premium_multiplier: 1, base_interest_rate: '0.0032' },
  ] }
  const { perps } = buildLighterUniverse(details, null)
  assert.equal(perps.find((p) => p.symbol === 'XTEN').category, 'crypto')
  assert.equal(perps.find((p) => p.symbol === 'OURA').category, 'equity')
})

test('the funding formula reproduces the rates Lighter prints', () => {
  const { perps } = universe()
  let checked = 0
  for (const p of perps) {
    const printed = Number(fixture.market_stats[p.marketId].current_funding_rate) / 100
    // Printed rates are truncated toward zero to 0,0001 %/h (and settled that way).
    near(truncateRate(hourlyFunding(p.premium, p.fundingParams)), printed, 1e-12)
    near(p.funding, printed, 1e-12)
    checked++
  }
  assert.ok(checked >= 20)
})

test('a missed update is resynced once, not once per following delta', async () => {
  const { stream, socket } = streamWith()
  stream.follow([7])
  socket.push(bookMsg('subscribed', 7, { bids: [level(99, 1)], asks: [level(101, 1)], nonce: 10 }))
  socket.push(bookMsg('update', 7, { bids: [level(99, 5)], nonce: 20, begin: 15 }))
  for (let n = 21; n < 40; n++) socket.push(bookMsg('update', 7, { bids: [level(99, n)], nonce: n, begin: n - 1 }))
  await tick()
  assert.equal(channelsOf(socket, 'unsubscribe').length, 1)
  assert.equal(channelsOf(socket, 'subscribe').filter((c) => c === 'order_book/7').length, 2)
})

test('messages queued for a dead socket are not sent on the next one', async () => {
  const { stream, socket, sockets, timers } = streamWith()
  stream.send({ type: 'ping' })
  socket.close()
  timers.find((t) => t.ms === 1_000).fn()
  sockets[1].open()
  await tick()
  assert.ok(!sockets[1].sent.some((m) => m.type === 'ping'))
})

test('spot ⇄ perp: same ticker, Robinhood stock tokens, gold proxies; LRTs excluded', () => {
  const { pairs, unbacked } = matchLighter(universe())
  const byId = (spotSym, perpSym) => pairs.find((p) => p.spot.coin === spotSym && p.perp.symbol === perpSym)
  assert.equal(byId('ETH/USDC', 'ETH').kind, 'native')
  const spy = byId('rhSPY/USDC', 'SPY')
  assert.equal(spy.kind, 'tokenized-equity')
  assert.equal(spy.issuer, 'Robinhood')
  // One rhSPY is 1.0017 SPY: per unit of underlying the token and the perp agree.
  assert.ok(Math.abs(spy.deviation) < 0.003, `deviation ${spy.deviation}`)
  assert.ok(Math.abs(spy.perpUnits - 1 / 1.001717991) < 1e-9)
  assert.equal(byId('XAUT/USDC', 'XAU').kind, 'proxy')
  assert.ok(byId('XAUT/USDC', 'PAXG'))
  // ETF tokens hedge with the index perps too, per token and at the index scale.
  const sp = byId('rhSPY/USDC', 'US500')
  assert.equal(sp.kind, 'proxy')
  assert.equal(sp.underlying, 'S&P 500')
  near(sp.perpUnits, 10.03 / sp.spot.multiplier)
  assert.ok(Math.abs(sp.deviation) < 0.03)
  assert.equal(byId('rhQQQ/USDC', 'US100').kind, 'proxy')
  assert.equal(byId('rhQQQ/USDC', 'QQQ').kind, 'tokenized-equity')
  assert.equal(pairs.filter((p) => p.spot.coin === 'rhSPY/USDC').length, 2)
  assert.ok(unbacked.includes('weETH'))
  assert.ok(!pairs.some((p) => p.spot.base.name === 'weETH'))
})

test('aliases join Lighter tickers to Hyperliquid names', () => {
  assert.equal(canonicalSymbol('1000PEPE'), 'kPEPE')
  assert.equal(canonicalSymbol('XAU'), 'GOLD')
  assert.equal(canonicalSymbol('US500'), 'SP500')
  assert.equal(canonicalSymbol('ETH'), 'ETH')
})

test('fees by account type; standard accounts trade free', () => {
  assert.equal(lighterFees().taker(), 0)
  assert.equal(lighterFees({ ltAccount: 1 }).maker(), 0.5)
  const premium = LIGHTER_ACCOUNTS.findIndex((a) => a.name.startsWith('Premium'))
  near(lighterFees({ ltAccount: premium }).taker(), 2.8)
  near(lighterFees({ ltAccount: LIGHTER_ACCOUNTS.length - 1 }).taker(), 1.96)
})

test('own-order premium shift uses $500 of margin as impact notional', () => {
  const perp = { oracle: 100, impactUsd: 5_000 }
  // A short eats the bids: the impact bid falls but stays below the index, so the
  // premium (only impact prices beyond the index count) is unchanged.
  const book = { bids: [{ px: 99.9, sz: 100 }, { px: 99, sz: 1000 }], asks: [{ px: 100.1, sz: 1000 }] }
  assert.equal(LIGHTER_FUNDING.premiumShift(book, 'sell', 100, perp), 0)
  // A rich book (bids above the index): selling into it pulls the premium down.
  const rich = { bids: [{ px: 100.5, sz: 60 }, { px: 100, sz: 1000 }], asks: [{ px: 100.6, sz: 1000 }] }
  assert.ok(LIGHTER_FUNDING.premiumShift(rich, 'sell', 60, perp) < 0)
})

test('books are trimmed to ±10 % of the touch: stub quotes far away are no depth', () => {
  const { stream, socket } = streamWith()
  stream.follow([9])
  socket.push(bookMsg('subscribed', 9, { bids: [level(100, 1), level(95, 1), level(0.01, 1e6)], asks: [level(101, 1), level(1e6, 5)], nonce: 1 }))
  const book = stream.book(9)
  assert.deepEqual(book.bids.map((l) => l.px), [100, 95])
  assert.deepEqual(book.asks.map((l) => l.px), [101])
  assert.equal(stream.book(9), book) // cached until the next update
})

test('reduce-only, frozen and hidden markets cannot be entered and are left out', async () => {
  const { openable } = await import('../site/js/venues/lighter.js')
  assert.equal(openable({ status: 'active', market_config: {} }), true)
  assert.equal(openable({ status: 'active', market_config: { force_reduce_only: true } }), false)
  assert.equal(openable({ status: 'active', is_frozen: true }), false)
  assert.equal(openable({ status: 'inactive' }), false)
})
