// The pair table and the overview tiles above it.

import { h, icon, mount } from './dom.js'
import * as fmt from '../core/format.js'
import { STATUS_RANK } from '../core/evaluate.js'
import { KIND, KIND_SHORT, KIND_HELP, CATEGORY, STATUS, DIRECTION, DIRECTION_SHORT, FUNDING_SOURCE, dexLabel, statusLabel, legNames, legClass } from './labels.js'

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
      const legs = p.type === 'cross' ? [p.a.coin, p.a.dex, p.b.symbol, 'lighter'] : [p.spot.coin, `${p.spot.base.name}/${p.spot.quote}`, p.spot.base.fullName, p.perp.coin, p.perp.dex]
      const hay = [p.underlying, p.key, ...legs, p.issuer, KIND[p.kind], CATEGORY[p.category]]
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
    h('div', { class: 'cell-sub', title: DIRECTION[r.direction] }, DIRECTION_SHORT[r.direction]))
}

function assetCell(r) {
  const p = r.pair
  const cross = p.type === 'cross'
  const full = !cross && p.spot.base.fullName && p.spot.base.fullName !== p.spot.base.name ? p.spot.base.fullName : null
  const [nameA, nameB] = legNames(p)
  const [keyA, keyB] = legClass(p)
  const hlPerp = cross ? p.a : p.venue === 'hl' ? p.perp : null
  return h('td', { class: 'col-asset' },
    h('div', { class: 'asset' },
      h('div', { class: 'asset-name' }, h('strong', null, p.underlying), full ? h('span', { class: 'fullname', title: full }, full) : null),
      h('div', { class: 'legs' },
        h('span', null, h('i', { class: `leg-key ${keyA}` }), nameA),
        h('span', { 'aria-hidden': 'true' }, '⇄'),
        h('span', null, h('i', { class: `leg-key ${keyB}` }), nameB)),
      h('div', { class: 'badges' },
        p.issuer ? h('span', { class: `badge${p.issuer === 'EQX' ? ' strong' : ''}` }, p.issuer) : null,
        h('span', { class: 'badge', title: KIND_HELP[p.kind] }, KIND_SHORT[p.kind]),
        hlPerp ? h('span', { class: 'badge', title: dexLabel(hlPerp) }, hlPerp.dex || 'main') : null,
        cross && p.category !== 'crypto' ? h('span', { class: 'badge' }, CATEGORY[p.category]) : null,
        p.flagged ? h('span', { class: 'badge', title: cross ? `Die Perps weichen um ${fmt.pct(Math.abs(p.deviation))} voneinander ab` : 'Spot und Perp weichen um mehr als 5 % voneinander ab' }, 'Preisabweichung') : null)))
}

/** Funding column: the carry's rate, or for a cross pair the spread and both rates. */
function fundingCell(r, settings) {
  const sub = r.type === 'cross'
    ? h('div', { class: 'cell-sub', title: `Hyperliquid ${fmt.rate(r.rates.a.value)}/h · Lighter ${fmt.rate(r.rates.b.value)}/h` },
        `HL ${fmt.pct(r.rates.a.value * 8760, { sign: true, digits: 1 })} · LT ${fmt.pct(r.rates.b.value * 8760, { sign: true, digits: 1 })}${r.rate.fallback ? '*' : ''}`)
    : h('div', { class: 'cell-sub', title: r.rate.fallback ? 'Historie lädt noch – bis dahin gilt die aktuelle Rate' : null }, `${fmt.rate(r.rate.value)}/h · ${r.rate.fallback ? 'aktuell*' : FUNDING_SOURCE[r.rate.source]}`)
  return h('td', { class: 'num', 'data-label': r.type === 'cross' ? 'Funding-Spread' : 'Funding p.a.' },
    h('div', { class: 'cell-main' }, fmt.pct(r.fundingApr, { sign: true })),
    sub,
    fundingShift(r, settings))
}

function basisCell(r) {
  const p = r.pair
  const cross = r.type === 'cross'
  const note = r.basis == null
    ? (p.kind === 'proxy' ? 'Proxy' : 'kein Preis')
    : cross ? (r.basis >= 0 ? 'Lighter über HL' : 'Lighter unter HL') : r.basis >= 0 ? 'Perp über Spot' : 'Perp unter Spot'
  return h('td', { class: 'num', 'data-label': cross ? 'Preisdifferenz' : 'Basis' },
    h('div', { class: 'cell-main' }, r.basis == null ? '–' : `${fmt.bps(r.basis, { sign: true })} bps`),
    h('div', { class: 'cell-sub' }, note))
}

