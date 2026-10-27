// Carry Desk: wire live data, user assumptions and rendering together.
//
// Three views share one set of assumptions: spot ⇄ perp carry on Hyperliquid, the same on
// Lighter, and perp ⇄ perp funding spreads across both venues. Each venue keeps its own
// live data (VenueData + adapter); only the venues the active view needs are refreshed.

import { VenueData } from './data.js'
import { createHyperliquid } from './venues/hyperliquid.js'
import { createLighter, LIGHTER_ACCOUNTS } from './venues/lighter.js'
import { evaluatePair } from './core/evaluate.js'
import { matchCross, evaluateCross } from './core/cross.js'
import { executorFor, WAITS } from './core/execution.js'
import { accountRates, VOLUME_TIERS, STAKING_DISCOUNTS, PERP_TAKER_BPS, SPOT_TAKER_BPS } from './core/fees.js'
import * as fmt from './core/format.js'
import { h, mount, hideTooltip } from './ui/dom.js'
import { renderRows, renderTiles, sortRows, filterRows, SORTS } from './ui/table.js'
import { renderDetail } from './ui/detail.js'
import { renderCrossDetail } from './ui/cross-detail.js'

const REFRESH_MS = 60_000
const DETAIL_REFRESH_MS = 6_000

const NOTIONAL_CHIPS = [1_000, 10_000, 50_000, 250_000, 1_000_000]
// Funding settles hourly and jumps around, so short holds are first-class horizons too.
const HORIZONS = [[1, '1 h'], [4, '4 h'], [8, '8 h'], [24, '1 T'], [168, '7 T'], [720, '30 T'], [2160, '90 T']]
const FUNDING_BASES = [['now', 'Aktuell'], ['avg24', 'Ø 24 h'], ['avg7d', 'Ø 7 T']]
const BASIS_MODES = [['hold', 'bleibt'], ['converge', 'konvergiert']]
const FUNDING_IMPACT = [['real', 'realistisch'], ['max', 'konservativ'], ['off', 'ignorieren']]
const CATEGORIES = [['all', 'Alle'], ['equity', 'Aktien & ETFs'], ['crypto', 'Krypto'], ['commodity', 'Rohstoffe'], ['fx', 'FX']]
const LEVERAGES = [1, 2, 3, 5, 10]

/** The views, the venues each one reads, and what its two legs are called. */
export const VIEWS = {
  hl: { name: 'Hyperliquid', sub: 'Spot ⇄ Perp', venues: ['hl'], legs: ['Spot', 'Perp'] },
  lt: { name: 'Lighter', sub: 'Spot ⇄ Perp', venues: ['lt'], legs: ['Spot', 'Perp'] },
  x: { name: 'Cross-DEX', sub: 'Perp ⇄ Perp', venues: ['hl', 'lt'], legs: ['HL', 'Lighter'], cross: true },
}

const EXECUTIONS = (view) => [['taker', 'Taker'], ['makerA', `Maker ${view.legs[0]}`], ['makerB', `Maker ${view.legs[1]}`], ['maker', 'Maker beide']]

const DEFAULTS = {
  view: 'hl',
  notional: 10_000,
  hours: 720,
  fundingBasis: 'avg7d',
  basisMode: 'hold',
  fundingImpact: 'real',
  exec: 'taker',
  wait: 5,
  tier: 0,
  staking: 0,
  ltAccount: 0,
  leverage: 2,
  category: 'all',
  issuer: 'all',
  q: '',
  onlyProfitable: false,
  showReverse: true,
  sort: 'net',
  dir: 'desc',
  pair: null,
}

// ── settings ⇄ URL hash ─────────────────────────────────────

const HASH_KEYS = {
  view: ['v', String], notional: ['n', Number], hours: ['h', Number], fundingBasis: ['f', String], basisMode: ['b', String],
  fundingImpact: ['fi', String], exec: ['e', String], wait: ['w', Number], tier: ['t', Number], staking: ['s', Number],
  ltAccount: ['la', Number], leverage: ['l', Number], category: ['c', String], issuer: ['i', String], q: ['q', String],
  onlyProfitable: ['p', (v) => v === '1'], showReverse: ['r', (v) => v !== '0'], sort: ['sort', String], dir: ['dir', String],
  pair: ['pair', String],
}

