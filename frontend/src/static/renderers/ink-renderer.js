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
 * A page as SieveInk exports it: the note header and the page's strokes.
 * @typedef {object} InkPage
 * @property {{pageAspect: number, [field: string]: any}} note
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
 * (page width = 1); `grid` is the SVG user-space width of a page, and
 * `tone.baseFrequency` is per grid unit.
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
    /** fraction of stipple dots each band keeps, lightest first */
    keep: Object.freeze([0.12, 0.22, 0.34, 0.48, 0.64, 0.82, 0.96]),
    /** measured [keep fraction, threshold] pairs for the filter chain below */
    coverage: Object.freeze([
      [1.0, -0.05], [0.98, 0], [0.95, 0.04], [0.88, 0.08], [0.79, 0.12], [0.68, 0.16],
      [0.57, 0.20], [0.45, 0.25], [0.34, 0.30], [0.23, 0.36], [0.14, 0.42], [0.05, 0.55],
    ].map((pair) => Object.freeze(pair))),
    baseFrequency: 0.7, numOctaves: 2, seed: 11, slope: 40,
  }),
  /** outline vertices are dropped while within this many grid units of the simplified outline */
  simplify: 0.25,
})

/** Layer names, in paint order: the pen layer, the seven tone bands, the live layer. */
export const INK_LAYERS = Object.freeze([
  'pen', ...INK_RULES.tone.keep.map((_, i) => `b${i}`), 'live',
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
    for (const stroke of page.strokes) {
      const markup = this.renderStroke(stroke)
      if (markup.pen) layers[0].push(markup.pen)
      markup.bands.forEach((part, i) => { if (part) layers[i + 1].push(part) })
    }
    return [
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
      `<defs>${this.#filterDefs()}</defs>`,
      '<rect width="100%" height="100%" fill="#fff"/>',
      ...INK_LAYERS.map((name, i) => InkRenderer.#layer(name, layers[i])),
      '</svg>',
    ].join('\n')
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

  /** @returns {string} the seven tone-band filters, built once */
  #filterDefs() {
    if (this.#defs !== undefined) return this.#defs
    const { keep, coverage, baseFrequency, numOctaves, seed, slope } = INK_RULES.tone
    this.#defs = keep.map((fraction, i) => {
      let k = 1
      while (k < coverage.length - 1 && coverage[k][0] > fraction) k++
      const [c0, t0] = coverage[k - 1]
      const [c1, t1] = coverage[k]
      const threshold = t0 + (t1 - t0) * ((c0 - fraction) / (c0 - c1 || 1))
      return `<filter id="ink-b${i}" x="0" y="0" width="1" height="1">` +
        `<feTurbulence type="turbulence" baseFrequency="${baseFrequency}" numOctaves="${numOctaves}" seed="${seed}" result="n"/>` +
        '<feColorMatrix in="n" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 0 1" result="o"/>' +
        `<feComponentTransfer in="o" result="s"><feFuncR type="linear" slope="${slope}" intercept="${(-slope * threshold).toFixed(2)}"/></feComponentTransfer>` +
        '<feColorMatrix in="s" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  1 0 0 0 0" result="m"/>' +
        '<feComposite in="SourceGraphic" in2="m" operator="in"/></filter>'
    }).join('')
    return this.#defs
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

  /** @param {string} name @param {string[]} parts @returns {string} */
  static #layer(name, parts) {
    const band = name.startsWith('b') ? ` filter="url(#ink-${name})"` : ''
    const fill = name === 'live' ? '' : ' fill="#000"'
    return `<g data-ink="${name}"${fill}${band}>${parts.length ? '\n' + parts.join('\n') + '\n' : ''}</g>`
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
