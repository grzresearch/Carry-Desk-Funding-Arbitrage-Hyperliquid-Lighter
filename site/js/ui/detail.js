// The drawer that explains one pair end to end: what you earn, what the books charge you
// to get in and out, how that scales with size, and what can go wrong.

import { h, icon, mount } from './dom.js'
import * as fmt from '../core/format.js'
import { PLANS } from '../core/shortfall.js'
import { sideDepth } from '../core/book.js'
import { fundingRate } from '../core/evaluate.js'
import { sizeCurveChart, depthChart, fundingChart } from './charts.js'
import { costParts } from './table.js'
import { KIND, KIND_HELP, CATEGORY, STATUS, DIRECTION, LEG, SIDE, FUNDING_SOURCE, dexLabel, statusLabel } from './labels.js'

export function legCard(title, key, rows, link) {
  return h('div', { class: 'leg-card' },
    h('div', { class: 'leg-title' }, h('span', null, h('i', { class: `leg-key ${key}` }), title), link),
    h('dl', null, rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])))
}

export function kpi(label, value, sub, tone) {
  return h('div', { class: 'kpi' },
    h('div', { class: 'tile-label' }, label),
    h('div', { class: `tile-value ${tone ?? ''}` }, value),
    sub ? h('div', { class: 'tile-sub' }, sub) : null)
}

export function section(title, lede, ...body) {
  return h('section', { class: 'section' }, h('h3', null, title), lede ? h('p', { class: 'lede' }, lede) : null, body)
}

export function waterfall(r) {
  const { econ, trip } = r
  const { spread, impact, adverse, fee } = costParts(trip)
  const steps = [
    { label: `Funding ${fmt.duration(econ.hours)}`, value: econ.fundingUsd },
    econ.basisUsd ? { label: 'Basis-Konvergenz', value: econ.basisUsd } : null,
    { label: spread < 0 ? 'Spread (Maker verdient)' : 'Spread (½ je Order)', value: -spread },
    { label: 'Markt-Impact', value: -impact },
    adverse ? { label: 'Adverse Selection', value: -adverse } : null,
    { label: 'Gebühren', value: -fee },
  ].filter(Boolean)
  let run = 0
  const spans = steps.map((st) => {
    const from = run
    run += st.value
    return { ...st, from, to: run }
  })
  const lo = Math.min(0, ...spans.map((x) => Math.min(x.from, x.to)), econ.netUsd)
  const hi = Math.max(0, ...spans.map((x) => Math.max(x.from, x.to)), econ.netUsd)
  const pos = (v) => `${((v - lo) / (hi - lo || 1)) * 100}%`
  const bar = (from, to, color) => h('div', { class: 'wf-bar', style: { left: pos(Math.min(from, to)), width: `max(2px, calc(${pos(Math.max(from, to))} - ${pos(Math.min(from, to))}))`, background: color } })
  return h('div', { class: 'waterfall card' },
    spans.map((st) => h('div', { class: 'wf-row' },
      h('span', null, st.label),
      h('div', { class: 'wf-track' }, bar(st.from, st.to, st.value >= 0 ? 'var(--pos)' : 'var(--neg)')),
      h('span', { class: `num ${st.value >= 0 ? 'pos' : 'neg'}` }, fmt.usd(st.value, { sign: true })))),
    h('div', { class: 'wf-row' },
      h('strong', null, 'Netto'),
      h('div', { class: 'wf-track' }, bar(0, econ.netUsd, econ.netUsd >= 0 ? 'var(--net)' : 'var(--neg)')),
      h('span', { class: `num ${econ.netUsd >= 0 ? 'pos' : 'neg'}` }, fmt.usd(econ.netUsd, { sign: true }))))
}

const SPOT_PERP_LEGS = { name: (key) => LEG[key], cls: (key) => (key.startsWith('spot') ? 'spot' : 'perp') }

/** How an order is placed: a market order, or resting as maker with its fill odds. */
function orderLabel(leg) {
  if (!leg.maker) return SIDE[leg.side]
  return `${SIDE[leg.side]} · Maker ${fmt.pct(leg.maker.filledShare, { digits: 0 })}`
}