function readHash() {
  const params = new URLSearchParams(location.hash.slice(1))
  const out = { ...DEFAULTS }
  for (const [key, [short, parse]] of Object.entries(HASH_KEYS)) {
    if (!params.has(short)) continue
    const v = parse(params.get(short))
    if (typeof v === 'number' && !Number.isFinite(v)) continue
    out[key] = v
  }
  // Links are user input: anything unknown falls back to the default.
  const allowed = (options, v) => options.some(([x]) => x === v)
  if (!VIEWS[out.view]) out.view = DEFAULTS.view
  out.notional = Math.min(1e8, Math.max(10, out.notional))
  if (!SORTS[out.sort]) out.sort = 'net'
  if (out.dir !== 'asc' && out.dir !== 'desc') out.dir = SORTS[out.sort].dir
  if (!allowed(HORIZONS, out.hours)) out.hours = DEFAULTS.hours
  if (!allowed(FUNDING_BASES, out.fundingBasis)) out.fundingBasis = DEFAULTS.fundingBasis
  if (!allowed(BASIS_MODES, out.basisMode)) out.basisMode = DEFAULTS.basisMode
  if (!allowed(FUNDING_IMPACT, out.fundingImpact)) out.fundingImpact = DEFAULTS.fundingImpact
  if (!allowed(EXECUTIONS(VIEWS.hl), out.exec)) out.exec = DEFAULTS.exec
  if (!allowed(WAITS, out.wait)) out.wait = DEFAULTS.wait
  if (!allowed(CATEGORIES, out.category)) out.category = DEFAULTS.category
  if (!LEVERAGES.includes(out.leverage)) out.leverage = DEFAULTS.leverage
  if (!(out.tier >= 0 && out.tier < VOLUME_TIERS.length)) out.tier = DEFAULTS.tier
  if (!(out.staking >= 0 && out.staking < STAKING_DISCOUNTS.length)) out.staking = DEFAULTS.staking
  if (!(out.ltAccount >= 0 && out.ltAccount < LIGHTER_ACCOUNTS.length)) out.ltAccount = DEFAULTS.ltAccount
  return out
}

function writeHash() {
  const params = new URLSearchParams()
  for (const [key, [short]] of Object.entries(HASH_KEYS)) {
    const v = settings[key]
    if (v === DEFAULTS[key] || v == null || v === '') continue
    params.set(short, typeof v === 'boolean' ? (v ? '1' : '0') : String(v))
  }
  const hash = params.toString()
  history.replaceState(null, '', hash ? `#${hash}` : location.pathname + location.search)
}

const settings = readHash()
const venues = { hl: new VenueData(createHyperliquid()), lt: new VenueData(createLighter()) }
const $ = (id) => document.getElementById(id)
const view = () => VIEWS[settings.view]
const activeVenues = () => view().venues.map((id) => venues[id])

// Settings that change a row's numbers (the rest only filter, sort or navigate).
const EVALUATION_KEYS = new Set(['notional', 'hours', 'fundingBasis', 'basisMode', 'fundingImpact', 'exec', 'wait', 'tier', 'staking', 'ltAccount', 'leverage'])
let settingsVersion = 0

function set(patch) {
  if (Object.keys(patch).some((k) => EVALUATION_KEYS.has(k) && patch[k] !== settings[k])) settingsVersion++
  Object.assign(settings, patch)
  writeHash()
  renderControls()
  scheduleRender()
}

// ── pairs per view ──────────────────────────────────────────

let cross = { hl: null, lt: null, pairs: [] }

/** Cross pairs are rebuilt whenever either venue's market list changes. */
function crossPairs() {
  const a = venues.hl.universe
  const b = venues.lt.universe
  if (!a || !b) return []
  if (cross.hl !== a || cross.lt !== b) cross = { hl: a, lt: b, pairs: matchCross(a.perps, b.perps) }
  return cross.pairs
}

function pairsOf(id = settings.view) {
  return VIEWS[id].cross ? crossPairs() : venues[id].pairs
}

/** Market keys a pair needs books for, per venue. */
function legKeys(pair) {
  return pair.type === 'cross' ? [['hl', pair.a.key], ['lt', pair.b.key]] : [[pair.venue, pair.spot.key], [pair.venue, pair.perp.key]]
}

// ── controls ────────────────────────────────────────────────

