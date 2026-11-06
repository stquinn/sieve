// @ts-check
// The one surface DigitalNoteLens has: one page of the note at a time, drawn as
// the renderer's SVG on a white sheet, with the page chrome above it. It hears
// the container's feed itself, so the page it shows takes committed strokes and
// the stroke under the pen as they arrive, and offers nothing to write with.
//
// The SVG is built once per page shown and is then only added to and trimmed:
// a committed stroke's markup is parsed into nodes and appended to its layers, a
// removed stroke's nodes are taken out, and a live stroke's one path is swapped
// in the `live` layer. Only showing a page — a turn, a change to the page's own
// entry in the block, a restarted log — draws the SVG again.
//
// An unbounded page is shown through a PlaneWindow the reader can move and zoom.
// Moving it rewrites the SVG's viewBox, size and background and redraws the
// `ruling` group alone; every stroke node stays where it is.

import { AbstractSurface, SurfaceEvent } from '../abstract-surface.js'
import { InkRenderer, INK_LAYERS, INK_RULES } from '../../renderers/ink-renderer.js'
import { InkFeed } from '../../contract/ink-container-provider.js'
import { rendererStyles } from '../../renderers/renderer-style-registry.js'
import { PlaneWindow, WindowEdge } from './plane-window.js'

/** @typedef {import('../../contract/ink-container-provider.js').InkContainerProvider} InkContainerProvider */
/** @typedef {import('../../contract/ink-container-provider.js').InkFeedEvent} InkFeedEvent */
/** @typedef {import('../../contract/ink-container-provider.js').InkLiveRecord} InkLiveRecord */
/** @typedef {import('../../contract/ink-container-provider.js').InkPage} InkPage */
/** @typedef {import('../../contract/ink-container-provider.js').InkPageStroke} InkPageStroke */
/** @typedef {import('../../renderers/ink-renderer.js').InkWindow} InkWindow */
/** @typedef {import('../abstract-surface.js').SurfaceStats} SurfaceStats */

/**
 * What the surface asks of the lens that made it: the key claim, asked first
 * for every key pressed in the surface, and where its events are reported.
 * @typedef {object} PageSurfaceHost
 * @property {(event: KeyboardEvent) => boolean} claimKey
 * @property {(event: import('../abstract-surface.js').SurfaceEventMsg) => void} onSurfaceEvent
 */

/**
 * A page as the note's block lists it.
 * @typedef {Readonly<{id: string, template?: any, bounds?: string}>} PageEntry
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

/** The zoom factor of one press of a zoom key or button. */
const ZOOM_STEP = 1.25

/** Zoom per pixel of wheel travel with Ctrl or Cmd held: a factor of exp(-deltaY · this). */
const WHEEL_ZOOM = 0.002

/** CSS pixels a wheel event counts per line when it reports lines. */
const WHEEL_LINE_PX = 16

/** For this long after the reader scrolls the surround, the live stroke is not scrolled into view. */
const READER_SCROLL_MS = 800

/** A scroll event this soon after the surface scrolled the surround is the surface's own. */
const OWN_SCROLL_MS = 120

/** How far inside the surround's edge the live stroke is brought, in CSS pixels. */
const REVEAL_MARGIN_PX = 48

/** The most pages the pager shows a dot each for; past it the pager counts the unseen ones. */
const MAX_DOTS = 12

/** A window more template spacings across than this is drawn without its template's marks. */
const MAX_RULING_SPACINGS = 60

export class PageSurface extends AbstractSurface {
  /** The mode this surface presents. */
  static MODE = 'page'

  /** How a fixed page's sheet is sized: to the surround's width, or one grid unit to a CSS pixel. */
  static Scale = Object.freeze({ FIT: 'fit', ACTUAL: 'actual' })

