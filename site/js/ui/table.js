// The pair table and the overview tiles above it.

import { h, icon, mount } from './dom.js'
import * as fmt from '../core/format.js'
import { STATUS_RANK } from '../core/evaluate.js'
import { KIND, KIND_SHORT, KIND_HELP, CATEGORY, STATUS, DIRECTION, FUNDING_SOURCE, dexLabel, statusLabel } from './labels.js'

// Economics exist only for sizes the books can fill (evaluatePair drops them otherwise),
// so rows that cannot fill sink below every priced row and rank among themselves by status.
/** Sort keys: value extractor and natural direction. Nulls always sink. */
export const SORTS = Object.assign(Object.create(null), {
  name: { get: (r) => r.pair.underlying, dir: 'asc' },
  funding: { get: (r) => r.fundingApr, dir: 'desc' },
  basis: { get: (r) => r.basis, dir: 'desc' },
  cost: { get: (r) => (r.econ ? r.trip.costBps : null), dir: 'asc' },
  breakeven: { get: (r) => r.econ?.breakEvenHours, dir: 'asc' },
  net: { get: (r) => r.econ?.netUsd, dir: 'desc' },
  optimal: { get: (r) => r.curve?.best?.netUsd, dir: 'desc' },
  depth: { get: (r) => r.curve?.capacity, dir: 'desc' },
  status: { get: (r) => -STATUS_RANK[r.status] * 1e12 + (r.econ?.netUsd ?? 0), dir: 'desc' },
})

export function sortRows(rows, key, dir) {
  const { get } = SORTS[key] ?? SORTS.net
  const sign = dir === 'asc' ? 1 : -1
  const valid = (v) => v != null && !Number.isNaN(v) && (typeof v === 'string' || Number.isFinite(v) || v === Infinity)
  return rows.slice().sort((a, b) => {
    const va = get(a)
    const vb = get(b)
    const ka = valid(va)
    const kb = valid(vb)
    if (ka !== kb) return ka ? -1 : 1
    if (!ka) return STATUS_RANK[a.status] - STATUS_RANK[b.status]
    if (typeof va === 'string') return sign * va.localeCompare(vb)
    if (va === vb) return STATUS_RANK[a.status] - STATUS_RANK[b.status]
    return sign * (va < vb ? -1 : 1)
  })
}

export function filterRows(rows, f) {
  const q = f.q.trim().toLowerCase()
  return rows.filter((r) => {
    const p = r.pair
    // A match the real quotes contradict is not a pair at all.
    if (r.status === 'mismatch') return false
    if (f.category !== 'all' && p.category !== f.category) return false
    if (f.issuer !== 'all' && (p.issuer ?? 'none') !== f.issuer) return false
    if (f.onlyProfitable && r.status !== 'profit') return false
    if (!f.showReverse && r.direction === 'reverse') return false
    if (q) {
      const hay = [p.underlying, p.key, p.spot.coin, `${p.spot.base.name}/${p.spot.quote}`, p.spot.base.fullName, p.perp.coin, p.perp.dex, p.issuer, KIND[p.kind], CATEGORY[p.category]]
        .filter(Boolean).join(' ').toLowerCase()
      if (!q.split(/[\s⇄]+/).filter(Boolean).every((t) => hay.includes(t))) return false
    }
    return true
  })
}

const signClass = (x) => (x > 0 ? 'pos' : x < 0 ? 'neg' : null)

function statusCell(r) {
  const st = STATUS[r.status]
  return h('td', { class: 'col-status', 'data-label': 'Status' },
    h('div', { class: `status ${st.tone}` }, icon(st.icon), statusLabel(r)),
    h('div', { class: 'cell-sub', title: DIRECTION[r.direction] }, r.direction === 'carry' ? 'Spot ↑ · Perp ↓' : 'Spot ↓ · Perp ↑'))
}

function assetCell(r) {
  const p = r.pair
  const full = p.spot.base.fullName && p.spot.base.fullName !== p.spot.base.name ? p.spot.base.fullName : null
  return h('td', { class: 'col-asset' },
    h('div', { class: 'asset' },
      h('div', { class: 'asset-name' }, h('strong', null, p.underlying), full ? h('span', { class: 'fullname', title: full }, full) : null),
      h('div', { class: 'legs' },
        h('span', null, h('i', { class: 'leg-key spot' }), `${p.spot.base.name}/${p.spot.quote}`),
        h('span', { 'aria-hidden': 'true' }, '⇄'),
        h('span', null, h('i', { class: 'leg-key perp' }), p.perp.coin)),
      h('div', { class: 'badges' },
        p.issuer ? h('span', { class: `badge${p.issuer === 'EQX' ? ' strong' : ''}` }, p.issuer) : null,
        h('span', { class: 'badge', title: KIND_HELP[p.kind] }, KIND_SHORT[p.kind]),
        h('span', { class: 'badge', title: dexLabel(p.perp) }, p.perp.dex || 'main'),
        p.flagged ? h('span', { class: 'badge', title: 'Spot und Perp weichen um mehr als 5 % voneinander ab' }, 'Preisabweichung') : null)))
}

