// @ts-check
// The reader's surface of a Digital Note: one page at a time on an InkSheet,
// its pager and scale offered to the workspace toolbar, a right-click on it
// asking its lens for the lens's menu. It hears the
// container's feed itself, so the page shown takes committed strokes as they
// arrive and the stroke under the pen while it is the page being written; and it
// never moves the reader. Which page
// is shown, and on a whiteboard which part of the plane, is the reader's alone,
// and is handed to the next surface over the note as a ReaderView.

import { AbstractSurface, SurfaceEvent, SurfaceIntent } from '../abstract-surface.js'
import { INK_RULES } from '../../renderers/ink-renderer.js'
import { InkFeed } from '../../contract/ink-container-provider.js'
import { rendererStyles } from '../../renderers/renderer-style-registry.js'
import { ButtonGroup, ToolbarButton, ToolbarLabel, ToolbarSelect } from '../../renderers/toolbar-button.js'
import { InkSheet } from './ink-sheet.js'
import { NotePager } from './note-pager.js'

/** @typedef {import('../../contract/ink-container-provider.js').InkContainerProvider} InkContainerProvider */
/** @typedef {import('../../contract/ink-container-provider.js').InkFeedEvent} InkFeedEvent */
/** @typedef {import('../../renderers/ink-renderer.js').InkWindow} InkWindow */
/** @typedef {import('../abstract-surface.js').SurfaceStats} SurfaceStats */
/** @typedef {import('./plane-window.js').PlaneWindow} PlaneWindow */
/** @typedef {import('./ink-sheet.js').SheetScale} SheetScale */
/** @typedef {import('../../contract/ink-container-provider.js').InkPageAnswer} InkPageAnswer */

/**
 * The reader's view of a note: the mode it was shown in, the page shown, where a
 * whiteboard's window was, how a fixed page was sized, the pages marked unseen,
 * and the highest log seq and stroke start every mark was decided against. A
 * surface handed one opens where it says and marks the pages that took ink
 * written after it.
 * @typedef {Readonly<{mode: string, page: string|null, window: import('./ink-sheet.js').WindowPlacement|null,
 *   scale: SheetScale, unseen: ReadonlyArray<string>, seq: number, startMillis: number}>} ReaderView
 */

/**
 * What the surface asks of the lens that made it: the key claim, asked first
 * for every key pressed in the surface, where its events are reported, and
 * where what came of an action is said.
 * @typedef {object} PageSurfaceHost
 * @property {(event: KeyboardEvent) => boolean} claimKey
 * @property {(event: import('../abstract-surface.js').SurfaceEventMsg) => void} onSurfaceEvent
 * @property {import('./action-status.js').ActionStatus} actionStatus
 */

/** The zoom factor of one press of a zoom key or button. */
const ZOOM_STEP = 1.25

/** Zoom per pixel of wheel travel with Ctrl or Cmd held: a factor of exp(-deltaY · this). */
const WHEEL_ZOOM = 0.002

/** Pixels of wheel travel, with Ctrl or Cmd held, that step a fixed page one level. */
const WHEEL_STEP_PX = 40

/** The pinch, as a factor of its scale since the last step, that steps a fixed page one level. */
const PINCH_STEP = 1.2

/** CSS pixels a wheel event counts per line when it reports lines. */
const WHEEL_LINE_PX = 16

/** What the sheet says when the note has no page. */
const NO_PAGES = 'This note has no pages yet.'

export class PageSurface extends AbstractSurface {
  /** The mode this surface presents. */
  static MODE = 'page'

  /** The fits a fixed page's sheet is sized by: whole in the surround, or to the
   *  surround's width. Its scale is one of these or one of InkSheet.LEVELS. */
  static Scale = Object.freeze({ PAGE: InkSheet.Scale.PAGE, FIT: InkSheet.Scale.FIT })

