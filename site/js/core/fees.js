// Taker fees per leg, following the "Fee formula for developers" in the Hyperliquid
// docs (https://hyperliquid.gitbook.io/hyperliquid-docs/trading/fees).
//
// Every leg of the carry is a market order, so only taker rates matter here.

/** Base taker rate in bps by 14-day volume tier (index 0 = < $5M). */
export const PERP_TAKER_BPS = [4.5, 4.0, 3.5, 3.0, 2.8, 2.6, 2.4]
export const SPOT_TAKER_BPS = [7.0, 6.0, 5.0, 4.0, 3.5, 3.0, 2.5]

export const VOLUME_TIERS = ['< $5M', '> $5M', '> $25M', '> $100M', '> $500M', '> $2B', '> $7B']

/** Discount for staked HYPE, applied to the base rates. */
export const STAKING_DISCOUNTS = [
  { name: 'Keins', discount: 0 },
  { name: 'Wood', discount: 0.05 },
  { name: 'Bronze', discount: 0.1 },
  { name: 'Silver', discount: 0.15 },
  { name: 'Gold', discount: 0.2 },
  { name: 'Platinum', discount: 0.3 },
  { name: 'Diamond', discount: 0.4 },
]

/**
 * Multiplier HIP-3 applies on top of the base perp rate. A deployer fee scale below 1
 * adds to the protocol fee; at or above 1 the deployer fee equals the protocol fee.
 */
export function hip3Scale(deployerFeeScale) {
  if (deployerFeeScale == null) return 1
  return deployerFeeScale < 1 ? deployerFeeScale + 1 : deployerFeeScale * 2
}

/** Share of the all-in fee kept by a HIP-3 deployer. */
export function hip3DeployerShare(deployerFeeScale) {
  if (deployerFeeScale == null) return 0
  return deployerFeeScale < 1 ? deployerFeeScale / (1 + deployerFeeScale) : 0.5
}

/**
 * The account's own base taker rates (before any per-market scaling).
 * @param {{ tier?: number, staking?: number, referral?: number }} account
 */
export function accountRates({ tier = 0, staking = 0, referral = 0 } = {}) {
  const keep = (1 - (STAKING_DISCOUNTS[staking]?.discount ?? 0)) * (1 - referral)
  return { perp: PERP_TAKER_BPS[tier] * keep, spot: SPOT_TAKER_BPS[tier] * keep }
}

/**
 * Taker fee in bps for one market.
 * @param {object} market        a spot or perp market from universe.js
 * @param {{ perp: number, spot: number }} rates  output of accountRates()
 * @param {{ aligned: Set<string>, stable: Set<string> }} quotes  aligned quote tokens; spot quote tokens
 */
export function takerFeeBps(market, rates, { aligned = new Set(), stable = new Set() } = {}) {
  if (market.kind === 'spot') {
    const stablePair = stable.has(market.base.name) && stable.has(market.quote)
    let bps = rates.spot * (stablePair ? 0.2 : 1)
    if (aligned.has(market.quote)) bps *= 0.8
    return bps
  }
  if (!market.dex) return rates.perp
  const share = hip3DeployerShare(market.feeScale)
  let bps = rates.perp * hip3Scale(market.feeScale) * (market.growthMode === 'enabled' ? 0.1 : 1)
  if (aligned.has(market.collateral)) bps *= (1 - share) * 0.8 + share
  return bps
}
