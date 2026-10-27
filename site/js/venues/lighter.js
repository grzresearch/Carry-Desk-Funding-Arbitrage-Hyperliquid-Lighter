// Lighter as a venue: its perps and spot markets through the public API.
//
// An anonymous client may make only 60 REST requests a minute, so everything live comes
// over one WebSocket (lighter-stream.js); REST carries the market metadata (one request
// per cycle), funding history and candles, paced well inside that limit.
//
// Units, as Lighter prints them: funding rates in percent per hour, the premium in
// percent (this hour's running average, times the market's premium multiplier), funding
// parameters in percent per 8 hours, margin fractions in 1/10 000, the multiplier in
// 1/100. With those, core/funding.js reproduces the printed rates exactly.

import { WeightLimiter } from '../core/ratelimit.js'
import { premiumShift } from '../core/funding.js'
import { perpUnderlying, PROXY_CLASSES, COMMODITIES, FX } from '../core/matching.js'
import { LighterStream } from './lighter-stream.js'

export const REST_URL = 'https://mainnet.zklighter.elliot.ai/api/v1'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const num = (x) => (x == null || x === '' ? null : Number(x))

/**
 * Lighter tickers for underlyings Hyperliquid names differently, mapped to Hyperliquid's
 * naming so both venues join on one key (verified against live prices). Contract sizes
 * are handled separately: 1000PEPE = kPEPE = 1000 PEPE.
 */
export const LIGHTER_ALIASES = {
  XAU: 'GOLD',
  XAG: 'SILVER',
  XPT: 'PLATINUM',
  XPD: 'PALLADIUM',
  XCU: 'COPPER',
  WTI: 'CL',
  EURUSD: 'EUR',
  GBPUSD: 'GBP',
  USDJPY: 'JPY', // both quote yen per dollar
  SAMSUNGUSD: 'SMSN',
  HYUNDAIUSD: 'HYUNDAI',
  SKHYNIXUSD: 'SKHX',
  OPENAI: 'OAI',
  ANTHROPIC: 'ANTH',
  TENCENT: 'TCNT',
  SPY: 'US500', // mkts:US500 is SPY-scaled (price ratio 1.0001)
  QQQ: 'USTECH', // mkts:USTECH is QQQ-scaled
  US500: 'SP500', // index level, like xyz:SP500
  US100: 'XYZ100', // index level
  IWM: 'SMALL2000', // ETF-scaled Russell 2000
}

/** Lighter symbol in Hyperliquid's naming (1000X → kX for perpUnderlying). */
export function canonicalSymbol(symbol) {
  return (LIGHTER_ALIASES[symbol] ?? symbol).replace(/^1000(?=[A-Z])/, 'k')
}

/** Spot tokens that look like an underlying but are not 1:1 claims on it. */
export const LIGHTER_EXCLUDED = new Set(['weETH', 'wstETH', 'stETH', 'cbETH', 'rETH', 'ezETH', 'rsETH'])

/** Lighter account types: maker / taker fee in bps (docs: Trading Fees, Account Types). */
export const LIGHTER_ACCOUNTS = [
  { name: 'Standard', maker: 0, taker: 0 },
  { name: 'Plus', maker: 0.5, taker: 0.5 },
  ...[0, 1_000, 3_000, 10_000, 30_000, 100_000, 300_000, 500_000].map((lit, i) => {
    const discount = [0, 0.025, 0.05, 0.1, 0.15, 0.2, 0.25, 0.3][i]
    return { name: `Premium · ${new Intl.NumberFormat('de-DE').format(lit)} LIT`, maker: 0.4 * (1 - discount), taker: 2.8 * (1 - discount) }
  }),
]

export function lighterFees({ ltAccount = 0 } = {}) {
  const account = LIGHTER_ACCOUNTS[ltAccount] ?? LIGHTER_ACCOUNTS[0]
  return { account, taker: () => account.taker, maker: () => account.maker }
}

function categoryOf(canonical, multiplier) {
  const { underlying } = perpUnderlying({ symbol: canonical })
  if (COMMODITIES.has(underlying)) return 'commodity'
  if (FX.has(underlying) || /^(USD[A-Z]{3}|[A-Z]{3}USD)$/.test(canonical)) return 'fx'
  // Real-world and pre-IPO markets run with a reduced premium multiplier.
  if (multiplier < 1 || PROXY_CLASSES.some((c) => c.perps[underlying] != null)) return 'equity'
  return 'crypto'
}