// Results first (cost, fill), mechanics after: the table scrolls sideways on small
// screens, and what matters must be visible without scrolling.
export function legsTable(trip, legs = SPOT_PERP_LEGS) {
  const maker = trip.order.some((k) => trip.legs[k].maker)
  const head = ['Leg', 'Summe bps', 'Kosten', 'Fill', 'Spread', 'Impact', maker ? 'Adverse' : null, 'Gebühr', 'Order', 'Menge', 'Ref.-Preis', 'VWAP', 'Schlechtester Px', 'Levels'].filter(Boolean)
  const rows = trip.order.map((key) => {
    const leg = trip.legs[key]
    return h('tr', null,
      h('td', null, h('i', { class: `leg-key ${legs.cls(key)}` }), legs.name(key)),
      h('td', null, h('strong', null, fmt.bps(leg.bps.total))),
      h('td', null, fmt.usd(leg.cost.total)),
      h('td', { class: leg.complete ? null : 'neg' }, fmt.pct(leg.fillRatio, { digits: 0 })),
      h('td', null, fmt.bps(leg.bps.spread)),
      h('td', null, fmt.bps(leg.bps.impact)),
      maker ? h('td', null, fmt.bps(leg.bps.adverse ?? 0)) : null,
      h('td', null, fmt.bps(leg.bps.fee)),
      h('td', { title: leg.maker ? 'Limit-Order am besten Kurs; der Rest wird nach der Wartezeit per Market-Order gefüllt' : null }, orderLabel(leg)),
      h('td', null, fmt.qty(leg.filled)),
      h('td', null, fmt.price(leg.mid)),
      h('td', null, fmt.price(leg.vwap)),
      h('td', null, fmt.price(leg.worstPx)),
      h('td', null, String(leg.levelsUsed)))
  })
  const sum = (f) => trip.order.reduce((a, k) => a + f(trip.legs[k]), 0)
  return h('div', { class: 'legs-scroll card' },
    h('table', { class: 'legs-table' },
      h('caption', { class: 'sr-only' }, 'Implementation Shortfall je Leg in Basispunkten der Positionsgröße'),
      h('thead', null, h('tr', null, head.map((c) => h('th', { scope: 'col', title: c === 'Ref.-Preis' ? 'Ankunftspreis: das Mid zum Entscheidungszeitpunkt (bei extrem breitem Buch der faire Preis, in die Quotes geklemmt)' : null }, c)))),
      h('tbody', null, rows),
      h('tfoot', null, h('tr', null,
        h('td', null, 'Ein + Aus'),
        h('td', null, trip.complete ? `${fmt.bps(trip.costBps)}` : '–'),
        h('td', null, trip.complete ? fmt.usd(trip.costUsd) : 'unvollständig'),
        h('td'),
        h('td', null, fmt.bps(sum((l) => l.bps.spread))),
        h('td', null, fmt.bps(sum((l) => l.bps.impact))),
        maker ? h('td', null, fmt.bps(sum((l) => l.bps.adverse ?? 0))) : null,
        h('td', null, fmt.bps(sum((l) => l.bps.fee))),
        h('td'), h('td'), h('td'), h('td'), h('td'), h('td')))))
}

/**
 * How each maker order is expected to play out: what it waits behind, the flow that
 * clears it, and what share fills before the rest is taken.
 */
export function makerNotes(trip, legs = SPOT_PERP_LEGS) {
  const notes = trip.order.filter((k) => trip.legs[k].maker).map((key) => {
    const leg = trip.legs[key]
    const m = leg.maker
    return h('li', null,
      h('strong', null, legs.name(key)), ': ',
      `Limit ${SIDE[leg.side].toLowerCase()} zu ${fmt.price(leg.best)}, davor ${fmt.usd(m.queueUsd)} in der Queue, Gegenflow ~${fmt.usd(m.flowUsd)}/s, σ ${fmt.bps(m.sigma * 1e4, { digits: 2 })} bps/√s${m.estimated ? ' (Schätzung, Kerzen laden)' : ''}. `,
      `In ${m.waitMin} min gefüllt: ${fmt.pct(m.filledShare, { digits: 0 })} (komplett mit ${fmt.pct(m.fullFill, { digits: 0 })} Wahrscheinlichkeit, im Mittel ${fmt.duration(m.openSec / 3600)} offen), Adverse Selection ${fmt.bps(leg.bps.adverse)} bps; der Rest geht als Market-Order.`)
  })
  if (!notes.length) return null
  return h('details', { class: 'fine maker-notes' },
    h('summary', null, 'Maker-Simulation je Order'),
    h('ul', null, notes),
    h('p', null, 'Modell: Eine Einheit der Order füllt, wenn der faire Preis die Distanz m = halber Spread + Y·σ·√(Queue davor / Gegenflow) auf sie zuläuft (in der Wartezeit T mit Wahrscheinlichkeit erfc(m / σ√2T)) und auf deiner Seite genug Volumen handelt (Verteilung aus 1-Minuten-Kerzen). Gefüllt wird also genau dann, wenn sich der Preis gegen dich bewegt – das ist die Adverse Selection. Der Rest geht nach T als Market-Order ins Buch. Y = 0,35, kalibriert an einem Queue-Backtest auf aufgezeichneten Orderbüchern und Trades.'))
}

