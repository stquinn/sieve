// @ts-check
// One page of a Digital Note drawn on a white sheet in a scrolling surround: the
// renderer's SVG, the committed strokes arriving into it and the stroke under the
// pen drawn live. It asks the provider for the page it is told to show and holds
// the stroke events for it that arrive meanwhile; it chooses no page and draws no
// chrome.
//
// The SVG is built once per page shown and is then only added to and trimmed:
// a committed stroke's markup is parsed into nodes and appended to its layers, a
// removed stroke's nodes are taken out, and a live stroke's one path is swapped
// in the `live` layer. Only showing a page — another one, a change to its own
// entry in the note, a restarted log — draws the SVG again.
//
// An unbounded page is drawn through a PlaneWindow. Moving it rewrites the SVG's
// viewBox, size and background and redraws the `ruling` group alone; every stroke
// node stays where it is. Whether the window and the surround's scroll move on
// their own is the sheet's SheetPolicy.

import { InkRenderer, INK_LAYERS, INK_RULES } from '../../renderers/ink-renderer.js'
import { InkFeed } from '../../contract/ink-container-provider.js'
import { rendererStyles } from '../../renderers/renderer-style-registry.js'
import { ImageClipboard } from '../../renderers/copy-image.js'
import { PlaneWindow, WindowEdge } from './plane-window.js'

/** @typedef {import('../../contract/ink-container-provider.js').InkContainerProvider} InkContainerProvider */
/** @typedef {import('../../contract/ink-container-provider.js').InkFeedEvent} InkFeedEvent */
/** @typedef {import('../../contract/ink-container-provider.js').InkLiveRecord} InkLiveRecord */
/** @typedef {import('../../contract/ink-container-provider.js').InkPage} InkPage */
/** @typedef {import('../../contract/ink-container-provider.js').InkPageStroke} InkPageStroke */
/** @typedef {import('../../renderers/ink-renderer.js').InkWindow} InkWindow */

/**
 * A page as the note's header lists it.
 * @typedef {Readonly<{id: string, template?: any, bounds?: string}>} PageEntry
 */

/**
 * What a sheet tells the surface showing it: that what it draws changed, which
 * is what the surface measures and labels.
 * @typedef {object} InkSheetHost
 * @property {() => void} onSheetChanged
 */

/**
 * Whether the view of a sheet moves on its own. One that follows the tablet puts
 * a whiteboard's window on the tablet's whenever the tablet says where it is, and
 * scrolls the surround to the stroke under the pen; one that marks edges shows,
 * at the edge of a whiteboard's window, where ink has landed out of view.
 * @typedef {Readonly<{followsTablet: boolean, marksEdges: boolean}>} SheetPolicy
 */

/**
 * A stroke under the pen: what its begin said, the points so far, and the path
 * drawn for it.
 * @typedef {object} LiveStroke
 * @property {'pen'|'pencil'} tool
 * @property {1|2|3} widthClass
 * @property {{x: number, y: number, pressure: number, tMillis: number}[]} points
 * @property {boolean} ended
 * @property {Element|null} el
 * @property {ReturnType<typeof setTimeout>|null} linger
 */

/** How long an ended live stroke stays drawn when no committed stroke claims it. */
const LIVE_LINGER_MS = 3000

/** For this long after the reader scrolls the surround, the live stroke is not scrolled into view. */
const READER_SCROLL_MS = 800

/** A scroll event this soon after the sheet scrolled the surround is the sheet's own. */
const OWN_SCROLL_MS = 120

/** How far inside the surround's edge the live stroke is brought, in CSS pixels. */
const REVEAL_MARGIN_PX = 48

/** A window more template spacings across than this is drawn without its template's marks. */
const MAX_RULING_SPACINGS = 60

export class InkSheet {
  /** The policies a sheet is built with. */
  static Policy = Object.freeze({
    /** @type {SheetPolicy} the reader's: nothing moves but by the reader */
    READER: Object.freeze({ followsTablet: false, marksEdges: true }),
    /** @type {SheetPolicy} the mirror's: the view is the tablet's */
    MIRROR: Object.freeze({ followsTablet: true, marksEdges: false }),
  })

