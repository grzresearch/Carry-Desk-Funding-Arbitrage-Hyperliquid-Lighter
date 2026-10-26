// Minimal element builders. Children are appended as text nodes unless they already
// are nodes, so strings from the API can never inject markup.

const SVG_NS = 'http://www.w3.org/2000/svg'

function build(el, attrs, children) {
  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value == null || value === false) continue
    if (key === 'class') el.setAttribute('class', value)
    else if (key === 'style' && typeof value === 'object') {
      for (const [prop, v] of Object.entries(value)) el.style.setProperty(prop, v)
    } else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value)
    else el.setAttribute(key, value === true ? '' : value)
  }
  for (const child of children.flat(Infinity)) {
    if (child == null || child === false) continue
    el.append(child instanceof Node ? child : document.createTextNode(String(child)))
  }
  return el
}

export function h(tag, attrs, ...children) {
  return build(document.createElement(tag), attrs, children)
}

export function s(tag, attrs, ...children) {
  return build(document.createElementNS(SVG_NS, tag), attrs, children)
}

export const ICONS = {
  check: 'M4 10.5l3.5 3.5L16 5.5',
  cross: 'M5.5 5.5l9 9M14.5 5.5l-9 9',
  warn: 'M10 3l8 14H2L10 3zm0 5v4m0 2.5v.5',
  dot: 'M10 6a4 4 0 1 1 0 8 4 4 0 0 1 0-8z',
  clock: 'M10 3a7 7 0 1 1 0 14 7 7 0 0 1 0-14zm0 3v4l3 2',
  info: 'M10 3a7 7 0 1 1 0 14 7 7 0 0 1 0-14zm0 6v5m0-8v.5',
  swap: 'M4 7h11l-3-3M16 13H5l3 3',
}

export function icon(name) {
  return s('svg', { viewBox: '0 0 20 20', 'aria-hidden': 'true' },
    s('path', { d: ICONS[name], fill: 'none', stroke: 'currentColor', 'stroke-width': 1.8, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))
}

/** Replace all children of `el`. */
export function mount(el, ...children) {
  el.replaceChildren(...children.flat(Infinity).filter((c) => c != null && c !== false))
  return el
}

// ── tooltip ──────────────────────────────────────────────────

let tip = null

/**
 * @param {PointerEvent|MouseEvent|{clientX:number, clientY:number}} at
 * @param {string} title
 * @param {{ label: string, value: string, color?: string }[]} rows
 */
export function showTooltip(at, title, rows) {
  tip ??= document.getElementById('tooltip')
  if (!tip) return
  mount(tip,
    h('div', { class: 'tt-title' }, title),
    rows.map((r) => h('div', { class: 'tt-row' },
      h('span', { class: 'tt-key' }, r.color ? h('i', { style: { background: r.color } }) : null, r.label),
      h('b', null, r.value))))
  tip.hidden = false
  const pad = 14
  const { innerWidth: vw, innerHeight: vh } = window
  const rect = tip.getBoundingClientRect()
  let x = at.clientX + pad
  let y = at.clientY + pad
  if (x + rect.width > vw - 8) x = at.clientX - rect.width - pad
  if (y + rect.height > vh - 8) y = at.clientY - rect.height - pad
  tip.style.left = `${Math.max(8, x)}px`
  tip.style.top = `${Math.max(8, y)}px`
}

export function hideTooltip() {
  tip ??= document.getElementById('tooltip')
  if (tip) tip.hidden = true
}