export function sizeTable(points) {
  const pick = points.filter((_, i) => i % Math.ceil(points.length / 8) === 0 || i === points.length - 1)
  return h('details', { class: 'fine' },
    h('summary', null, 'Als Tabelle'),
    h('table', { class: 'legs-table' },
      h('thead', null, h('tr', null, ['Größe', 'Kosten', 'Netto', 'Netto p.a.'].map((c) => h('th', { scope: 'col' }, c)))),
      h('tbody', null, pick.map((p) => h('tr', null,
        h('td', null, fmt.usd(p.notional)), h('td', null, `${fmt.bps(p.costBps)} bps`),
        h('td', null, fmt.usd(p.netUsd, { sign: true })), h('td', null, fmt.pct(p.netApr, { sign: true })))))))
}

function risks(r, settings, history) {
  const p = r.pair
  const hl = p.venue !== 'lt'
  const out = []
  const add = (tone, text) => out.push({ tone, text })
  if (r.direction === 'reverse') add('warn', 'Negatives Funding: verdient wird mit Short Spot · Long Perp. Dafür brauchst du den Spot-Token bereits im Bestand (oder eine Leihe) – sonst ist die Position nicht umsetzbar.')
  if (p.evidence === 'weak') add('warn', 'Zuordnung nur über den Ticker und den Preisabgleich – kein bekannter Emittent. Prüfe, ob der Spot-Token wirklich einen Anspruch auf das Underlying verbrieft.')
  else add(p.kind === 'native' ? 'info' : 'warn', KIND_HELP[p.kind])
  if (p.flagged) add('warn', `Spot und Perp weichen um ${fmt.pct(Math.abs(p.deviation))} voneinander ab – entweder eine echte Basis-Chance oder ein Hinweis, dass die Assets nicht identisch sind.`)
  // The perp leg is short in a carry and long in a reverse trade: it dies on the opposite move.
  const rev = r.direction === 'reverse'
  const side = rev ? 'Long' : 'Short'
  const move = rev ? 'Kursrückgang' : 'Kursanstieg'
  if (p.perp.onlyIsolated) {
    const mm = 1 / (2 * (p.perp.maxLeverage || 1))
    const dist = Math.max(0, 1 / settings.leverage - mm)
    add('warn', `Perp nur mit isolierter Margin: der Spot-Bestand zählt nicht als Sicherheit. Ein ${side} mit ${settings.leverage}× wird grob bei ${rev ? '−' : '+'}${fmt.pct(dist, { digits: 0 })} ${move} liquidiert – Margin nachschießen oder Hebel senken.`)
  } else {
    add('info', `Perp-${side} mit ${settings.leverage}× Hebel: bei starkem ${move} droht Liquidation, bevor der Gewinn auf dem Spot-Leg gegengerechnet ist (außer bei Portfolio-Margin).`)
  }
  const maxMarket = (p.perp.maxLeverage ?? 1) >= 25 ? 30e6 : p.perp.maxLeverage >= 20 ? 5e6 : p.perp.maxLeverage >= 10 ? 2e6 : 5e5
  if (hl && settings.notional > maxMarket) add('warn', `Eine einzelne Market-Order auf diesem Perp ist auf ${fmt.usd(maxMarket)} begrenzt (abhängig vom Max-Hebel) – die Position muss in mehrere Orders aufgeteilt werden.`)
  if (p.perp.collateral !== p.spot.quote) add('info', `Spot notiert in ${p.spot.quote}, der Perp ist in ${p.perp.collateral} besichert – kleines Stablecoin-Basisrisiko.`)
  if (p.category === 'equity' && (p.perp.dex || !hl)) add('info', 'Aktien-Perps laufen 24/7, die Börse nicht: außerhalb der Handelszeiten folgt das Oracle internen Preisen, Spot und Perp können am Wochenende auseinanderlaufen.')
  if (p.perp.oiCap && p.perp.openInterestUsd && p.perp.openInterestUsd > 0.8 * p.perp.oiCap) add('warn', `Open Interest bei ${fmt.pct(p.perp.openInterestUsd / p.perp.oiCap, { digits: 0 })} des Caps – neue Positionen können blockiert werden.`)
  if (history?.length >= 24) {
    const share = history.filter((x) => Math.sign(x.rate) === Math.sign(r.rate.value || 1)).length / history.length
    if (share < 0.7) add('warn', `Funding hatte in nur ${fmt.pct(share, { digits: 0 })} der letzten ${history.length} Stunden dieses Vorzeichen – der Carry ist instabil.`)
  }
  if (!hl) add('info', 'Lighter-Standard-Accounts handeln gebührenfrei, Taker-Orders kommen aber mit 300 ms Verzögerung an – in schnellen Märkten kann sich das Buch bis dahin bewegen.')
  add('info', 'Exit-Kosten sind mit dem heutigen Orderbuch geschätzt; dünne Bücher können zum Ausstieg deutlich schlechter sein.')
  return riskList(out)
}