/** Funding parameters of a Lighter perp in the units core/funding.js works in. */
function fundingParamsOf(d) {
  return {
    m: (num(d.funding_premium_multiplier) ?? 100) / 100,
    I: (num(d.base_interest_rate) ?? 0.01) / 100,
    c: (num(d.funding_clamp_small) ?? 0.05) / 100,
    scaleInterest: false,
    cap: (num(d.funding_clamp_big) ?? 4) / 100 / 8,
  }
}

/**
 * Can a position be opened? Markets being wound down are reduce-only, frozen or hidden:
 * no hedge can be entered there.
 */
export function openable(d) {
  return d.status === 'active' && !d.is_frozen && !d.market_config?.force_reduce_only && !d.market_config?.hidden
}

/** Market records from orderBookDetails, updated with the stream's live stats. */
export function buildLighterUniverse(details, stream) {
  const perps = []
  for (const d of details.order_book_details ?? []) {
    if (!openable(d) || d.market_type !== 'perp') continue
    const id = d.market_id
    const live = stream?.perpStats(id)
    const index = live?.index ?? num(d.index_price)
    // Impact prices use the margin fraction at maximum leverage (verified on live premiums).
    const minImf = (num(d.min_initial_margin_fraction) ?? 1000) / 1e4
    const oiLimit = num(d.open_interest_limit) // base units, both sides; 2^56 = no cap
    const canonical = canonicalSymbol(d.symbol)
    const params = fundingParamsOf(d)
    const openInterest = num(d.open_interest) ?? 0
    // Until the stream reports this hour's estimate, the last settled rate stands in.
    const fundingPct = live?.fundingPct ?? live?.lastFundingPct
    perps.push({
      kind: 'perp',
      venue: 'lt',
      key: `lt/${id}`,
      marketId: id,
      coin: d.symbol,
      symbol: d.symbol,
      canonical,
      dex: '',
      collateral: 'USDC',
      funding: fundingPct != null ? fundingPct / 100 : null,
      lastFunding: live?.lastFundingPct != null ? live.lastFundingPct / 100 : null,
      // Lighter prints the hour's average premium already scaled by the multiplier.
      premium: live?.premiumPct != null ? live.premiumPct / 100 / params.m : null,
      oracle: index,
      mark: live?.mark ?? num(d.mark_price),
      mid: live?.mid ?? null,
      volume: live?.volume ?? num(d.daily_quote_token_volume) ?? 0,
      openInterest,
      openInterestUsd: index ? openInterest * index : null,
      oiCap: oiLimit && oiLimit < 1e15 && index ? (oiLimit / 2) * index : null,
      fundingParams: params,
      impactUsd: 500 / minImf,
      maxLeverage: Math.floor(1 / minImf),
      onlyIsolated: d.market_config?.market_margin_mode === 1,
      category: categoryOf(canonical, params.m),
      sizeDecimals: d.size_decimals,
    })
  }
  const spot = []
  for (const d of details.spot_order_book_details ?? []) {
    if (!openable(d)) continue
    const id = d.market_id
    const live = stream?.spot(id)
    const [base, quote = 'USDC'] = d.symbol.split('/')
    spot.push({
      kind: 'spot',
      venue: 'lt',
      key: `lt/${id}`,
      marketId: id,
      coin: d.symbol,
      base: { name: base, fullName: null },
      quote,
      // Shares per token for stock tokens (rhSPY grows with reinvested dividends).
      multiplier: num(d.multiplier) ?? 1,
      mid: live?.mid ?? null,
      index: live?.index ?? null,
      volume: live?.volume ?? num(d.daily_quote_token_volume) ?? 0,
    })
  }
  return { spot, perps }
}

/** Tolerances for Lighter spot ⇄ perp: listed by the exchange itself, still price-checked. */
const SPOT_TOLERANCE = { native: 0.1, 'tokenized-equity': 0.15, proxy: 0.03, flag: 0.05 }

