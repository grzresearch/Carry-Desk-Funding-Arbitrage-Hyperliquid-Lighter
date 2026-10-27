// Maker execution: post a limit order at the touch, wait, then take what is left.
//
// A resting order saves the half spread and pays the (lower) maker fee — but only on
// what fills, and fills are not free: the order fills when the market comes to it,
// which is exactly when the price is moving against it (adverse selection). Whatever
// has not filled when the wait is over is crossed as a market order into a book like
// today's. This module prices all of that per order, so a maker leg slots into the
// implementation shortfall of a round trip exactly like a market order does: against
// the arrival mid, in the same components.
//
// The model, for unit u ∈ [0, q] of the order, queued FIFO behind x0 at the touch:
//  (1) price — the fair price (a driftless random walk, volatility σ per √s) has moved
//      towards the order by
//          m(u) = d0 + Y · σ · √((x0 + u) / λ)
//      d0 is the distance from the mid to the limit (the half spread when joining), λ
//      the marketable flow per second on our side, and Y · σ · √(v/λ) the excursion that
//      comes with v trading at one level (square-root scaling). By the reflection
//      principle the walk gets there within T with probability
//          P_price(u) = erfc(m / (σ √(2T)))
//  (2) volume — the side's marketable volume during T is at least u (our own size: the
//      queue ahead mostly cancels when the price moves, so it need not trade). From a
//      zero-inflated Gamma fitted on the market's 1-minute candles: thin markets spend
//      most minutes without a trade at all.
// Taken as independent, P(u) = P_price(u) · P_vol(u), made non-increasing in u (FIFO).
// Independence keeps the adverse-selection identity exact: given a fill, the price has
// on average moved m(u) against the order by T (optional stopping) — so
//     filled share   E[φ]  = ∫ P(u) du / q
//     spread               = −E[φ] · d0              half spread earned on fills
//     adverse              = ∫ m(u) · P(u) du / q    adverse selection, counted once
//     rest                 = E[market order for q − F], F distributed as P(F ≥ u) = P(u)
//     fees                 = maker fee on fills, taker fee on the rest
// The tape shows the price does not stop at a fill: it keeps going for a few seconds
// (BTC −0.8 bps 5–10 s after a level is emptied). That continuation, ψ = 0.25·σ·√10 s
// per filled unit, is added to the adverse selection; it does not change who fills.
// Y = 0.35 (fits ranged 0.25–0.5) and the volume condition were fitted and checked on a
// queue-position backtest — resting orders replayed against recorded Hyperliquid books
// and trades — and on 24 h candle replays (BTC, SOL, LINK, thin HIP-3 and spot markets,
// Lighter BTC and LINK), matching realised fill rates and adverse selection. It is a
// closed form of Cont & Kukanov's limit/market split with the adverse selection of
// Moallemi & Yuan made explicit; static order, no re-pegging.

import { legShortfall } from './shortfall.js'

export const WAITS = [[1, '1 min'], [5, '5 min'], [15, '15 min'], [60, '60 min']]

/** Queue time → price distance (see above). */
export const QUEUE_Y = 0.35

/** How far back the activity estimate looks (1-minute candles). */
export const CANDLE_HOURS = 24

/** Used until a market's candles have loaded: crypto-typical, flagged as an estimate. */
const FALLBACK_SIGMA = 0.8e-4 // per √s ≈ 45 % a year

/** Price continuation after a fill: ψ = POST_FILL · σ · √min(T, POST_FILL_SEC). */
const POST_FILL = 0.25
const POST_FILL_SEC = 10

/**
 * The 24 h volume averages in its bursts; the median hour, which Y was fitted against,
 * runs at roughly 0.55–0.75 of that mean on the markets measured.
 */
const MEAN_TO_MEDIAN = 0.6

/** erfc, relative error < 1.2e-7 (Numerical Recipes erfcc). */
export function erfc(x) {
  const z = Math.abs(x)
  const t = 1 / (1 + 0.5 * z)
  const r = t * Math.exp(-z * z - 1.26551223 + t * (1.00002368 + t * (0.37409196 + t * (0.09678418 + t * (-0.18628806 + t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))))
  return x >= 0 ? r : 2 - r
}

/** ln Γ(x), Lanczos (g = 7, n = 9). */
function lgamma(x) {
  const c = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7]
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x)
  x -= 1
  let a = c[0]
  const t = x + 7.5
  for (let i = 1; i < 9; i++) a += c[i] / (x + i)
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a)
}