export function riskList(out) {
  return h('ul', { class: 'risks' }, out.map((x) => h('li', null,
    h('span', { style: { color: x.tone === 'warn' ? 'var(--warning)' : 'var(--muted)' } }, icon(x.tone === 'warn' ? 'warn' : 'info')),
    h('span', null, x.text))))
}

function fundingSection(r, history, width) {
  if (!history) return section('Funding-Historie', 'Lädt die letzten 7 Tage …')
  if (!history.length) return section('Funding-Historie', 'Keine Historie verfügbar.')
  return fundingHistory(r.pair.perp, history, width)
}

/** Hourly funding of the last days, with averages and how often it was positive. */
export function fundingHistory(perp, history, width, { title = 'Funding-Historie (7 Tage, stündlich)', labels = ['Shorts erhalten', 'Longs erhalten'], now = perp.funding } = {}) {
  const avg7 = fundingRate({ funding: now }, history, 'avg7d').value
  const avg24 = fundingRate({ funding: now }, history, 'avg24').value
  const positive = history.filter((x) => x.rate > 0).length / history.length
  return section(title,
    `Ø 7 T ${fmt.pct(avg7 * 8760, { sign: true })} p.a. · Ø 24 h ${fmt.pct(avg24 * 8760, { sign: true })} p.a. · aktuell ${fmt.pct(now * 8760, { sign: true })} p.a. · ${fmt.pct(positive, { digits: 0 })} der Stunden positiv`,
    h('div', { class: 'card' },
      h('div', { class: 'legend' },
        h('span', null, h('i', { class: 'area', style: { background: 'var(--pos)' } }), labels[0]),
        h('span', null, h('i', { class: 'area', style: { background: 'var(--neg)' } }), labels[1]),
        h('span', null, h('i', { style: { background: 'var(--text-2)' } }), 'Durchschnitt')),
      fundingChart({ history, average: avg7, width })))
}

/** What the shortfall table measures, for the execution chosen. */
export function executionText(trip) {
  const maker = trip.order.some((k) => trip.legs[k].maker)
  return maker
    ? 'Gegen den Preis zum Entscheidungszeitpunkt (Mid), in bps der Positionsgröße. Market-Orders zahlen halben Spread + Impact + Taker-Gebühr; Maker-Orders verdienen den halben Spread auf dem gefüllten Teil, zahlen Adverse Selection und holen den Rest nach der Wartezeit per Market-Order nach.'
    : 'Market-Order gegen den Preis zum Entscheidungszeitpunkt (Mid): halber Spread + Impact beim Abarbeiten der Levels + Taker-Gebühr, in bps der Positionsgröße.'
}