function segmented(el, options, value, onPick) {
  mount(el, options.map(([v, label]) =>
    h('button', {
      type: 'button',
      role: 'radio',
      'aria-checked': String(v === value),
      tabindex: v === value ? 0 : -1,
      onclick: () => onPick(v),
      onkeydown: (e) => {
        const i = options.findIndex(([x]) => x === value)
        const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0
        if (!step) return
        e.preventDefault()
        onPick(options[(i + step + options.length) % options.length][0])
        requestAnimationFrame(() => el.querySelector('[aria-checked="true"]')?.focus())
      },
    }, label)))
}

/** Tabs are built once and then updated in place, so keyboard focus survives renders. */
function renderTabs() {
  const ids = Object.keys(VIEWS)
  const list = $('tabs')
  if (!list.children.length) {
    mount(list, ids.map((id) => h('button', {
      type: 'button',
      role: 'tab',
      id: `tab-${id}`,
      'aria-controls': 'board',
      onclick: () => pickView(id),
      onkeydown: (e) => {
        const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0
        if (!step) return
        e.preventDefault()
        const next = ids[(ids.indexOf(settings.view) + step + ids.length) % ids.length]
        pickView(next)
        $(`tab-${next}`).focus()
      },
    },
    h('span', { class: 'tab-name' }, VIEWS[id].name),
    h('span', { class: 'tab-sub' }, VIEWS[id].sub, h('span', { class: 'tab-count' })))))
  }
  for (const id of ids) {
    const tab = $(`tab-${id}`)
    const selected = id === settings.view
    tab.setAttribute('aria-selected', String(selected))
    tab.tabIndex = selected ? 0 : -1
    const n = pairsOf(id).length
    const badge = tab.querySelector('.tab-count')
    badge.textContent = n ? String(n) : ''
    badge.hidden = !n
  }
}

function pickView(id) {
  if (id === settings.view) return
  if (settings.pair) closePair()
  set({ view: id, issuer: 'all' })
  enterView()
}

/** After the view changed: idle the venues it does not read, refresh the ones it does. */
function enterView() {
  $('board').setAttribute('aria-labelledby', `tab-${settings.view}`)
  // A streaming venue would otherwise keep sampling the books of the last view.
  for (const venue of Object.values(venues)) if (!view().venues.includes(venue.id)) venue.want([])
  refreshNow()
}

/** Every venue of the view has loaded its markets (so a missing pair or issuer is really missing). */
const viewLoaded = () => activeVenues().every((d) => d.universe) && pairsOf().length > 0

function feeSummary(v) {
  const rates = accountRates(settings)
  const lt = LIGHTER_ACCOUNTS[settings.ltAccount]
  const ltText = lt.taker ? `Lighter ${fmt.bps(lt.taker, { digits: 2 })} bps` : 'Lighter 0 bps'
  if (v.cross) return `HL ${fmt.bps(rates.perp, { digits: 2 })} · ${ltText}`
  if (settings.view === 'lt') return `${lt.name.split(' ·')[0]} · Maker ${fmt.bps(lt.maker, { digits: 2 })} / Taker ${fmt.bps(lt.taker, { digits: 2 })} bps`
  return `Spot ${fmt.bps(rates.spot, { digits: 2 })} · Perp ${fmt.bps(rates.perp, { digits: 2 })} bps`
}

