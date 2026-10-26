// Which spot token and which perp track the same underlying?
//
// Spot tokens on Hyperliquid rarely carry the underlying's ticker verbatim: Unit
// bridges prefix a U (UBTC), LayerZero deployments suffix a 0 (LINK0), xStocks suffix
// an X (NVDAX), EQX prefixes EQ (EQNVDA)… Names alone are not proof, so every
// candidate comes with evidence, and weaker evidence must be confirmed by price:
//
//   strong    issuer naming convention or curated override — accepted as is
//   moderate  affix rule backed by the token's full name    — price-checked when tradable
//   weak      bare ticker coincidence                        — must be confirmed by price
//
// Perps are resolved the same way (kPEPE = 1000 PEPE). Exposure that is equivalent
// but not identical (an S&P 500 ETF token against an index perp, tokenised gold
// against PAXG) joins through curated proxy classes with explicit price scales.

/** Spot token name → underlying, for conventions no rule can infer. */
export const OVERRIDES = {
  UUUSPX: { underlying: 'SPX', kind: 'bridged', issuer: 'Unit' }, // Unit SPX6900 ↔ perp SPX
  UDZ: { underlying: '2Z', kind: 'bridged', issuer: 'Unit' }, // Unit DoubleZero ↔ perp 2Z
  FXRP: { underlying: 'XRP', kind: 'bridged', issuer: 'Flare' }, // Flare FAsset XRP
  HPENGU: { underlying: 'PENGU', kind: 'bridged', issuer: 'Hyperbridge' },
  HNIL: { underlying: 'NIL', kind: 'bridged', issuer: 'Hyperbridge' },
  SPCXD: { underlying: 'SPCX', kind: 'tokenized-equity', issuer: null },
  USPYX: { underlying: 'SPY', kind: 'tokenized-equity', issuer: 'Unit' }, // Unit SP500 xStock
  XAUM: { underlying: 'XAUM', kind: 'wrapped', issuer: 'Matrixdock' },
  WMNT: { underlying: 'MNT', kind: 'wrapped', issuer: null }, // "Mantle"
  LZCC: { underlying: 'CC', kind: 'bridged', issuer: 'LayerZero' }, // Canton Coin
  MMOVE: { underlying: 'MOVE', kind: 'bridged', issuer: null, evidence: 'moderate' },
  LZZRO: { underlying: 'ZRO', kind: 'bridged', issuer: 'LayerZero' },
}

/** Tokens that look like an underlying but are not 1:1 claims on it. */
export const EXCLUDED = new Set(['KHYPE', 'STHYPE', 'WSTHYPE', 'LHYPE', 'BEHYPE', 'DHYPE', 'HPEPE', 'HPUMP', 'HOP', 'HAR', 'FARM'])

/**
 * Deployers of unbacked "mirror" tokens: stock and ETF tickers (AAPL, AMZN, SPY, GLD …)
 * whose whole supply was minted to one wallet, copying real share counts, with no
 * redemption. They track nothing, so they are never a hedge. `tokenDetails` reveals the
 * deployer of any new token; the token ids below cover today's list without a lookup.
 */
export const UNBACKED_DEPLOYERS = new Set(['0x9a93d976277bfda0b69b1625358cb257f4908106'])
export const UNBACKED_TOKEN_IDS = new Set([
  '0x8b92defb1901e6be9384d365c4f306a4', // CRCL
  '0xba48f5724be19bf0b127bb4c7fbeb9db', // GOOGL
  '0xec340db435d4d90899e97655cb8e71f5', // AAPL
  '0xe101753dcfea619a512111d3ae54a592', // HOOD
  '0xd35b9bc1770c7bdda96f65cf0f76d4d5', // AMZN
  '0x555659a2a856d42399cdde096eb998e9', // META
  '0xf5559ee90ac19c61eb6379eb3b3dade8', // MSFT
  '0x92de6e7ea04b168f6acc93d18f3becce', // ORCL
  '0x5e28c011d22a86d0787301fc8512fb00', // MU
  '0x7d12581c6783aed7cd320d5460077063', // SPCX
  '0xeba4707b8cce42965026c6863faca7d4', // AVGO
  '0xf574f3e097a19ad8f184141d669d2514', // BNB1
  '0xd0b13a173230b8e8dfd664ac0a00c9a8', // GLD
  '0x354131c048026531b2e4bb07d3180977', // SLV
  '0x7ad071597884285ad3be27ef21a024f1', // SPY
  '0xd443b26d9c0663dc89413d4cbab11b5b', // QQQ
])

/** Is this spot token a known unbacked mirror? `deployers` maps tokenId → deployer. */
export function isUnbacked(token, deployers) {
  return UNBACKED_TOKEN_IDS.has(token.tokenId) || UNBACKED_DEPLOYERS.has(deployers?.get(token.tokenId))
}

/**
 * Equivalent exposure under different tickers. `scale` is the perp price per unit of
 * the class's reference spot price (S&P 500 index ≈ 10 × SPY).
 */