/** Regularised upper incomplete gamma Q(a, x) = P(Gamma(a, 1) > x). */
export function gammaQ(a, x) {
  if (!(x > 0)) return 1
  if (!(a > 0)) return 0
  const lead = -x + a * Math.log(x) - lgamma(a)
  if (x < a + 1) {
    // Series for the lower part.
    let ap = a
    let sum = 1 / a
    let del = sum
    for (let n = 0; n < 500; n++) {
      ap += 1
      del *= x / ap
      sum += del
      if (Math.abs(del) < Math.abs(sum) * 1e-13) break
    }
    return Math.max(0, 1 - sum * Math.exp(lead))
  }
  // Continued fraction for the upper part (modified Lentz).
  const tiny = 1e-300
  let b = x + 1 - a
  let c = 1 / tiny
  let d = 1 / b
  let h = d
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a)
    b += 2
    d = an * d + b
    if (Math.abs(d) < tiny) d = tiny
    c = b + an / c
    if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const del = d * c
    h *= del
    if (Math.abs(del - 1) < 1e-13) break
  }
  return Math.min(1, Math.exp(lead) * h)
}

/** P(a driftless walk with volatility σ per √s moves m ≥ 0 within T seconds). */
export function hitProb(m, sigma, T) {
  if (!(m > 0)) return 1
  const s = sigma * Math.sqrt(T)
  if (!(s > 0) || !Number.isFinite(m)) return 0
  return erfc(m / (s * Math.SQRT2))
}

/** σ per √s from 1-minute closes, over 5-minute steps (damps the bid/ask bounce). */
export function sigmaFromCandles(candles, step = 5) {
  const closes = candles.map((c) => c.close).filter((x) => x > 0)
  let ss = 0
  let n = 0
  for (let i = step; i < closes.length; i += step) {
    const r = Math.log(closes[i] / closes[i - step])
    ss += r * r
    n++
  }
  return n ? Math.sqrt(ss / n / (step * 60)) : null
}

/**
 * Marketable volume on one side, from 1-minute candles [{ time, notional }]: half of
 * each minute's notional. For windows of 1, 2, 5, 15 and 60 minutes a zero-inflated
 * Gamma is fitted by moments on rolling sums (minutes without candles count as zero);
 * `survival(usd, sec)` = P(volume over `sec` ≥ `usd`), interpolated in log time.
 * The flow λ is the median of the rolling hours — robust to the bursts that will not be
 * there while you wait, and what Y was calibrated against.
 */
export function sideVolume(candles) {
  if (!candles?.length) return { flowUsd: 0, survival: () => 0 }
  const first = Math.floor(candles[0].time / 60_000)
  const last = Math.floor(candles[candles.length - 1].time / 60_000)
  const minutes = new Float64Array(last - first + 1)
  for (const c of candles) minutes[Math.floor(c.time / 60_000) - first] += (c.notional || 0) / 2
  const fits = [1, 2, 5, 15, 60].filter((n) => n <= minutes.length).map((n) => {
    let sum = 0
    for (let i = 0; i < n; i++) sum += minutes[i]
    let windows = 0
    let busy = 0
    let s1 = 0
    let s2 = 0
    for (let i = n; ; i++) {
      windows++
      if (sum > 1e-9) {
        busy++
        s1 += sum
        s2 += sum * sum
      }
      if (i >= minutes.length) break
      sum += minutes[i] - minutes[i - n]
    }
    const mean = busy ? s1 / busy : 0
    const variance = busy > 1 ? Math.max(s2 / busy - mean * mean, 1e-12) : mean * mean
    const k = Math.min(50, Math.max(0.05, (mean * mean) / variance))
    return { sec: n * 60, p: busy / windows, k, theta: mean / k }
  })
  const at = (f, usd) => (f.p > 0 && f.theta > 0 ? f.p * gammaQ(f.k, usd / f.theta) : 0)
  const survival = (usd, sec) => {
    if (!(usd > 0)) return 1
    const f0 = fits[0]
    if (sec <= f0.sec) {
      // Under a minute fewer windows carry a trade; a busy one looks like a busy minute.
      return (1 - (1 - f0.p) ** (sec / f0.sec)) * (f0.theta > 0 ? gammaQ(f0.k, usd / f0.theta) : 0)
    }
    for (let i = 1; i < fits.length; i++) {
      if (sec <= fits[i].sec) {
        const x = Math.log(sec / fits[i - 1].sec) / Math.log(fits[i].sec / fits[i - 1].sec)
        return (1 - x) * at(fits[i - 1], usd) + x * at(fits[i], usd)
      }
    }
    const f = fits[fits.length - 1] // beyond the longest window: scale its mean with time
    return at(f, (usd * f.sec) / sec)
  }
  const hours = []
  let run = 0
  for (let i = 0; i < minutes.length; i++) {
    run += minutes[i]
    if (i >= 60) run -= minutes[i - 60]
    if (i >= 59) hours.push(run)
  }
  hours.sort((a, b) => a - b)
  let total = 0
  for (const v of minutes) total += v
  const flowUsd = hours.length ? hours[hours.length >> 1] / 3600 : total / (minutes.length * 60)
  return { flowUsd, survival }
}

