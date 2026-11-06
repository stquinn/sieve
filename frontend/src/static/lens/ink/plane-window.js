// @ts-check
// The window an unbounded page is shown through: a rectangle of the plane,
// placed by its top-left and its zoom, whose shape is the note's page aspect
// unless it is given another. Zoom 1 is one sheet's width across the window,
// which at the page aspect is the tablet's own view; zoom 2 shows half a sheet's
// width. It also holds the extent of every committed stroke, which framing all
// ink and finding ink outside the window are computed from.
//
// Framing all ink is a state, not a move: from fitAll until the window is next
// placed, panned or zoomed, the window is `fitting`, and follow() frames the ink
// again whenever what it should frame has changed.

/** @typedef {import('../../renderers/ink-renderer.js').InkWindow} InkWindow */

/** Which edge of the window a stretch of the plane lies beyond. */
export const WindowEdge = Object.freeze({ LEFT: 'left', RIGHT: 'right', TOP: 'top', BOTTOM: 'bottom' })

/** @typedef {typeof WindowEdge[keyof typeof WindowEdge]} WindowEdgeName */

export class PlaneWindow {
  /** The closest zoom: a quarter of a sheet's width across the window. */
  static MAX_ZOOM = 4

  /** Space left round the ink when it is framed, in page units. */
  static MARGIN = 0.05

  /** @type {number} page width / page height */ #aspect
  /** @type {number} window width / window height */ #shape
  /** @type {number} */ #x0 = 0
  /** @type {number} */ #y0 = 0
  /** @type {number} */ #zoom = 1
  /** @type {boolean} whether the window frames all ink and follows it */ #fitting = false
  /** @type {InkWindow|null} the box last framed, margin included; null for the sheet at the origin */ #framed = null
  /** @type {Map<string, InkWindow>} each committed stroke's extent, by stroke id */ #extents = new Map()
  /** @type {InkWindow|null|undefined} the union of the extents; undefined while out of date */ #ink = null
  /** @type {{x: number, y: number}|null} the top-left of the tablet's view; null until one is heard */ #tablet = null
  /** @type {boolean} whether #tablet came from the tablet's own VIEW */ #viewHeard = false

  /** @param {number} aspect the note's pageAspect, > 0 */
  constructor(aspect) {
    this.#aspect = aspect
    this.#shape = aspect
  }

