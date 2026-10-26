// Carry Desk: wire live data, user assumptions and rendering together.

import { LiveData } from './data.js'
import { evaluatePair } from './core/evaluate.js'
import { accountRates, VOLUME_TIERS, STAKING_DISCOUNTS, PERP_TAKER_BPS, SPOT_TAKER_BPS } from './core/fees.js'
import * as fmt from './core/format.js'
import { h, mount, hideTooltip } from './ui/dom.js'
import { renderRows, renderTiles, sortRows, filterRows, SORTS } from './ui/table.js'
import { renderDetail } from './ui/detail.js'

const REFRESH_MS = 60_000
const DETAIL_REFRESH_MS = 6_000

// Aligned quote assets (AQAv1) get 20 % off taker fees. There is no API flag; USDH is
// aligned per the docs and verified on live fills.
const ALIGNED_QUOTES = new Set(['USDH'])

const NOTIONAL_CHIPS = [1_000, 10_000, 50_000, 250_000, 1_000_000]
const HORIZONS = [[24, '1 T'], [168, '7 T'], [720, '30 T'], [2160, '90 T']]
const FUNDING_BASES = [['now', 'Aktuell'], ['avg24', 'Ø 24 h'], ['avg7d', 'Ø 7 T']]
const BASIS_MODES = [['hold', 'bleibt'], ['converge', 'konvergiert']]
const CATEGORIES = [['all', 'Alle'], ['equity', 'Aktien & ETFs'], ['crypto', 'Krypto'], ['commodity', 'Rohstoffe']]
const LEVERAGES = [1, 2, 3, 5, 10]