export const PROXY_CLASSES = [
  // Index level ÷ ETF-scaled contract, measured live: SP500/US500 ≈ 10.03, XYZ100/USTECH ≈ 41.1.
  { key: 'S&P 500', spot: ['SPY'], perps: { US500: 1, USA500: 10.03, SP500: 10.03 } },
  { key: 'Nasdaq-100', spot: ['QQQ'], perps: { USTECH: 1, XYZ100: 41.1, USA100: 41.1 } },
  { key: 'Gold', spot: ['XAUT', 'XAUM', 'PAXG', 'GOLD'], perps: { GOLD: 1, PAXG: 1, XAUT: 1 } },
]

export const COMMODITIES = new Set(['Gold', 'GOLD', 'SILVER', 'PLATINUM', 'PALLADIUM', 'COPPER', 'ALUMINIUM', 'URANIUM', 'CL', 'OIL', 'WTI', 'USOIL', 'BRENTOIL', 'NATGAS', 'GAS', 'TTF', 'HO', 'CORN', 'WHEAT', 'SOY', 'PAXG', 'XAUT'])
export const FX = new Set(['EUR', 'JPY', 'GBP', 'KRW', 'DXY', 'CHF', 'CNH', 'AUD', 'CAD'])

/**
 * Price agreement (perp per underlying unit ÷ spot, in USD) a match needs. Weak and
 * moderate evidence must be confirmed by a price; strong evidence is rejected only when
 * prices are wildly apart (a ticker collision, e.g. STX on two dexes).
 */
export const TOLERANCE = { weak: 0.1, moderate: 0.15, proxy: 0.03, strong: 0.5, flag: 0.05 }

const words = (s) => (s ?? '').split(/[^A-Za-z0-9]+/).filter(Boolean)

/**
 * Candidate underlyings for a spot token, strongest evidence first.
 * @returns {{ underlying: string, kind: string, issuer: string|null, evidence: 'strong'|'moderate'|'weak' }[]}
 */
export function spotCandidates(token) {
  const { name, fullName } = token
  if (EXCLUDED.has(name) || /\bstaked\b/i.test(fullName ?? '')) return []
  const out = []
  const add = (underlying, kind, issuer, evidence) => {
    if (underlying && !out.some((c) => c.underlying === underlying)) out.push({ underlying, kind, issuer, evidence })
  }
  const full = fullName ?? ''

  const override = OVERRIDES[name]
  if (override) add(override.underlying, override.kind, override.issuer, override.evidence ?? 'strong')

  let m
  if ((m = full.match(/^EQX Tokenized (\S+)$/))) add(m[1].toUpperCase(), 'tokenized-equity', 'EQX', 'strong')
  if (/^Wrapped .+ xStock$/i.test(full) && name.endsWith('X')) add(name.slice(0, -1), 'tokenized-equity', 'xStocks', 'strong')
  if (/^Unit\s/.test(full) && name.startsWith('U')) {
    add(name.slice(1), 'bridged', 'Unit', 'strong')
    add(words(full.slice(5)).join('').toUpperCase(), 'bridged', 'Unit', 'strong')
  }
  if ((m = full.match(/^(\w+) - Wagyu\.xyz$/)) && /\d$/.test(name)) add(m[1].toUpperCase(), 'bridged', 'Wagyu', 'strong')

  // Bridged deployments: LINK0, AVAX0, BNB1 …
  if (/^[A-Z]{2,}[01]$/.test(name)) add(name.slice(0, -1), 'bridged', name.endsWith('0') ? 'LayerZero' : null, 'moderate')

  // One- or two-letter wrapper affix confirmed by the full name: ONEAR "NEAR Protocol",
  // FXMR "Freedom XMR", HTAO "Hyper TAO", HSEI "hSEI".
  for (const word of words(full)) {
    const core = word.replace(/^[a-z]+(?=[A-Z0-9])/, '').toUpperCase()
    if (core.length < 2 || core === name) continue
    const i = name.indexOf(core)
    if (i >= 0 && name.length - core.length <= 2 && (i === 0 || i + core.length === name.length)) add(core, 'bridged', null, 'moderate')
  }

  add(name, 'native', null, 'weak')
  return out
}

/** Underlying and contract size of a perp: kBONK → BONK × 1000. */
export function perpUnderlying(perp) {
  const sym = perp.symbol
  let m
  if ((m = sym.match(/^k([A-Z][A-Z0-9]*)$/))) return { underlying: m[1], units: 1000 }
  if ((m = sym.match(/^1000([A-Z][A-Z0-9]*)$/))) return { underlying: m[1], units: 1000 }
  return { underlying: sym, units: 1 }
}

function proxyForSpot(underlying) {
  return PROXY_CLASSES.find((c) => c.spot.includes(underlying)) ?? null
}

function proxyForPerp(underlying) {
  for (const c of PROXY_CLASSES) if (c.perps[underlying] != null) return { cls: c, scale: c.perps[underlying] }
  return null
}