  /** @returns {number} the note's page aspect */
  get aspect() { return this.#aspect }

  /** @returns {number} the window's width over its height */
  get shape() { return this.#shape }

  /**
   * Gives the window another shape, keeping its zoom: one fitting is framed
   * again round what it framed, any other keeps its centre.
   * @param {number} shape width over height, > 0
   */
  set shape(shape) {
    if (!(shape > 0) || shape === this.#shape) return
    const w = this.window
    this.#shape = shape
    if (this.#fitting) {
      this.#frame(this.#framed)
      return
    }
    const half = 1 / this.#zoom / 2
    this.#place((w.x0 + w.x1) / 2 - half, (w.y0 + w.y1) / 2 - half / shape, this.#zoom)
  }

  /** @returns {number} */
  get zoom() { return this.#zoom }

  /** @returns {InkWindow} the part of the plane shown */
  get window() {
    const w = 1 / this.#zoom
    return Object.freeze({ x0: this.#x0, y0: this.#y0, x1: this.#x0 + w, y1: this.#y0 + w / this.#shape })
  }

  /** @returns {boolean} whether the tablet has said where its view is */
  get viewHeard() { return this.#viewHeard }

  /** @param {number} x @param {number} y the top-left of the tablet's view, as it says it */
  setView(x, y) {
    this.#tablet = { x, y }
    this.#viewHeard = true
  }

  /** Places the tablet's view at a stroke's origin, which is the view's top-left
   *  when the pen landed; ignored once the tablet has said where its view is.
   *  @param {number} x @param {number} y */
  setOrigin(x, y) {
    if (!this.#viewHeard) this.#tablet = { x, y }
  }

  /** Forgets where the tablet's view is, as when the note stops being live. */
  forgetTablet() {
    this.#tablet = null
    this.#viewHeard = false
  }

  /** Moves the window onto the tablet's view. @returns {boolean} false while none is heard */
  showTablet() {
    if (!this.#tablet) return false
    this.#place(this.#tablet.x, this.#tablet.y, 1)
    return true
  }

  /**
   * Replaces every extent with those of these strokes.
   * @param {ReadonlyArray<{id: string, points: ReadonlyArray<{x: number, y: number}>}>} strokes
   */
  setStrokes(strokes) {
    this.#extents = new Map()
    this.#ink = undefined
    for (const stroke of strokes) this.addStroke(stroke)
  }

  /** @param {{id: string, points: ReadonlyArray<{x: number, y: number}>}} stroke */
  addStroke(stroke) {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
    for (const p of stroke.points) {
      x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y)
      x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y)
    }
    if (!(x1 >= x0)) return
    this.#extents.set(stroke.id, Object.freeze({ x0, y0, x1, y1 }))
    this.#ink = undefined
  }

  /** @param {string} id */
  removeStroke(id) {
    if (this.#extents.delete(id)) this.#ink = undefined
  }

  /** @param {string} id @returns {InkWindow|undefined} */
  extentOf(id) { return this.#extents.get(id) }

  /** @returns {boolean} whether the window frames all ink, and follows it, until it is next moved */
  get fitting() { return this.#fitting }

  /**
   * Frames all ink and `also` with a margin, or shows the sheet at the origin
   * when there is neither, and is fitting from now on.
   * @param {InkWindow|null} [also] more of the plane to frame, as the stroke under the pen
   */
  fitAll(also = null) {
    this.#frame(this.#fitBox(also))
  }

  /**
   * While fitting, frames all ink and `also` again when that is not what the
   * window frames; otherwise does nothing.
   * @param {InkWindow|null} [also] more of the plane to frame, as the stroke under the pen
   * @returns {boolean} whether the window moved
   */
  follow(also = null) {
    if (!this.#fitting) return false
    const box = this.#fitBox(also)
    if (PlaneWindow.#sameBox(box, this.#framed)) return false
    this.#frame(box)
    return true
  }

  /** @param {InkWindow} box @returns {boolean} whether all of the box is in the window */
  holds(box) {
    const w = this.window
    return box.x0 >= w.x0 && box.x1 <= w.x1 && box.y0 >= w.y0 && box.y1 <= w.y1
  }

  /**
   * Puts the window's top-left at (x0, y0) at a zoom, within the zoom's limits.
   * @param {number} x0 @param {number} y0 page units @param {number} zoom
   */
  place(x0, y0, zoom) {
    this.#place(x0, y0, Math.min(PlaneWindow.MAX_ZOOM, Math.max(this.minZoom, zoom)))
  }

  /** @returns {number} the farthest zoom: all ink framed, or a sheet when that is closer */
  get minZoom() {
    const ink = this.#inkBox()
    return ink ? Math.min(1, this.#fitZoom(ink)) : 1
  }

  /** @param {number} dx @param {number} dy page units the window moves by */
  pan(dx, dy) {
    this.#place(this.#x0 + dx, this.#y0 + dy, this.#zoom)
  }

  /**
   * Zooms by a factor, within the limits, keeping the plane point (x, y) where
   * it is in the window.
   * @param {number} factor above 1 zooms in
   * @param {number} x @param {number} y a plane point, page units
   */
  zoomAbout(factor, x, y) {
    const zoom = Math.min(PlaneWindow.MAX_ZOOM, Math.max(this.minZoom, this.#zoom * factor))
    const k = this.#zoom / zoom
    this.#place(x - (x - this.#x0) * k, y - (y - this.#y0) * k, zoom)
  }

  /** @param {number} factor above 1 zooms in, about the window's centre */
  zoomBy(factor) {
    const w = this.window
    this.zoomAbout(factor, (w.x0 + w.x1) / 2, (w.y0 + w.y1) / 2)
  }

  /** @param {InkWindow} box @returns {boolean} whether any of the box is in the window */
  shows(box) {
    const w = this.window
    return box.x1 >= w.x0 && box.x0 <= w.x1 && box.y1 >= w.y0 && box.y0 <= w.y1
  }

  /**
   * The edge of the window nearest a box outside it: the side its centre lies
   * beyond along the axis it is farther along, measured in window widths and
   * heights; left or right when the two are equal.
   * @param {InkWindow} box @returns {WindowEdgeName}
   */
  edgeOf(box) {
    const w = this.window
    const dx = ((box.x0 + box.x1) - (w.x0 + w.x1)) / 2 / (w.x1 - w.x0)
    const dy = ((box.y0 + box.y1) - (w.y0 + w.y1)) / 2 / (w.y1 - w.y0)
    if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? WindowEdge.RIGHT : WindowEdge.LEFT
    return dy > 0 ? WindowEdge.BOTTOM : WindowEdge.TOP
  }

  /** @returns {InkWindow|null} */
  #inkBox() {
    if (this.#ink !== undefined) return this.#ink
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
    for (const e of this.#extents.values()) {
      x0 = Math.min(x0, e.x0); y0 = Math.min(y0, e.y0)
      x1 = Math.max(x1, e.x1); y1 = Math.max(y1, e.y1)
    }
    const m = PlaneWindow.MARGIN
    this.#ink = x1 >= x0 ? Object.freeze({ x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m }) : null
    return this.#ink
  }

  /** @param {InkWindow|null} also @returns {InkWindow|null} all ink and `also`, with a margin */
  #fitBox(also) {
    const ink = this.#inkBox()
    if (!also) return ink
    const m = PlaneWindow.MARGIN
    const more = { x0: also.x0 - m, y0: also.y0 - m, x1: also.x1 + m, y1: also.y1 + m }
    return Object.freeze(ink ? {
      x0: Math.min(ink.x0, more.x0), y0: Math.min(ink.y0, more.y0), x1: Math.max(ink.x1, more.x1), y1: Math.max(ink.y1, more.y1),
    } : more)
  }

  /** Puts the window round a box, or the sheet at the origin for none, and is fitting.
   *  @param {InkWindow|null} box */
  #frame(box) {
    if (!box) {
      this.#place(0, 0, 1)
    } else {
      const zoom = this.#fitZoom(box)
      const cx = (box.x0 + box.x1) / 2
      const cy = (box.y0 + box.y1) / 2
      this.#place(cx - 1 / (2 * zoom), cy - 1 / (2 * zoom * this.#shape), zoom)
    }
    this.#framed = box
    this.#fitting = true
  }

  /** @param {InkWindow|null} a @param {InkWindow|null} b @returns {boolean} */
  static #sameBox(a, b) {
    if (!a || !b) return a === b
    return a.x0 === b.x0 && a.y0 === b.y0 && a.x1 === b.x1 && a.y1 === b.y1
  }

  /** @param {InkWindow} box @returns {number} the zoom whose window just holds the box, at most MAX_ZOOM */
  #fitZoom(box) {
    return Math.min(PlaneWindow.MAX_ZOOM, 1 / (box.x1 - box.x0), 1 / ((box.y1 - box.y0) * this.#shape))
  }

  /** @param {number} x0 @param {number} y0 @param {number} zoom */
  #place(x0, y0, zoom) {
    this.#x0 = x0
    this.#y0 = y0
    this.#zoom = zoom
    this.#fitting = false
  }
}