/**
 * Join Lighter's spot markets with its perps. Same ticker first (ETH/USDC ⇄ ETH), then
 * Robinhood stock tokens (rhSPY ⇄ SPY), then proxy classes (XAUT ⇄ XAU, PAXG).
 */
export function matchLighter({ spot, perps }) {
  const bySymbol = new Map()
  const byClass = new Map()
  for (const p of perps) {
    const { underlying, units } = perpUnderlying({ symbol: p.symbol.replace(/^1000(?=[A-Z])/, 'k') })
    if (!bySymbol.has(underlying)) bySymbol.set(underlying, [])
    bySymbol.get(underlying).push({ perp: p, units })
    const c = PROXY_CLASSES.find((x) => x.perps[perpUnderlying({ symbol: p.canonical }).underlying] != null)
    if (c) {
      if (!byClass.has(c.key)) byClass.set(c.key, [])
      byClass.get(c.key).push({ perp: p, units: c.perps[perpUnderlying({ symbol: p.canonical }).underlying] })
    }
  }
  const pairs = []
  const excluded = []
  for (const s of spot) {
    const name = s.base.name
    if (LIGHTER_EXCLUDED.has(name)) {
      excluded.push(name)
      continue
    }
    const price = s.mid ?? s.index
    // Compare per unit of underlying: a token of multiplier 1.0017 is worth 1.0017 shares.
    const per = s.multiplier || 1
    const candidates = [{ underlying: name, kind: 'native', issuer: null }]
    if (/^rh[A-Z]/.test(name)) candidates.unshift({ underlying: name.slice(2), kind: 'tokenized-equity', issuer: 'Robinhood' })
    let found = false
    for (const cand of candidates) {
      for (const { perp, units } of bySymbol.get(cand.underlying) ?? []) {
        const deviation = price && perp.oracle ? (perp.oracle * per) / units / price - 1 : null
        if (deviation == null || Math.abs(deviation) > SPOT_TOLERANCE[cand.kind]) continue
        pairs.push(lighterPair(s, perp, { ...cand, units: units / per, deviation }))
        found = true
      }
      if (found) break
    }
    if (found) continue
    const cls = PROXY_CLASSES.find((c) => c.spot.includes(name))
    for (const { perp, units } of (cls && byClass.get(cls.key)) ?? []) {
      const deviation = price && perp.oracle ? (perp.oracle * per) / units / price - 1 : null
      if (deviation == null || Math.abs(deviation) > SPOT_TOLERANCE.proxy) continue
      pairs.push(lighterPair(s, perp, { underlying: cls.key, kind: 'proxy', issuer: null, units: units / per, deviation }))
    }
  }
  return { pairs, unbacked: excluded }
}

function lighterPair(spot, perp, { underlying, kind, issuer, units, deviation }) {
  return {
    id: `${spot.key}|${perp.key}`,
    venue: 'lt',
    key: underlying,
    underlying,
    spot,
    perp,
    perpUnits: units,
    kind,
    issuer,
    evidence: kind === 'native' ? 'moderate' : 'strong',
    deviation,
    verify: null,
    quoteUsd: 1,
    flagged: deviation != null && Math.abs(deviation) > SPOT_TOLERANCE.flag,
    category: kind === 'tokenized-equity' ? 'equity' : perp.category,
  }
}

/** REST client inside the anonymous limit (60 a minute; we keep a margin). */
export function createLighterClient({ fetchImpl = (...args) => globalThis.fetch(...args), limiter = new WeightLimiter({ budget: 40 }), url = REST_URL } = {}) {
  async function get(path, params = {}, { priority = 5 } = {}) {
    const query = new URLSearchParams(params).toString()
    for (let attempt = 0; ; attempt++) {
      await limiter.take(1, priority)
      let res
      try {
        res = await fetchImpl(`${url}/${path}${query ? `?${query}` : ''}`)
      } catch (err) {
        if (attempt >= 3) throw err
        await sleep(500 * 2 ** attempt)
        continue
      }
      // Lighter may answer a rate limit with 405 as well as 429.
      if ((res.status === 429 || res.status === 405) && attempt < 3) {
        limiter.backoff(10_000 * 2 ** attempt)
        continue
      }
      if (!res.ok) throw new Error(`${path} ${res.status}`)
      const body = await res.json()
      if (body.code != null && body.code !== 200) throw new Error(`${path} ${body.code}`)
      return body
    }
  }
  return {
    limiter,
    get,
    orderBookDetails: () => get('orderBookDetails', {}, { priority: 0 }),
    fundingRates: () => get('funding-rates', {}, { priority: 1 }),
    candles: (marketId, startMs, endMs, { priority = 9 } = {}) =>
      get('candles', { market_id: marketId, resolution: '1m', start_timestamp: Math.floor(startMs / 1000), end_timestamp: Math.ceil(endMs / 1000), count_back: 0 }, { priority }),
    fundings: (marketId, startMs, endMs, { priority = 8 } = {}) =>
      get('fundings', { market_id: marketId, resolution: '1h', start_timestamp: Math.floor(startMs / 1000), end_timestamp: Math.ceil(endMs / 1000), count_back: 0 }, { priority }),
  }
}

