// Hand-built SVG charts. Thin 2px lines, hairline grids, one y-axis, a crosshair that
// snaps to the nearest datum, and text in ink tokens — never in the series colour.

import { s, showTooltip, hideTooltip } from './dom.js'
import * as fmt from '../core/format.js'

const css = (name) => `var(--${name})`

export function niceStep(span, count) {
  const raw = span / Math.max(1, count)
  const mag = 10 ** Math.floor(Math.log10(raw))
  const err = raw / mag
  return (err >= 7.5 ? 10 : err >= 3.5 ? 5 : err >= 1.5 ? 2 : 1) * mag
}

/** Tick values covering [min, max] and the nice domain they imply. */
export function niceTicks(min, max, count = 4) {
  if (!(max > min)) {
    const pad = Math.abs(min) * 0.1 || 1
    min -= pad
    max += pad
  }
  const step = niceStep(max - min, count)
  const lo = Math.floor(min / step) * step
  const hi = Math.ceil(max / step) * step
  const ticks = []
  for (let v = lo; v <= hi + step * 1e-9; v += step) ticks.push(Number((Math.round(v / step) * step).toPrecision(12)))
  return { ticks, lo, hi }
}

/** 1-2-5 ticks for a log axis. */
export function logTicks(lo, hi) {
  const out = []
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** e
      if (v >= lo * 0.999 && v <= hi * 1.001) out.push(v)
    }
  }
  return out.length >= 2 ? out : [lo, hi]
}

function frame(width, height, margin) {
  const svg = s('svg', { class: 'chart', viewBox: `0 0 ${width} ${height}`, width, height, role: 'img' })
  return { svg, x0: margin.left, x1: width - margin.right, y0: height - margin.bottom, y1: margin.top }
}

function yGrid(svg, f, ticks, y, format) {
  for (const t of ticks) {
    const yy = y(t)
    svg.append(s('line', { class: t === 0 ? 'axis' : 'grid', x1: f.x0, x2: f.x1, y1: yy, y2: yy }))
    svg.append(s('text', { x: f.x0 - 8, y: yy + 4, 'text-anchor': 'end' }, format(t)))
  }
}

/**
 * Bottom-axis labels, thinned until none collide (≈6.6 px per glyph at 11 px, 6 px gap).
 * `major` picks a sparser subset to fall back to first (powers of ten on a log axis);
 * after that every k-th label is kept so the spacing stays regular.
 */
function xLabels(svg, f, ticks, x, format, major) {
  const all = ticks.map((t) => ({ t, xx: x(t), text: format(t) }))
  const half = (a) => a.text.length * 3.3
  const fits = (list) => list.every((a, i) => !i || a.xx - half(a) >= list[i - 1].xx + half(list[i - 1]) + 6)
  const majors = major ? all.filter((a) => major(a.t)) : []
  const base = fits(all) || majors.length < 2 ? all : majors
  let shown = base
  for (let k = 2; !fits(shown) && k < base.length; k++) shown = base.filter((_, i) => i % k === 0)
  for (const a of shown) svg.append(s('text', { x: a.xx, y: f.y0 + 18, 'text-anchor': 'middle' }, a.text))
}

const isPow10 = (v) => Math.abs(Math.log10(v) - Math.round(Math.log10(v))) < 1e-9

/** Invisible overlay that turns pointer x into the nearest datum. */
function hover(svg, f, { nearest, draw, clear }) {
  const layer = s('g', { 'pointer-events': 'none' })
  const hit = s('rect', { x: f.x0, y: f.y1, width: f.x1 - f.x0, height: f.y0 - f.y1, fill: 'transparent', tabindex: 0 })
  const toLocal = (evt) => {
    const box = svg.getBoundingClientRect()
    return ((evt.clientX - box.left) / box.width) * svg.viewBox.baseVal.width
  }
  const move = (evt) => {
    const datum = nearest(toLocal(evt))
    layer.replaceChildren()
    if (!datum) return hideTooltip()
    draw(layer, datum, evt)
  }
  hit.addEventListener('pointermove', move)
  hit.addEventListener('pointerdown', move)
  hit.addEventListener('pointerleave', () => {
    layer.replaceChildren()
    hideTooltip()
    clear?.()
  })
  svg.append(layer, hit)
}