function costBar(trip) {
  let spread = 0
  let impact = 0
  let fee = 0
  for (const leg of Object.values(trip.legs)) {
    spread += leg.cost.spread
    impact += leg.cost.impact
    fee += leg.cost.fee
  }
  const total = spread + impact + fee || 1
  const seg = (cls, v, label) => h('span', { class: cls, style: { width: `${Math.max(2, (v / total) * 72)}px` }, title: `${label}: ${fmt.usd(v)}` })
  return h('div', { class: 'costbar', 'aria-hidden': 'true' }, seg('spread', spread, 'Spread'), seg('impact', impact, 'Impact'), seg('fee', fee, 'Gebühren'))
}

/** Funding once your own perp order has moved the premium — shown only when it differs. */
function fundingShift(r, settings) {
  if (!r.atSize || settings.fundingImpact === 'off') return null
  const earned = r.direction === 'carry' ? r.fundingApr : -r.fundingApr
  if (Math.abs(r.atSize.apr - earned) < 0.0005) return null
  return h('div', { class: 'cell-sub neg', title: 'Dein Perp-Order drückt die Premium, aus der das Funding berechnet wird' },
    `→ ${fmt.pct(r.atSize.apr, { sign: true, digits: 1 })} bei ${fmt.usd(settings.notional)}`)
}

function row(r, settings, selectedId) {
  const p = r.pair
  const { econ, trip, curve } = r
  const cells = [
    assetCell(r),
    h('td', { class: 'num', 'data-label': 'Funding p.a.' },
      h('div', { class: 'cell-main' }, fmt.pct(r.fundingApr, { sign: true })),
      h('div', { class: 'cell-sub', title: r.rate.fallback ? 'Historie lädt noch – bis dahin gilt die aktuelle Rate' : null }, `${fmt.rate(r.rate.value)}/h · ${r.rate.fallback ? 'aktuell*' : FUNDING_SOURCE[r.rate.source]}`),
      fundingShift(r, settings)),
    h('td', { class: 'num', 'data-label': 'Basis' },
      h('div', { class: 'cell-main' }, r.basis == null ? '–' : `${fmt.bps(r.basis, { sign: true })} bps`),
      h('div', { class: 'cell-sub' }, r.basis == null ? (p.kind === 'proxy' ? 'Proxy' : 'kein Preis') : r.basis >= 0 ? 'Perp über Spot' : 'Perp unter Spot')),
    h('td', { class: 'num', 'data-label': 'Kosten Ein + Aus' },
      econ
        ? [h('div', { class: 'cell-main' }, `${fmt.bps(trip.costBps)} bps`), h('div', { class: 'cell-sub' }, fmt.usd(trip.costUsd)), costBar(trip)]
        : trip
          ? [h('div', { class: 'cell-main muted', title: 'Die sichtbare Tiefe füllt diese Größe nicht – Kosten unbekannt' }, 'unvollständig'), h('div', { class: 'cell-sub' }, `Fill ${fmt.pct(Math.min(...Object.values(trip.legs).map((l) => l.fillRatio)), { digits: 0 })}`)]
          : h('div', { class: 'cell-sub' }, '–')),
    h('td', { class: 'num', 'data-label': 'Break-even' },
      econ ? h('div', { class: 'cell-main' }, fmt.duration(econ.breakEvenHours)) : h('div', { class: 'cell-sub' }, '–')),
    h('td', { class: 'num', 'data-label': `Netto ${fmt.duration(settings.hours)}` },
      econ
        ? [h('div', { class: `cell-main ${signClass(econ.netUsd) ?? ''}` }, fmt.usd(econ.netUsd, { sign: true })), h('div', { class: 'cell-sub' }, `${fmt.pct(econ.netApr, { sign: true })} p.a.`)]
        : h('div', { class: 'cell-sub' }, '–')),
    h('td', { class: 'num', 'data-label': 'Optimale Größe' },
      curve?.best
        ? [
            h('div', { class: 'cell-main', title: curve.depthLimited ? 'Netto steigt bis zum Ende der sichtbaren Tiefe – das echte Optimum liegt darüber' : null }, `${curve.depthLimited ? '≥ ' : ''}${fmt.usd(curve.best.notional)}`),
            h('div', { class: 'cell-sub' }, curve.depthLimited ? `${fmt.usd(curve.best.netUsd, { sign: true })} · Buchende` : `${fmt.usd(curve.best.netUsd, { sign: true })} · max ${fmt.usd(curve.maxProfitable.notional)}`),
          ]
        : h('div', { class: 'cell-sub' }, curve ? 'keine' : '–')),
    h('td', { class: 'num', 'data-label': 'Tiefe' },
      curve
        ? [h('div', { class: 'cell-main' }, `${curve.depthLimited ? '≥ ' : ''}${fmt.usd(curve.capacity)}`), h('div', { class: 'cell-sub' }, `Spot-Vol ${fmt.usd(p.spot.volume)}`)]
        : h('div', { class: 'cell-sub' }, `Spot-Vol ${fmt.usd(p.spot.volume)}`)),
    statusCell(r),
  ]
  return h('tr', { tabindex: 0, 'data-id': p.id, 'aria-selected': p.id === selectedId ? 'true' : 'false' }, cells)
}

