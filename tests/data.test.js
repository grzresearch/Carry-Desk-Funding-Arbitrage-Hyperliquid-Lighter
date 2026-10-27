import { test } from 'node:test'
import assert from 'node:assert/strict'
import { VenueData } from '../site/js/data.js'

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

test('a thin row asks for the deeper book when its asks sit far above the bid', async () => {
  // Deep bids at 0.99, 200 tokens offered between 1.30 and 1.49: Σ px·sz is $279, but a
  // trip trades notional ÷ arrival price, and the arrival price can be as low as the bid.
  const precise = {
    bids: Array.from({ length: 20 }, (_, i) => ({ px: 0.99 - 0.001 * i, sz: 1000 })),
    asks: Array.from({ length: 20 }, (_, i) => ({ px: 1.3 + 0.01 * i, sz: 10 })),
    time: 1,
  }
  let coarse = 0
  const spot = { kind: 'spot', key: 'S', coin: 'S', base: { name: 'UX' }, quote: 'USDC', mid: 1.145, volume: 1e6 }
  const adapter = {
    id: 'hl',
    name: 'Fake',
    supportsCoarse: true,
    loadUniverse: async () => ({ spot: [spot], perps: [], pairs: [] }),
    fetchBook: async (m, opts) => {
      if (opts?.coarse) coarse++
      return precise
    },
  }
  const v = new VenueData(adapter)
  await v.refreshUniverse()
  await v.refreshBooks(['S'])
  assert.ok(v.preciseDepth('S') < 220 * 1.2)
  v.wantDepth(['S'], 220)
  await tick()
  assert.equal(coarse, 1)
})
