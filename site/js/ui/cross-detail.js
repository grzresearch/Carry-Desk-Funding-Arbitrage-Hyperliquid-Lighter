// The drawer for a cross-venue pair: the same underlying as a perp on Hyperliquid and on
// Lighter, short where funding is higher, long where it is lower. Same story as the
// spot/perp drawer — what you earn, what four orders on two books cost, how it scales —
// plus what is special about holding a hedge across two exchanges.

import { h, icon, mount } from './dom.js'
import * as fmt from '../core/format.js'
import { sideDepth } from '../core/book.js'
import { sizeCurveChart, depthChart } from './charts.js'
import { KIND, KIND_HELP, CATEGORY, STATUS, DIRECTION, FUNDING_SOURCE, dexLabel, statusLabel } from './labels.js'
import { legCard, kpi, section, waterfall, legsTable, makerNotes, executionText, sizeTable, fundingHistory, riskList, drawerWidth, tradeLink } from './detail.js'

const HOUR = 3_600_000
const VENUE = { a: 'Hyperliquid', b: 'Lighter' }
const CROSS_LEGS = {
  name: (key) => `${VENUE[key[0]]} ${key.endsWith('Entry') ? 'Entry' : 'Exit'}`,
  cls: (key) => key[0],
}

/**
 * Hourly spread you would have earned in this direction: the short leg's funding minus
 * the long leg's, on the hours both venues settled.
 */
export function spreadHistory(histA, histB, short) {
  if (!histA?.length || !histB?.length) return null
  const b = new Map(histB.map((x) => [Math.round(x.time / HOUR), x.rate]))
  const out = []
  for (const x of histA) {
    const rb = b.get(Math.round(x.time / HOUR))
    if (rb == null) continue
    out.push({ time: x.time, rate: short === 'a' ? x.rate - rb : rb - x.rate })
  }
  return out
}

/**
 * Who pays whom on one leg: at a positive rate longs pay and shorts receive, at a
 * negative rate the other way round.
 */
export function fundingFlow(short, rate) {
  const receives = short ? rate >= 0 : rate < 0
  return { receives, verb: receives ? 'erhält' : 'zahlt' }
}

const SOURCE = (rate) => (rate.fallback ? 'aktuell, Historie lädt' : FUNDING_SOURCE[rate.source])

function legOf(r, key, venue, perp) {
  const rate = r.rates[key]
  const short = r.short === key
  const flow = fundingFlow(short, rate.value)
  const rows = [
    key === 'a' ? ['Dex', `${dexLabel(perp)}${perp.growthMode === 'enabled' ? ' · Growth Mode' : ''}`] : ['Markt', `Lighter · ${perp.symbol} (#${perp.marketId})`],
    ['Rolle', `${short ? 'Short' : 'Long'} · ${flow.verb} ${fmt.pct(Math.abs(rate.value) * 8760)} p.a.`],
    ['Mid / Oracle', `${fmt.price(key === 'a' ? r.spotMid : r.perpMid)} / ${fmt.price(perp.oracle)}`],
    ['Funding jetzt', `${fmt.rate(perp.funding)} /h · ${fmt.pct(perp.funding * 8760, { sign: true })} p.a.`],
    ['Funding geplant', `${fmt.pct(rate.value * 8760, { sign: true })} p.a. · ${SOURCE(rate)}`],
    ['Spread', r.spread[key] == null ? '–' : `${fmt.bps(r.spread[key])} bps`],
    ['Open Interest', `${fmt.usd(perp.openInterestUsd)}${perp.oiCap ? ` von ${fmt.usd(perp.oiCap)}` : ''}`],
    ['Max. Hebel · Margin', `${perp.maxLeverage}× · ${perp.onlyIsolated ? 'isoliert' : 'cross'} · ${perp.collateral}`],
    ['Taker-Gebühr', `${fmt.bps(r.fees[key], { digits: 2 })} bps`],
  ]
  return legCard(`${VENUE[key]} · ${perp.coin}`, key, rows, tradeLink(venue, perp))
}