const volumeNote = (p) => (p.type === 'cross' ? `Vol ${fmt.usd(p.a.volume)} · ${fmt.usd(p.b.volume)}` : `Spot-Vol ${fmt.usd(p.spot.volume)}`)

/** Cost components of a round trip summed over its orders (USD). */
export function costParts(trip) {
  const sum = { spread: 0, impact: 0, adverse: 0, fee: 0 }
  for (const leg of Object.values(trip.legs)) for (const k of Object.keys(sum)) sum[k] += leg.cost[k] ?? 0
  return sum
}

function costBar(trip) {
  const { spread, impact, adverse, fee } = costParts(trip)
  // A maker leg earns half the spread; only what costs is drawn.
  const parts = [['spread', Math.max(0, spread), 'Spread'], ['impact', impact + adverse, adverse ? 'Impact + Adverse Selection' : 'Impact'], ['fee', fee, 'Gebühren']]
  const total = parts.reduce((a, [, v]) => a + v, 0) || 1
  return h('div', { class: 'costbar', 'aria-hidden': 'true' },
    parts.map(([cls, v, label]) => h('span', { class: cls, style: { width: `${Math.max(2, (v / total) * 72)}px` }, title: `${label}: ${fmt.usd(v)}` })))
}

/** Funding once your own perp order has moved the premium — shown only when it differs. */
export function fundingShift(r, settings) {
  if (!r.atSize || settings.fundingImpact === 'off') return null
  const earned = r.direction === 'reverse' ? -r.fundingApr : r.fundingApr
  if (Math.abs(r.atSize.apr - earned) < 0.0005) return null
  const title = r.type === 'cross' ? 'Deine Perp-Orders verschieben die Premium auf beiden Börsen und damit den Spread' : 'Dein Perp-Order drückt die Premium, aus der das Funding berechnet wird'
  return h('div', { class: 'cell-sub neg', title },
    `→ ${fmt.pct(r.atSize.apr, { sign: true, digits: 1 })} bei ${fmt.usd(settings.notional)}`)
}

function row(r, settings, selectedId) {
  const p = r.pair
  const { econ, trip, curve } = r
  const cells = [
    assetCell(r),
    fundingCell(r, settings),
    basisCell(r),
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
        ? [h('div', { class: 'cell-main' }, `${curve.depthLimited ? '≥ ' : ''}${fmt.usd(curve.capacity)}`), h('div', { class: 'cell-sub' }, volumeNote(p))]
        : h('div', { class: 'cell-sub' }, volumeNote(p))),
    statusCell(r),
  ]
  return h('tr', { tabindex: 0, 'data-id': p.id, 'aria-selected': p.id === selectedId ? 'true' : 'false' }, cells)
}

/**
 * Rows are re-evaluated only when their inputs change (main.js), so most renders hand
 * back the same row objects: reuse their elements, and leave the DOM alone entirely if
 * nothing moved.
 */
const rowElements = new WeakMap() // row result → { key, tr }

export function renderRows(tbody, rows, settings, selectedId) {
  const look = `${settings.notional}|${settings.hours}|${settings.fundingImpact}`
  const trs = rows.map((r) => {
    const key = `${look}|${r.pair.id === selectedId}`
    const cached = rowElements.get(r)
    if (cached?.key === key) return cached.tr
    const tr = row(r, settings, selectedId)
    rowElements.set(r, { key, tr })
    return tr
  })
  const current = tbody.children
  if (current.length === trs.length && trs.every((tr, i) => current[i] === tr)) return
  mount(tbody, trs)
}

