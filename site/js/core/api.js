// Thin client for the public Hyperliquid info endpoint. Every call is routed through a
// WeightLimiter so the dashboard never trips the per-IP rate limit.

import { WeightLimiter } from './ratelimit.js'

export const INFO_URL = 'https://api.hyperliquid.xyz/info'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function createClient({ fetchImpl = globalThis.fetch.bind(globalThis), limiter = new WeightLimiter(), url = INFO_URL } = {}) {
  async function info(body, { weight = 20, priority = 5, perItems = 0 } = {}) {
    await limiter.take(weight, priority)
    for (let attempt = 0; ; attempt++) {
      let res
      try {
        res = await fetchImpl(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        })
      } catch (err) {
        if (attempt >= 3) throw err
        await sleep(500 * 2 ** attempt)
        continue
      }
      if (res.status === 429 && attempt < 4) {
        limiter.charge(limiter.budget / 4)
        await sleep(2000 * 2 ** attempt)
        continue
      }
      if (!res.ok) throw new Error(`${body.type} ${res.status}`)
      const data = await res.json()
      // Responses that return a variable number of items cost extra weight per item.
      if (perItems && Array.isArray(data)) limiter.charge(Math.floor(data.length / perItems))
      return data
    }
  }

  return {
    limiter,
    info,
    perpDexs: () => info({ type: 'perpDexs' }, { priority: 0 }),
    spotMetaAndAssetCtxs: () => info({ type: 'spotMetaAndAssetCtxs' }, { priority: 0 }),
    metaAndAssetCtxs: (dex = '') => info(dex ? { type: 'metaAndAssetCtxs', dex } : { type: 'metaAndAssetCtxs' }, { priority: 1 }),
    l2Book: (coin, { nSigFigs = null, priority = 3 } = {}) =>
      info(nSigFigs ? { type: 'l2Book', coin, nSigFigs } : { type: 'l2Book', coin }, { weight: 2, priority }),
    fundingHistory: (coin, startTime, { priority = 8 } = {}) =>
      info({ type: 'fundingHistory', coin, startTime }, { weight: 20, priority, perItems: 20 }),
  }
}