const dot = (cx, cy, color) => s('circle', { cx, cy, r: 4.5, 'stroke-width': 2, style: { fill: color, stroke: css('surface') } })

/**
 * Net carry over the horizon against position size (log x). Marks the chosen size and
 * the optimum.
 */
export function sizeCurveChart({ points: all, notional, best, maxProfitable, width = 640, height = 240 }) {
  const f = frame(width, height, { top: 18, right: 22, bottom: 30, left: 64 })
  // Focus on the sizes that matter: up to a few times the break-even size or the chosen
  // size, not the far tail where shortfall explodes and flattens everything else.
  const reach = Math.max(notional * 2, (maxProfitable?.notional ?? 0) * 3)
  const points = all.filter((p, i) => i < 2 || p.notional <= reach)
  const xs = points.map((p) => p.notional)
  const lo = xs[0]
  const hi = xs[xs.length - 1]
  const lx = (v) => f.x0 + ((Math.log(v) - Math.log(lo)) / (Math.log(hi) - Math.log(lo) || 1)) * (f.x1 - f.x0)
  const nets = points.map((p) => p.netUsd)
  const { ticks, lo: ylo, hi: yhi } = niceTicks(Math.min(0, ...nets), Math.max(0, ...nets), 4)
  const y = (v) => f.y0 - ((v - ylo) / (yhi - ylo)) * (f.y0 - f.y1)
  const { svg } = f
  svg.setAttribute('aria-label', 'Netto-Ertrag über die Haltedauer in Abhängigkeit der Positionsgröße')

  yGrid(svg, f, ticks, y, (v) => fmt.usd(v, { axis: true }))
  xLabels(svg, f, logTicks(lo, hi), lx, (v) => fmt.usd(v, { axis: true }), isPow10)

  const d = points.map((p, i) => `${i ? 'L' : 'M'}${lx(p.notional).toFixed(1)},${y(p.netUsd).toFixed(1)}`).join('')
  svg.append(s('path', { d, fill: 'none', 'stroke-width': 2, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', style: { stroke: css('net') } }))

  if (notional >= lo && notional <= hi) {
    const xx = lx(notional)
    const left = xx > (f.x0 + f.x1) / 2
    svg.append(s('line', { x1: xx, x2: xx, y1: f.y1, y2: f.y0, 'stroke-width': 1, style: { stroke: css('muted') } }))
    svg.append(s('text', { x: xx + (left ? -5 : 5), y: f.y0 - 6, 'text-anchor': left ? 'end' : 'start' }, 'Deine Größe'))
  } else if (notional > hi) {
    // The books cannot fill the chosen size: the curve ends where the depth ends.
    svg.append(s('line', { class: 'grid', x1: f.x1, x2: f.x1, y1: f.y1, y2: f.y0 }))
    svg.append(s('text', { x: f.x1 - 4, y: f.y0 - 6, 'text-anchor': 'end' }, `Buchende – ${fmt.usd(notional)} passt nicht`))
  }
  if (best) {
    const bx = lx(best.notional)
    const by = y(best.netUsd)
    svg.append(dot(bx, by, css('net')))
    const right = bx > (f.x0 + f.x1) / 2
    svg.append(s('text', { class: 'label-strong', x: bx + (right ? -10 : 10), y: by - 10, 'text-anchor': right ? 'end' : 'start' },
      `Optimum ${fmt.usd(best.notional)} → ${fmt.usd(best.netUsd, { sign: true })}`))
  }

  hover(svg, f, {
    nearest: (px) => {
      let bestI = -1
      let bestD = Infinity
      points.forEach((p, i) => {
        const dd = Math.abs(lx(p.notional) - px)
        if (dd < bestD) {
          bestD = dd
          bestI = i
        }
      })
      return points[bestI]
    },
    draw: (layer, p, evt) => {
      const xx = lx(p.notional)
      layer.append(s('line', { x1: xx, x2: xx, y1: f.y1, y2: f.y0, 'stroke-width': 1, style: { stroke: css('muted') } }))
      layer.append(dot(xx, y(p.netUsd), css('net')))
      showTooltip(evt, `Größe ${fmt.usd(p.notional)} je Leg`, [
        { label: 'Netto', value: fmt.usd(p.netUsd, { sign: true }), color: css('net') },
        { label: 'Kosten Ein + Aus', value: `${fmt.bps(p.costBps)} bps` },
        { label: 'Netto-APR', value: fmt.pct(p.netApr, { sign: true }) },
        { label: 'Funding p.a. bei dieser Größe', value: fmt.pct(p.fundingApr, { sign: true }) },
      ])
    },
  })
  return svg
}

/** Cumulative depth (y, $) against distance from mid (x, bps) for both entry sides. */
export function depthChart({ sides, notional, width = 640, height = 240 }) {
  const f = frame(width, height, { top: 18, right: 18, bottom: 30, left: 64 })
  const curves = sides.map((side) => {
    let cum = 0
    const pts = [{ d: 0, cum: 0 }]
    for (const { px, sz } of side.levels) {
      const d = (Math.abs(px - side.mid) / side.mid) * 1e4
      pts.push({ d, cum })
      cum += px * sz
      pts.push({ d, cum })
    }
    return { ...side, pts }
  })
  // Show enough of the book to fill twice the chosen size, but no more than is visible.
  const reach = (c) => c.pts.find((p) => p.cum >= notional * 2)?.d ?? c.pts[c.pts.length - 1].d
  const xmax = Math.max(1, ...curves.map(reach)) * 1.05
  // Scale to the chosen size: what matters is where each curve crosses it.
  const ymax = Math.min(notional * 3, Math.max(notional * 1.25, ...curves.map((c) => (c.pts.filter((p) => p.d <= xmax).pop() ?? { cum: 0 }).cum)))
  const xt = niceTicks(0, xmax, 5)
  const yt = niceTicks(0, ymax, 4)
  const x = (v) => f.x0 + (v / xt.hi) * (f.x1 - f.x0)
  const y = (v) => f.y0 - (v / yt.hi) * (f.y0 - f.y1)
  const { svg } = f
  svg.setAttribute('aria-label', 'Kumulierte Orderbuchtiefe nach Abstand vom Mid')

  yGrid(svg, f, yt.ticks, y, (v) => fmt.usd(v, { axis: true }))
  xLabels(svg, f, xt.ticks, x, (v) => `${fmt.bps(v, { digits: v < 10 && xt.hi < 10 ? 1 : 0 })} bps`)

  const clip = (pts) => {
    const out = []
    for (const p of pts) {
      if (p.d > xt.hi) {
        out.push({ d: xt.hi, cum: out.length ? out[out.length - 1].cum : 0 })
        break
      }
      out.push(p)
    }
    return out
  }
  for (const c of curves) {
    let pts = clip(c.pts)
    // A book deeper than the y-range leaves through the top edge rather than drawing a
    // fake plateau along it; an arrow says the depth keeps going.
    const over = pts.findIndex((p) => p.cum > yt.hi)
    if (over > 0) pts = [...pts.slice(0, over), { d: pts[over].d, cum: yt.hi }]
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.d).toFixed(1)},${y(p.cum).toFixed(1)}`).join('')
    const area = `${line}L${x(pts[pts.length - 1].d).toFixed(1)},${f.y0}L${f.x0},${f.y0}Z`
    svg.append(s('path', { d: area, stroke: 'none', style: { fill: css(`${c.key}-wash`) } }))
    svg.append(s('path', { d: line, fill: 'none', 'stroke-width': 2, 'stroke-linejoin': 'round', style: { stroke: css(c.key) } }))
    if (over > 0) svg.append(s('text', { x: x(pts[pts.length - 1].d) + 4, y: f.y1 + 10 }, '↑'))
  }
  const ny = y(notional)
  svg.append(s('line', { x1: f.x0, x2: f.x1, y1: ny, y2: ny, 'stroke-width': 1, style: { stroke: css('muted') } }))
  svg.append(s('text', { x: f.x0 + 6, y: ny - 6 }, `Deine Größe ${fmt.usd(notional)}`))

  const valueAt = (c, d) => {
    let cum = 0
    for (const p of c.pts) {
      if (p.d > d) break
      cum = p.cum
    }
    return cum
  }
  hover(svg, f, {
    nearest: (px) => {
      const d = ((px - f.x0) / (f.x1 - f.x0)) * xt.hi
      return d >= 0 && d <= xt.hi ? d : null
    },
    draw: (layer, d, evt) => {
      const xx = x(d)
      layer.append(s('line', { x1: xx, x2: xx, y1: f.y1, y2: f.y0, 'stroke-width': 1, style: { stroke: css('muted') } }))
      showTooltip(evt, `bis ${fmt.bps(d)} bps vom Mid`, curves.map((c) => ({ label: c.label, value: fmt.usd(valueAt(c, d)), color: css(c.key) })))
    },
  })
  return svg
}

/** Hourly funding as APR bars around zero, with the window average as a line. */
export function fundingChart({ history, average, width = 640, height = 200 }) {
  const f = frame(width, height, { top: 18, right: 18, bottom: 30, left: 56 })
  const aprs = history.map((h) => h.rate * 24 * 365)
  const { ticks, lo, hi } = niceTicks(Math.min(0, ...aprs), Math.max(0, ...aprs), 4)
  const y = (v) => f.y0 - ((v - lo) / (hi - lo)) * (f.y0 - f.y1)
  const n = history.length
  const slot = (f.x1 - f.x0) / Math.max(1, n)
  const barW = Math.max(1, slot - (slot > 3 ? 1 : 0))
  const { svg } = f
  svg.setAttribute('aria-label', 'Stündliches Funding als Jahresrate')

  yGrid(svg, f, ticks, y, (v) => fmt.pct(v, { digits: 0 }))
  const zero = y(0)
  history.forEach((h, i) => {
    const v = aprs[i]
    const top = Math.min(y(v), zero)
    const ht = Math.max(1, Math.abs(y(v) - zero))
    svg.append(s('rect', { x: f.x0 + i * slot, y: top, width: barW, height: ht, rx: barW > 4 ? 1.5 : 0, style: { fill: css(v >= 0 ? 'pos' : 'neg') } }))
  })
  // Day labels at UTC midnight, thinned so they never run together on a narrow chart.
  const everyDays = Math.max(1, Math.ceil(44 / (slot * 24)))
  history.forEach((h, i) => {
    const d = new Date(h.time)
    if (d.getUTCHours() === 0 && i > 2 && i < n - 3 && Math.floor(h.time / 86_400_000) % everyDays === 0) {
      svg.append(s('text', { x: f.x0 + i * slot, y: f.y0 + 18, 'text-anchor': 'middle' }, `${d.getUTCDate()}.${d.getUTCMonth() + 1}.`))
    }
  })
  if (average != null) {
    const ay = y(average * 24 * 365)
    svg.append(s('line', { x1: f.x0, x2: f.x1, y1: ay, y2: ay, 'stroke-width': 2, style: { stroke: css('text-2') } }))
    svg.append(s('text', { class: 'label-strong', x: f.x1, y: ay - 6, 'text-anchor': 'end' }, `Ø ${fmt.pct(average * 24 * 365)}`))
  }

  hover(svg, f, {
    nearest: (px) => history[Math.min(n - 1, Math.max(0, Math.floor((px - f.x0) / slot)))],
    draw: (layer, h, evt) => {
      const i = history.indexOf(h)
      layer.append(s('rect', { x: f.x0 + i * slot - 1, y: f.y1, width: barW + 2, height: f.y0 - f.y1, opacity: 0.06, style: { fill: css('text') } }))
      const when = new Date(h.time).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
      showTooltip(evt, when, [
        { label: 'Funding p.a.', value: fmt.pct(h.rate * 24 * 365, { sign: true }), color: css(h.rate >= 0 ? 'pos' : 'neg') },
        { label: 'je Stunde', value: fmt.rate(h.rate) },
      ])
    },
  })
  return svg
}