/** "Short auf Lighter erhält 12,3 % p.a. (Ø 7 T)" — the verb follows the sign. */
function legSentence(role, venueName, rate, short) {
  return `${role} auf ${venueName} ${fundingFlow(short, rate.value).verb} ${fmt.pct(Math.abs(rate.value) * 8760)} p.a. (${SOURCE(rate)})`
}

function risks(r, settings, spread) {
  const p = r.pair
  const out = []
  const add = (tone, text) => out.push({ tone, text })
  add(p.kind === 'same' ? 'info' : 'warn', KIND_HELP[p.kind])
  const dist = Math.max(0, 1 / settings.leverage - 1 / (2 * Math.min(p.a.maxLeverage || 1, p.b.maxLeverage || 1)))
  add('warn', `Zwei Börsen, zwei Margin-Konten: Gewinne auf der einen Seite stützen die andere nicht. Mit ${settings.leverage}× wird ein Leg grob bei ${fmt.pct(dist, { digits: 0 })} Kursbewegung gegen es liquidiert – Margin rechtzeitig zwischen den Börsen umschichten (Bridge-Dauer einplanen) oder Hebel senken.`)
  if (r.basis != null && Math.abs(r.basis) > 20) add('warn', `Die Perps notieren ${fmt.bps(Math.abs(r.basis))} bps auseinander. Läuft die Differenz bis zum Exit weiter auseinander, kostet das – „Basis bei Exit: konvergiert“ rechnet den umgekehrten Fall.`)
  if (p.a.collateral !== 'USDC') add('info', `Der Hyperliquid-Perp ist in ${p.a.collateral} besichert, Lighter in USDC – kleines Stablecoin-Basisrisiko.`)
  if (p.category === 'equity' || p.category === 'commodity' || p.category === 'fx') add('info', 'Real-World-Perps laufen 24/7, die Heimatbörse nicht: außerhalb der Handelszeiten folgen die Oracles internen Preisen – und die beiden Börsen können dabei unterschiedlich rechnen.')
  if (p.a.oiCap && p.a.openInterestUsd > 0.8 * p.a.oiCap) add('warn', `Open Interest auf Hyperliquid bei ${fmt.pct(p.a.openInterestUsd / p.a.oiCap, { digits: 0 })} des Caps – neue Positionen können blockiert werden.`)
  if (spread?.length >= 24) {
    const share = spread.filter((x) => x.rate > 0).length / spread.length
    if (share < 0.7) add('warn', `Der Spread lag in nur ${fmt.pct(share, { digits: 0 })} der letzten ${spread.length} Stunden in deiner Richtung – er kann schnell drehen.`)
  }
  add('info', 'Beide Börsen zahlen Funding stündlich. Lighter rechnet mit der auf 0,0001 %/h abgeschnittenen Rate.')
  if (r.fees.b === 0) add('info', 'Lighter-Standard-Accounts handeln gebührenfrei, Taker-Orders kommen aber mit 300 ms Verzögerung an.')
  add('info', 'Exit-Kosten sind mit den heutigen Orderbüchern geschätzt; dünne Bücher können zum Ausstieg deutlich schlechter sein.')
  return riskList(out)
}

function bookMessage(r, books) {
  if (r.status === 'loading') return 'Orderbücher werden geladen …'
  const venue = VENUE[r.missing]
  const book = books[r.missing]
  if (book && (book.bids?.length || book.asks?.length)) {
    const side = book.bids?.length ? 'bids' : 'asks'
    return `Das ${venue}-Buch ist einseitig (nur ${side === 'bids' ? 'Bids' : 'Asks'}, Tiefe ${fmt.usd(sideDepth(book[side]).notional)}) – ohne Gegenseite gibt es keinen Shortfall.`
  }
  return `Der ${venue}-Perp hat aktuell kein Orderbuch.`
}