export function renderRows(tbody, rows, settings, selectedId) {
  mount(tbody, rows.map((r) => row(r, settings, selectedId)))
}

function tile(label, value, sub, { onClick } = {}) {
  return h('div', { class: 'tile' },
    h('div', { class: 'tile-label' }, label),
    h('div', { class: 'tile-value' }, value),
    h('div', { class: 'tile-sub' }, onClick ? h('button', { class: 'linkish', type: 'button', onclick: onClick }, sub) : sub))
}

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`

/** Overview of the rows currently shown (all counts follow the filters). */
export function renderTiles(el, rows, unbacked, settings, onOpen, loading) {
  const wait = '…'
  const priced = rows.filter((r) => r.econ)
  const profitable = priced.filter((r) => r.status === 'profit')
  const best = profitable.reduce((a, r) => (!a || r.econ.netUsd > a.econ.netUsd ? r : a), null)
  const underlyings = new Set(rows.map((r) => r.pair.key)).size
  const dexes = new Set(rows.map((r) => r.pair.perp.dex || 'main')).size
  const equities = rows.filter((r) => r.pair.kind === 'tokenized-equity' || (r.pair.kind === 'proxy' && r.pair.category === 'equity'))
  const eqx = equities.filter((r) => r.pair.issuer === 'EQX')
  const eqxTwo = eqx.filter((r) => r.status !== 'nobook' && r.status !== 'loading')
  const eqxOne = eqx.filter((r) => r.status === 'nobook' && r.oneSided)
  const noBooks = 'keine Paare mit zweiseitigem Buch'
  mount(el,
    h('div', { class: 'tile' },
      h('div', { class: 'tile-label' }, 'Spot ⇄ Perp-Paare'),
      h('div', { class: 'tile-value' }, loading && !rows.length ? wait : String(rows.length)),
      h('div', { class: 'tile-sub' },
        loading && !rows.length ? 'Lade Märkte …' : `${count(underlyings, 'Underlying', 'Underlyings')} · ${count(dexes, 'Perp-Dex', 'Perp-Dexes')}`,
        unbacked.length
          ? h('span', { title: `Ungedeckte Mirror-Token (gesamte Supply an eine Wallet geminted, keine Rücknahme) – kein Hedge: ${unbacked.join(', ')}` }, ` · ${unbacked.length} Mirror-Token ausgeschlossen`)
          : null)),
    tile(`Lohnt sich bei ${fmt.usd(settings.notional)}`, loading ? wait : `${profitable.length} von ${priced.length}`,
      loading ? 'Orderbücher laden …' : rows.length && !priced.length ? noBooks : `über ${fmt.duration(settings.hours)} inkl. Ein- und Ausstieg`),
    best
      ? tile('Bestes Netto', fmt.usd(best.econ.netUsd, { sign: true }), `${best.pair.spot.base.name}/${best.pair.spot.quote} ⇄ ${best.pair.perp.coin} · ${fmt.pct(best.econ.netApr)} p.a.`, { onClick: () => onOpen(best.pair.id) })
      : tile('Bestes Netto', loading ? wait : '–', loading ? 'Orderbücher laden …' : priced.length ? 'keine profitable Position bei dieser Größe' : rows.length ? noBooks : 'keine Paare für diese Filter'),
    tile('Tokenisierte Aktien', loading && !rows.length ? wait : count(equities.length, 'Paar', 'Paare'),
      eqx.length ? `EQX: ${count(eqx.length, 'Paar', 'Paare')}, ${eqxTwo.length} handelbar${eqxOne.length ? `, ${eqxOne.length} einseitig` : ''}` : 'EQX, xStocks und weitere'),
  )
}