/** Activity of a market from its 1-minute candles, or null while they are missing. */
export function activityFrom(candles) {
  if (!candles || candles.length < 30) return null
  const sigma = sigmaFromCandles(candles)
  const volume = sideVolume(candles)
  return { sigma: sigma ?? FALLBACK_SIGMA, flowUsd: volume.flowUsd, survival: volume.survival }
}

/** Fallback from the 24 h volume alone (Gamma with shape sec/300), flagged as estimate. */
export function activityFallback(market) {
  const flowUsd = (MEAN_TO_MEDIAN * (market.volume ?? 0)) / 86_400 / 2
  return {
    sigma: FALLBACK_SIGMA,
    flowUsd,
    survival: (usd, sec) => (flowUsd > 0 ? gammaQ(sec / 300, usd / (flowUsd * 300)) : 0),
    estimated: true,
  }
}

/**
 * survival(usd, sec) for one wait time, tabulated once per activity on a log grid of
 * sizes and interpolated: the size curve prices hundreds of orders against it.
 */
const GRID_LO = -1 // 10^-1 USD
const GRID_STEP = 0.05 // in log10
const GRID_N = 201 // up to 10^9 USD
function survivalAt(activity, sec) {
  activity.tables ??= new Map()
  let table = activity.tables.get(sec)
  if (!table) {
    table = new Float64Array(GRID_N)
    for (let i = 0; i < GRID_N; i++) table[i] = activity.survival(10 ** (GRID_LO + i * GRID_STEP), sec)
    activity.tables.set(sec, table)
  }
  return (usd) => {
    if (!(usd > 0)) return 1
    const x = (Math.log10(usd) - GRID_LO) / GRID_STEP
    if (x <= 0) return table[0]
    if (x >= GRID_N - 1) return table[GRID_N - 1]
    const i = Math.floor(x)
    return table[i] + (x - i) * (table[i + 1] - table[i])
  }
}

const GL_X = [0.019855071751231856, 0.10166676129318664, 0.2372337950418355, 0.4082826787521751, 0.5917173212478249, 0.7627662049581645, 0.8983332387068134, 0.9801449282487681]
const GL_W = [0.05061426814518813, 0.11119051722668724, 0.15685332293894363, 0.181341891689181, 0.181341891689181, 0.15685332293894363, 0.11119051722668724, 0.05061426814518813]

/**
 * Price one order as a resting maker order (see the module comment). Same shape as
 * legShortfall — cost components in quote currency and bps of qty × ref — plus
 * `cost.adverse` and a `maker` summary.
 */
