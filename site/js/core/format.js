// Number formatting for a German-speaking desk: comma decimals, dot thousands.

const LOCALE = 'de-DE'
const cache = new Map()

function nf(options) {
  const key = JSON.stringify(options)
  if (!cache.has(key)) cache.set(key, new Intl.NumberFormat(LOCALE, options))
  return cache.get(key)
}

const DASH = '–'
const finite = (x) => typeof x === 'number' && Number.isFinite(x)

/** $ amounts: cents only below $10, whole dollars below a million, then "Mio."/"Mrd.". */
export function usd(x, { sign = false, axis = false } = {}) {
  if (!finite(x)) return DASH
  const abs = Math.abs(x)
  const cents = abs < 10 && !axis && abs !== 0
  const opts = abs >= 1e6
    ? { notation: 'compact', maximumFractionDigits: abs >= 1e7 ? 1 : 2 }
    : { maximumFractionDigits: cents ? 2 : 0, minimumFractionDigits: cents ? 2 : 0 }
  const body = nf(opts).format(abs)
  const prefix = x < 0 ? '−' : sign && x > 0 ? '+' : ''
  return `${prefix}$${body}`
}

/** Prices keep ~5 significant digits whatever their magnitude. */
export function price(x) {
  if (!finite(x)) return DASH
  const abs = Math.abs(x)
  const digits = abs >= 1000 ? 1 : abs >= 1 ? Math.min(4, 5 - Math.floor(Math.log10(abs)) - 1) : Math.min(10, 4 - Math.floor(Math.log10(abs)))
  const d = Math.max(0, digits)
  return nf({ maximumFractionDigits: d, minimumFractionDigits: d }).format(x)
}

export function bps(x, { sign = false, digits = 1 } = {}) {
  if (!finite(x)) return DASH
  const body = nf({ maximumFractionDigits: digits, minimumFractionDigits: digits }).format(Math.abs(x))
  const prefix = x < 0 ? '−' : sign && x > 0 ? '+' : ''
  return `${prefix}${body}`
}

/** Fractions as percent: 0.1095 → "10,95 %". */
export function pct(x, { sign = false, digits = 2 } = {}) {
  if (!finite(x)) return DASH
  const body = nf({ maximumFractionDigits: digits, minimumFractionDigits: digits }).format(Math.abs(x) * 100)
  const prefix = x < 0 ? '−' : sign && x > 0 ? '+' : ''
  return `${prefix}${body} %`
}

/** Hourly funding rate as "0,0012 %". */
export function rate(x) {
  if (!finite(x)) return DASH
  return pct(x, { sign: true, digits: 4 })
}

/** Hours as a human duration: 5 h, 3,2 T, 7 W. */
export function duration(hours) {
  if (hours === Infinity) return '∞'
  if (!finite(hours)) return DASH
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`
  if (hours < 48) return `${nf({ maximumFractionDigits: 1 }).format(hours)} h`
  const days = hours / 24
  if (days < 60) return `${nf({ maximumFractionDigits: 1 }).format(days)} T`
  return `${nf({ maximumFractionDigits: 0 }).format(days / 30.4)} M`
}

export function qty(x) {
  if (!finite(x)) return DASH
  const abs = Math.abs(x)
  return nf({ maximumFractionDigits: abs >= 100 ? 0 : abs >= 1 ? 3 : 6 }).format(x)
}

export function compact(x) {
  if (!finite(x)) return DASH
  return nf({ notation: 'compact', maximumFractionDigits: 1 }).format(x)
}

export function timeOfDay(ms) {
  if (!finite(ms)) return DASH
  return new Date(ms).toLocaleTimeString(LOCALE, { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

/** "10.000", "10k", "1,5m", "250 000" → number. */
export function parseAmount(text) {
  const t = String(text).trim().toLowerCase().replace(/\s|\$/g, '')
  const m = t.match(/^([\d.,]+)([km]?)$/)
  if (!m) return null
  let digits = m[1]
  // German: dots group thousands, a comma is the decimal mark.
  if (digits.includes(',')) digits = digits.replace(/\./g, '').replace(',', '.')
  else if (/^\d{1,3}(\.\d{3})+$/.test(digits)) digits = digits.replace(/\./g, '')
  const n = Number(digits) * (m[2] === 'k' ? 1e3 : m[2] === 'm' ? 1e6 : 1)
  return Number.isFinite(n) && n > 0 ? n : null
}