function renderControls() {
  const v = view()
  renderTabs()
  const input = $('notional')
  if (document.activeElement !== input) input.value = new Intl.NumberFormat('de-DE').format(settings.notional)
  mount($('notional-chips'), NOTIONAL_CHIPS.map((n) =>
    h('button', { type: 'button', class: 'chip', 'aria-pressed': String(n === settings.notional), onclick: () => set({ notional: n }) }, fmt.usd(n))))
  segmented($('hours'), HORIZONS, settings.hours, (x) => set({ hours: x }))
  segmented($('funding-basis'), FUNDING_BASES, settings.fundingBasis, (x) => set({ fundingBasis: x }))
  segmented($('basis-mode'), BASIS_MODES, settings.basisMode, (x) => set({ basisMode: x }))
  segmented($('funding-impact'), FUNDING_IMPACT, settings.fundingImpact, (x) => set({ fundingImpact: x }))
  segmented($('exec'), EXECUTIONS(v), settings.exec, (x) => set({ exec: x }))
  segmented($('wait'), WAITS, settings.wait, (x) => set({ wait: x }))
  $('wait-control').hidden = settings.exec === 'taker'
  segmented($('category'), CATEGORIES, settings.category, (x) => set({ category: x }))

  const exec = EXECUTIONS(v).find(([x]) => x === settings.exec)[1]
  $('params-text').textContent = `${fmt.usd(settings.notional)} · ${fmt.duration(settings.hours)} · Funding ${FUNDING_BASES.find(([x]) => x === settings.fundingBasis)[1]} · ${exec}${settings.exec === 'taker' ? '' : ` ${settings.wait} min`} · ${settings.leverage}×`
  $('fees-summary').textContent = feeSummary(v)
  const tier = $('fee-tier')
  if (!tier.options.length) {
    VOLUME_TIERS.forEach((label, i) => tier.append(new Option(`${label} (Spot ${fmt.bps(SPOT_TAKER_BPS[i], { digits: 2 })} / Perp ${fmt.bps(PERP_TAKER_BPS[i], { digits: 2 })} bps)`, i)))
    STAKING_DISCOUNTS.forEach((s, i) => $('fee-staking').append(new Option(s.discount ? `${s.name} (−${s.discount * 100} %)` : s.name, i)))
    LIGHTER_ACCOUNTS.forEach((a, i) => $('lt-account').append(new Option(`${a.name} (Maker ${fmt.bps(a.maker, { digits: 2 })} / Taker ${fmt.bps(a.taker, { digits: 2 })} bps)`, i)))
    LEVERAGES.forEach((l) => $('leverage').append(new Option(`${l}×`, l)))
  }
  tier.value = settings.tier
  $('fee-staking').value = settings.staking
  $('lt-account').value = settings.ltAccount
  $('leverage').value = settings.leverage
  for (const el of document.querySelectorAll('[data-venue]')) el.hidden = !v.venues.includes(el.dataset.venue)

  const search = $('search')
  if (document.activeElement !== search) search.value = settings.q
  search.placeholder = v.cross ? 'Suche: BTC, GOLD, NVDA, xyz …' : settings.view === 'lt' ? 'Suche: ETH, LIT, SPY …' : 'Suche: NVDA, HYPE, xyz, EQX …'
  $('only-profitable').checked = settings.onlyProfitable
  $('show-reverse').checked = settings.showReverse
  $('show-reverse').closest('label').hidden = Boolean(v.cross)
  $('issuer').hidden = Boolean(v.cross)

  const head = (key, text, title) => {
    const th = document.querySelector(`.pairs th[data-sort="${key}"]`)
    th.firstChild.textContent = text
    if (title !== undefined) th.title = title
  }
  head('net', `Netto ${fmt.duration(settings.hours)}`)
  head('funding', v.cross ? 'Funding-Spread p.a.' : 'Funding p.a.', v.cross ? 'Was du verdienst: Funding des Shorts minus Funding des Longs' : '')
  head('basis', v.cross ? 'Preisdifferenz' : 'Basis', v.cross ? 'Lighter-Perp gegenüber HL-Perp, je Einheit des Underlyings' : '')
  for (const th of document.querySelectorAll('.pairs th[data-sort]')) {
    if (th.dataset.sort === settings.sort) th.setAttribute('aria-sort', settings.dir === 'asc' ? 'ascending' : 'descending')
    else th.removeAttribute('aria-sort')
  }
  $('pairs-caption').textContent = v.cross ? 'Cross-DEX-Paare Hyperliquid ⇄ Lighter mit Funding-Spread und Implementation Shortfall' : `${v.name}: Spot/Perp-Paare mit Funding-Carry und Implementation Shortfall`
}

function renderIssuers() {
  const el = $('issuer')
  const counts = new Map()
  if (!view().cross) for (const p of pairsOf()) counts.set(p.issuer ?? 'none', (counts.get(p.issuer ?? 'none') ?? 0) + 1)
  const options = [['all', 'Alle Emittenten'], ...[...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, `${k === 'none' ? 'Ohne Emittent (Ticker)' : k} · ${n}`])]
  const key = options.map((o) => o.join()).join('|')
  if (el.dataset.key !== key) {
    el.dataset.key = key
    mount(el, options.map(([v, label]) => new Option(label, v)))
  }
  // An issuer from a link that this view does not have would hide every row.
  if (settings.issuer !== 'all' && !counts.has(settings.issuer) && viewLoaded()) set({ issuer: 'all' })
  el.value = counts.has(settings.issuer) ? settings.issuer : 'all'
}