export function makerOrder(book, side, qty, { ref, takerFeeBps, makerFeeBps, activity, waitMin, Y = QUEUE_Y, nodes = 24 }) {
  const buy = side === 'buy'
  const own = buy ? book.bids : book.asks
  const opp = buy ? book.asks : book.bids
  if (!own?.length || !opp?.length || !ref || !(qty > 0)) return legShortfall(book, side, qty, takerFeeBps, ref)
  const { px: limit, sz: queue } = own[0]
  const d0 = Math.max(0, (buy ? ref - limit : limit - ref) / ref)
  const T = waitMin * 60
  const { sigma } = activity
  const lambda = activity.flowUsd / ref // base units per second on our side
  const m = (u) => (lambda > 0 ? d0 + Y * sigma * Math.sqrt((queue + u) / lambda) : Infinity)
  const psi = POST_FILL * sigma * Math.sqrt(Math.min(T, POST_FILL_SEC))
  const pAt = (u, t) => hitProb(m(u), sigma, t) * (u > 0 ? survivalAt(activity, t)(u * ref) : 1)

  // Quadratic grid in u (dense where √(x0 + u) bends), trapezoid rule.
  const us = Array.from({ length: nodes + 1 }, (_, k) => qty * (k / nodes) ** 2)
  const ms = us.map(m)
  const ps = us.map((u) => pAt(u, T))
  for (let k = 1; k <= nodes; k++) ps[k] = Math.min(ps[k], ps[k - 1]) // FIFO
  let intP = 0
  let intMP = 0
  for (let k = 0; k < nodes; k++) {
    const du = us[k + 1] - us[k]
    intP += 0.5 * (ps[k] + ps[k + 1]) * du
    intMP += 0.5 * ((ps[k] > 0 ? (ms[k] + psi) * ps[k] : 0) + (ps[k + 1] > 0 ? (ms[k + 1] + psi) * ps[k + 1] : 0)) * du
  }
  const filledShare = intP / qty

  // The rest R = q − F as a market order, averaged over how much filled (P(F ≥ u) = P(u)):
  // impact is convex in size, so the rest at the average fill would understate it.
  const rest = { spread: 0, impact: 0, fee: 0, notional: 0, qty: 0, complete: true, worstPx: null, levels: 0 }
  const take = (prob, R) => {
    if (!(prob > 1e-12) || !(R > qty * 1e-12)) return
    const leg = legShortfall(book, side, R, takerFeeBps, ref)
    if (!leg) return
    if (!leg.complete) rest.complete = false
    rest.spread += prob * leg.cost.spread
    rest.impact += prob * leg.cost.impact
    rest.fee += prob * leg.cost.fee
    rest.notional += prob * leg.vwap * leg.filled
    rest.qty += prob * leg.filled
    // Worst case: the largest rest walks deepest.
    if (leg.worstPx != null && (rest.worstPx == null || (buy ? leg.worstPx > rest.worstPx : leg.worstPx < rest.worstPx))) rest.worstPx = leg.worstPx
    rest.levels = Math.max(rest.levels, leg.levelsUsed)
  }
  take(1 - ps[0], qty)
  for (let k = 0; k < nodes; k++) take(ps[k] - ps[k + 1], qty - 0.5 * (us[k] + us[k + 1]))

  // How long the order stays open: E[min(τ_last, T)] = ∫₀ᵀ P(τ > t) dt, with t = T·s².
  let open = 0
  for (let i = 0; i < 8; i++) open += GL_W[i] * 2 * GL_X[i] * (1 - pAt(qty, T * GL_X[i] ** 2))

  const made = filledShare * qty
  const arrival = qty * ref
  const cost = {
    spread: -d0 * arrival * filledShare + rest.spread,
    impact: rest.impact,
    adverse: intMP * ref,
    fee: (made * limit * makerFeeBps) / 1e4 + rest.fee,
  }
  cost.total = cost.spread + cost.impact + cost.adverse + cost.fee
  const bps = (x) => (x / arrival) * 1e4
  const filled = made + rest.qty
  return {
    side,
    qty,
    mid: ref,
    best: limit,
    vwap: filled ? (made * limit + rest.notional) / filled : null,
    worstPx: rest.worstPx ?? limit,
    filled,
    fillRatio: filled / qty,
    complete: rest.complete,
    levelsUsed: rest.levels,
    arrival,
    cost,
    bps: { spread: bps(cost.spread), impact: bps(cost.impact), adverse: bps(cost.adverse), fee: bps(cost.fee), total: bps(cost.total) },
    maker: {
      filledShare,
      fullFill: ps[nodes],
      takenQty: qty - made, // expected size that still hits the book as a market order
      openSec: T * open,
      waitMin,
      queueUsd: queue * limit,
      flowUsd: activity.flowUsd,
      sigma,
      estimated: Boolean(activity.estimated),
    },
  }
}

/** Activity per candle set (or per market while candles are missing), built once. */
const activities = new WeakMap()
function activityOf(market, candles) {
  const key = candles ?? market
  let activity = activities.get(key)
  if (!activity) {
    activity = activityFrom(candles) ?? activityFallback(market)
    activities.set(key, activity)
  }
  return activity
}

/** An order executor for one market's leg: (book, side, qty, takerFeeBps, ref) → leg. */
export function executorFor({ market, candles, waitMin, makerFeeBps, takerFeeBps }) {
  const activity = activityOf(market, candles)
  return (book, side, qty, feeBps = takerFeeBps, ref) => makerOrder(book, side, qty, { ref, takerFeeBps: feeBps, makerFeeBps, activity, waitMin })
}

/** Quantity of a leg that takes liquidity (moves the book the premium is read from). */
export const takenQty = (leg) => (leg.maker ? leg.maker.takenQty : leg.qty)