  static styles = /* css */ `
  .ink-page {
    display: flex;
    flex-direction: column;
    flex: 1 1 auto;
    min-height: 0;
    background: var(--theme-bgDark);
    outline: none;
  }

  .ink-page [hidden] { display: none; }

  .ink-page__chrome {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 16px;
    padding: 8px 24px;
    background: var(--theme-bg);
    border-bottom: 1px solid var(--theme-border);
    color: var(--theme-textDim);
    font-family: var(--theme-uiFont);
    font-size: 0.85em;
  }

  .ink-page__heading {
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
    flex: 1 1 auto;
  }

  .ink-page__title {
    color: var(--theme-text);
    font-size: 1.1em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ink-page__device { color: var(--theme-muted); white-space: nowrap; }

  .ink-page__notice { color: var(--theme-accentYellow); }

  .ink-page__pager {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .ink-page__pager button {
    border: 1px solid transparent;
    border-radius: 4px;
    background: none;
    color: var(--theme-textDim);
    font: inherit;
    padding: 2px 8px;
    cursor: pointer;
  }

  .ink-page__pager button:hover:not(:disabled) {
    color: var(--theme-text);
    border-color: var(--theme-border2);
  }

  .ink-page__pager button:disabled { opacity: 0.4; cursor: default; }

  .ink-page__position {
    font-variant-numeric: tabular-nums;
    color: var(--theme-text);
    min-width: 4.5em;
    text-align: center;
  }

  .ink-page__dots { display: flex; gap: 2px; }

  .ink-page__pager .ink-page__dot {
    position: relative;
    width: 14px;
    height: 14px;
    padding: 0;
  }

  .ink-page__dot::before {
    content: '';
    position: absolute;
    inset: 4px;
    border-radius: 50%;
    background: var(--theme-border2);
  }

  .ink-page__dot[aria-current="page"]::before { background: var(--theme-text); }

  .ink-page__dot[data-unseen]::after,
  .ink-page__unseen::before {
    content: '';
    position: absolute;
    top: 0;
    right: 0;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--theme-accentPrimary);
  }

  .ink-page__pager .ink-page__unseen { position: relative; white-space: nowrap; }

  .ink-page__view { display: flex; align-items: center; gap: 2px; }

  .ink-page__pager .ink-page__live {
    color: var(--theme-accentRed);
    border-color: color-mix(in srgb, var(--theme-accentRed) 40%, transparent);
  }

  .ink-page__live::before {
    content: '';
    display: inline-block;
    width: 7px;
    height: 7px;
    margin-right: 6px;
    border-radius: 50%;
    background: var(--theme-accentRed);
    vertical-align: 1px;
  }

  .ink-page__live[aria-pressed="false"]::before { background: none; box-shadow: inset 0 0 0 1px var(--theme-accentRed); }

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

  .ink-page[data-scale="fit"] .ink-page__sheet { width: auto; max-width: 100%; }

  .ink-page[data-bounds="unbounded"] .ink-page__surround {
    container-type: size;
    min-height: 240px;
    overflow: hidden;
  }

  .ink-page[data-bounds="unbounded"] .ink-page__sheet {
    position: relative;
    width: min(100cqw, calc(100cqh * var(--ink-aspect, 1)));
    max-width: none;
    cursor: grab;
    touch-action: none;
    user-select: none;
  }

  .ink-page[data-dragging] .ink-page__sheet { cursor: grabbing; }

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
  /** @type {PageSurfaceHost} */ #host
  /** @type {InkRenderer} */ #renderer = new InkRenderer()

  /** @type {boolean} between mount and unmount */ #mounted = false
  /** @type {HTMLElement} */ #root
  /** @type {HTMLElement} */ #title
  /** @type {HTMLElement} */ #device
  /** @type {HTMLElement} */ #notice
  /** @type {HTMLElement} */ #position
  /** @type {HTMLElement} */ #dots
  /** @type {HTMLButtonElement} */ #prev
  /** @type {HTMLButtonElement} */ #next
  /** @type {HTMLButtonElement} */ #scaleButton
  /** @type {HTMLElement} the whiteboard's zoom and framing buttons */ #viewTools
  /** @type {HTMLButtonElement} */ #liveButton
  /** @type {HTMLElement} */ #surround
  /** @type {HTMLElement} */ #sheet
  /** @type {HTMLElement} the edge marks laid over a whiteboard's sheet */ #edges
  /** @type {Map<string, HTMLElement>} each edge mark, by WindowEdge */ #edgeMarks = new Map()

  /** @type {ReadonlyArray<PageEntry>} */ #pages = []
  /** @type {any} the note header's attrs: pageAspect, template */ #note = {}

  /** @type {string|null} the page shown, null when the note has none */ #shown = null
  /** @type {boolean} whether a page, or the note's having none, has been shown */ #painted = false
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

  /** @type {Set<string>} pages with ink not seen since it arrived */ #unseen = new Set()
  /** @type {string|null} the page the tablet shows as written; null when the note is not live */ #livePage = null
  /** @type {boolean} whether the lens follows the tablet: its live page, and on a whiteboard its window */ #following = true
  /** @type {Map<number, LiveStroke>} the strokes under the pen, in the order they began */ #live = new Map()
  /** @type {Set<number>} live strokes whose path is out of date */ #stale = new Set()
  /** @type {number} the pending animation frame; 0 when none */ #frame = 0

  /** @type {{id: number, x: number, y: number}|null} the pointer dragging the sheet */ #drag = null
  /** @type {number} the scale the last WebKit gesture event reported */ #gestureScale = 1
  /** @type {number} Date.now() of the reader's last scroll of the surround */ #readerScrollAt = -Infinity
  /** @type {number} Date.now() of the surface's last scroll of the surround */ #ownScrollAt = -Infinity

  /** @type {string} */ #scale = PageSurface.Scale.FIT

  /**
   * @param {InkContainerProvider} provider the note's provider; its feed is heard
   *   from mount to unmount
   * @param {PageSurfaceHost} host
   */
  constructor(provider, host) {
    super()
    this.#provider = provider
    this.#host = host
    rendererStyles.register(PageSurface)
    this.#root = this.#el('div', 'ink-page')
    this.#root.tabIndex = 0
    this.#root.dataset.scale = this.#scale
    const chrome = this.#el('header', 'ink-page__chrome')
    const heading = this.#el('div', 'ink-page__heading')
    this.#title = this.#el('span', 'ink-page__title')
    this.#device = this.#el('span', 'ink-page__device')
    heading.append(this.#title, this.#device)
    this.#notice = this.#el('span', 'ink-page__notice')
    this.#notice.hidden = true
    const pager = this.#el('nav', 'ink-page__pager')
    pager.setAttribute('aria-label', 'Pages')
    this.#prev = this.#button('prev', '‹', 'Previous page')
    this.#position = this.#el('span', 'ink-page__position')
    this.#next = this.#button('next', '›', 'Next page')
    this.#dots = this.#el('span', 'ink-page__dots')
    this.#scaleButton = this.#button('scale', '', '')
    this.#viewTools = this.#el('span', 'ink-page__view')
    this.#viewTools.hidden = true
    this.#viewTools.append(
      this.#button('zoom-out', '−', 'Zoom out'),
      this.#button('zoom-in', '+', 'Zoom in'),
      this.#button('actual', '100%', 'One grid unit to a pixel'),
      this.#button('fit', 'Fit all', 'Frame all the ink'),
    )
    this.#liveButton = this.#button('live', '', '')
    this.#liveButton.className = 'ink-page__live'
    this.#liveButton.hidden = true
    pager.append(this.#prev, this.#position, this.#next, this.#dots, this.#scaleButton, this.#viewTools, this.#liveButton)
    chrome.append(heading, this.#notice, pager)
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
    this.#root.append(chrome, this.#surround)
  }

  /** @returns {string} */
  get mode() { return PageSurface.MODE }

  /**
   * Where the reader is and how much ink it holds: the page's place in the note
   * (or that it is the whiteboard) and the strokes drawn on it.
   * @returns {SurfaceStats}
   */
  stats() {
    const index = this.#indexOf(this.#shown)
    const where = index < 0 ? 'No pages'
      : this.#isUnbounded(this.#shown) ? 'Whiteboard'
        : `Page ${index + 1} of ${this.#pages.length}`
    const count = this.#layers ? this.#strokes.size : 0
    return {
      chars: 0, lines: 0, blockCount: 0,
      readout: Object.freeze([
        Object.freeze({ text: where, title: 'Page' }),
        Object.freeze({ text: `${count} stroke${count === 1 ? '' : 's'}`, title: 'Strokes on this page' }),
      ]),
    }
  }