function bindControls() {
  const input = $('notional')
  const commit = () => {
    const n = fmt.parseAmount(input.value)
    if (n) set({ notional: Math.min(1e8, Math.max(10, Math.round(n))) })
    else renderControls()
  }
  input.addEventListener('change', commit)
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      commit()
      input.blur()
    }
  })
  $('fee-tier').addEventListener('change', (e) => set({ tier: Number(e.target.value) }))
  $('fee-staking').addEventListener('change', (e) => set({ staking: Number(e.target.value) }))
  $('lt-account').addEventListener('change', (e) => set({ ltAccount: Number(e.target.value) }))
  $('leverage').addEventListener('change', (e) => set({ leverage: Number(e.target.value) }))
  $('issuer').addEventListener('change', (e) => set({ issuer: e.target.value }))
  $('search').addEventListener('input', (e) => set({ q: e.target.value }))
  $('only-profitable').addEventListener('change', (e) => set({ onlyProfitable: e.target.checked }))
  $('show-reverse').addEventListener('change', (e) => set({ showReverse: e.target.checked }))
  for (const th of document.querySelectorAll('.pairs th[data-sort]')) {
    th.tabIndex = 0
    const sort = () => {
      const key = th.dataset.sort
      set(key === settings.sort ? { dir: settings.dir === 'asc' ? 'desc' : 'asc' } : { sort: key, dir: SORTS[key].dir })
    }
    th.addEventListener('click', sort)
    th.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), sort()))
  }
  const rows = $('rows')
  rows.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-id]')
    if (tr) openPair(tr.dataset.id)
  })
  rows.addEventListener('keydown', (e) => {
    const tr = e.target.closest('tr[data-id]')
    if (!tr) return
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      openPair(tr.dataset.id)
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault()
      ;(e.key === 'ArrowDown' ? tr.nextElementSibling : tr.previousElementSibling)?.focus()
    }
  })
  $('refresh').addEventListener('click', () => refreshNow())
  $('theme').addEventListener('click', toggleTheme)
  for (const el of document.querySelectorAll('[data-close]')) el.addEventListener('click', closePair)
  document.addEventListener('keydown', (e) => e.key === 'Escape' && settings.pair && closePair())
  document.addEventListener('click', (e) => {
    const fees = $('fees')
    if (fees.open && !fees.contains(e.target)) fees.open = false
  })
  window.addEventListener('resize', () => settings.pair && scheduleRender())
}

// ── theme ───────────────────────────────────────────────────

function storage(fn) {
  try {
    return fn(window.localStorage)
  } catch {
    return null
  }
}

function applyTheme(theme) {
  if (theme === 'light' || theme === 'dark') document.documentElement.dataset.theme = theme
  else delete document.documentElement.dataset.theme
}

function toggleTheme() {
  const current = document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
  const next = current === 'dark' ? 'light' : 'dark'
  applyTheme(next)
  storage((s) => s.setItem('carry-desk-theme', next))
}

// ── evaluation & rendering ──────────────────────────────────

let rows = []
let frame = 0

/** Does the user post this leg (0 = spot or HL, 1 = perp or Lighter) as a maker order? */
const isMaker = (legIndex) => settings.exec === 'maker' || settings.exec === (legIndex === 0 ? 'makerA' : 'makerB')

/** Order execution for one leg: a market order unless the user posts this leg as maker. */
function executionFor(venueId, market, legIndex, fees) {
  if (!isMaker(legIndex)) return undefined
  return executorFor({ market, candles: venues[venueId].candles.get(market.key), waitMin: settings.wait, makerFeeBps: fees.maker(market), takerFeeBps: fees.taker(market) })
}

/** Everything evaluateCross needs about one venue's leg. */
function venueContext(venueId, fees) {
  const venue = venues[venueId]
  return { books: venue.books, history: venue.history, fees, funding: venue.adapter.funding }
}

/**
 * Rows are pure functions of their inputs. Renders come far more often than any one
 * row's inputs change (every streamed book, every history that lands), so a row is only
 * re-evaluated when its pair, books, history, candles or the settings moved.
 */
let evaluated = new Map() // pair id → { deps, row }

function inputsOf(pair) {
  const deps = [pair, settingsVersion]
  for (const [id, key] of legKeys(pair)) {
    const venue = venues[id]
    deps.push(venue.books.get(key), venue.history.get(key), venue.candles.get(key))
  }
  return deps
}