  /**
   * How a fixed page's sheet is sized: to the surround's width, one grid unit to
   * a CSS pixel, or whole within the surround but never under half its width.
   */
  static Scale = Object.freeze({ FIT: 'fit', ACTUAL: 'actual', WHOLE: 'whole' })

  static styles = /* css */ `
  .ink-page__surround {
    flex: 1 1 auto;
    min-height: 0;
    overflow: auto;
    padding: 24px;
  }

  .ink-page__sheet {
    margin: 0 auto;
    width: fit-content;
    box-shadow: 0 0 0 1px var(--theme-border2), 0 2px 10px color-mix(in srgb, var(--theme-text) 18%, transparent);
  }

  .ink-page__surround[data-scale="fit"] .ink-page__sheet { width: auto; max-width: 100%; }

  .ink-page__surround[data-scale="whole"],
  .ink-page__surround[data-bounds="unbounded"] { container-type: size; min-height: 240px; }

  .ink-page__surround[data-scale="whole"] .ink-page__sheet {
    width: max(50cqw, min(100cqw, calc(100cqh * var(--ink-aspect, 1))));
  }

  .ink-page__surround[data-bounds="unbounded"] { overflow: hidden; }

  .ink-page__surround[data-bounds="unbounded"] .ink-page__sheet {
    position: relative;
    width: min(100cqw, calc(100cqh * var(--ink-aspect, 1)));
    max-width: none;
    user-select: none;
  }

  .ink-page__sheet > svg { display: block; height: auto; }

  .ink-page__edge {
    position: absolute;
    width: 0;
    height: 0;
    border: 8px solid transparent;
    pointer-events: none;
  }

  .ink-page__edge[data-ink-edge="left"] { left: 4px; top: 50%; translate: 0 -50%; border-left-width: 0; border-right-color: var(--theme-accentPrimary); }
  .ink-page__edge[data-ink-edge="right"] { right: 4px; top: 50%; translate: 0 -50%; border-right-width: 0; border-left-color: var(--theme-accentPrimary); }
  .ink-page__edge[data-ink-edge="top"] { top: 4px; left: 50%; translate: -50% 0; border-top-width: 0; border-bottom-color: var(--theme-accentPrimary); }
  .ink-page__edge[data-ink-edge="bottom"] { bottom: 4px; left: 50%; translate: -50% 0; border-bottom-width: 0; border-top-color: var(--theme-accentPrimary); }

  .ink-page__empty {
    margin: 48px auto;
    color: var(--theme-muted);
    text-align: center;
  }
`

  /** @type {InkContainerProvider} */ #provider
  /** @type {InkSheetHost} */ #host
  /** @type {SheetPolicy} */ #policy
  /** @type {InkRenderer} */ #renderer = new InkRenderer()
  /** @type {ImageClipboard} */ #clipboard = new ImageClipboard()

  /** @type {boolean} between attach and detach */ #attached = false
  /** @type {HTMLElement} */ #surround
  /** @type {HTMLElement} */ #sheet
  /** @type {HTMLElement} the edge marks laid over a whiteboard's sheet */ #edges
  /** @type {Map<string, HTMLElement>} each edge mark, by WindowEdge */ #edgeMarks = new Map()

  /** @type {ReadonlyArray<PageEntry>} */ #pages = []
  /** @type {any} the note header's attrs: pageAspect, template */ #note = {}
  /** @type {string} one of InkSheet.Scale, for a fixed page */ #scale

  /** @type {string|null} the page shown, null when none is */ #shown = null
  /** @type {number} the seq of the log the shown page reflects */ #seq = 0
  /** @type {number} the load the shown page waits on; 0 when it is drawn */ #loading = 0
  /** @type {number} the last load asked for, so an answer to an older one is dropped */ #loads = 0
  /** @type {InkFeedEvent[]} stroke events for the shown page heard while it loads */ #held = []
  /** @type {string|null} the page the SVG on the sheet draws */ #drawn = null
  /** @type {SVGSVGElement|null} the SVG on the sheet */ #svg = null
  /** @type {Element|null} the SVG's white background */ #background = null
  /** @type {any} the template the drawn page is ruled with, as its answer gave it */ #template = null
  /** @type {PlaneWindow|null} the window an unbounded page is drawn through; null for a fixed page */ #plane = null
  /** @type {boolean} whether the drawn SVG lags the plane window */ #windowStale = false
  /** @type {Set<string>} strokes the feed added outside the window, not yet in it */ #offWindow = new Set()
  /** @type {Map<string, Element>|null} the drawn SVG's layers by name; null while none is drawn for the shown page */ #layers = null
  /** @type {Map<string, Element[]>} every drawn element of each committed stroke, by stroke id */ #strokes = new Map()

