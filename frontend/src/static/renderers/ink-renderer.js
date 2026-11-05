// @ts-check
// InkRenderer — draws a Digital Note page (docs/ink-contract.md §Rendering) as
// SVG markup. PM-free and DOM-free: a page in the export shape in, a string
// out, and the same page always yields the same bytes. Stroke outlines come
// from perfect-freehand, read through the vendor seam.
//
// SVG user space is a fixed grid of INK_RULES.grid units across the page, with
// the viewBox carrying the page to any output size. Outlines are computed in
// that grid because perfect-freehand's thresholds are absolute, not relative to
// the stroke size.

import { T } from './vendor-libs.js'
import { esc } from './html-escape.js'
import { ContractViolation } from '../contract/sieve-block.js'

/**
 * @typedef {object} InkPoint
 * @property {number} x page units, 0..1 across the page width
 * @property {number} y page units, 0..1/pageAspect down the page
 * @property {number} pressure 0..1
 * @property {number} [tMillis] ms since the stroke started
 * @property {number} [tiltX] degrees; no rendering rule reads it
 * @property {number} [tiltY] degrees; no rendering rule reads it
 */

/**
 * @typedef {object} InkStroke
 * @property {string} id
 * @property {'pen'|'pencil'} tool
 * @property {1|2|3} widthClass
 * @property {number} [startMillis]
 * @property {InkPoint[]} points
 */

/**
 * A template as the note header carries it: an id and its params, lengths in
 * page units. Ids other than `blank`, `ruled`, `grid` and `dots` draw as `blank`.
 * @typedef {{id: string, params?: {spacing?: number, margin?: number}}} InkTemplate
 */

/**
 * A rectangle of the page plane in page units, `x0 < x1`, `y0 < y1`. The origin
 * may be negative: marks sit on the plane's own multiples, not the window's.
 * @typedef {{x0: number, y0: number, x1: number, y1: number}} InkWindow
 */

/**
 * A page as SieveInk exports it: the note header and the page's strokes.
 * @typedef {object} InkPage
 * @property {{pageAspect: number, template?: InkTemplate|null, [field: string]: any}} note
 * @property {InkStroke[]} strokes
 */

/**
 * One stroke's committed markup, split by the layer each part is appended to:
 * `pen` goes in the `pen` layer; `bands[i]` goes in layer `b{i}`. Parts a
 * stroke does not use are ''.
 * @typedef {Readonly<{pen: string, bands: ReadonlyArray<string>}>} InkStrokeMarkup
 */

/** @typedef {(points: number[][], options: object) => number[][]} OutlineFn */

/**
 * The rendering rules. Widths and the nominal class widths are in page units
 * (page width = 1); `grid` is the SVG user-space width of a page, and the
 * tone pattern's sizes are in grid units.
 */
export const INK_RULES = Object.freeze({
  grid: 1404,
  nominal: Object.freeze({ 1: 0.0012, 2: 0.0024, 3: 0.0045 }),
  pen: Object.freeze({
    floor: 0.002991, slope: 0.76, referencePressure: 0.95,
    thinning: 0.75, smoothing: 0.5, streamline: 0.3,
  }),
  pencil: Object.freeze({
    floor: 0.002991, slope: 1.09, saturation: 0.8, exponent: 0.8,
    chunk: 10, smoothing: 0.5, streamline: 0.2, liveFill: '#808080',
  }),
  tone: Object.freeze({
    floor: 0.10, gain: 0.95, exponent: 1.3,
    /** fraction of a band's area its dots cover, lightest first */
    keep: Object.freeze([0.12, 0.22, 0.34, 0.48, 0.64, 0.82, 0.96]),
    /** a band whose keep fraction reaches this is filled solid */
    solid: 0.96,
    /** dot pattern: tile side and dot radius in grid units, PRNG seed of band 0 */
    tile: 96, dotRadius: 0.95, seed: 1000,
    /** dot count multiplier making up the area lost where random dots overlap */
    overlap: 1.15,
  }),
  /** template marks: colour, line width and dot radius, in grid units */
  ruling: Object.freeze({ color: '#888888', line: 1, dotRadius: 3 }),
  /** outline vertices are dropped while within this many grid units of the simplified outline */
  simplify: 0.25,
})