  /** The scale drop-down's choices, in order: each level, then the fits. */
  static SCALES = Object.freeze([
    ...InkSheet.LEVELS.map((level) => Object.freeze({ scale: level, label: `${level}%` })),
    Object.freeze({ scale: InkSheet.Scale.FIT, label: 'Fit width' }),
    Object.freeze({ scale: InkSheet.Scale.PAGE, label: 'Fit page' }),
  ])

  /** What Copy page says: copied, no page drawn to copy, or the clipboard not taking it. */
  static CopyWords = Object.freeze({ COPIED: 'Copied', NOTHING: 'Nothing to copy yet', FAILED: 'Could not copy the page' })

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

  .ink-page--reader .ink-page__surround[data-bounds="unbounded"] .ink-page__sheet {
    cursor: grab;
    touch-action: none;
  }

  .ink-page--reader[data-dragging] .ink-page__sheet { cursor: grabbing; }
`

  /** @type {InkContainerProvider} */ #provider
  /** @type {PageSurfaceHost} */ #host
  /** @type {InkSheet} */ #sheet

  /** @type {boolean} between mount and unmount */ #mounted = false
  /** @type {HTMLElement} */ #root
  /** @type {NotePager} */ #pager = new NotePager(this)
  /** @type {string} the name of the device the note was written on; '' when unknown */ #device = ''

  /** @type {boolean} whether a page, or the note's having none, has been shown */ #painted = false
  /** @type {Set<string>} pages with ink not seen since it arrived */ #unseen = new Set()
  /** @type {ReaderView|null} the view handed to this surface, until its first page is drawn */ #restored = null
  /** @type {number} the highest log seq heard, in a page answer or a stroke event */ #heardSeq = 0
  /** @type {number} the latest stroke start heard, in a page answer or a stroke event; -1 before any */ #heardMillis = -1
  /** @type {string|null} the Live view mirroring this note while it is live; null when it is not */ #liveView = null

  /** @type {{id: number, x: number, y: number}|null} the pointer dragging the sheet */ #drag = null
  /** @type {number} the scale the last WebKit gesture event reported */ #gestureScale = 1
  /** @type {number} Ctrl or Cmd wheel travel on a fixed page not yet stepped by, in CSS pixels */ #wheelTravel = 0

  /**
   * @param {InkContainerProvider} provider the note's provider; its feed is heard
   *   from mount to unmount
   * @param {PageSurfaceHost} host
   * @param {ReaderView|null} [view] where an earlier surface over the note left the reader
   */
  constructor(provider, host, view = null) {
    super()
    this.#provider = provider
    this.#host = host
    rendererStyles.register(PageSurface)
    const scale = view && PageSurface.#isScale(view.scale) ? view.scale : PageSurface.Scale.PAGE
    this.#sheet = new InkSheet(provider, {
      onSheetChanged: () => this.#sheetChanged(),
      onAnswered: (answer) => this.#answered(answer),
    }, InkSheet.Policy.READER, scale)
    if (view) {
      this.#restored = view
      this.#unseen = new Set(view.unseen)
      this.#heardSeq = view.seq
      this.#heardMillis = view.startMillis
    }
    this.#root = this.#el('div', 'ink-page ink-page--reader')
    this.#root.tabIndex = 0
    this.#root.append(this.#sheet.element)
  }

  /** @returns {string} */
  get mode() { return PageSurface.MODE }

  /**
   * Where the reader is and how much ink it holds: the page's place in the note
   * (or that it is the whiteboard), the strokes drawn on it, and the device the
   * note was written on, when it is known.
   * @returns {SurfaceStats}
   */
  stats() {
    const shown = this.#sheet.shown
    const index = this.#sheet.indexOf(shown)
    const where = index < 0 ? 'No pages'
      : this.#sheet.isUnbounded(shown) ? 'Whiteboard'
        : `Page ${index + 1} of ${this.#sheet.pages.length}`
    const count = this.#sheet.strokeCount
    return {
      chars: 0, lines: 0, blockCount: 0,
      readout: Object.freeze([
        Object.freeze({ text: where, title: 'Page' }),
        Object.freeze({ text: `${count} stroke${count === 1 ? '' : 's'}`, title: 'Strokes on this page' }),
        ...(this.#device ? [Object.freeze({ text: this.#device, title: 'Written on' })] : []),
      ]),
    }
  }

  /**
   * What the surface offers the toolbar: the pager (but on a whiteboard of one
   * page), the scale on a fixed page or the window on a whiteboard, and that the
   * template is unknown.
   * @returns {ButtonGroup[]}
   */
  toolbarContents() {
    const sheet = this.#sheet
    const whiteboard = sheet.isUnbounded(sheet.shown)
    /** @type {ButtonGroup[]} */
    const groups = []
    if (!(whiteboard && sheet.pages.length === 1)) groups.push(this.#pager.group(sheet.pages, sheet.shown, this.#unseen))
    groups.push(whiteboard ? this.#windowGroup() : this.#scaleGroup())
    if (sheet.unknownTemplate) {
      groups.push(new ButtonGroup([new ToolbarLabel({ id: 'tb-ink-notice', className: 'tb-notice', text: () => 'Unknown template, drawn blank' })]))
    }
    return groups
  }

  /** @returns {ButtonGroup} the scale drop-down, the scale in force chosen */
  #scaleGroup() {
    return new ButtonGroup([new ToolbarSelect({
      id: 'tb-scale', title: 'Size',
      options: PageSurface.SCALES.map((choice) => ({ value: String(choice.scale), label: choice.label })),
      value: () => String(this.#sheet.scale),
      onChange: (value) => this.setScale(/^\d+$/.test(value) ? Number(value) : value),
    })], { label: 'Size' })
  }

  /** @returns {ButtonGroup} a whiteboard's zoom and framing */
  #windowGroup() {
    return new ButtonGroup([
      new ToolbarButton({ id: 'tb-zoom-out', text: '−', title: 'Zoom out', onClick: () => { this.zoomBy(1 / ZOOM_STEP) } }),
      new ToolbarButton({ id: 'tb-zoom-in', text: '+', title: 'Zoom in', onClick: () => { this.zoomBy(ZOOM_STEP) } }),
      new ToolbarButton({ id: 'tb-zoom-actual', text: '100%', title: 'One grid unit to a pixel', onClick: () => { this.showActualSize() } }),
      new ToolbarButton({ id: 'tb-zoom-fit', text: 'Fit all', title: 'Frame all the ink', onClick: () => { this.fitAll() } }),
    ], { label: 'Window' })
  }

  /** @returns {string|null} the id of the page shown */
  get shownPage() { return this.#sheet.shown }

  /** @returns {SheetScale} one of PageSurface.Scale or InkSheet.LEVELS */
  get scale() { return this.#sheet.scale }

  /** @returns {string|null} the Live view mirroring this note while it is live; null when it is not */
  get liveView() { return this.#liveView }

  /** @returns {boolean} whether the page shown is drawn through a window the reader can move */
  get pannable() { return this.#sheet.pannable }

  /** @returns {InkWindow|null} the part of the plane shown; null for a fixed page */
  get window() { return this.#sheet.window }

  /** @returns {ReadonlySet<string>} the pages marked as holding ink not yet seen */
  get unseenPages() { return this.#unseen }

  /**
   * Where the reader is, for the next surface over the note.
   * @returns {ReaderView}
   */
  viewState() {
    const sheet = this.#sheet
    const drawn = sheet.drawn !== null && sheet.drawn === sheet.shown
    return Object.freeze({
      mode: PageSurface.MODE,
      page: sheet.shown ?? (this.#restored ? this.#restored.page : null),
      window: drawn ? sheet.placement : (this.#restored ? this.#restored.window : null),
      scale: sheet.scale,
      unseen: Object.freeze([...this.#unseen]),
      seq: this.#heardSeq,
      startMillis: this.#heardMillis,
    })
  }

  /**
   * Puts the page in the editor's root and starts hearing the feed, which is
   * before the container's first cue asks for a page.
   * @param {HTMLElement} rootEl
   */
  mount(rootEl) {
    const sheet = this.#sheet.sheetElement
    const surround = this.#sheet.element
    this.#root.addEventListener('click', this.#onClick)
    this.#root.addEventListener('keydown', this.#onKeyDown)
    this.#root.addEventListener('contextmenu', this.#onContextMenu)
    sheet.addEventListener('pointerdown', this.#onPointerDown)
    sheet.addEventListener('pointermove', this.#onPointerMove)
    sheet.addEventListener('pointerup', this.#onPointerUp)
    sheet.addEventListener('pointercancel', this.#onPointerUp)
    surround.addEventListener('wheel', this.#onWheel, { passive: false })
    surround.addEventListener('gesturestart', this.#onGesture)
    surround.addEventListener('gesturechange', this.#onGesture)
    rootEl.appendChild(this.#root)
    this.#mounted = true
    this.#sheet.attach()
    this.#provider.subscribeFeed(this)
  }

  /** Stops hearing the feed, drops every pending frame, timer and load, and
   *  removes the DOM. */
  unmount() {
    const sheet = this.#sheet.sheetElement
    const surround = this.#sheet.element
    this.#provider.unsubscribeFeed(this)
    this.#mounted = false
    this.#sheet.detach()
    this.#drag = null
    this.#root.removeEventListener('click', this.#onClick)
    this.#root.removeEventListener('keydown', this.#onKeyDown)
    this.#root.removeEventListener('contextmenu', this.#onContextMenu)
    sheet.removeEventListener('pointerdown', this.#onPointerDown)
    sheet.removeEventListener('pointermove', this.#onPointerMove)
    sheet.removeEventListener('pointerup', this.#onPointerUp)
    sheet.removeEventListener('pointercancel', this.#onPointerUp)
    surround.removeEventListener('wheel', this.#onWheel)
    surround.removeEventListener('gesturestart', this.#onGesture)
    surround.removeEventListener('gesturechange', this.#onGesture)
    this.#root.remove()
  }

  /**
   * The note's block changed: the toolbar is asked again, and a page is drawn
   * only when the page to show is another one, its own entry changed, or it is
   * not drawn (its load failed).
   * @param {unknown} _change @param {InkContainerProvider} provider
   */
  applyContainerChange(_change, provider) {
    const sheet = this.#sheet
    const shown = sheet.shown
    const index = sheet.indexOf(shown)
    const before = sheet.drawnWith(shown)
    this.#read(provider)
    const target = this.#target(index)
    const undrawn = target !== null && target !== sheet.drawn && !sheet.loading
    if (!this.#painted || undrawn || target !== shown || sheet.drawnWith(target) !== before) this.#show(target)
    else {
      this.#toolbarChanged()
      this.#measured()
    }
  }

  /** Draws the shown page again from the note as it now stands.
   *  @param {InkContainerProvider} provider */
  paintContainer(provider) {
    const index = this.#sheet.indexOf(this.#sheet.shown)
    this.#read(provider)
    this.#show(this.#target(index))
  }

  /**
   * The page to show: the page shown while the note lists it, else the page now
   * at the shown page's index (the first, before any is shown), else none.
   * @param {number} index the shown page's index before the block changed
   * @returns {string|null}
   */
  #target(index) {
    const pages = this.#sheet.pages
    if (this.#sheet.indexOf(this.#sheet.shown) >= 0) return this.#sheet.shown
    const restored = this.#restored ? this.#restored.page : null
    if (this.#sheet.shown === null && this.#sheet.indexOf(restored) >= 0) return restored
    const at = Math.min(Math.max(index, 0), pages.length - 1)
    return at >= 0 ? pages[at].id : null
  }

  flushPending() {}

  /** Puts the keyboard on the page. */
  focusEditor() { this.#root.focus() }

  /**
   * One event of the note's feed.
   * @param {InkFeedEvent} event
   */
  onFeed(event) {
    if (!this.#mounted) return
    switch (event.type) {
      case InkFeed.STROKE_ADDED:
      case InkFeed.STROKE_REMOVED:
        this.#heard(event.seq, event.type === InkFeed.STROKE_ADDED ? [event.stroke] : [])
        if (!this.#sheet.takeStroke(event)) {
          this.#unseen.add(event.pageId)
          this.#toolbarChanged()
        }
        break
      case InkFeed.LIVE:
        this.#sheet.takeLive(event.records)
        break
      case InkFeed.LIVE_PAGE:
        this.#sheet.livePage = event.live ? event.pageId : null
        this.#liveView = event.live && event.view ? event.view : null
        this.#toolbarChanged()
        break
      case InkFeed.LOG_RESTARTED:
        this.#unseen.clear()
        this.#heardSeq = 0
        this.#sheet.restart(NO_PAGES)
        if (this.#sheet.shown === null && this.#sheet.pages.length) this.#show(this.#sheet.pages[0].id)
        break
    }
  }

  /** Shows the page `pageId`. @param {string} pageId */
  showPage(pageId) {
    if (pageId !== this.#sheet.shown) this.#show(pageId)
  }

  /**
   * Shows the page `delta` pages on from the shown one, clamped to the note.
   * @param {number} delta
   */
  turn(delta) {
    const pages = this.#sheet.pages
    const index = this.#sheet.indexOf(this.#sheet.shown)
    const to = Math.min(Math.max(index + delta, 0), pages.length - 1)
    if (to < 0 || to === index) return
    this.#show(pages[to].id)
  }

  /** Shows the first page with unseen ink after the shown one, from the start
   *  again past the last. Does nothing while no page has any. */
  showNextUnseen() {
    const pages = this.#sheet.pages
    const from = this.#sheet.indexOf(this.#sheet.shown)
    for (let i = 1; i <= pages.length; i++) {
      const page = pages[(from + i) % pages.length]
      if (this.#unseen.has(page.id)) {
        this.#show(page.id)
        return
      }
    }
  }

  /** Asks the host to open the Live view mirroring this note. Does nothing while
   *  the note is not live. */
  openLive() {
    if (this.#liveView) this.#host.onSurfaceEvent({ type: SurfaceIntent.OPEN_CONTAINER, uuid: this.#liveView })
  }

  /**
   * Puts the page shown on the clipboard as an image, and says so.
   * @returns {Promise<void>}
   */
  copyPage() {
    const words = PageSurface.CopyWords
    const status = this.#host.actionStatus
    return this.#sheet.copyPage().then(
      (copied) => status.showResult(copied ? words.COPIED : words.NOTHING),
      (err) => {
        console.warn('[ink] the page could not be copied', err)
        status.showResult(words.FAILED)
      })
  }

  /** @param {unknown} scale @returns {boolean} whether it is one of PageSurface.SCALES */
  static #isScale(scale) { return PageSurface.SCALES.some((choice) => choice.scale === scale) }

  /** @param {SheetScale} scale one of PageSurface.SCALES: how a fixed page is sized from now on */
  setScale(scale) {
    if (!PageSurface.#isScale(scale) || scale === this.#sheet.scale) return
    this.#sheet.scale = scale
    this.#toolbarChanged()
  }

  /**
   * Shows a fixed page at the next level in `direction`, keeping the point
   * under the pointer where it is as far as the surround's scroll allows.
   * @param {number} direction above 0 for larger
   * @param {number} clientX @param {number} clientY
   * @returns {boolean} false at either end, and on a whiteboard
   */
  stepScale(direction, clientX, clientY) {
    if (!this.#sheet.stepScale(direction, clientX, clientY)) return false
    this.#toolbarChanged()
    return true
  }

  /**
   * Moves a whiteboard's window by fractions of its own size.
   * @param {number} fx @param {number} fy
   * @returns {boolean} false when the page shown is not a whiteboard
   */
  panBy(fx, fy) {
    const w = this.#sheet.window
    if (!w) return false
    return this.#sheet.moveWindow((plane) => plane.pan(fx * (w.x1 - w.x0), fy * (w.y1 - w.y0)))
  }

  /**
   * Zooms a whiteboard's window about its centre, within its limits.
   * @param {number} factor above 1 zooms in
   * @returns {boolean} false when the page shown is not a whiteboard
   */
  zoomBy(factor) {
    return this.#sheet.moveWindow((plane) => plane.zoomBy(factor))
  }

  /** Zooms a whiteboard's window about its centre to one grid unit per CSS
   *  pixel. @returns {boolean} false when not a whiteboard or not laid out */
  showActualSize() {
    const width = this.#sheet.laidOutWidth
    if (!width) return false
    return this.#sheet.moveWindow((plane) => plane.zoomBy(INK_RULES.grid / width / plane.zoom))
  }

  /** Frames all of a whiteboard's ink. @returns {boolean} false when the page shown is not a whiteboard */
  fitAll() {
    return this.#sheet.moveWindow((plane) => plane.fitAll())
  }

  /** @param {InkContainerProvider} provider */
  #read(provider) {
    const id = provider.getOrder()[0]
    const block = id ? provider.getBlock(id) : null
    const attrs = (block && block.attrs) || {}
    this.#sheet.setNote(attrs.note)
    this.#device = String((attrs.note_device && attrs.note_device.name) || '')
  }

  /** @param {string|null} pageId */
  #show(pageId) {
    this.#painted = true
    if (pageId !== null) this.#unseen.delete(pageId)
    const restored = this.#restored
    this.#sheet.show(pageId, NO_PAGES, restored && restored.page === pageId ? restored.window : null)
    this.#toolbarChanged()
  }

  /**
   * A page answer was drawn. The first after a ReaderView was handed over, when
   * the log has moved past the seq the view was decided against, marks every
   * other page holding a stroke begun after the latest stroke start it had heard.
   * @param {InkPageAnswer} answer
   */
  #answered(answer) {
    const restored = this.#restored
    this.#restored = null
    this.#heard(answer.seq, answer.page.strokes)
    if (!restored || answer.seq <= restored.seq) return
    const shown = this.#sheet.shown
    for (const page of this.#sheet.pages) {
      if (page.id === shown || this.#unseen.has(page.id)) continue
      this.#provider.loadPage(page.id).then((other) => {
        if (!this.#mounted) return
        this.#heard(other.seq, other.page.strokes)
        if (page.id === this.#sheet.shown || !other.page.strokes.some((s) => s.startMillis > restored.startMillis)) return
        this.#unseen.add(page.id)
        this.#toolbarChanged()
      }, () => {})
    }
  }

  /**
   * Accounts a log seq and the strokes it brought as heard.
   * @param {number} seq @param {ReadonlyArray<{startMillis: number}>} strokes
   */
  #heard(seq, strokes) {
    this.#heardSeq = Math.max(this.#heardSeq, seq)
    for (const stroke of strokes) this.#heardMillis = Math.max(this.#heardMillis, stroke.startMillis)
  }

  #sheetChanged() {
    this.#toolbarChanged()
    this.#measured()
  }

  /** Reports that what toolbarContents() offers may have changed. */
  #toolbarChanged() {
    if (this.#mounted) this.#host.onSurfaceEvent(SurfaceEvent.TOOLBAR_CHANGED)
  }

  /** Reports that what stats() measures may have changed. */
  #measured() {
    this.#host.onSurfaceEvent(SurfaceEvent.DOC_PROJECTED)
  }

  /** A click on the sheet puts the keyboard on the page. @param {Event} event */
  #onClick = (event) => {
    const target = /** @type {Element} */ (event.target)
    if (target && this.#sheet.sheetElement.contains(target)) this.#root.focus()
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
    const sheet = this.#sheet.sheetElement
    if (typeof sheet.setPointerCapture === 'function') sheet.setPointerCapture(event.pointerId)
    this.#root.dataset.dragging = ''
  }

  /** @param {PointerEvent} event */
  #onPointerMove = (event) => {
    const drag = this.#drag
    if (!drag || event.pointerId !== drag.id) return
    const [dx, dy] = [event.clientX - drag.x, event.clientY - drag.y]
    drag.x = event.clientX
    drag.y = event.clientY
    const u = this.#sheet.unitsPerPixel()
    if (u && (dx || dy)) this.#sheet.moveWindow((plane) => plane.pan(-dx * u, -dy * u))
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
   * page the wheel scrolls, and with Ctrl or Cmd held steps the scale a level
   * for every WHEEL_STEP_PX of travel, about the pointer.
   * @param {WheelEvent} event
   */
  #onWheel = (event) => {
    const zoom = event.ctrlKey || event.metaKey
    if (!this.pannable && !(zoom && this.#sheet.drawn !== null)) return
    event.preventDefault()
    const px = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? this.#sheet.element.clientHeight : 1
    let [dx, dy] = [event.deltaX * px, event.deltaY * px]
    if (!this.pannable) {
      if (Math.sign(dy) !== Math.sign(this.#wheelTravel)) this.#wheelTravel = 0
      this.#wheelTravel += dy
      if (Math.abs(this.#wheelTravel) < WHEEL_STEP_PX) return
      this.stepScale(this.#wheelTravel < 0 ? 1 : -1, event.clientX, event.clientY)
      this.#wheelTravel = 0
      return
    }
    if (zoom) {
      this.#zoomAt(Math.exp(-dy * WHEEL_ZOOM), event.clientX, event.clientY)
      return
    }
    if (event.shiftKey && !dx) [dx, dy] = [dy, 0]
    const u = this.#sheet.unitsPerPixel()
    if (u && (dx || dy)) this.#sheet.moveWindow((plane) => plane.pan(dx * u, dy * u))
  }

  /**
   * WebKit's pinch: `scale` is the pinch's total since it began. On a whiteboard
   * it zooms the window with the fingers; on a fixed page it steps the scale a
   * level each time it grows or shrinks by PINCH_STEP since the last step.
   * @param {Event} event
   */
  #onGesture = (event) => {
    if (!this.pannable && this.#sheet.drawn === null) return
    event.preventDefault()
    const e = /** @type {any} */ (event)
    const scale = Number(e.scale) || 1
    if (event.type === 'gesturestart') {
      this.#gestureScale = scale
      return
    }
    const factor = scale / this.#gestureScale
    if (this.pannable) {
      this.#zoomAt(factor, Number(e.clientX), Number(e.clientY))
      this.#gestureScale = scale
    } else if (factor >= PINCH_STEP || factor <= 1 / PINCH_STEP) {
      this.stepScale(factor > 1 ? 1 : -1, Number(e.clientX), Number(e.clientY))
      this.#gestureScale = scale
    }
  }

  /** A right-click, or the menu key, asks the lens for its menu, and nothing
   *  else is offered over the page. @param {MouseEvent} event */
  #onContextMenu = (event) => {
    event.preventDefault()
    event.stopPropagation()
    this.#host.onSurfaceEvent(this.contextMenuIntent(event, this.#root))
  }

  /** @param {number} factor @param {number} clientX @param {number} clientY */
  #zoomAt(factor, clientX, clientY) {
    const at = this.#sheet.planeAt(clientX, clientY)
    if (!at) {
      this.zoomBy(factor)
      return
    }
    this.#sheet.moveWindow((plane) => plane.zoomAbout(factor, at.x, at.y))
  }

  /** @param {string} tag @param {string} className @returns {HTMLElement} */
  #el(tag, className) {
    const el = document.createElement(tag)
    el.className = className
    return el
  }
}