  /** @type {string|null} the page the tablet shows as written; null when none */ #livePage = null
  /** @type {Map<number, LiveStroke>} the strokes under the pen, in the order they began */ #live = new Map()
  /** @type {Set<number>} live strokes whose path is out of date */ #stale = new Set()
  /** @type {number} the pending animation frame; 0 when none */ #frame = 0

  /** @type {number} Date.now() of the reader's last scroll of the surround */ #readerScrollAt = -Infinity
  /** @type {number} Date.now() of the sheet's last scroll of the surround */ #ownScrollAt = -Infinity

  /**
   * @param {InkContainerProvider} provider what pages are asked of
   * @param {InkSheetHost} host
   * @param {SheetPolicy} policy
   * @param {string} scale one of InkSheet.Scale, how a fixed page is sized at first
   */
  constructor(provider, host, policy, scale) {
    this.#provider = provider
    this.#host = host
    this.#policy = policy
    this.#scale = scale
    rendererStyles.register(InkSheet)
    this.#surround = this.#el('div', 'ink-page__surround')
    this.#sheet = this.#el('div', 'ink-page__sheet')
    this.#surround.appendChild(this.#sheet)
    this.#edges = this.#el('div', 'ink-page__edges')
    for (const edge of Object.values(WindowEdge)) {
      const mark = this.#el('span', 'ink-page__edge')
      mark.dataset.inkEdge = edge
      mark.hidden = true
      this.#edgeMarks.set(edge, mark)
      this.#edges.appendChild(mark)
    }
    this.#applyScale()
  }