/** @param {{ a: VenueData, b: VenueData }} venues Hyperliquid and Lighter */
export function renderCrossDetail(el, r, settings, { a, b }) {
  const p = r.pair
  const width = drawerWidth(el)
  const histA = a.history.get(p.a.key)
  const histB = b.history.get(p.b.key)
  const spread = spreadHistory(histA, histB, r.short)
  const st = STATUS[r.status]
  const shortName = VENUE[r.short]
  const longName = VENUE[r.short === 'a' ? 'b' : 'a']

  const head = h('div', { class: 'detail-head' },
    h('h2', { id: 'drawer-title' }, p.underlying),
    h('div', { class: 'sub' }, `${KIND[p.kind]} · ${CATEGORY[p.category]} · ${DIRECTION[r.direction]}`),
    h('div', { class: 'badges', style: { 'margin-top': '8px' } }, h('span', { class: `status ${st.tone}` }, icon(st.icon), statusLabel(r))),
    h('div', { class: 'detail-legs' }, legOf(r, 'a', a, p.a), legOf(r, 'b', b, p.b)))

  const blocks = [head]
  const fundingBlock = () => {
    if (!histA || !histB) return section('Spread-Historie', 'Lädt die letzten 7 Tage beider Börsen …')
    if (!spread?.length) return section('Spread-Historie', 'Keine gemeinsame Historie verfügbar.')
    return fundingHistory(p.a, spread, width, {
      title: `Spread-Historie: ${shortName} minus ${longName} (7 Tage, stündlich)`,
      labels: ['Spread zu deinen Gunsten', 'Spread gegen dich'],
      now: r.short === 'a' ? p.a.funding - p.b.funding : p.b.funding - p.a.funding,
    })
  }

  if (!r.trip) {
    blocks.push(h('p', { class: 'card' }, bookMessage(r, { a: a.books.get(p.a.key), b: b.books.get(p.b.key) })))
    blocks.push(fundingBlock())
    blocks.push(section('Risiken & Hinweise', null, risks(r, settings, spread)))
    return mount(el, h('div', { class: 'detail' }, blocks))
  }

  const { econ, trip, curve } = r
  const capital = (settings.notional * 2) / settings.leverage
  blocks.push(h('div', { class: 'kpis' },
    econ
      ? kpi(`Netto ${fmt.duration(settings.hours)}`, fmt.usd(econ.netUsd, { sign: true }), `${fmt.pct(econ.netApr, { sign: true })} p.a.`, econ.netUsd >= 0 ? 'pos' : 'neg')
      : kpi(`Netto ${fmt.duration(settings.hours)}`, '–', 'Buch zu dünn'),
    kpi('Auf Kapital', econ ? fmt.pct(econ.capitalApr, { sign: true }) : '–', `p.a. · ${fmt.usd(capital)} Margin bei ${settings.leverage}×`),
    kpi('Break-even', econ ? fmt.duration(econ.breakEvenHours) : '–', `Spread ${fmt.pct(econ ? econ.fundingApr : r.fundingApr, { sign: true })} p.a.${econ && settings.fundingImpact !== 'off' ? ' bei deiner Größe' : ''}`),
    kpi('Kosten Ein + Aus', econ ? `${fmt.bps(trip.costBps)} bps` : '–', econ ? fmt.usd(trip.costUsd) : 'unvollständig')))

  const moved = r.atSize && settings.fundingImpact !== 'off' && Math.abs(r.atSize.apr - r.fundingApr) >= 0.0005
  blocks.push(section('Woher der Ertrag kommt',
    `${legSentence('Short', shortName, r.rates[r.short], true)}, ${legSentence('Long', longName, r.rates[r.short === 'a' ? 'b' : 'a'], false)}: ${fmt.pct(r.fundingApr, { sign: true })} Spread über ${fmt.duration(settings.hours)} gegen die Kosten von vier Orders zu je ${fmt.usd(settings.notional)}.${moved ? ` Deine Orders verschieben die Premium auf beiden Börsen: wir rechnen mit ${fmt.pct(r.atSize.apr, { sign: true })} p.a.` : ''}${settings.basisMode === 'converge' && r.basis != null ? ' Basis-Szenario: die Preisdifferenz schließt sich bis zum Exit.' : ''}`,
    econ ? waterfall(r) : h('p', { class: 'card' }, 'Die sichtbare Tiefe reicht für diese Größe nicht – Netto nicht berechenbar.')))

  blocks.push(section('Implementation Shortfall je Leg',
    `${executionText(trip)} Entry: ${shortName} shorten, ${longName} kaufen. Exit umgekehrt.`,
    legsTable(trip, CROSS_LEGS),
    makerNotes(trip, CROSS_LEGS),
    !trip.complete ? h('p', { class: 'fine neg' }, `${CROSS_LEGS.name(trip.limiting)} kann die Größe nicht vollständig füllen – sichtbare Tiefe ${fmt.usd(curve.capacity)}.`) : null))

  if (curve.points.length > 2) {
    blocks.push(section('Lohnt sich die Größe?',
      curve.best && curve.depthLimited
        ? `Der Ertrag steigt bis zum Ende der sichtbaren Tiefe (${fmt.usd(curve.capacity)}): ${fmt.usd(curve.best.netUsd, { sign: true })} über ${fmt.duration(settings.hours)}. Das echte Optimum liegt darüber.`
        : curve.best
        ? `Der Spread wächst mit der Größe, der Shortfall überproportional. Am meisten bringen ${fmt.usd(curve.best.notional)} je Leg (${fmt.usd(curve.best.netUsd, { sign: true })} über ${fmt.duration(settings.hours)}); bis ${fmt.usd(curve.maxProfitable.notional)} bleibt die Position im Plus.`
        : `Bei keiner Größe deckt der Spread über ${fmt.duration(settings.hours)} die Kosten für Ein- und Ausstieg.`,
      h('div', { class: 'card' }, sizeCurveChart({ points: curve.points, notional: settings.notional, best: curve.best, maxProfitable: curve.maxProfitable, width }), sizeTable(curve.points))))
  }

  const bookA = a.books.get(p.a.key)
  const bookB = b.books.get(p.b.key)
  const sideA = r.short === 'a' ? 'bids' : 'asks'
  const sideB = r.short === 'b' ? 'bids' : 'asks'
  const what = (side) => (side === 'asks' ? 'Asks (Kauf)' : 'Bids (Verkauf)')
  blocks.push(section('Liquiditätsprofil beim Einstieg',
    'Wie viel Volumen liegt bis zu welchem Abstand vom Mid? Wo eine Kurve deine Größe kreuzt, liegt der schlechteste Fill dieses Legs.',
    h('div', { class: 'card' },
      h('div', { class: 'legend' },
        h('span', null, h('i', { style: { background: 'var(--spot)' } }), `Hyperliquid ${what(sideA)}`),
        h('span', null, h('i', { style: { background: 'var(--perp)' } }), `Lighter ${what(sideB)}`)),
      depthChart({
        sides: [
          { key: 'spot', label: 'HL', levels: bookA[sideA], mid: r.spotMid },
          { key: 'perp', label: 'Lighter', levels: bookB[sideB], mid: r.perpMid },
        ],
        notional: settings.notional,
        width,
      }))))

  blocks.push(fundingBlock())
  blocks.push(section('Risiken & Hinweise', null, risks(r, settings, spread)))
  blocks.push(h('p', { class: 'fine' },
    `Annahmen: ${settings.exec === 'taker' ? 'Market-Orders' : `${settings.exec === 'maker' ? 'beide Legs' : settings.exec === 'makerA' ? 'Hyperliquid' : 'Lighter'} als Maker mit ${settings.wait} min Wartezeit, Rest per Market-Order`}, Funding beider Börsen ${FUNDING_SOURCE[r.rate.source]} konstant über ${fmt.duration(settings.hours)}${settings.fundingImpact === 'off' ? '' : ', abzüglich dessen, was deine Orders an Premium verschieben'}, Exit gegen Bücher wie die heutigen, Preisdifferenz ${settings.basisMode === 'converge' ? 'schließt sich bis zum Exit' : 'bleibt unverändert'}. Kapital: Margin auf beiden Börsen.`))

  return mount(el, h('div', { class: 'detail' }, blocks))
}
