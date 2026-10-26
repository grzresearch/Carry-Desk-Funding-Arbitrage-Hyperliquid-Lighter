// Capture a trimmed snapshot of the Hyperliquid universe for regression tests:
//   node scripts/snapshot.mjs > tests/fixtures/universe.json
// Only the fields the dashboard reads are kept so the fixture stays small.

const INFO = 'https://api.hyperliquid.xyz/info'

async function info(body) {
  const res = await fetch(INFO, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  if (!res.ok) throw new Error(`${body.type} ${res.status}`)
  return res.json()
}

const pick = (o, keys) => Object.fromEntries(keys.filter((k) => k in o).map((k) => [k, o[k]]))

const dexes = await info({ type: 'perpDexs' })
const [spotMeta, spotCtxs] = await info({ type: 'spotMetaAndAssetCtxs' })
const perps = []
for (const dex of ['', ...dexes.filter(Boolean).map((d) => d.name)]) {
  const [meta, ctxs] = await info(dex ? { type: 'metaAndAssetCtxs', dex } : { type: 'metaAndAssetCtxs' })
  perps.push({
    dex,
    meta: { collateralToken: meta.collateralToken, universe: meta.universe },
    ctxs: ctxs.map((c) => pick(c, ['funding', 'openInterest', 'premium', 'oraclePx', 'markPx', 'midPx', 'impactPxs', 'dayNtlVlm', 'prevDayPx'])),
  })
}

const snapshot = {
  capturedAt: new Date().toISOString(),
  dexes: dexes.map((d) => d && pick(d, ['name', 'fullName', 'deployer', 'assetToStreamingOiCap', 'assetToFundingMultiplier', 'assetToFundingInterestRate'])),
  spot: [
    {
      universe: spotMeta.universe,
      tokens: spotMeta.tokens.map((t) => pick(t, ['name', 'fullName', 'index', 'szDecimals', 'tokenId', 'isCanonical', 'deployerTradingFeeShare'])),
    },
    spotCtxs.map((c) => pick(c, ['coin', 'midPx', 'markPx', 'prevDayPx', 'dayNtlVlm'])),
  ],
  perps,
}
process.stdout.write(JSON.stringify(snapshot))