function categoryOf(key, spotKind, perp) {
  if (COMMODITIES.has(key)) return 'commodity'
  if (FX.has(key)) return 'fx'
  if (spotKind === 'tokenized-equity' || key === 'S&P 500' || key === 'Nasdaq-100') return 'equity'
  // Growth mode is only allowed on markets disjoint from crypto perps.
  if (perp.growthMode === 'enabled') return 'equity'
  return 'crypto'
}

const perpPrice = (p) => p.oracle ?? p.mid ?? p.mark

/** USD value of each quote token: USDC is the unit, the others trade against it. */
export function quoteUsd(spotMarkets, quotes) {
  const out = new Map([['USDC', 1]])
  for (const m of spotMarkets) {
    if (m.quote === 'USDC' && quotes.has(m.base.name) && m.mid) out.set(m.base.name, m.mid)
  }
  return out
}

/**
 * Reference USD price per spot token: the mid of its most active pair against a dollar
 * stable, so every pair of the token is validated once and consistently.
 */
function tokenPrices(spotMarkets, quotes, usd) {
  const best = new Map()
  for (const m of spotMarkets) {
    if (!m.mid || !quotes.has(m.quote)) continue
    const prev = best.get(m.base.name)
    if (!prev || m.volume > prev.volume) best.set(m.base.name, m)
  }
  return new Map([...best].map(([k, m]) => [k, m.mid * (usd.get(m.quote) ?? 1)]))
}

/**
 * Join every spot pair with every perp on the same underlying.
 * @param {{ spot: object[], perps: object[], quotes: Set<string> }} universe output of buildUniverse()
 * @param {{ deployers?: Map<string, string> }} opts  tokenId → deployer, from tokenDetails
 * @returns {{ pairs: object[], unbacked: string[] }}
 */
export function matchPairs(universe, { deployers = new Map() } = {}) {
  const quotes = universe.quotes
  const usd = quoteUsd(universe.spot, quotes)
  // Index live perps by join key.
  const perpsByKey = new Map()
  for (const perp of universe.perps) {
    const { underlying, units } = perpUnderlying(perp)
    const proxy = proxyForPerp(underlying)
    const entries = [{ key: underlying, units, proxy: false }]
    if (proxy) entries.push({ key: proxy.cls.key, units: proxy.scale, proxy: true })
    for (const e of entries) {
      if (!perpsByKey.has(e.key)) perpsByKey.set(e.key, [])
      perpsByKey.get(e.key).push({ perp, units: e.units, proxy: e.proxy })
    }
  }

  const prices = tokenPrices(universe.spot, quotes, usd)
  const resolved = new Map() // token name → accepted resolution or null

  function resolve(token) {
    if (resolved.has(token.name)) return resolved.get(token.name)
    const spotPx = prices.get(token.name) ?? null
    let result = null
    for (const cand of spotCandidates(token)) {
      const proxy = proxyForSpot(cand.underlying)
      const key = proxy ? proxy.key : cand.underlying
      const perps = (perpsByKey.get(key) ?? []).filter((e) => proxy || !e.proxy)
      if (!perps.length) continue
      // Price check against each perp; keep the ones that agree.
      const checked = perps.map((e) => {
        const px = perpPrice(e.perp)
        const deviation = spotPx && px ? px / e.units / spotPx - 1 : null
        return { ...e, deviation }
      })
      const tol = TOLERANCE[cand.evidence]
      const accepted = checked.filter((e) => {
        // Without a spot price only issuer conventions and curated overrides count.
        if (e.deviation == null) return cand.evidence === 'strong'
        return Math.abs(e.deviation) <= (e.proxy ? TOLERANCE.proxy : tol)
      })
      if (!accepted.length) continue
      result = { ...cand, key, proxy: Boolean(proxy), perps: accepted, spotPx }
      break
    }
    resolved.set(token.name, result)
    return result
  }

  const pairs = []
  const unbacked = new Set()
  for (const spot of universe.spot) {
    if (!quotes.has(spot.quote) || quotes.has(spot.base.name)) continue
    if (isUnbacked(spot.base, deployers)) {
      unbacked.add(spot.base.name)
      continue
    }
    const res = resolve(spot.base)
    if (!res) continue
    for (const { perp, units, proxy, deviation } of res.perps) {
      const kind = proxy ? 'proxy' : res.kind
      pairs.push({
        id: `${spot.coin}|${perp.coin}`,
        key: res.key,
        underlying: res.proxy ? res.key : res.underlying,
        spot,
        perp,
        perpUnits: units,
        kind,
        issuer: res.issuer,
        evidence: res.evidence,
        deviation,
        quoteUsd: usd.get(spot.quote) ?? 1,
        flagged: deviation != null && Math.abs(deviation) > TOLERANCE.flag,
        category: categoryOf(res.key, res.kind, perp),
      })
    }
  }
  return { pairs, unbacked: [...unbacked].sort() }
}