/** Layer names, in paint order: the ruling, the pen layer, the seven tone bands, the live layer. */
export const INK_LAYERS = Object.freeze([
  'ruling', 'pen', ...INK_RULES.tone.keep.map((_, i) => `b${i}`), 'live',
])

export class InkRenderer {
  /** @type {OutlineFn|undefined} */ #outline
  /** @type {string|undefined} */ #defs

  /**
   * @param {{getStroke?: OutlineFn}} [options] perfect-freehand's getStroke;
   *   defaults to the bundled one, read when the first stroke is drawn
   */
  constructor(options = {}) {
    this.#outline = options.getStroke
  }

  /**
   * The drawn width, in page units, of a stroke at a pressure.
   * @param {'pen'|'pencil'} tool
   * @param {number} widthClass 1, 2 or 3
   * @param {number} pressure 0..1, clamped
   * @returns {number}
   */
  widthFor(tool, widthClass, pressure) {
    const nominal = INK_RULES.nominal[/** @type {1|2|3} */ (widthClass)]
    if (nominal === undefined) throw new ContractViolation(`ink: unknown width class ${widthClass}`)
    const p = Math.min(1, Math.max(0, pressure))
    if (tool === 'pen') {
      const { floor, slope, thinning, referencePressure } = INK_RULES.pen
      return (floor + slope * nominal) * InkRenderer.#thinned(thinning, p) / InkRenderer.#thinned(thinning, referencePressure)
    }
    if (tool === 'pencil') {
      const { floor, slope, saturation, exponent } = INK_RULES.pencil
      return (floor + slope * nominal) * Math.pow(Math.min(1, p / saturation), exponent)
    }
    throw new ContractViolation(`ink: unknown tool ${tool}`)
  }