const DEFAULTS = {
  notional: 10_000,
  hours: 720,
  fundingBasis: 'avg7d',
  basisMode: 'hold',
  tier: 0,
  staking: 0,
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
  notional: ['n', Number], hours: ['h', Number], fundingBasis: ['f', String], basisMode: ['b', String],
  tier: ['t', Number], staking: ['s', Number], leverage: ['l', Number], category: ['c', String],
  issuer: ['i', String], q: ['q', String], onlyProfitable: ['p', (v) => v === '1'], showReverse: ['r', (v) => v !== '0'],
  sort: ['sort', String], dir: ['dir', String], pair: ['pair', String],
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
  out.notional = Math.min(1e8, Math.max(10, out.notional))
  if (!SORTS[out.sort]) out.sort = 'net'
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
const data = new LiveData()
const $ = (id) => document.getElementById(id)

function set(patch) {
  Object.assign(settings, patch)
  writeHash()
  renderControls()
  scheduleRender()
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

function renderControls() {
  const input = $('notional')
  if (document.activeElement !== input) input.value = new Intl.NumberFormat('de-DE').format(settings.notional)
  mount($('notional-chips'), NOTIONAL_CHIPS.map((n) =>
    h('button', { type: 'button', class: 'chip', 'aria-pressed': String(n === settings.notional), onclick: () => set({ notional: n }) }, fmt.compact(n))))
  segmented($('hours'), HORIZONS, settings.hours, (v) => set({ hours: v }))
  segmented($('funding-basis'), FUNDING_BASES, settings.fundingBasis, (v) => set({ fundingBasis: v }))
  segmented($('basis-mode'), BASIS_MODES, settings.basisMode, (v) => set({ basisMode: v }))
  segmented($('category'), CATEGORIES, settings.category, (v) => set({ category: v }))

  const rates = accountRates(settings)
  $('params-text').textContent = `${fmt.usd(settings.notional)} · ${fmt.duration(settings.hours)} · Funding ${FUNDING_BASES.find(([v]) => v === settings.fundingBasis)[1]} · ${settings.leverage}×`
  $('fees-summary').textContent = `Spot ${fmt.bps(rates.spot, { digits: 2 })} · Perp ${fmt.bps(rates.perp, { digits: 2 })} bps`
  const tier = $('fee-tier')
  if (!tier.options.length) {
    VOLUME_TIERS.forEach((label, i) => tier.append(new Option(`${label} (Spot ${SPOT_TAKER_BPS[i]} / Perp ${PERP_TAKER_BPS[i]} bps)`, i)))
    STAKING_DISCOUNTS.forEach((s, i) => $('fee-staking').append(new Option(s.discount ? `${s.name} (−${s.discount * 100} %)` : s.name, i)))
    LEVERAGES.forEach((l) => $('leverage').append(new Option(`${l}×`, l)))
  }
  tier.value = settings.tier
  $('fee-staking').value = settings.staking
  $('leverage').value = settings.leverage

  const search = $('search')
  if (document.activeElement !== search) search.value = settings.q
  $('only-profitable').checked = settings.onlyProfitable
  $('show-reverse').checked = settings.showReverse

  document.querySelector('.pairs th[data-sort="net"]').firstChild.textContent = `Netto ${fmt.duration(settings.hours)}`
  for (const th of document.querySelectorAll('.pairs th[data-sort]')) {
    if (th.dataset.sort === settings.sort) th.setAttribute('aria-sort', settings.dir === 'asc' ? 'ascending' : 'descending')
    else th.removeAttribute('aria-sort')
  }
}

function renderIssuers() {
  const el = $('issuer')
  const counts = new Map()
  for (const p of data.pairs) counts.set(p.issuer ?? 'none', (counts.get(p.issuer ?? 'none') ?? 0) + 1)
  const options = [['all', 'Alle Emittenten'], ...[...counts].sort((a, b) => b[1] - a[1]).map(([k, n]) => [k, `${k === 'none' ? 'Ohne Emittent (Ticker)' : k} · ${n}`])]
  const key = options.map((o) => o.join()).join('|')
  if (el.dataset.key !== key) {
    el.dataset.key = key
    mount(el, options.map(([v, label]) => new Option(label, v)))
  }
  el.value = counts.has(settings.issuer) || settings.issuer === 'all' ? settings.issuer : 'all'
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

function evaluateAll() {
  const quotes = { stable: data.universe?.quotes ?? new Set(['USDC']), aligned: ALIGNED_QUOTES }
  const ctx = { books: data.books, history: data.history, settings, rates: accountRates(settings), quotes }
  rows = data.pairs.map((pair) => evaluatePair(pair, ctx))
  return rows
}

function scheduleRender() {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    render()
  })
}

function render() {
  evaluateAll()
  renderIssuers()
  const visible = sortRows(filterRows(rows, settings), settings.sort, settings.dir)
  renderTiles($('tiles'), visible, data.pairs, settings, openPair)
  renderRows($('rows'), visible, settings, settings.pair)
  const empty = $('empty')
  empty.hidden = visible.length > 0
  if (!visible.length) empty.textContent = data.pairs.length ? 'Keine Paare für diese Filter.' : data.error ? 'Die Hyperliquid-API ist gerade nicht erreichbar – neuer Versuch beim nächsten Update.' : 'Lade Märkte …'
  $('table-wrap').classList.toggle('stale', data.busy && !data.updatedAt)
  renderStatus()
  if (settings.pair) renderOpenDetail()
  requestData(visible)
}

/** Ask the data layer for deeper books and funding history where they matter. */
function requestData(visible) {
  const deeper = []
  for (const r of visible) {
    if (r.status === 'thin' || r.curve?.depthLimited) deeper.push(r.pair.spot.coin, r.pair.perp.coin)
  }
  data.wantDepth(deeper, settings.notional)
  if (data.updatedAt) data.wantHistory(visible.filter((r) => r.status !== 'nobook').map((r) => r.pair.perp.coin))
}

function renderStatus() {
  const live = $('live')
  const usage = data.usage()
  $('live-meter').style.setProperty('--fill', `${Math.min(100, (usage / 1200) * 100)}%`)
  $('live-meter').title = `API-Gewicht der letzten Minute: ${usage} von 1200 (Limit pro IP)`
  $('refresh').classList.toggle('spinning', data.busy)
  if (data.error && !data.updatedAt) {
    live.dataset.state = 'error'
    $('live-text').textContent = 'API nicht erreichbar'
    return
  }
  if (!data.updatedAt) {
    live.dataset.state = 'busy'
    $('live-text').textContent = data.pairs.length ? `Lade Orderbücher · ${data.books.size} von ${data.legCoins().length}` : 'Lade Märkte …'
    return
  }
  live.dataset.state = data.error ? 'error' : data.busy ? 'busy' : 'ok'
  const next = Math.max(0, Math.round((nextRefreshAt - Date.now()) / 1000))
  $('live-text').textContent = `${data.error ? 'Letzter Stand' : 'Live'} · ${fmt.timeOfDay(data.updatedAt)} · Update in ${next} s`
}

// ── detail drawer ───────────────────────────────────────────

let detailTimer = null
let lastFocus = null

function openPair(id) {
  if (!data.pairs.some((p) => p.id === id)) return
  if (!settings.pair) lastFocus = document.activeElement
  set({ pair: id })
  const drawer = $('drawer')
  drawer.setAttribute('aria-hidden', 'false')
  document.body.style.overflow = 'hidden'
  requestAnimationFrame(() => drawer.querySelector('.drawer-panel').focus())
  const pair = data.pairs.find((p) => p.id === id)
  data.wantHistory([pair.perp.coin], 2)
  clearInterval(detailTimer)
  data.refreshPair(pair)
  detailTimer = setInterval(() => {
    const current = data.pairs.find((p) => p.id === settings.pair)
    if (current && !document.hidden) data.refreshPair(current)
  }, DETAIL_REFRESH_MS)
}

function closePair() {
  clearInterval(detailTimer)
  detailTimer = null
  hideTooltip()
  $('drawer').setAttribute('aria-hidden', 'true')
  document.body.style.overflow = ''
  set({ pair: null })
  lastFocus?.focus?.()
}

function renderOpenDetail() {
  const r = rows.find((x) => x.pair.id === settings.pair)
  if (!r) return
  const drawer = $('drawer')
  if (drawer.getAttribute('aria-hidden') === 'true') {
    openPair(settings.pair)
    return
  }
  const panel = drawer.querySelector('.drawer-panel')
  const scroll = panel.scrollTop
  renderDetail($('detail'), r, settings, data)
  panel.scrollTop = scroll
}

// ── refresh loop ────────────────────────────────────────────

let nextRefreshAt = Date.now()
let loopTimer = null

async function refreshNow() {
  clearTimeout(loopTimer)
  nextRefreshAt = Date.now() + REFRESH_MS
  await data.refresh()
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

data.addEventListener('change', scheduleRender)
setInterval(renderStatus, 1000)
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && Date.now() > nextRefreshAt) refreshNow()
})

applyTheme(storage((s) => s.getItem('carry-desk-theme')))
if (matchMedia('(max-width: 860px)').matches) $('params').open = false
bindControls()
renderControls()
scheduleRender()
refreshNow()
