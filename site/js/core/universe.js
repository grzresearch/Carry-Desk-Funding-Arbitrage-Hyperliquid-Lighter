// The tradable universe: every spot pair and every perp on every perp dex (the main
// dex plus all HIP-3 builder-deployed dexes), normalised into flat market records.

const num = (x) => (x == null || x === '' ? null : Number(x))

/** Fetch everything the scanner needs in one sweep (≈ 20 weight per dex). */
export async function fetchUniverse(client) {
  const [dexes, spot] = await Promise.all([client.perpDexs(), client.spotMetaAndAssetCtxs()])
  const names = ['', ...dexes.filter(Boolean).map((d) => d.name)]
  const perps = await Promise.all(
    names.map((dex) =>
      client
        .metaAndAssetCtxs(dex)
        .then(([meta, ctxs]) => ({ dex, meta, ctxs }))
        .catch(() => null),
    ),
  )
  return { dexes, spot, perps: perps.filter(Boolean) }
}

/** Pure: raw API payloads → { spot, perps, dexes, tokens }. */
export function buildUniverse({ dexes = [], spot, perps = [] }) {
  const [spotMeta, spotCtxs] = spot
  const tokens = new Map(spotMeta.tokens.map((t) => [t.index, t]))
  const spotCtxByCoin = new Map(spotCtxs.map((c) => [c.coin, c]))

  // Every token that quotes a spot pair is a quote asset (USDC, USDT0, USDE, USDH …).
  const quotes = new Set(spotMeta.universe.map((p) => tokens.get(p.tokens[1])?.name).filter(Boolean))

  const spotMarkets = []
  for (const pair of spotMeta.universe) {
    const base = tokens.get(pair.tokens[0])
    const quote = tokens.get(pair.tokens[1])
    if (!base || !quote) continue
    const ctx = spotCtxByCoin.get(pair.name) ?? {}
    spotMarkets.push({
      kind: 'spot',
      coin: pair.name,
      pairIndex: pair.index,
      base: {
        name: base.name,
        fullName: base.fullName ?? null,
        index: base.index,
        tokenId: base.tokenId,
        szDecimals: base.szDecimals,
        feeShare: num(base.deployerTradingFeeShare),
      },
      quote: quote.name,
      mid: num(ctx.midPx),
      mark: num(ctx.markPx),
      prevDay: num(ctx.prevDayPx),
      volume: num(ctx.dayNtlVlm) ?? 0,
    })
  }

  const dexInfo = new Map()
  for (const d of dexes) {
    if (!d) continue
    dexInfo.set(d.name, {
      name: d.name,
      fullName: d.fullName,
      deployer: d.deployer,
      oiCaps: new Map((d.assetToStreamingOiCap ?? []).map(([coin, cap]) => [coin, num(cap)])),
      fundingMultipliers: new Map((d.assetToFundingMultiplier ?? []).map(([coin, m]) => [coin, num(m)])),
    })
  }

  const perpMarkets = []
  for (const { dex, meta, ctxs } of perps) {
    const collateral = tokens.get(meta.collateralToken)?.name ?? 'USDC'
    meta.universe.forEach((asset, i) => {
      if (asset.isDelisted) return
      const ctx = ctxs[i] ?? {}
      const oracle = num(ctx.oraclePx)
      const openInterest = num(ctx.openInterest) ?? 0
      const symbol = dex ? asset.name.slice(dex.length + 1) : asset.name
      perpMarkets.push({
        kind: 'perp',
        coin: asset.name,
        dex,
        symbol,
        collateral,
        funding: num(ctx.funding) ?? 0,
        premium: num(ctx.premium),
        oracle,
        mark: num(ctx.markPx),
        mid: num(ctx.midPx),
        impact: ctx.impactPxs ? ctx.impactPxs.map(Number) : null,
        prevDay: num(ctx.prevDayPx),
        volume: num(ctx.dayNtlVlm) ?? 0,
        openInterest,
        openInterestUsd: oracle ? openInterest * oracle : null,
        oiCap: dexInfo.get(dex)?.oiCaps.get(asset.name) ?? null,
        maxLeverage: asset.maxLeverage,
        onlyIsolated: Boolean(asset.onlyIsolated) || asset.marginMode === 'strictIsolated' || asset.marginMode === 'noCross',
        feeScale: num(asset.deployerFeeScale),
        growthMode: asset.growthMode ?? null,
        szDecimals: asset.szDecimals,
      })
    })
  }

  return { spot: spotMarkets, perps: perpMarkets, dexes: dexInfo, tokens, quotes }
}