/** Lighter's own-order premium model: the main-dex rule with impact notional $500 / IMF. */
export const LIGHTER_FUNDING = {
  params: (perp) => perp.fundingParams,
  premiumShift: (book, side, qty, perp, ref) => premiumShift(book, side, qty, perp.oracle ?? ref, { hip3: false, impactUsd: perp.impactUsd }),
}

export function createLighter({ client = createLighterClient(), stream = null, onChange = () => {} } = {}) {
  const adapter = {
    id: 'lt',
    name: 'Lighter',
    short: 'LT',
    limiter: client.limiter,
    budget: client.limiter.budget,
    supportsCoarse: false,
    stream: null,
    onChange,

    async loadUniverse() {
      const [details] = await Promise.all([client.orderBookDetails(), adapter.stream.refreshStats()])
      const universe = buildLighterUniverse(details, adapter.stream)
      // No stream yet (blocked WebSocket, first seconds): fall back to the last settled
      // rates, which REST publishes for all markets at once, normalised to 8 hours.
      if (universe.perps.some((p) => p.funding == null)) {
        const rates = await client.fundingRates().catch(() => null)
        const last = new Map((rates?.funding_rates ?? []).filter((r) => r.exchange === 'lighter').map((r) => [r.market_id, r.rate / 8]))
        for (const p of universe.perps) if (p.funding == null) p.funding = last.get(p.marketId) ?? 0
      }
      const matched = matchLighter(universe)
      return { ...universe, quotes: new Set(['USDC']), pairs: matched.pairs, unbacked: matched.unbacked }
    },

    /** Books to keep sampled, most important first. */
    watch(markets) {
      adapter.stream.watch(markets.map((m) => m.marketId))
    },

    /** Books to stream live (an open detail view). */
    follow(markets) {
      adapter.stream.follow(markets.map((m) => m.marketId))
    },

    /** Books arrive over the stream: read the latest (null while its snapshot is on the way). */
    peekBook(market) {
      return adapter.stream.book(market.marketId)
    },

    async fetchFundingHistory(perp, startMs, { priority = 8 } = {}) {
      const res = await client.fundings(perp.marketId, startMs, Date.now(), { priority })
      // Rates come unsigned in percent; `direction` names the side that pays.
      return (res.fundings ?? [])
        .map((f) => ({ time: f.timestamp * 1000, rate: (f.direction === 'short' ? -1 : 1) * (Number(f.rate) / 100), premium: null }))
        .sort((a, b) => a.time - b.time)
    },

    async fetchCandles(market, startMs, { priority = 9 } = {}) {
      const res = await client.candles(market.marketId, startMs, Date.now(), { priority })
      // Zero fields are omitted: a minute without trades has no V. At most 500 per call.
      return (res.c ?? []).map((c) => ({ time: c.t, close: c.c, high: c.h, low: c.l, notional: c.V ?? 0 })).sort((a, b) => a.time - b.time)
    },

    fees(settings) {
      return lighterFees(settings)
    },

    funding: LIGHTER_FUNDING,

    tradeUrl(market) {
      return `https://app.lighter.xyz/trade/${encodeURIComponent(market.kind === 'spot' ? market.coin.replace('/', '-') : market.coin)}`
    },
  }
  adapter.stream = stream ?? new LighterStream({ onChange: () => adapter.onChange() })
  return adapter
}
