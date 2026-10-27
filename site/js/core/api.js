// Thin client for the public Hyperliquid info endpoint. Every attempt — retries included —
// is paid for through the WeightLimiter, so the dashboard never trips the per-IP limit.

import { WeightLimiter } from './ratelimit.js'

export const INFO_URL = 'https://api.hyperliquid.xyz/info'

const HOUR = 3_600_000
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function createClient({ fetchImpl = (...args) => globalThis.fetch(...args), limiter = new WeightLimiter(), url = INFO_URL } = {}) {
  /**
   * @param {object} body       info request
   * @param {object} o
   * @param {number} o.weight   weight reserved before the request
   * @param {number} o.perItems responses that cost extra per this many items
   * @param {number} o.prepaid  part of that extra already included in `weight`
   */
  async function info(body, { weight = 20, priority = 5, perItems = 0, prepaid = 0 } = {}) {
    for (let attempt = 0; ; attempt++) {
      await limiter.take(weight, priority)
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
        limiter.backoff(2000 * 2 ** attempt)
        continue
      }
      if (!res.ok) throw new Error(`${body.type} ${res.status}`)
      const data = await res.json()
      if (perItems && Array.isArray(data)) limiter.charge(Math.floor(data.length / perItems) - prepaid)
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
    tokenDetails: (tokenId, { priority = 6 } = {}) => info({ type: 'tokenDetails', tokenId }, { priority }),
    // Candles cost 20 plus 1 per 60 returned; reserve that up front like fundingHistory.
    candleSnapshot: (coin, interval, startTime, { minutes = 1, priority = 9 } = {}) => {
      const prepaid = Math.floor(Math.ceil((Date.now() - startTime) / (minutes * 60_000)) / 60)
      return info({ type: 'candleSnapshot', req: { coin, interval, startTime, endTime: Date.now() } }, { weight: 20 + prepaid, priority, perItems: 60, prepaid })
    },
    // One row per hour, at most 500 per call; reserve the per-20-rows weight up front.
    fundingHistory: (coin, startTime, { priority = 8 } = {}) => {
      const prepaid = Math.floor(Math.min(500, Math.ceil((Date.now() - startTime) / HOUR)) / 20)
      return info({ type: 'fundingHistory', coin, startTime }, { weight: 20 + prepaid, priority, perItems: 20, prepaid })
    },
  }
}
