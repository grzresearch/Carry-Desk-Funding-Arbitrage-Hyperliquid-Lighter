// Words the UI shows for internal codes, in one place.

export const KIND = {
  same: 'Gleicher Basiswert',
  native: 'Gleicher Ticker',
  bridged: 'Bridge',
  wrapped: 'Wrapped',
  'tokenized-equity': 'Tokenisierte Aktie',
  proxy: 'Proxy',
}

export const KIND_SHORT = {
  same: 'Gleich',
  native: 'Ticker',
  bridged: 'Bridge',
  wrapped: 'Wrapped',
  'tokenized-equity': 'Tokenisiert',
  proxy: 'Proxy',
}

export const KIND_HELP = {
  same: 'Derselbe Basiswert auf beiden Börsen (gleicher oder umgerechneter Ticker, Preise bestätigt).',
  native: 'Spot-Token und Perp tragen denselben Ticker; die Preise stimmen überein (kein bekannter Emittent).',
  bridged: 'Gebridgter Token des Underlyings (z. B. Unit, LayerZero, Wagyu) – Peg- und Bridge-Risiko.',
  wrapped: 'Wrapper auf das Underlying – Emittenten- und Rücknahmerisiko.',
  'tokenized-equity': 'Tokenisierte Aktie eines Emittenten (EQX, xStocks …) gegen den Aktien-Perp.',
  proxy: 'Gleiches Exposure, anderes Instrument (ETF gegen Index, Gold-Token gegen PAXG) – Tracking-Risiko, Basis ohne Aussagekraft.',
}

export const CATEGORY = {
  equity: 'Aktie/ETF',
  crypto: 'Krypto',
  commodity: 'Rohstoff',
  fx: 'FX',
}

export const STATUS = {
  profit: { label: 'Lohnt sich', tone: 'good', icon: 'check' },
  loss: { label: 'Lohnt nicht', tone: 'bad', icon: 'cross' },
  thin: { label: 'Zu wenig Tiefe', tone: 'warn', icon: 'warn' },
  nobook: { label: 'Kein Orderbuch', tone: 'idle', icon: 'dot' },
  loading: { label: 'Lade …', tone: 'idle', icon: 'clock' },
  mismatch: { label: 'Preis passt nicht', tone: 'bad', icon: 'cross' },
}

/** Status text for a row; book states name the leg and whether it is one-sided. */
export function statusLabel(r) {
  if (r.status !== 'nobook') return STATUS[r.status].label
  const leg = { spot: 'Spot', perp: 'Perp', a: 'HL', b: 'Lighter' }[r.missing]
  return r.oneSided ? `${leg}-Buch einseitig` : `${leg} ohne Orderbuch`
}

export const DIRECTION = {
  carry: 'Long Spot · Short Perp',
  reverse: 'Short Spot · Long Perp',
  shortA: 'Short Hyperliquid · Long Lighter',
  shortB: 'Long Hyperliquid · Short Lighter',
}

/** Compact direction for table cells. */
export const DIRECTION_SHORT = {
  carry: 'Spot ↑ · Perp ↓',
  reverse: 'Spot ↓ · Perp ↑',
  shortA: 'HL ↓ · Lighter ↑',
  shortB: 'HL ↑ · Lighter ↓',
}

/** Display names of a pair's two legs. */
export function legNames(pair) {
  if (pair.type === 'cross') return [`HL ${pair.a.coin}`, `LT ${pair.b.symbol}`]
  return [`${pair.spot.base.name}/${pair.spot.quote}`, pair.perp.coin]
}

/** Leg colour classes: spot/perp, or venue A/B for a cross pair. */
export const legClass = (pair) => (pair.type === 'cross' ? ['a', 'b'] : ['spot', 'perp'])

export const LEG = {
  spotEntry: 'Spot Entry',
  perpEntry: 'Perp Entry',
  spotExit: 'Spot Exit',
  perpExit: 'Perp Exit',
}

export const SIDE = { buy: 'Kauf', sell: 'Verkauf' }

export const dexLabel = (perp) => (perp.venue === 'lt' ? 'Lighter' : perp.dex ? `HIP-3 · ${perp.dex}` : 'Main-Dex')

export const FUNDING_SOURCE = { now: 'aktuell', avg24: 'Ø 24 h', avg7d: 'Ø 7 T' }