function evaluateAll() {
  const v = view()
  const fees = Object.fromEntries(v.venues.map((id) => [id, venues[id].adapter.fees(settings)]))
  const evaluate = v.cross
    ? (pair) => evaluateCross(pair, {
        a: { ...venueContext('hl', fees.hl), execute: executionFor('hl', pair.a, 0, fees.hl) },
        b: { ...venueContext('lt', fees.lt), execute: executionFor('lt', pair.b, 1, fees.lt) },
        settings,
      })
    : (pair) => {
        const venue = venues[pair.venue]
        const f = fees[pair.venue]
        return evaluatePair(pair, {
          books: venue.books,
          history: venue.history,
          settings,
          fees: f,
          funding: venue.adapter.funding,
          execute: { spot: executionFor(pair.venue, pair.spot, 0, f), perp: executionFor(pair.venue, pair.perp, 1, f) },
        })
      }
  const next = new Map()
  rows = pairsOf().map((pair) => {
    const deps = inputsOf(pair)
    const hit = evaluated.get(pair.id)
    const row = hit && hit.deps.length === deps.length && hit.deps.every((d, i) => d === deps[i]) ? hit.row : evaluate(pair)
    next.set(pair.id, { deps, row })
    return row
  })
  evaluated = next
  return rows
}

// Data lands in bursts (a cycle's books, streamed snapshots): render it at most every
// RENDER_GAP_MS. Anything the user does renders on the next frame.
const RENDER_GAP_MS = 500
let lastRender = 0
let throttle = null

function scheduleRender() {
  clearTimeout(throttle)
  throttle = null
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    lastRender = performance.now()
    render()
  })
}

function scheduleDataRender() {
  if (frame || throttle) return
  throttle = setTimeout(scheduleRender, Math.max(0, lastRender + RENDER_GAP_MS - performance.now()))
}

const loadingAll = () => activeVenues().some((d) => d.busy && !d.updatedAt)

function render() {
  evaluateAll()
  renderTabs()
  renderIssuers()
  const v = view()
  const visible = sortRows(filterRows(rows, settings), settings.sort, settings.dir)
  const loading = loadingAll() || (v.cross && !crossPairs().length && activeVenues().some((d) => !d.updatedAt))
  renderTiles($('tiles'), visible, unbackedOf(), settings, openPair, loading, v)
  // Rows are rebuilt on every tick: carry keyboard focus over to the new row.
  const tbody = $('rows')
  const focusId = tbody.contains(document.activeElement) ? document.activeElement.dataset.id : returnFocusId
  returnFocusId = null
  renderRows(tbody, visible, settings, settings.pair, v)
  if (focusId != null && !settings.pair) {
    ;(tbody.querySelector(`tr[data-id="${CSS.escape(focusId)}"]`) ?? tbody.firstElementChild)?.focus({ preventScroll: true })
  }
  const empty = $('empty')
  empty.hidden = visible.length > 0
  if (!visible.length) {
    const failed = activeVenues().find((d) => d.error && !d.updatedAt)
    empty.textContent = rows.length ? 'Keine Paare für diese Filter.' : failed ? `Die ${failed.adapter.name}-API ist gerade nicht erreichbar – neuer Versuch beim nächsten Update.` : 'Lade Märkte …'
  }
  $('table-wrap').classList.toggle('stale', loading)
  renderStatus()
  if (settings.pair) renderOpenDetail()
  requestData(visible)
}

function unbackedOf() {
  return view().cross ? [] : venues[settings.view].unbacked
}

/** Ask each venue for the books, tails, history and candles the view needs. */
function requestData(visible) {
  const v = view()
  // Every pair's books, the widest funding first: a streaming venue subscribes in this
  // order, so the rows that matter most fill in first.
  const books = Object.fromEntries(v.venues.map((id) => [id, new Set()]))
  const byFunding = rows.slice().sort((x, y) => Math.abs(y.fundingApr) - Math.abs(x.fundingApr))
  for (const r of byFunding) for (const [id, key] of legKeys(r.pair)) books[id].add(key)
  for (const id of v.venues) venues[id].want([...books[id]])

  const thin = { hl: [], lt: [] }
  const limited = { hl: [], lt: [] }
  const perps = { hl: [], lt: [] }
  const makers = { hl: [], lt: [] }
  for (const r of visible) {
    const legs = legKeys(r.pair)
    if (r.status === 'thin') for (const [id, key] of legs) thin[id].push(key)
    else if (r.curve?.depthLimited) for (const [id, key] of legs) limited[id].push(key)
    if (r.status !== 'nobook') {
      if (r.type === 'cross') perps.hl.push(r.pair.a.key), perps.lt.push(r.pair.b.key)
      else perps[r.pair.venue].push(r.pair.perp.key)
    }
    legs.forEach(([id, key], i) => isMaker(i) && makers[id].push(key))
  }
  for (const id of v.venues) {
    const venue = venues[id]
    venue.wantDepth(thin[id], settings.notional)
    // Net still rises at the edge of the visible levels: fetch the tail whatever the size.
    venue.wantDepth(limited[id], Infinity)
    // History decides the funding basis of every row, so it goes ahead of maker candles.
    if (venue.updatedAt) venue.wantHistory(perps[id], 7)
    if (makers[id].length) venue.wantCandles(makers[id], 8)
  }
}