  /**
   * The whole page as a standalone SVG document.
   * @param {InkPage} page
   * @returns {string}
   */
  renderPage(page) {
    const aspect = page?.note?.pageAspect
    if (!(aspect > 0) || !Array.isArray(page.strokes)) {
      throw new ContractViolation('ink: a page needs note.pageAspect > 0 and a strokes array')
    }
    const width = INK_RULES.grid
    const height = Math.round(width / aspect)
    /** @type {string[][]} */
    const layers = INK_LAYERS.map(() => [])
    const pen = INK_LAYERS.indexOf('pen')
    for (const stroke of page.strokes) {
      const markup = this.renderStroke(stroke)
      if (markup.pen) layers[pen].push(markup.pen)
      markup.bands.forEach((part, i) => { if (part) layers[pen + 1 + i].push(part) })
    }
    const ruling = this.renderRuling(page.note.template, { x0: 0, y0: 0, x1: 1, y1: 1 / aspect })
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
      `<defs>${this.#patternDefs()}</defs>`,
      '<rect width="100%" height="100%" fill="#fff"/>',
      ...INK_LAYERS.map((name, i) => (name === 'ruling' ? ruling : InkRenderer.#layer(name, layers[i]))),
      '</svg>',
    ].join('\n')
  }

  /**
   * The `ruling` group: a template's marks over a window of the plane.
   *
   * A mark sits at `round(p · grid)` of its own position p = k·spacing (the
   * margin line at margin + k) for every integer k (and l), so it is where it
   * is whatever the window. A mark is drawn when its extent overlaps the
   * window's interior; lines are clipped to the window. Horizontal lines,
   * vertical lines and dots are one `<path>` each, filled from the group:
   * a line is `M{x} {y}h{w}v1h-{w}z` (vertical: `M{x} {y}v{h}h1v-{h}z`) and a
   * dot is `M{cx} {cy}m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0z`.
   *
   * A null template, `blank`, and a missing or zero spacing draw no marks; the
   * group is always present. An id that is not a known template draws as
   * `blank` and the group carries `data-ink-template="unknown"`.
   * @param {InkTemplate|null|undefined} template
   * @param {InkWindow} window
   * @returns {string} the group's markup
   */
  renderRuling(template, window) {
    const { color, dotRadius: r } = INK_RULES.ruling
    const known = !!template && ['blank', 'ruled', 'grid', 'dots'].includes(template.id)
    const attrs = ` fill="${color}"` + (template && !known ? ' data-ink-template="unknown"' : '')
    const spacing = Number(template?.params?.spacing)
    if (!template || !known || !(spacing > 0)) return InkRenderer.#layer('ruling', [], attrs)
    const g = INK_RULES.grid
    const [x0, y0, x1, y1] = [window.x0 * g, window.y0 * g, window.x1 * g, window.y1 * g]
    const w = InkRenderer.#grid(x1 - x0)
    const h = InkRenderer.#grid(y1 - y0)
    const margin = Number(template.params?.margin)
    /** @type {string[]} */
    const paths = []
    if (template.id === 'dots') {
      const cols = this.#positions(spacing, 0, x0, x1, r, r)
      const rows = this.#positions(spacing, 0, y0, y1, r, r)
      paths.push(rows.flatMap((y) => cols.map((x) => `M${x} ${y}m-${r} 0a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0-${2 * r} 0z`)).join(''))
    } else {
      const line = INK_RULES.ruling.line
      const verticals = template.id === 'grid' ? this.#positions(spacing, 0, x0, x1, 0, line)
        : margin > 0 ? this.#positions(1, margin, x0, x1, 0, line) : []
      paths.push(this.#positions(spacing, 0, y0, y1, 0, line).map((y) => `M${InkRenderer.#grid(x0)} ${y}h${w}v${line}h-${w}z`).join(''))
      paths.push(verticals.map((x) => `M${x} ${InkRenderer.#grid(y0)}v${h}h${line}v-${h}z`).join(''))
    }
    return InkRenderer.#layer('ruling', paths.filter(Boolean).map((d) => `<path d="${d}"/>`), attrs)
  }

  /**
   * Grid positions `round((offset + k·step) · grid)` for every integer k whose
   * mark, spanning `before` to `after` grid units either side of the position,
   * overlaps the open interval (lo, hi).
   * @param {number} step page units @param {number} offset page units
   * @param {number} lo grid units @param {number} hi grid units
   * @param {number} before @param {number} after
   * @returns {number[]} ascending
   */
  #positions(step, offset, lo, hi, before, after) {
    const g = INK_RULES.grid
    const out = []
    const to = Math.ceil((hi / g - offset) / step) + 1
    for (let k = Math.floor((lo / g - offset) / step) - 1; k <= to; k++) {
      const c = Math.round((offset + k * step) * g)
      if (c + after > lo && c - before < hi) out.push(c)
    }
    return out
  }

  /**
   * One stroke's committed markup: a pen stroke is one `<path>`; a pencil
   * stroke is a `<g data-stroke>` of chunk paths per tone band it touches.
   * @param {InkStroke} stroke
   * @returns {InkStrokeMarkup}
   */
  renderStroke(stroke) {
    /** @type {string[]} */
    const bands = INK_RULES.tone.keep.map(() => '')
    if (stroke.tool === 'pen') {
      return Object.freeze({ pen: this.#penPath(stroke), bands: Object.freeze(bands) })
    }
    /** @type {string[][]} */
    const byBand = bands.map(() => [])
    for (const chunk of this.#pencilChunks(stroke)) {
      byBand[chunk.band].push(`<path d="${chunk.d}"/>`)
    }
    byBand.forEach((paths, i) => {
      if (paths.length) bands[i] = `<g data-stroke="${esc(stroke.id)}">${paths.join('')}</g>`
    })
    return Object.freeze({ pen: '', bands: Object.freeze(bands) })
  }

  /**
   * A stroke still under the pen, as one `<path>` for the `live` layer: a pen
   * stroke exactly as it will commit; a pencil stroke as its chunk outlines in
   * plain grey, with no tone.
   * @param {InkStroke} stroke the points received so far
   * @returns {string} '' while there are too few points to draw
   */
  renderLiveStroke(stroke) {
    if (stroke.tool === 'pen') return this.#penPath(stroke)
    const d = this.#pencilChunks(stroke).map((chunk) => chunk.d).join('')
    if (!d) return ''
    return `<path data-stroke="${esc(stroke.id)}" fill="${INK_RULES.pencil.liveFill}" d="${d}"/>`
  }

  /** @param {InkStroke} stroke @returns {string} */
  #penPath(stroke) {
    const { thinning, smoothing, streamline } = INK_RULES.pen
    const size = this.widthFor('pen', stroke.widthClass, 0.5) * INK_RULES.grid
    const d = this.#pathData(this.#strokeOutline(stroke.points, {
      size, thinning, smoothing, streamline, simulatePressure: false, last: true,
    }))
    return d ? `<path data-stroke="${esc(stroke.id)}" d="${d}"/>` : ''
  }

  /**
   * Fixed-length runs of a pencil stroke, each overlapping its neighbours by a
   * point, at the run's mean pressure and in the band that tone selects.
   * @param {InkStroke} stroke
   * @returns {{band: number, d: string}[]}
   */
  #pencilChunks(stroke) {
    const { chunk, smoothing, streamline } = INK_RULES.pencil
    const caps = { taper: 0, cap: true }
    const points = stroke.points
    const chunks = []
    for (let i = 0; i < points.length; i += chunk) {
      const run = points.slice(Math.max(0, i - 1), i + chunk + 1)
      if (run.length < 2) continue
      const pressure = run.reduce((sum, q) => sum + q.pressure, 0) / run.length
      const size = this.widthFor('pencil', stroke.widthClass, pressure) * INK_RULES.grid
      const d = this.#pathData(this.#strokeOutline(run, {
        size, thinning: 0, smoothing, streamline, simulatePressure: false, last: true, start: caps, end: caps,
      }))
      if (d) chunks.push({ band: InkRenderer.#band(pressure), d })
    }
    return chunks
  }

  /**
   * @param {InkPoint[]} points @param {object} options
   * @returns {number[][]} outline vertices in grid units
   */
  #strokeOutline(points, options) {
    const outline = this.#outline ?? T.getStroke
    if (typeof outline !== 'function') throw new ContractViolation('ink: perfect-freehand getStroke is not loaded')
    this.#outline = outline
    const g = INK_RULES.grid
    return outline(points.map((q) => [q.x * g, q.y * g, q.pressure]), options)
  }

  /**
   * Closed path data for an outline: a quadratic through the midpoints of
   * successive vertices, each vertex its control point. Vertices are thinned
   * by Douglas–Peucker and snapped to a 0.2 grid so every midpoint lands on
   * the 0.1 grid and the implied `t` controls stay exact; coordinates after the
   * first are relative, in that 0.1 grid.
   * @param {number[][]} outline
   * @returns {string} '' for fewer than three distinct vertices
   */
  #pathData(outline) {
    /** @type {number[][]} vertices in tenths of a grid unit */
    const v = []
    for (const [x, y] of InkRenderer.#simplified(outline, INK_RULES.simplify)) {
      const q = [Math.round(x * 5) * 2, Math.round(y * 5) * 2]
      const last = v[v.length - 1]
      if (!last || last[0] !== q[0] || last[1] !== q[1]) v.push(q)
    }
    if (v.length < 3) return ''
    const mid = (/** @type {number} */ i) => [(v[i][0] + v[i + 1][0]) / 2, (v[i][1] + v[i + 1][1]) / 2]
    let prev = mid(0)
    let d = `M${InkRenderer.#tenths(v[0][0])} ${InkRenderer.#tenths(v[0][1])}q0 0${InkRenderer.#pair(prev[0] - v[0][0], prev[1] - v[0][1])}t`
    for (let i = 1; i < v.length - 1; i++) {
      const m = mid(i)
      d += InkRenderer.#pair(m[0] - prev[0], m[1] - prev[1])
      prev = m
    }
    return d + 'z'
  }

  /**
   * The seven tone-band patterns, built once: band i tiles a square of round
   * dots of radius `dotRadius` at positions drawn from a PRNG seeded `seed + i`,
   * as many as cover the band's keep fraction of the tile; a band at `solid` or
   * above is a filled tile. Each dot is a zero-length subpath under a round cap,
   * which every SVG renderer draws as a disc of the stroke's width.
   * @returns {string}
   */
  #patternDefs() {
    if (this.#defs !== undefined) return this.#defs
    const { keep, solid, tile, dotRadius, seed, overlap } = INK_RULES.tone
    this.#defs = keep.map((fraction, i) => {
      const open = `<pattern id="ink-b${i}" patternUnits="userSpaceOnUse" width="${tile}" height="${tile}">`
      if (fraction >= solid) return `${open}<rect width="${tile}" height="${tile}"/></pattern>`
      const count = Math.round(fraction * tile * tile / (Math.PI * dotRadius * dotRadius) * overlap)
      const next = InkRenderer.#mulberry32(seed + i)
      let d = ''
      for (let k = 0; k < count; k++) d += `M${(next() * tile).toFixed(1)} ${(next() * tile).toFixed(1)}h0`
      return `${open}<path stroke="#000" stroke-width="${2 * dotRadius}" stroke-linecap="round" d="${d}"/></pattern>`
    }).join('')
    return this.#defs
  }

  /** @param {number} seed @returns {() => number} mulberry32: a deterministic stream in [0, 1) */
  static #mulberry32(seed) {
    let t = seed >>> 0
    return () => {
      t = (t + 0x6D2B79F5) >>> 0
      let x = Math.imul(t ^ (t >>> 15), 1 | t)
      x ^= x + Math.imul(x ^ (x >>> 7), 61 | x)
      return ((x ^ (x >>> 14)) >>> 0) / 4294967296
    }
  }

  /** @param {number} thinning @param {number} p @returns {number} perfect-freehand's radius factor */
  static #thinned(thinning, p) { return 0.5 - thinning * (0.5 - p) }

  /** @param {number} pressure @returns {number} the tone band for a pressure */
  static #band(pressure) {
    const { floor, gain, exponent, keep } = INK_RULES.tone
    const dark = Math.min(1, floor + gain * Math.pow(pressure, exponent))
    let band = 0
    while (band < keep.length - 1 && dark > keep[band]) band++
    return band
  }

  /** @param {number} n grid units @returns {string} n to one decimal, no redundant zeros */
  static #grid(n) { return String(Math.round(n * 10) / 10) }

  /** @param {string} name @param {string[]} parts @param {string} [attrs] the group's attributes after data-ink; default: its fill @returns {string} */
  static #layer(name, parts, attrs) {
    const fill = attrs ?? (name === 'live' ? '' : name === 'pen' ? ' fill="#000"' : ` fill="url(#ink-${name})"`)
    return `<g data-ink="${name}"${fill}>${parts.length ? '\n' + parts.join('\n') + '\n' : ''}</g>`
  }

  /**
   * Douglas–Peucker over an open polyline, keeping both ends.
   * @param {number[][]} points @param {number} tolerance
   * @returns {number[][]}
   */
  static #simplified(points, tolerance) {
    if (points.length < 3) return points
    const keep = new Uint8Array(points.length)
    keep[0] = keep[points.length - 1] = 1
    const spans = [[0, points.length - 1]]
    while (spans.length) {
      const [a, b] = /** @type {number[]} */ (spans.pop())
      const [ax, ay] = points[a]
      const dx = points[b][0] - ax
      const dy = points[b][1] - ay
      const len = Math.hypot(dx, dy)
      let worst = -1
      let far = 0
      for (let i = a + 1; i < b; i++) {
        const px = points[i][0] - ax
        const py = points[i][1] - ay
        const dist = len ? Math.abs(px * dy - py * dx) / len : Math.hypot(px, py)
        if (dist > far) { far = dist; worst = i }
      }
      if (worst >= 0 && far > tolerance) {
        keep[worst] = 1
        spans.push([a, worst], [worst, b])
      }
    }
    return points.filter((_, i) => keep[i])
  }

  /** @param {number} dx @param {number} dy @returns {string} a relative pair in tenths, minimally separated */
  static #pair(dx, dy) {
    const x = InkRenderer.#tenths(dx)
    const y = InkRenderer.#tenths(dy)
    return (x.startsWith('-') ? '' : ' ') + x + (y.startsWith('-') ? '' : ' ') + y
  }

  /** @param {number} n an integer count of tenths @returns {string} n/10 with no redundant zeros */
  static #tenths(n) {
    const sign = n < 0 ? '-' : ''
    const a = Math.abs(n)
    const whole = Math.floor(a / 10)
    const frac = a % 10
    return sign + (frac ? `${whole || ''}.${frac}` : String(whole))
  }
}
