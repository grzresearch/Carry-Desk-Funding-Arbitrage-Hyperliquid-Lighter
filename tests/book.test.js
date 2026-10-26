import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseBook, midPrice, spreadBps, walk, stitchDepth, deepBook, sideDepth } from '../site/js/core/book.js'

const book = parseBook({
  time: 1,
  levels: [
    [{ px: '99', sz: '1', n: 1 }, { px: '98', sz: '2', n: 1 }, { px: '97', sz: '5', n: 2 }],
    [{ px: '101', sz: '1', n: 1 }, { px: '102', sz: '2', n: 1 }, { px: '103', sz: '5', n: 2 }],
  ],
})

test('parseBook converts strings to numbers, best first', () => {
  assert.deepEqual(book.bids[0], { px: 99, sz: 1 })
  assert.deepEqual(book.asks[2], { px: 103, sz: 5 })
  assert.equal(midPrice(book), 100)
  assert.equal(spreadBps(book), 200)
})

test('parseBook tolerates missing data', () => {
  const empty = parseBook(null)
  assert.deepEqual(empty.bids, [])
  assert.equal(midPrice(empty), null)
})

test('walk fills across levels and reports vwap', () => {
  const fill = walk(book.asks, 2)
  assert.equal(fill.filled, 2)
  assert.equal(fill.notional, 101 + 102)
  assert.equal(fill.vwap, 101.5)
  assert.equal(fill.worstPx, 102)
  assert.equal(fill.levelsUsed, 2)
  assert.equal(fill.complete, true)
})

test('walk flags an incomplete fill when the book runs dry', () => {
  const fill = walk(book.bids, 10)
  assert.equal(fill.filled, 8)
  assert.equal(fill.complete, false)
})

test('walk of zero quantity is not complete and has no vwap', () => {
  const fill = walk(book.asks, 0)
  assert.equal(fill.vwap, null)
  assert.equal(fill.complete, false)
})

test('sideDepth sums size and notional', () => {
  assert.deepEqual(sideDepth(book.asks), { qty: 8, notional: 101 + 204 + 515 })
})

test('stitchDepth adds only the hidden residual of the straddling ask bucket', () => {
  // Visible asks up to 102. Coarse buckets (ceil): 101 -> [101], 110 -> (101,110], 120.
  const coarse = [
    { px: 101, sz: 1 },
    { px: 110, sz: 10 }, // contains visible 102 (2) and 103 (5) -> residual 3
    { px: 120, sz: 4 },
  ]
  const precise = [{ px: 101, sz: 1 }, { px: 102, sz: 2 }, { px: 103, sz: 5 }]
  const out = stitchDepth(precise, coarse, 'asks')
  assert.deepEqual(out.slice(3), [{ px: 110, sz: 3 }, { px: 120, sz: 4 }])
})

test('stitchDepth mirrors for bids (floored buckets)', () => {
  const precise = [{ px: 99, sz: 1 }, { px: 98, sz: 2 }, { px: 97, sz: 5 }]
  const coarse = [
    { px: 99, sz: 1 }, // [99,100) fully visible
    { px: 90, sz: 9 }, // [90,99) contains visible 98 + 97 = 7 -> residual 2
    { px: 80, sz: 6 },
  ]
  const out = stitchDepth(precise, coarse, 'bids')
  assert.deepEqual(out.slice(3), [{ px: 90, sz: 2 }, { px: 80, sz: 6 }])
})

test('stitchDepth drops a straddling bucket whose residual is negative (snapshot skew)', () => {
  const precise = [{ px: 101, sz: 5 }]
  const coarse = [{ px: 110, sz: 3 }, { px: 120, sz: 1 }]
  assert.deepEqual(stitchDepth(precise, coarse, 'asks'), [{ px: 101, sz: 5 }, { px: 120, sz: 1 }])
})

test('stitchDepth keeps prices monotonic so walking stays valid', () => {
  const precise = [{ px: 101, sz: 1 }, { px: 101.5, sz: 1 }]
  const coarse = [{ px: 102, sz: 5 }, { px: 103, sz: 5 }]
  const out = stitchDepth(precise, coarse, 'asks')
  for (let i = 1; i < out.length; i++) assert.ok(out[i].px >= out[i - 1].px)
  // bucket 102 holds the 2 visible units plus 3 hidden ones; bucket 103 is all hidden
  assert.equal(walk(out, 10).complete, true)
  assert.equal(walk(out, 10.5).complete, false)
})

test('deepBook passes through when one snapshot is missing', () => {
  assert.equal(deepBook(book, null), book)
  assert.equal(deepBook(null, book), book)
})