const growth = (settings) =>
  settings.fundingImpact === 'off'
    ? 'Funding wächst linear mit der Größe, der Shortfall überproportional'
    : 'Funding wächst mit der Größe – abzüglich dessen, was dein Perp-Order an Premium wegnimmt –, der Shortfall überproportional'

/** One sentence on how your own order changes the funding you earn. */
function impactNote(r, settings, venueName) {
  if (settings.fundingImpact === 'off' || !r.atSize) return ''
  const base = r.direction === 'carry' ? r.fundingApr : -r.fundingApr
  const at = r.atSize.apr
  if (Math.abs(at - base) < 0.0005) return ' Dein Perp-Order verändert das Funding bei dieser Größe nicht – es liegt im Clamp-Band am Zins-Basiswert oder das Buch ist tief genug.'
  return ` Dein Perp-${r.direction === 'carry' ? 'Short' : 'Long'} verschiebt die Premium, aus der ${venueName} das Funding berechnet: statt ${fmt.pct(base, { sign: true })} rechnen wir mit ${fmt.pct(at, { sign: true })} p.a.`
}

/** What the missing or one-sided book looks like, so a listing can be followed live. */
function bookMessage(r, venue) {
  const p = r.pair
  if (r.status === 'loading') return 'Orderbücher werden geladen …'
  if (r.status === 'mismatch') return 'Die echten Quotes des Spot-Markts passen nicht zum Perp – kein Hedge.'
  const legName = r.missing === 'spot' ? 'Spot' : 'Perp'
  const book = venue.books.get(r.missing === 'spot' ? p.spot.key : p.perp.key)
  if (r.oneSided && book) {
    const side = book.bids?.length ? 'bids' : 'asks'
    const levels = book[side]
    const [have, best, lack] = side === 'bids' ? ['Bids', 'bester Bid', 'Asks'] : ['Asks', 'bester Ask', 'Bids']
    return `Das ${legName}-Buch ist einseitig: nur ${have} (${best} ${fmt.price(levels[0].px)}, Tiefe ${fmt.usd(sideDepth(levels).notional)}), ${lack} fehlen noch. Ohne Gegenseite gibt es weder Mid noch Shortfall – sobald beide Seiten belegt sind, rechnet die Seite automatisch.`
  }
  return r.missing === 'spot'
    ? 'Der Spot-Markt hat (noch) kein Orderbuch – z. B. vor dem Handelsstart. Sobald Orders im Buch liegen, rechnet die Seite automatisch.'
    : 'Der Perp-Markt hat aktuell kein Orderbuch.'
}

export const drawerWidth = (el) => Math.max(300, Math.min(712, (el.closest('.drawer-panel')?.clientWidth ?? 760) - 48 - 30))

export const tradeLink = (venue, market) => h('a', { href: venue.adapter.tradeUrl(market), target: '_blank', rel: 'noopener', class: 'fine' }, `Auf ${venue.adapter.name} handeln ↗`)

/**
 * @param {VenueData} venue the pair's venue (books, history, adapter)
 */