  /** @returns {HTMLElement} the surround, which holds the sheet */
  get element() { return this.#surround }

  /** @returns {HTMLElement} the sheet itself */
  get sheetElement() { return this.#sheet }

  /** @returns {string|null} the page shown */
  get shown() { return this.#shown }

  /** @returns {string|null} the page the SVG on the sheet draws */
  get drawn() { return this.#drawn }

  /** @returns {boolean} whether the shown page waits on its answer */
  get loading() { return this.#loading !== 0 }

  /** @returns {number} the committed strokes drawn of the shown page; 0 while none is drawn */
  get strokeCount() { return this.#layers ? this.#strokes.size : 0 }

  /** @returns {ReadonlyArray<PageEntry>} the note's pages */
  get pages() { return this.#pages }

  /** @returns {boolean} whether the page shown is drawn through a window */
  get pannable() { return this.#plane !== null && this.#layers !== null }

  /** @returns {InkWindow|null} the part of the plane shown; null for a fixed page */
  get window() { return this.#plane ? this.#plane.window : null }

  /** @returns {string} one of InkSheet.Scale */
  get scale() { return this.#scale }

  /** @param {string} scale one of InkSheet.Scale */
  set scale(scale) {
    this.#scale = scale
    this.#applyScale()
  }

  /** @returns {string|null} the page the tablet shows as written */
  get livePage() { return this.#livePage }

  /**
   * The page the tablet shows as written, or none. A move to another page drops
   * the strokes under the pen and forgets where the tablet's window was.
   * @param {string|null} pageId
   */
  set livePage(pageId) {
    if (pageId !== this.#livePage) {
      this.#clearLive()
      if (this.#plane) this.#plane.forgetTablet()
    }
    this.#livePage = pageId
  }

  /** Starts hearing the surround's scroll. */
  attach() {
    this.#attached = true
    this.#surround.addEventListener('scroll', this.#onScroll)
  }

  /** Stops hearing the surround, and drops every pending frame, timer and load. */
  detach() {
    this.#attached = false
    this.#surround.removeEventListener('scroll', this.#onScroll)
    this.#clearLive()
    if (this.#frame) cancelAnimationFrame(this.#frame)
    this.#frame = 0
    this.#loads++
    this.#layers = null
  }

  /**
   * The note's header as its block holds it: pageAspect, template and pages.
   * @param {any} note
   */
  setNote(note) {
    this.#note = note || {}
    this.#pages = Array.isArray(this.#note.pages) ? this.#note.pages.filter((/** @type {any} */ p) => p && p.id) : []
  }

  /** What the drawing of a page depends on in the header, as one comparable string.
   *  @param {string|null} pageId @returns {string} */
  drawnWith(pageId) {
    const entry = this.#pages[this.indexOf(pageId)]
    if (!entry) return ''
    return JSON.stringify([entry.template ?? null, entry.bounds ?? null, this.#note.template ?? null, this.#note.pageAspect ?? null])
  }

  /** @param {string|null} pageId @returns {number} -1 for a page the note does not list */
  indexOf(pageId) {
    return pageId === null ? -1 : this.#pages.findIndex((p) => p.id === pageId)
  }

  /** @param {string|null} pageId @returns {boolean} */
  isUnbounded(pageId) {
    const entry = this.#pages[this.indexOf(pageId)]
    return !!entry && entry.bounds === 'unbounded'
  }

  /**
   * Asks for a page and draws it when it comes. The SVG already shown stays until
   * then; stroke events for the page heard meanwhile are held and applied above
   * the seq the answer reflects. Null shows that there is no page, in `empty`'s words.
   * @param {string|null} pageId
   * @param {string} empty what is said when pageId is null
   */
  show(pageId, empty) {
    if (pageId !== this.#shown) {
      this.#clearLive()
      this.#layers = null
    }
    this.#shown = pageId
    this.#seq = 0
    this.#held = []
    const load = ++this.#loads
    if (pageId === null) {
      this.#loading = 0
      this.#showEmpty(empty)
      return
    }
    this.#loading = load
    this.#provider.loadPage(pageId).then((answer) => {
      if (load !== this.#loads || !this.#attached) return
      this.#draw(answer.page)
      this.#seq = answer.seq
      this.#loading = 0
      const held = this.#held
      this.#held = []
      for (const event of held) this.#applyStroke(event)
    }, (err) => {
      if (load !== this.#loads || !this.#attached) return
      console.warn('[ink] the page could not be loaded', pageId, err)
      this.#loading = 0
      this.#showEmpty('This page could not be loaded.')
    })
  }

  /**
   * A stroke event of the feed: applied to the shown page, or held while it
   * loads. Reports whether it was for the shown page.
   * @param {InkFeedEvent} event a stroke-added or stroke-removed
   * @returns {boolean}
   */
  takeStroke(event) {
    if (/** @type {any} */ (event).pageId !== this.#shown) return false
    if (this.#loading) this.#held.push(event)
    else this.#applyStroke(event)
    return true
  }

  /**
   * Live records, drawn while the shown page is the live page. A whiteboard
   * records where the tablet's window is, and moves onto it when the policy
   * follows the tablet.
   * @param {ReadonlyArray<InkLiveRecord>} records
   */
  takeLive(records) {
    if (this.#livePage === null || this.#livePage !== this.#shown) return
    for (const r of records) {
      switch (r.record) {
        case 'view':
          if (this.#plane) {
            this.#plane.setView(r.x, r.y)
            this.#followTablet()
          }
          break
        case 'begin':
          if (this.#plane && !this.#plane.viewHeard) {
            this.#plane.setOrigin(r.x, r.y)
            this.#followTablet()
          }
          this.#dropLive(r.stroke)
          this.#live.set(r.stroke, {
            tool: r.tool === 'pencil' ? 'pencil' : 'pen',
            widthClass: /** @type {1|2|3} */ ([1, 2, 3].includes(r.widthClass) ? r.widthClass : 2),
            points: [], ended: false, el: null, linger: null,
          })
          break
        case 'point': {
          const stroke = this.#live.get(r.stroke)
          if (!stroke || stroke.ended) break
          stroke.points.push({ x: r.x, y: r.y, pressure: r.pressure, tMillis: r.tMillis })
          this.#stale.add(r.stroke)
          break
        }
        case 'end': {
          const stroke = this.#live.get(r.stroke)
          if (!stroke || stroke.ended) break
          stroke.ended = true
          stroke.linger = setTimeout(() => this.#dropLive(r.stroke), LIVE_LINGER_MS)
          break
        }
        case 'remove':
          this.#dropLive(r.stroke)
          break
      }
    }
    this.#schedule()
  }

  /** The note's log restarted: the strokes under the pen go and the shown page
   *  is asked for again. @param {string} empty what is said when no page is shown */
  restart(empty) {
    this.#clearLive()
    this.show(this.#shown, empty)
  }

  /**
   * Moves a whiteboard's window, which is redrawn at the next frame.
   * @param {(plane: PlaneWindow) => void} move
   * @returns {boolean} false when the page shown is not a whiteboard
   */
  moveWindow(move) {
    if (!this.pannable) return false
    move(/** @type {PlaneWindow} */ (this.#plane))
    this.#windowMoved()
    return true
  }

  /** @returns {number} the SVG's laid-out width in CSS pixels; 0 while it is not laid out */
  get laidOutWidth() { return this.#svg ? this.#svg.getBoundingClientRect().width : 0 }

  /** @param {number} x @param {number} y client pixels @returns {{x: number, y: number}|null} page units */
  planeAt(x, y) {
    const w = this.#shownWindow()
    const r = this.#svg ? this.#svg.getBoundingClientRect() : null
    if (!w || !r || !r.width || !r.height) return null
    return { x: w.x0 + (x - r.left) / r.width * (w.x1 - w.x0), y: w.y0 + (y - r.top) / r.height * (w.y1 - w.y0) }
  }

  /** @returns {number} page units per CSS pixel on the sheet; 0 while it is not laid out */
  unitsPerPixel() {
    const w = this.#shownWindow()
    const width = this.laidOutWidth
    return w && width ? (w.x1 - w.x0) / width : 0
  }

  /** @returns {boolean} whether the drawn page shows a template it cannot draw */
  get unknownTemplate() {
    return !!this.#svg && !!this.#svg.querySelector('g[data-ink="ruling"][data-ink-template="unknown"]')
  }

  /**
   * The page as the sheet draws it, as a self-contained SVG document to make an
   * image of: the white sheet, the ruling and the committed ink — of the whole
   * page for a fixed page, of the window for a whiteboard — without the stroke
   * under the pen or the sheet's own styling, sized INK_RULES.grid pixels across.
   * Null while the page shown is not drawn.
   * @returns {{svg: string, width: number, height: number}|null}
   */
  pageImage() {
    if (!this.#svg || !this.#layers || this.#drawn !== this.#shown) return null
    if (this.#windowStale) {
      this.#windowStale = false
      this.#applyWindow()
    }
    const copy = /** @type {SVGSVGElement} */ (this.#svg.cloneNode(true))
    copy.removeAttribute('style')
    copy.querySelector('g[data-ink="live"]')?.replaceChildren()
    const [, , w, h] = String(copy.getAttribute('viewBox')).trim().split(/\s+/).map(Number)
    if (!(w > 0 && h > 0)) return null
    const width = INK_RULES.grid
    const height = Math.max(1, Math.round(width * h / w))
    copy.setAttribute('width', String(width))
    copy.setAttribute('height', String(height))
    return { svg: new XMLSerializer().serializeToString(copy), width, height }
  }

  /**
   * Puts the page as pageImage draws it on the clipboard as a PNG.
   * @returns {Promise<boolean>} false when no page is drawn; rejects when the
   *   clipboard does not take the image
   */
  copyPage() {
    const image = this.pageImage()
    if (!image) return Promise.resolve(false)
    return this.#clipboard.copySvg(image.svg, image.width, image.height).then(() => true)
  }

  /** @param {string} text */
  #showEmpty(text) {
    this.#layers = null
    this.#drawn = null
    this.#svg = null
    this.#background = null
    this.#plane = null
    this.#strokes = new Map()
    const empty = this.#el('p', 'ink-page__empty')
    empty.textContent = text
    this.#sheet.replaceChildren(empty)
    this.#applyScale()
    this.#host.onSheetChanged()
  }

  /**
   * Draws the page. A whiteboard drawn again keeps the window it had; one newly
   * shown is framed round all its ink, or put on the tablet's window when the
   * policy follows the tablet and the tablet has said where it is.
   * @param {Readonly<InkPage>} page
   */
  #draw(page) {
    if (this.isUnbounded(this.#shown)) {
      const aspect = page.note.pageAspect
      const same = this.#plane !== null && this.#drawn === this.#shown && this.#plane.aspect === aspect
      if (!same) this.#plane = new PlaneWindow(aspect)
      const plane = /** @type {PlaneWindow} */ (this.#plane)
      plane.setStrokes(page.strokes)
      if (!same) plane.fitAll()
      if (this.#policy.followsTablet) plane.showTablet()
    } else {
      this.#plane = null
    }
    this.#template = page.note.template ?? null
    this.#offWindow = new Set()
    this.#windowStale = false
    const window = this.#plane ? this.#plane.window : undefined
    const ruled = window ? { ...page, note: { ...page.note, template: this.#rulingTemplate(window) } } : page
    const svg = /** @type {SVGSVGElement} */ (this.#parse(this.#renderer.renderPage(/** @type {any} */ (ruled), window))[0])
    this.#svg = svg
    this.#background = [...svg.children].find((el) => el.tagName.toLowerCase() === 'rect') ?? null
    this.#layers = new Map(INK_LAYERS.map((name) => [name, /** @type {Element} */ (svg.querySelector(`g[data-ink="${name}"]`))]))
    this.#strokes = new Map()
    for (const name of INK_LAYERS) {
      if (name === 'live' || name === 'ruling') continue
      for (const el of /** @type {Element} */ (this.#layers.get(name)).children) this.#index(el)
    }
    if (this.#plane && this.#policy.marksEdges) this.#sheet.replaceChildren(svg, this.#edges)
    else this.#sheet.replaceChildren(svg)
    this.#markEdges()
    if (this.#drawn !== this.#shown) this.#surround.scrollTo(0, 0)
    this.#drawn = this.#shown
    this.#applyScale()
    for (const n of this.#live.keys()) this.#stale.add(n)
    for (const stroke of this.#live.values()) stroke.el = null
    this.#schedule()
    this.#host.onSheetChanged()
  }

  /**
   * The template a window is ruled with: the page's own, or, once the window is
   * so wide that its marks would sit under a pixel or two apart, the same id with
   * no params, which draws no marks.
   * @param {InkWindow} window @returns {any}
   */
  #rulingTemplate(window) {
    const template = this.#template
    const spacing = Number(template?.params?.spacing)
    if (!template || !(spacing > 0) || (window.x1 - window.x0) / spacing <= MAX_RULING_SPACINGS) return template
    return Object.freeze({ id: template.id })
  }

  /** Brings the drawn SVG to the plane window: its box, its background and its
   *  ruling. Every stroke node stays as it is. */
  #applyWindow() {
    const svg = this.#svg
    const plane = this.#plane
    const ruling = this.#layers && this.#layers.get('ruling')
    if (!svg || !plane || !ruling) return
    const window = plane.window
    const box = this.#renderer.windowBox(window)
    svg.setAttribute('viewBox', `${box.x} ${box.y} ${box.width} ${box.height}`)
    svg.setAttribute('width', box.width)
    svg.setAttribute('height', box.height)
    if (this.#background) {
      for (const [name, value] of Object.entries(box)) this.#background.setAttribute(name, value)
    }
    const fresh = this.#fragment(this.#renderer.renderRuling(this.#rulingTemplate(window), window))[0]
    ruling.replaceChildren(...fresh.childNodes)
    this.#markEdges()
  }

  /** Shows the mark on each edge of the window beyond which ink the feed added
   *  lies unseen, and forgets the ink the window now shows. */
  #markEdges() {
    /** @type {Set<string>} */
    const edges = new Set()
    const plane = this.#plane
    for (const id of [...this.#offWindow]) {
      const extent = plane ? plane.extentOf(id) : undefined
      if (!plane || !extent || plane.shows(extent)) this.#offWindow.delete(id)
      else edges.add(plane.edgeOf(extent))
    }
    for (const [edge, mark] of this.#edgeMarks) mark.hidden = !edges.has(edge)
  }

  /** @param {InkFeedEvent} event */
  #applyStroke(event) {
    const e = /** @type {any} */ (event)
    if (!this.#layers || e.seq <= this.#seq) return
    this.#seq = e.seq
    if (e.type === InkFeed.STROKE_REMOVED) {
      for (const el of this.#strokes.get(e.strokeId) || []) el.remove()
      this.#strokes.delete(e.strokeId)
      if (this.#plane) {
        this.#plane.removeStroke(e.strokeId)
        this.#markEdges()
      }
      this.#host.onSheetChanged()
      return
    }
    const markup = this.#renderer.renderStroke(/** @type {any} */ (e.stroke))
    this.#append('pen', markup.pen)
    markup.bands.forEach((part, i) => this.#append(`b${i}`, part))
    if (this.#plane) {
      this.#plane.addStroke(e.stroke)
      const extent = this.#plane.extentOf(e.stroke.id)
      if (extent && !this.#plane.shows(extent)) this.#offWindow.add(e.stroke.id)
      this.#markEdges()
    }
    if (this.#shown === this.#livePage) this.#claimLive(e.stroke)
    this.#host.onSheetChanged()
  }

  /** @param {string} layer @param {string} markup */
  #append(layer, markup) {
    if (!markup) return
    const group = /** @type {Element} */ (/** @type {Map<string, Element>} */ (this.#layers).get(layer))
    for (const el of this.#fragment(markup)) {
      group.appendChild(el)
      this.#index(el)
    }
  }

  /** @param {Element} el */
  #index(el) {
    const id = el.getAttribute('data-stroke')
    if (!id) return
    const els = this.#strokes.get(id)
    if (els) els.push(el)
    else this.#strokes.set(id, [el])
  }

  /** When the policy follows the tablet, puts the window on the tablet's at the next frame. */
  #followTablet() {
    if (this.#policy.followsTablet && this.#plane && this.#plane.showTablet()) this.#windowMoved()
  }

  /**
   * A committed stroke on the live page takes the place of the oldest ended
   * live stroke drawn with the same tool and width class.
   * @param {Readonly<InkPageStroke>} committed
   */
  #claimLive(committed) {
    for (const [n, stroke] of this.#live) {
      if (stroke.ended && stroke.tool === committed.tool && stroke.widthClass === committed.widthClass) {
        this.#dropLive(n)
        return
      }
    }
  }

  #windowMoved() {
    this.#windowStale = true
    this.#schedule()
  }

  #schedule() {
    if (this.#frame || !this.#attached || (this.#stale.size === 0 && !this.#windowStale)) return
    this.#frame = requestAnimationFrame(() => this.#onFrame())
  }

  /** One frame: the window brought up to date, then every changed live stroke. */
  #onFrame() {
    this.#frame = 0
    if (this.#windowStale) {
      this.#windowStale = false
      this.#applyWindow()
    }
    this.#redrawLive()
  }

  /** Redraws the path of every live stroke that changed since the last frame. */
  #redrawLive() {
    const group = this.#layers && this.#layers.get('live')
    if (!group || this.#stale.size === 0) return
    for (const n of this.#stale) {
      const stroke = this.#live.get(n)
      if (!stroke) continue
      const markup = this.#renderer.renderLiveStroke({ id: `live-${n}`, tool: stroke.tool, widthClass: stroke.widthClass, points: stroke.points })
      const el = markup ? this.#fragment(markup)[0] : null
      if (stroke.el && el) stroke.el.replaceWith(el)
      else if (stroke.el) stroke.el.remove()
      else if (el) group.appendChild(el)
      stroke.el = el
    }
    this.#stale.clear()
    this.#revealLive()
  }

  /**
   * On a fixed page, when the policy follows the tablet, scrolls the surround the
   * least that brings the newest point of the stroke under the pen within
   * REVEAL_MARGIN_PX of its edges, unless the reader has scrolled it in the last
   * READER_SCROLL_MS.
   */
  #revealLive() {
    if (this.#plane || !this.#policy.followsTablet || this.#livePage !== this.#shown) return
    if (Date.now() - this.#readerScrollAt < READER_SCROLL_MS) return
    const strokes = [...this.#live.values()]
    const newest = strokes[strokes.length - 1]
    if (!newest || newest.ended || !newest.points.length) return
    const p = newest.points[newest.points.length - 1]
    const at = this.#clientOf(p.x, p.y)
    const view = this.#surround.getBoundingClientRect()
    if (!at || !view.width || !view.height) return
    const m = Math.min(REVEAL_MARGIN_PX, view.width / 4, view.height / 4)
    const dx = at.x < view.left + m ? at.x - view.left - m : at.x > view.right - m ? at.x - view.right + m : 0
    const dy = at.y < view.top + m ? at.y - view.top - m : at.y > view.bottom - m ? at.y - view.bottom + m : 0
    if (!dx && !dy) return
    this.#ownScrollAt = Date.now()
    this.#surround.scrollTo(this.#surround.scrollLeft + dx, this.#surround.scrollTop + dy)
  }

  /** @param {number} n */
  #dropLive(n) {
    const stroke = this.#live.get(n)
    if (!stroke) return
    if (stroke.linger) clearTimeout(stroke.linger)
    if (stroke.el) stroke.el.remove()
    this.#live.delete(n)
    this.#stale.delete(n)
  }

  #clearLive() {
    for (const n of [...this.#live.keys()]) this.#dropLive(n)
  }

  /** @returns {InkWindow|null} the part of the plane the SVG on the sheet shows */
  #shownWindow() {
    if (this.#plane) return this.#plane.window
    const aspect = Number(this.#note.pageAspect)
    return this.#svg && aspect > 0 ? { x0: 0, y0: 0, x1: 1, y1: 1 / aspect } : null
  }

  /** @param {number} x @param {number} y page units @returns {{x: number, y: number}|null} client pixels */
  #clientOf(x, y) {
    const w = this.#shownWindow()
    const r = this.#svg ? this.#svg.getBoundingClientRect() : null
    if (!w || !r || !r.width || !r.height) return null
    return { x: r.left + (x - w.x0) / (w.x1 - w.x0) * r.width, y: r.top + (y - w.y0) / (w.y1 - w.y0) * r.height }
  }

  #applyScale() {
    this.#surround.dataset.scale = this.#scale
    const aspect = this.#plane ? this.#plane.aspect : Number(this.#note.pageAspect)
    if (this.#plane) this.#surround.dataset.bounds = 'unbounded'
    else delete this.#surround.dataset.bounds
    if (aspect > 0) this.#sheet.style.setProperty('--ink-aspect', String(aspect))
    else this.#sheet.style.removeProperty('--ink-aspect')
    const svg = this.#svg
    if (!svg) return
    svg.style.width = this.#plane || this.#scale !== InkSheet.Scale.ACTUAL ? '100%' : `${svg.getAttribute('width')}px`
  }

  #onScroll = () => {
    if (Date.now() - this.#ownScrollAt > OWN_SCROLL_MS) this.#readerScrollAt = Date.now()
  }

  /**
   * Nodes from the renderer's markup, parsed as HTML parses inline SVG, so every
   * element lands in the SVG namespace.
   * @param {string} markup @returns {Element[]}
   */
  #parse(markup) {
    const template = document.createElement('template')
    template.innerHTML = markup
    return [...template.content.children]
  }

  /** @param {string} markup SVG elements @returns {Element[]} */
  #fragment(markup) {
    return [.../** @type {Element} */ (this.#parse(`<svg>${markup}</svg>`)[0]).children]
  }

  /** @param {string} tag @param {string} className @returns {HTMLElement} */
  #el(tag, className) {
    const el = document.createElement(tag)
    el.className = className
    return el
  }
}