function renderStatus() {
  const live = $('live')
  const list = activeVenues()
  mount($('live-meters'), list.map((d) => {
    const usage = d.usage()
    const budget = d.adapter.budget
    return h('span', { class: 'live-venue', title: `${d.adapter.name}: API-Last der letzten Minute ${usage} von ${budget}${d.adapter.stream ? ` · WebSocket ${d.adapter.stream.connected ? 'verbunden' : 'getrennt'}` : ''}` },
      h('span', { class: 'live-api' }, d.adapter.short),
      h('span', { class: 'live-meter', role: 'meter', 'aria-label': `${d.adapter.name} API-Last`, 'aria-valuemin': '0', 'aria-valuemax': String(budget), 'aria-valuenow': String(usage), style: { '--fill': `${Math.min(100, (usage / budget) * 100)}%` } }))
  }))
  $('refresh').classList.toggle('spinning', list.some((d) => d.busy))
  const failed = list.find((d) => d.error && !d.updatedAt)
  if (failed) {
    live.dataset.state = 'error'
    $('live-text').textContent = `${failed.adapter.name} nicht erreichbar`
    return
  }
  const waiting = list.find((d) => !d.updatedAt)
  if (waiting) {
    live.dataset.state = 'busy'
    const wanted = waiting.wanted.size
    $('live-text').textContent = waiting.pairs.length && wanted ? `${waiting.adapter.name}: lade Orderbücher · ${[...waiting.wanted].filter((k) => waiting.books.has(k)).length} von ${wanted}` : `${waiting.adapter.name}: lade Märkte …`
    return
  }
  // A streaming venue without its socket has no books: say so instead of "Live".
  const offline = list.find((d) => d.adapter.stream && !d.adapter.stream.connected)
  if (offline) {
    live.dataset.state = 'error'
    $('live-text').textContent = `${offline.adapter.name}: WebSocket getrennt – verbinde neu …`
    return
  }
  const error = list.some((d) => d.error)
  live.dataset.state = error ? 'error' : list.some((d) => d.busy) ? 'busy' : 'ok'
  const updated = Math.min(...list.map((d) => d.updatedAt))
  const next = Math.max(0, Math.round((nextRefreshAt - Date.now()) / 1000))
  // Sampled books arrive over the first minutes: show how far that got.
  const sampling = list.find((d) => d.streaming && [...d.wanted].some((k) => !d.books.has(k)))
  const progress = sampling ? ` · ${sampling.adapter.short}-Bücher ${[...sampling.wanted].filter((k) => sampling.books.has(k)).length}/${sampling.wanted.size}` : ''
  $('live-text').textContent = `${error ? 'Letzter Stand' : 'Live'} · ${fmt.timeOfDay(updated)} · Update in ${next} s${progress}`
}

// ── detail drawer ───────────────────────────────────────────

let detailTimer = null
let lastFocusId = null // row that opened the drawer
let returnFocusId = null // row to focus after the next render

/** While the drawer is open, everything behind it is inert (no focus, no clicks). */
function setModal(open) {
  const drawer = $('drawer')
  drawer.inert = !open
  for (const el of document.body.children) if (el !== drawer && el.id !== 'tooltip') el.inert = open
}

const findPair = (id) => pairsOf().find((p) => p.id === id)

/** The open pair's market keys, per venue. */
function legsByVenue(pair) {
  const byVenue = new Map()
  for (const [id, key] of legKeys(pair)) byVenue.set(id, [...(byVenue.get(id) ?? []), key])
  return byVenue
}

/** Keep the open pair's books (and their tails) fresh, per venue. */
function refreshLegs(pair) {
  for (const [id, keys] of legsByVenue(pair)) venues[id].refreshMarkets(keys)
}