export function renderDetail(el, r, settings, venue) {
  const p = r.pair
  const width = drawerWidth(el)
  const history = venue.history.get(p.perp.key)
  const lighter = p.venue === 'lt'
  const st = STATUS[r.status]
  const title = h('h2', { id: 'drawer-title' }, p.underlying)

  const head = h('div', { class: 'detail-head' },
    title,
    h('div', { class: 'sub' }, `${KIND[p.kind]}${p.issuer ? ` · ${p.issuer}` : ''} · ${CATEGORY[p.category]} · ${DIRECTION[r.direction]}`),
    h('div', { class: 'badges', style: { 'margin-top': '8px' } },
      h('span', { class: `status ${st.tone}` }, icon(st.icon), statusLabel(r))),
    h('div', { class: 'detail-legs' },
      legCard(`Spot · ${p.spot.base.name}/${p.spot.quote}`, 'spot', [
        ['Markt', h('span', { class: 'mono' }, p.spot.coin)],
        ['Token', p.spot.base.fullName ?? p.spot.base.name],
        ['Mid', fmt.price(r.spotMid)],
        ['Spread', r.spread.spot == null ? '–' : `${fmt.bps(r.spread.spot)} bps`],
        ['Volumen 24 h', fmt.usd(p.spot.volume)],
        ['Taker-Gebühr', `${fmt.bps(r.fees.spot, { digits: 2 })} bps`],
      ], tradeLink(venue, p.spot)),
      legCard(`Perp · ${p.perp.coin}`, 'perp', [
        lighter ? ['Börse', `Lighter · Markt ${p.perp.marketId}`] : ['Dex', `${dexLabel(p.perp)}${p.perp.growthMode === 'enabled' ? ' · Growth Mode' : ''}`],
        ['Mid / Oracle', `${fmt.price(r.perpMid)} / ${fmt.price(p.perp.oracle)}`],
        ['Funding jetzt', `${fmt.rate(p.perp.funding)} /h · ${fmt.pct(p.perp.funding * 8760, { sign: true })} p.a.`],
        ...(r.atSize && settings.fundingImpact !== 'off'
          ? [['Funding bei deiner Größe', `${fmt.pct(r.atSize.apr, { sign: true })} p.a. (${FUNDING_SOURCE[r.rate.source]}, nach Eigeneinfluss)`]]
          : []),
        ['Open Interest', `${fmt.usd(p.perp.openInterestUsd)}${p.perp.oiCap ? ` von ${fmt.usd(p.perp.oiCap)}` : ''}`],
        ['Max. Hebel · Margin', `${p.perp.maxLeverage}× · ${p.perp.onlyIsolated ? 'isoliert' : 'cross'} · ${p.perp.collateral}`],
        ['Taker-Gebühr', `${fmt.bps(r.fees.perp, { digits: 2 })} bps`],
      ], tradeLink(venue, p.perp))))

  const blocks = [head]

  if (!r.trip) {
    blocks.push(h('p', { class: 'card' }, bookMessage(r, venue)))
    blocks.push(fundingSection(r, history, width))
    blocks.push(section('Risiken & Hinweise', null, risks(r, settings, history)))
    return mount(el, h('div', { class: 'detail' }, blocks))
  }

  const { econ, trip, curve } = r
  const capital = settings.notional * (1 + 1 / settings.leverage)
  blocks.push(h('div', { class: 'kpis' },
    econ
      ? kpi(`Netto ${fmt.duration(settings.hours)}`, fmt.usd(econ.netUsd, { sign: true }), `${fmt.pct(econ.netApr, { sign: true })} p.a.`, econ.netUsd >= 0 ? 'pos' : 'neg')
      : kpi(`Netto ${fmt.duration(settings.hours)}`, '–', 'Buch zu dünn'),
    kpi('Auf Kapital', econ ? fmt.pct(econ.capitalApr, { sign: true }) : '–', `p.a. · ${fmt.usd(capital)} bei ${settings.leverage}×`),
    kpi('Break-even', econ ? fmt.duration(econ.breakEvenHours) : '–', `Funding ${fmt.pct(econ ? econ.fundingApr : r.fundingApr, { sign: true })} p.a.${econ && settings.fundingImpact !== 'off' ? ' bei deiner Größe' : ''}`),
    kpi('Kosten Ein + Aus', econ ? `${fmt.bps(trip.costBps)} bps` : '–', econ ? fmt.usd(trip.costUsd) : 'unvollständig')))

  blocks.push(section('Woher der Ertrag kommt',
    `Funding ${FUNDING_SOURCE[r.rate.source]}${r.rate.fallback ? ' (Historie lädt noch)' : ''} über ${fmt.duration(settings.hours)} gegen die Kosten, ${fmt.usd(settings.notional)} je Leg ein- und wieder auszusteigen.${impactNote(r, settings, venue.adapter.name)}${settings.basisMode === 'converge' && r.basis != null ? ' Basis-Szenario: Spot und Perp laufen bis zum Exit zusammen.' : ''}`,
    econ ? waterfall(r) : h('p', { class: 'card' }, 'Die sichtbare Tiefe reicht für diese Größe nicht – Netto nicht berechenbar.')))

  blocks.push(section('Implementation Shortfall je Leg',
    `${executionText(trip)} ${PLANS[r.direction].spotEntry === 'buy' ? 'Entry: Spot kaufen, Perp shorten. Exit: Spot verkaufen, Perp zurückkaufen.' : 'Entry: Spot verkaufen, Perp kaufen. Exit umgekehrt.'}`,
    legsTable(trip),
    makerNotes(trip),
    !trip.complete ? h('p', { class: 'fine neg' }, `${LEG[trip.limiting]} kann die Größe nicht vollständig füllen – sichtbare Tiefe ${fmt.usd(curve.capacity)}.`) : null))

  if (curve.points.length > 2) {
    const crossover = curve.maxProfitable
    blocks.push(section('Lohnt sich die Größe?',
      curve.best && curve.depthLimited
        ? `${growth(settings)} – hier steigt der Ertrag aber bis zum Ende der sichtbaren Tiefe (${fmt.usd(curve.capacity)}): ${fmt.usd(curve.best.netUsd, { sign: true })} über ${fmt.duration(settings.hours)}. Das echte Optimum liegt darüber.`
        : curve.best
        ? `${growth(settings)}. Am meisten bringen ${fmt.usd(curve.best.notional)} je Leg (${fmt.usd(curve.best.netUsd, { sign: true })} über ${fmt.duration(settings.hours)}); bis ${fmt.usd(crossover.notional)} bleibt die Position im Plus.`
        : `Bei keiner Größe deckt das Funding über ${fmt.duration(settings.hours)} die Kosten für Ein- und Ausstieg – eine längere Haltedauer oder ein günstigeres Gebühren-Tier ändert das eventuell.`,
      h('div', { class: 'card' }, sizeCurveChart({ points: curve.points, notional: settings.notional, best: curve.best, maxProfitable: curve.maxProfitable, width }), sizeTable(curve.points))))
  }

  const plan = PLANS[r.direction]
  const spotSide = plan.spotEntry === 'buy' ? 'asks' : 'bids'
  const perpSide = plan.perpEntry === 'buy' ? 'asks' : 'bids'
  const spotBook = venue.books.get(p.spot.key)
  const perpBook = venue.books.get(p.perp.key)
  blocks.push(section('Liquiditätsprofil beim Einstieg',
    'Wie viel Volumen liegt bis zu welchem Abstand vom Mid? Wo eine Kurve deine Größe kreuzt, liegt der schlechteste Fill dieses Legs.',
    h('div', { class: 'card' },
      h('div', { class: 'legend' },
        h('span', null, h('i', { style: { background: 'var(--spot)' } }), `Spot ${spotSide === 'asks' ? 'Asks (Kauf)' : 'Bids (Verkauf)'}`),
        h('span', null, h('i', { style: { background: 'var(--perp)' } }), `Perp ${perpSide === 'asks' ? 'Asks (Kauf)' : 'Bids (Verkauf)'}`)),
      depthChart({
        sides: [
          { key: 'spot', label: 'Spot', levels: spotBook[spotSide], mid: r.spotMid },
          { key: 'perp', label: 'Perp', levels: perpBook[perpSide], mid: r.perpMid },
        ],
        notional: settings.notional,
        width,
      }))))

  blocks.push(fundingSection(r, history, width))
  blocks.push(section('Risiken & Hinweise', null, risks(r, settings, history)))
  blocks.push(h('p', { class: 'fine' },
    `Annahmen: ${settings.exec === 'taker' ? 'Market-Orders auf beiden Legs' : `${settings.exec === 'maker' ? 'beide Legs' : settings.exec === 'makerA' ? 'Spot' : 'Perp'} als Maker mit ${settings.wait} min Wartezeit, Rest per Market-Order`}, Exit gegen ein Buch wie das heutige, Funding ${FUNDING_SOURCE[r.rate.source]} konstant über ${fmt.duration(settings.hours)}${settings.fundingImpact === 'off' ? ' (ohne eigenen Einfluss)' : settings.fundingImpact === 'max' ? ', abzüglich dessen, was dein Perp-Order an Premium wegnimmt (Obergrenze: die verbrauchte Liquidität kommt nie zurück)' : ', abzüglich dessen, was dein Perp-Order an Premium wegnimmt (gewichtet mit deiner Größe relativ zum Stunden-Volumen des Perps)'}, Basis ${settings.basisMode === 'converge' ? 'konvergiert bis zum Exit' : 'bleibt unverändert'}. ${lighter ? 'Lighter liefert das volle Orderbuch per WebSocket (bis ±10 % um den besten Kurs).' : 'Bücher über die 20 sichtbaren Levels hinaus werden konservativ aus aggregierten Leveln ergänzt.'}`))

  return mount(el, h('div', { class: 'detail' }, blocks))
}