function tile(label, value, sub, { onClick } = {}) {
  return h('div', { class: 'tile' },
    h('div', { class: 'tile-label' }, label),
    h('div', { class: 'tile-value' }, value),
    h('div', { class: 'tile-sub' }, onClick ? h('button', { class: 'linkish', type: 'button', onclick: onClick }, sub) : sub))
}

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`

/** Overview of the rows currently shown (all counts follow the filters). */
export function renderTiles(el, rows, unbacked, settings, onOpen, loading, view = { name: 'Hyperliquid' }) {
  const wait = '…'
  const priced = rows.filter((r) => r.econ)
  const profitable = priced.filter((r) => r.status === 'profit')
  const best = profitable.reduce((a, r) => (!a || r.econ.netUsd > a.econ.netUsd ? r : a), null)
  const underlyings = new Set(rows.map((r) => r.pair.key)).size
  const noBooks = 'keine Paare mit zweiseitigem Buch'
  const legs = (r) => legNames(r.pair).join(' ⇄ ')
  const countTile = view.cross
    ? h('div', { class: 'tile' },
        h('div', { class: 'tile-label' }, 'HL ⇄ Lighter Perp-Paare'),
        h('div', { class: 'tile-value' }, loading && !rows.length ? wait : String(rows.length)),
        h('div', { class: 'tile-sub' }, loading && !rows.length ? 'Lade beide Börsen …' : `${count(underlyings, 'Underlying', 'Underlyings')} · ${rows.filter((r) => r.pair.kind === 'proxy').length} Proxy`))
    : h('div', { class: 'tile' },
        h('div', { class: 'tile-label' }, 'Spot ⇄ Perp-Paare'),
        h('div', { class: 'tile-value' }, loading && !rows.length ? wait : String(rows.length)),
        h('div', { class: 'tile-sub' },
          loading && !rows.length ? 'Lade Märkte …' : view.venues?.[0] === 'lt' ? count(underlyings, 'Underlying', 'Underlyings') : `${count(underlyings, 'Underlying', 'Underlyings')} · ${count(new Set(rows.map((r) => r.pair.perp.dex || 'main')).size, 'Perp-Dex', 'Perp-Dexes')}`,
          unbacked.length
            ? h('span', { title: `Kein 1:1-Anspruch auf das Underlying (ungedeckte Mirror-Token, Liquid-Restaking-Token) – kein Hedge: ${unbacked.join(', ')}` }, ` · ${unbacked.length} ausgeschlossen`)
            : null))
  // Fourth tile: the tokenised-equity story on Hyperliquid, the widest spread elsewhere.
  let fourth
  if (!view.cross && view.venues?.[0] !== 'lt') {
    const equities = rows.filter((r) => r.pair.kind === 'tokenized-equity' || (r.pair.kind === 'proxy' && r.pair.category === 'equity'))
    const eqx = equities.filter((r) => r.pair.issuer === 'EQX')
    const eqxTwo = eqx.filter((r) => r.status !== 'nobook' && r.status !== 'loading')
    const eqxOne = eqx.filter((r) => r.status === 'nobook' && r.oneSided)
    fourth = tile('Tokenisierte Aktien', loading && !rows.length ? wait : count(equities.length, 'Paar', 'Paare'),
      eqx.length ? `EQX: ${count(eqx.length, 'Paar', 'Paare')}, ${eqxTwo.length} handelbar${eqxOne.length ? `, ${eqxOne.length} einseitig` : ''}` : 'EQX, xStocks und weitere')
  } else {
    const live = rows.filter((r) => r.status !== 'nobook' && r.status !== 'loading' && r.status !== 'mismatch')
    const top = live.reduce((a, r) => (!a || Math.abs(r.fundingApr) > Math.abs(a.fundingApr) ? r : a), null)
    fourth = top
      ? tile(view.cross ? 'Größter Funding-Spread' : 'Höchstes Funding', fmt.pct(view.cross ? top.fundingApr : Math.abs(top.fundingApr), { sign: !view.cross }), `${legs(top)} · ${DIRECTION_SHORT[top.direction]}`, { onClick: () => onOpen(top.pair.id) })
      : tile(view.cross ? 'Größter Funding-Spread' : 'Höchstes Funding', loading ? wait : '–', loading ? 'Orderbücher laden …' : noBooks)
  }
  mount(el,
    countTile,
    tile(`Lohnt sich bei ${fmt.usd(settings.notional)}`, loading ? wait : `${profitable.length} von ${priced.length}`,
      loading ? 'Orderbücher laden …' : rows.length && !priced.length ? noBooks : `über ${fmt.duration(settings.hours)} inkl. Ein- und Ausstieg`),
    best
      ? tile('Bestes Netto', fmt.usd(best.econ.netUsd, { sign: true }), `${legs(best)} · ${fmt.pct(best.econ.netApr)} p.a.`, { onClick: () => onOpen(best.pair.id) })
      : tile('Bestes Netto', loading ? wait : '–', loading ? 'Orderbücher laden …' : priced.length ? 'keine profitable Position bei dieser Größe' : rows.length ? noBooks : 'keine Paare für diese Filter'),
    fourth,
  )
}