  /** @returns {string|null} the id of the page shown */
  get shownPage() { return this.#shown }

  /** @returns {string} one of PageSurface.Scale */
  get scale() { return this.#scale }

  /** @returns {boolean} whether the page shown is drawn through a window the reader can move */
  get pannable() { return this.#plane !== null && this.#layers !== null }

  /** @returns {InkWindow|null} the part of the plane shown; null for a fixed page */
  get window() { return this.#plane ? this.#plane.window : null }

  /**
   * Puts the page in the editor's root and starts hearing the feed, which is
   * before the container's first cue asks for a page.
   * @param {HTMLElement} rootEl
   */
  mount(rootEl) {
    this.#root.addEventListener('click', this.#onClick)
    this.#root.addEventListener('keydown', this.#onKeyDown)
    this.#sheet.addEventListener('pointerdown', this.#onPointerDown)
    this.#sheet.addEventListener('pointermove', this.#onPointerMove)
    this.#sheet.addEventListener('pointerup', this.#onPointerUp)
    this.#sheet.addEventListener('pointercancel', this.#onPointerUp)
    this.#surround.addEventListener('wheel', this.#onWheel, { passive: false })
    this.#surround.addEventListener('scroll', this.#onScroll)
    this.#surround.addEventListener('gesturestart', this.#onGesture)
    this.#surround.addEventListener('gesturechange', this.#onGesture)
    rootEl.appendChild(this.#root)
    this.#mounted = true
    this.#provider.subscribeFeed(this)
  }

  /** Stops hearing the feed, drops every pending frame, timer and load, and
   *  removes the DOM. */
  unmount() {
    this.#provider.unsubscribeFeed(this)
    this.#mounted = false
    this.#clearLive()
    if (this.#frame) cancelAnimationFrame(this.#frame)
    this.#frame = 0
    this.#loads++
    this.#drag = null
    this.#root.removeEventListener('click', this.#onClick)
    this.#root.removeEventListener('keydown', this.#onKeyDown)
    this.#sheet.removeEventListener('pointerdown', this.#onPointerDown)
    this.#sheet.removeEventListener('pointermove', this.#onPointerMove)
    this.#sheet.removeEventListener('pointerup', this.#onPointerUp)
    this.#sheet.removeEventListener('pointercancel', this.#onPointerUp)
    this.#surround.removeEventListener('wheel', this.#onWheel)
    this.#surround.removeEventListener('scroll', this.#onScroll)
    this.#surround.removeEventListener('gesturestart', this.#onGesture)
    this.#surround.removeEventListener('gesturechange', this.#onGesture)
    this.#root.remove()
    this.#layers = null
  }

  /**
   * The note's block changed: the chrome is redrawn from it, and a page is drawn
   * only when the page to show is another one, its own entry changed, or it is
   * not drawn (its load failed).
   * @param {unknown} _change @param {InkContainerProvider} provider
   */
  applyContainerChange(_change, provider) {
    const index = this.#indexOf(this.#shown)
    const before = this.#drawnWith(this.#shown)
    this.#read(provider)
    const target = this.#target(index)
    const undrawn = target !== null && target !== this.#drawn && !this.#loading
    if (!this.#painted || undrawn || target !== this.#shown || this.#drawnWith(target) !== before) this.#show(target)
    else {
      this.#renderChrome()
      this.#measured()
    }
  }

  /** Draws the shown page again from the note as it now stands.
   *  @param {InkContainerProvider} provider */
  paintContainer(provider) {
    const index = this.#indexOf(this.#shown)
    this.#read(provider)
    this.#show(this.#target(index))
  }

  /**
   * The page to show: the live page while it is followed, else the page shown
   * while the note lists it, else the page now at the shown page's index (the
   * first, before any is shown), else none.
   * @param {number} index the shown page's index before the block changed
   * @returns {string|null}
   */
  #target(index) {
    if (this.#following && this.#livePage !== null && this.#indexOf(this.#livePage) >= 0) return this.#livePage
    if (this.#indexOf(this.#shown) >= 0) return this.#shown
    const at = Math.min(Math.max(index, 0), this.#pages.length - 1)
    return at >= 0 ? this.#pages[at].id : null
  }

  flushPending() {}

  /**
   * One event of the note's feed.
   * @param {InkFeedEvent} event
   */
  onFeed(event) {
    if (!this.#mounted) return
    switch (event.type) {
      case InkFeed.STROKE_ADDED:
      case InkFeed.STROKE_REMOVED:
        this.#onStroke(event)
        break
      case InkFeed.LIVE:
        this.#onLive(event.records)
        break
      case InkFeed.LIVE_PAGE:
        this.#onLivePage(event.live ? event.pageId : null)
        break
      case InkFeed.LOG_RESTARTED:
        this.#unseen.clear()
        this.#clearLive()
        this.#show(this.#shown ?? (this.#pages.length ? this.#pages[0].id : null))
        break
    }
  }

  /**
   * Shows the page `delta` pages on from the shown one, clamped to the note. A
   * page turned to by hand pauses following unless it is the live page.
   * @param {number} delta
   */
  turn(delta) {
    const index = this.#indexOf(this.#shown)
    const to = Math.min(Math.max(index + delta, 0), this.#pages.length - 1)
    if (to < 0 || to === index) return
    this.#navigate(this.#pages[to].id)
  }

  /** Shows the first page with unseen ink after the shown one, from the start
   *  again past the last. Does nothing while no page has any. */
  showNextUnseen() {
    const from = this.#indexOf(this.#shown)
    for (let i = 1; i <= this.#pages.length; i++) {
      const page = this.#pages[(from + i) % this.#pages.length]
      if (this.#unseen.has(page.id)) {
        this.#navigate(page.id)
        return
      }
    }
  }

  /** Follows the tablet again: shows the live page and, on a whiteboard, the
   *  tablet's window. Does nothing while the note is not live. */
  returnToLive() {
    if (this.#livePage === null) return
    this.#following = true
    if (this.#livePage !== this.#shown) {
      this.#show(this.#livePage)
      return
    }
    if (this.#plane && this.#plane.showTablet()) this.#windowMoved()
    this.#renderChrome()
  }

  /** Switches a fixed page's sheet between fitting the surround's width and actual size. */
  toggleScale() {
    this.#scale = this.#scale === PageSurface.Scale.FIT ? PageSurface.Scale.ACTUAL : PageSurface.Scale.FIT
    this.#applyScale()
    this.#renderChrome()
  }

  /**
   * Moves a whiteboard's window by fractions of its own size. Pauses following.
   * @param {number} fx @param {number} fy
   * @returns {boolean} false when the page shown is not a whiteboard
   */
  panBy(fx, fy) {
    if (!this.pannable) return false
    const w = /** @type {PlaneWindow} */ (this.#plane).window
    return this.#readerMoves((plane) => plane.pan(fx * (w.x1 - w.x0), fy * (w.y1 - w.y0)))
  }

  /**
   * Zooms a whiteboard's window about its centre, within its limits. Pauses following.
   * @param {number} factor above 1 zooms in
   * @returns {boolean} false when the page shown is not a whiteboard
   */
  zoomBy(factor) {
    return this.#readerMoves((plane) => plane.zoomBy(factor))
  }

  /** Zooms a whiteboard's window about its centre to one grid unit per CSS
   *  pixel. Pauses following. @returns {boolean} false when not a whiteboard or not laid out */
  showActualSize() {
    const width = this.#svg ? this.#svg.getBoundingClientRect().width : 0
    if (!width) return false
    return this.#readerMoves((plane) => plane.zoomBy(INK_RULES.grid / width / plane.zoom))
  }

  /** Frames all of a whiteboard's ink. Pauses following.
   *  @returns {boolean} false when the page shown is not a whiteboard */
  fitAll() {
    return this.#readerMoves((plane) => plane.fitAll())
  }

  /**
   * A move of the window by the reader: it pauses following while the note is
   * live, and the window is redrawn at the next frame.
   * @param {(plane: PlaneWindow) => void} move
   * @returns {boolean} false when the page shown is not a whiteboard
   */
  #readerMoves(move) {
    if (!this.pannable) return false
    move(/** @type {PlaneWindow} */ (this.#plane))
    if (this.#livePage !== null && this.#following) {
      this.#following = false
      this.#renderChrome()
    }
    this.#windowMoved()
    return true
  }

  #windowMoved() {
    this.#windowStale = true
    this.#schedule()
  }

  /** @param {string} pageId */
  #navigate(pageId) {
    if (this.#livePage !== null) this.#following = pageId === this.#livePage
    this.#show(pageId)
  }

  /** @param {InkContainerProvider} provider */
  #read(provider) {
    const id = provider.getOrder()[0]
    const block = id ? provider.getBlock(id) : null
    const attrs = (block && block.attrs) || {}
    this.#note = attrs.note || {}
    this.#pages = Array.isArray(this.#note.pages) ? this.#note.pages.filter((/** @type {any} */ p) => p && p.id) : []
    this.#title.textContent = String(attrs.title || 'Untitled note')
    this.#device.textContent = String((attrs.note_device && attrs.note_device.name) || '')
  }

  /** What the drawing of a page depends on in the block, as one comparable string.
   *  @param {string|null} pageId @returns {string} */
  #drawnWith(pageId) {
    const entry = this.#pages[this.#indexOf(pageId)]
    if (!entry) return ''
    return JSON.stringify([entry.template ?? null, entry.bounds ?? null, this.#note.template ?? null, this.#note.pageAspect ?? null])
  }

  /** @param {string|null} pageId @returns {number} -1 for a page the note does not list */
  #indexOf(pageId) {
    return pageId === null ? -1 : this.#pages.findIndex((p) => p.id === pageId)
  }

  /** @param {string|null} pageId @returns {boolean} */
  #isUnbounded(pageId) {
    const entry = this.#pages[this.#indexOf(pageId)]
    return !!entry && entry.bounds === 'unbounded'
  }

  /**
   * Asks for a page and draws it when it comes. The SVG already shown stays until
   * then; stroke events for the page heard meanwhile are held and applied above
   * the seq the answer reflects.
   * @param {string|null} pageId
   */
  #show(pageId) {
    if (pageId !== this.#shown) {
      this.#clearLive()
      this.#layers = null
    }
    this.#shown = pageId
    this.#painted = true
    this.#seq = 0
    this.#held = []
    if (pageId !== null) this.#unseen.delete(pageId)
    const load = ++this.#loads
    this.#renderChrome()
    if (pageId === null) {
      this.#loading = 0
      this.#showEmpty('This note has no pages yet.')
      return
    }
    this.#loading = load
    this.#provider.loadPage(pageId).then((answer) => {
      if (load !== this.#loads || !this.#mounted) return
      this.#draw(answer.page)
      this.#seq = answer.seq
      this.#loading = 0
      const held = this.#held
      this.#held = []
      for (const event of held) this.#applyStroke(event)
    }, (err) => {
      if (load !== this.#loads || !this.#mounted) return
      console.warn('[ink] the page could not be loaded', pageId, err)
      this.#loading = 0
      this.#showEmpty('This page could not be loaded.')
    })
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
    this.#notice.hidden = true
    this.#applyScale()
    this.#measured()
  }

  /**
   * Draws the page. A whiteboard drawn again keeps the window the reader had on
   * it; one newly shown is framed round all its ink, or put on the tablet's
   * window while that is followed.
   * @param {Readonly<InkPage>} page
   */
  #draw(page) {
    if (this.#isUnbounded(this.#shown)) {
      const aspect = page.note.pageAspect
      const same = this.#plane !== null && this.#drawn === this.#shown && this.#plane.aspect === aspect
      if (!same) this.#plane = new PlaneWindow(aspect)
      const plane = /** @type {PlaneWindow} */ (this.#plane)
      plane.setStrokes(page.strokes)
      if (!same) plane.fitAll()
      if (this.#following && this.#livePage === this.#shown) plane.showTablet()
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
    if (this.#plane) this.#sheet.replaceChildren(svg, this.#edges)
    else this.#sheet.replaceChildren(svg)
    this.#markEdges()
    if (this.#drawn !== this.#shown) this.#surround.scrollTo(0, 0)
    this.#drawn = this.#shown
    this.#notice.hidden = !svg.querySelector('g[data-ink="ruling"][data-ink-template="unknown"]')
    this.#notice.textContent = 'Unknown template, drawn blank'
    this.#applyScale()
    for (const n of this.#live.keys()) this.#stale.add(n)
    for (const stroke of this.#live.values()) stroke.el = null
    this.#schedule()
    this.#measured()
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
  #onStroke(event) {
    const pageId = /** @type {any} */ (event).pageId
    if (pageId !== this.#shown) {
      this.#unseen.add(pageId)
      this.#renderChrome()
      return
    }
    if (this.#loading) {
      this.#held.push(event)
      return
    }
    this.#applyStroke(event)
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
      this.#measured()
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
    this.#measured()
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

  /** @param {ReadonlyArray<InkLiveRecord>} records */
  #onLive(records) {
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

  /** While following, puts the window on the tablet's at the next frame. */
  #followTablet() {
    if (this.#following && this.#plane && this.#plane.showTablet()) this.#windowMoved()
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

  /** @param {string|null} pageId the live page, null when the note stops being live */
  #onLivePage(pageId) {
    if (pageId !== this.#livePage) {
      this.#clearLive()
      if (this.#plane) this.#plane.forgetTablet()
    }
    this.#livePage = pageId
    if (pageId === null) this.#following = true
    if (pageId !== null && this.#following && pageId !== this.#shown && this.#indexOf(pageId) >= 0) this.#show(pageId)
    else this.#renderChrome()
  }

  #schedule() {
    if (this.#frame || !this.#mounted || (this.#stale.size === 0 && !this.#windowStale)) return
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
   * On a fixed page that is followed, scrolls the surround the least that brings
   * the newest point of the stroke under the pen within REVEAL_MARGIN_PX of its
   * edges, unless the reader has scrolled it in the last READER_SCROLL_MS.
   */
  #revealLive() {
    if (this.#plane || !this.#following || this.#livePage !== this.#shown) return
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

  /** @param {number} x @param {number} y client pixels @returns {{x: number, y: number}|null} page units */
  #planeAt(x, y) {
    const w = this.#shownWindow()
    const r = this.#svg ? this.#svg.getBoundingClientRect() : null
    if (!w || !r || !r.width || !r.height) return null
    return { x: w.x0 + (x - r.left) / r.width * (w.x1 - w.x0), y: w.y0 + (y - r.top) / r.height * (w.y1 - w.y0) }
  }

  /** @returns {number} page units per CSS pixel on the sheet; 0 while it is not laid out */
  #unitsPerPixel() {
    const w = this.#shownWindow()
    const width = this.#svg ? this.#svg.getBoundingClientRect().width : 0
    return w && width ? (w.x1 - w.x0) / width : 0
  }

  #applyScale() {
    this.#root.dataset.scale = this.#scale
    if (this.#plane) {
      this.#root.dataset.bounds = 'unbounded'
      this.#sheet.style.setProperty('--ink-aspect', String(this.#plane.aspect))
    } else {
      delete this.#root.dataset.bounds
      this.#sheet.style.removeProperty('--ink-aspect')
    }
    const svg = this.#svg
    if (!svg) return
    svg.style.width = this.#plane || this.#scale === PageSurface.Scale.FIT ? '100%' : `${svg.getAttribute('width')}px`
  }

  #renderChrome() {
    const index = this.#indexOf(this.#shown)
    const count = this.#pages.length
    this.#position.textContent = count ? `${index + 1} / ${count}` : '0 / 0'
    this.#prev.disabled = index <= 0
    this.#next.disabled = index < 0 || index >= count - 1
    this.#dots.replaceChildren(...(count > MAX_DOTS ? this.#unseenCount() : this.#pageDots()))
    const whiteboard = this.#isUnbounded(this.#shown)
    const actual = this.#scale === PageSurface.Scale.ACTUAL
    this.#scaleButton.hidden = whiteboard
    this.#scaleButton.textContent = actual ? 'Fit width' : '100%'
    this.#scaleButton.title = actual ? 'Fit the page to the width' : 'Show the page at actual size'
    this.#viewTools.hidden = !whiteboard
    const following = this.#following && this.#livePage === this.#shown
    this.#liveButton.hidden = this.#livePage === null
    this.#liveButton.textContent = following ? 'Live' : 'Back to live'
    this.#liveButton.setAttribute('aria-label', whiteboard ? "Follow the tablet's window" : 'Follow the page being written')
    this.#liveButton.setAttribute('aria-pressed', String(following))
  }

  /** @returns {HTMLButtonElement[]} one dot per page */
  #pageDots() {
    return this.#pages.map((page, i) => {
      const dot = this.#button('', '', `Page ${i + 1}`)
      dot.className = 'ink-page__dot'
      dot.dataset.inkPage = page.id
      if (page.id === this.#shown) dot.setAttribute('aria-current', 'page')
      if (this.#unseen.has(page.id)) dot.dataset.unseen = ''
      return dot
    })
  }

  /** @returns {HTMLButtonElement[]} the count of pages with unseen ink, as the button that
   *  shows the next of them; none while there are none */
  #unseenCount() {
    const unseen = this.#pages.filter((page) => this.#unseen.has(page.id)).length
    if (!unseen) return []
    const button = this.#button('unseen', `${unseen} unseen`, `Show the next of ${unseen} pages with unseen ink`)
    button.className = 'ink-page__unseen'
    return [button]
  }

  /** Reports that what stats() measures may have changed. */
  #measured() {
    this.#host.onSurfaceEvent(SurfaceEvent.DOC_PROJECTED)
  }

  /** @param {Event} event */
  #onClick = (event) => {
    const target = /** @type {Element} */ (event.target)
    const button = target && typeof target.closest === 'function' ? target.closest('button') : null
    if (!button) {
      if (target && this.#sheet.contains(target)) this.#root.focus()
      return
    }
    const page = button.getAttribute('data-ink-page')
    if (page !== null) {
      if (page !== this.#shown) this.#navigate(page)
      return
    }
    switch (button.getAttribute('data-ink-action')) {
      case 'prev': this.turn(-1); break
      case 'next': this.turn(1); break
      case 'unseen': this.showNextUnseen(); break
      case 'scale': this.toggleScale(); break
      case 'zoom-in': this.zoomBy(ZOOM_STEP); break
      case 'zoom-out': this.zoomBy(1 / ZOOM_STEP); break
      case 'actual': this.showActualSize(); break
      case 'fit': this.fitAll(); break
      case 'live': this.returnToLive(); break
    }
  }

  /** @param {KeyboardEvent} event */
  #onKeyDown = (event) => {
    if (this.#host.claimKey(event)) event.preventDefault()
  }

  /** @param {PointerEvent} event */
  #onPointerDown = (event) => {
    if (!this.pannable || event.button !== 0) return
    event.preventDefault()
    this.#root.focus()
    this.#drag = { id: event.pointerId, x: event.clientX, y: event.clientY }
    if (typeof this.#sheet.setPointerCapture === 'function') this.#sheet.setPointerCapture(event.pointerId)
    this.#root.dataset.dragging = ''
  }

  /** @param {PointerEvent} event */
  #onPointerMove = (event) => {
    const drag = this.#drag
    if (!drag || event.pointerId !== drag.id) return
    const [dx, dy] = [event.clientX - drag.x, event.clientY - drag.y]
    drag.x = event.clientX
    drag.y = event.clientY
    const u = this.#unitsPerPixel()
    if (u && (dx || dy)) this.#readerMoves((plane) => plane.pan(-dx * u, -dy * u))
  }

  /** @param {PointerEvent} event */
  #onPointerUp = (event) => {
    if (!this.#drag || event.pointerId !== this.#drag.id) return
    this.#drag = null
    delete this.#root.dataset.dragging
  }

  /**
   * On a whiteboard a wheel moves the window, and with Ctrl or Cmd held (which
   * is also how a trackpad pinch arrives) zooms it about the pointer. On a fixed
   * page the wheel scrolls.
   * @param {WheelEvent} event
   */
  #onWheel = (event) => {
    if (!this.pannable) return
    event.preventDefault()
    const px = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? this.#surround.clientHeight : 1
    let [dx, dy] = [event.deltaX * px, event.deltaY * px]
    if (event.ctrlKey || event.metaKey) {
      this.#zoomAt(Math.exp(-dy * WHEEL_ZOOM), event.clientX, event.clientY)
      return
    }
    if (event.shiftKey && !dx) [dx, dy] = [dy, 0]
    const u = this.#unitsPerPixel()
    if (u && (dx || dy)) this.#readerMoves((plane) => plane.pan(dx * u, dy * u))
  }

  /**
   * WebKit's pinch: `scale` is the pinch's total since it began.
   * @param {Event} event
   */
  #onGesture = (event) => {
    if (!this.pannable) return
    event.preventDefault()
    const e = /** @type {any} */ (event)
    const scale = Number(e.scale) || 1
    if (event.type === 'gesturestart') {
      this.#gestureScale = scale
      return
    }
    this.#zoomAt(scale / this.#gestureScale, Number(e.clientX), Number(e.clientY))
    this.#gestureScale = scale
  }

  /** @param {number} factor @param {number} clientX @param {number} clientY */
  #zoomAt(factor, clientX, clientY) {
    const at = this.#planeAt(clientX, clientY)
    if (!at) {
      this.zoomBy(factor)
      return
    }
    this.#readerMoves((plane) => plane.zoomAbout(factor, at.x, at.y))
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

  /** @param {string} action @param {string} text @param {string} label @returns {HTMLButtonElement} */
  #button(action, text, label) {
    const button = document.createElement('button')
    button.type = 'button'
    if (action) button.dataset.inkAction = action
    button.textContent = text
    if (label) button.setAttribute('aria-label', label)
    return button
  }
}