function openPair(id) {
  const pair = findPair(id)
  if (!pair) return
  if (!settings.pair) lastFocusId = document.activeElement?.closest?.('#rows tr[data-id]')?.dataset.id ?? id
  set({ pair: id })
  const drawer = $('drawer')
  drawer.setAttribute('aria-hidden', 'false')
  setModal(true)
  document.body.style.overflow = 'hidden'
  requestAnimationFrame(() => drawer.querySelector('.drawer-panel').focus())
  if (pair.type === 'cross') {
    venues.hl.wantHistory([pair.a.key], 2)
    venues.lt.wantHistory([pair.b.key], 2)
  } else {
    venues[pair.venue].wantHistory([pair.perp.key], 2)
  }
  legKeys(pair).forEach(([venueId, key], i) => isMaker(i) && venues[venueId].wantCandles([key], 2))
  // Streaming venues follow the open pair live instead of sampling it.
  for (const [id, keys] of legsByVenue(pair)) venues[id].follow(keys)
  clearInterval(detailTimer)
  refreshLegs(pair)
  detailTimer = setInterval(() => {
    const current = findPair(settings.pair)
    if (current && !document.hidden) refreshLegs(current)
  }, DETAIL_REFRESH_MS)
}

function closePair() {
  clearInterval(detailTimer)
  detailTimer = null
  for (const venue of Object.values(venues)) venue.follow([])
  hideTooltip()
  $('drawer').setAttribute('aria-hidden', 'true')
  setModal(false)
  document.body.style.overflow = ''
  returnFocusId = lastFocusId ?? settings.pair // deep links fall back to the pair's own row
  lastFocusId = null
  set({ pair: null })
}

function renderOpenDetail() {
  const r = rows.find((x) => x.pair.id === settings.pair)
  if (!r) {
    // A link to a pair this view does not have (any more): forget it.
    if (viewLoaded()) set({ pair: null })
    return
  }
  const drawer = $('drawer')
  if (drawer.getAttribute('aria-hidden') === 'true') {
    openPair(settings.pair)
    return
  }
  // The drawer is rebuilt on every tick: keep scroll, open <details> and focus.
  const panel = drawer.querySelector('.drawer-panel')
  const el = $('detail')
  const scroll = panel.scrollTop
  const focusables = () => [...el.querySelectorAll('a[href], button, summary')]
  const focusIdx = focusables().indexOf(document.activeElement)
  const open = [...el.querySelectorAll('details')].map((d) => d.open)
  hideTooltip()
  if (r.type === 'cross') renderCrossDetail(el, r, settings, { a: venues.hl, b: venues.lt, view: view() })
  else renderDetail(el, r, settings, venues[r.pair.venue], view())
  el.querySelectorAll('details').forEach((d, i) => open[i] && (d.open = true))
  if (focusIdx >= 0) focusables()[focusIdx]?.focus({ preventScroll: true })
  panel.scrollTop = scroll
}

// ── refresh loop ────────────────────────────────────────────

let nextRefreshAt = Date.now()
let loopTimer = null

async function refreshNow() {
  clearTimeout(loopTimer)
  nextRefreshAt = Date.now() + REFRESH_MS
  await Promise.all(activeVenues().map((d) => d.refresh()))
  schedule()
}

function schedule() {
  clearTimeout(loopTimer)
  const wait = Math.max(0, nextRefreshAt - Date.now())
  loopTimer = setTimeout(() => {
    if (document.hidden) {
      nextRefreshAt = Date.now() + 5_000
      schedule()
      return
    }
    refreshNow()
  }, wait)
}

// Data of venues the view does not read never needs a render.
for (const venue of Object.values(venues)) venue.addEventListener('change', () => view().venues.includes(venue.id) && scheduleDataRender())

// A shared link pasted into an open tab only changes the hash: take it over.
window.addEventListener('hashchange', () => {
  const next = readHash()
  const viewChanged = next.view !== settings.view
  if (settings.pair && settings.pair !== next.pair) closePair()
  Object.assign(settings, next)
  settingsVersion++
  writeHash()
  renderControls()
  scheduleRender()
  if (viewChanged) enterView()
})
setInterval(renderStatus, 1000)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() > nextRefreshAt) refreshNow()
})

applyTheme(storage((s) => s.getItem('carry-desk-theme')))
if (matchMedia('(max-width: 860px)').matches) $('params').open = false
bindControls()
renderControls()
scheduleRender()
enterView()
