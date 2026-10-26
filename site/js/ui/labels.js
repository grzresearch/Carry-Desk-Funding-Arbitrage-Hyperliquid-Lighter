// Words the UI shows for internal codes, in one place.

export const KIND = {
  native: 'Gleicher Ticker',
  bridged: 'Bridge',
  wrapped: 'Wrapped',
  'tokenized-equity': 'Tokenisierte Aktie',
  proxy: 'Proxy',
}

export const KIND_SHORT = {
  native: 'Ticker',
  bridged: 'Bridge',
  wrapped: 'Wrapped',
  'tokenized-equity': 'Tokenisiert',
  proxy: 'Proxy',
}

export const KIND_HELP = {
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
  const leg = r.missing === 'spot' ? 'Spot' : 'Perp'
  return r.oneSided ? `${leg}-Buch einseitig` : `${leg} ohne Orderbuch`
}

export const DIRECTION = {
  carry: 'Long Spot · Short Perp',
  reverse: 'Short Spot · Long Perp',
}

export const LEG = {
  spotEntry: 'Spot Entry',
  perpEntry: 'Perp Entry',
  spotExit: 'Spot Exit',
  perpExit: 'Perp Exit',
}

export const SIDE = { buy: 'Kauf', sell: 'Verkauf' }

export const dexLabel = (perp) => (perp.dex ? `HIP-3 · ${perp.dex}` : 'Main-Dex')

export const FUNDING_SOURCE = { now: 'aktuell', avg24: 'Ø 24 h', avg7d: 'Ø 7 T' }
