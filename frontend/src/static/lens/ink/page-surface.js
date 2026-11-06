// @ts-check
// The reader's surface of a Digital Note: one page at a time on an InkSheet,
// with the page chrome above it. It hears the container's feed itself, so the
// page shown takes committed strokes as they arrive and the stroke under the pen
// while it is the page being written; and it never moves the reader. Which page
// is shown, and on a whiteboard which part of the plane, is the reader's alone.

import { AbstractSurface, SurfaceEvent, SurfaceIntent } from '../abstract-surface.js'
import { INK_RULES } from '../../renderers/ink-renderer.js'
import { InkFeed, InkOpening, InkRefusal } from '../../contract/ink-container-provider.js'
import { rendererStyles } from '../../renderers/renderer-style-registry.js'
import { ActionStatus } from './action-status.js'
import { InkSheet } from './ink-sheet.js'

/** @typedef {import('../../contract/ink-container-provider.js').InkContainerProvider} InkContainerProvider */
/** @typedef {import('../../contract/ink-container-provider.js').InkFeedEvent} InkFeedEvent */
/** @typedef {import('../../contract/ink-container-provider.js').InkOpeningResult} InkOpeningResult */
/** @typedef {import('../../renderers/ink-renderer.js').InkWindow} InkWindow */
/** @typedef {import('../abstract-surface.js').SurfaceStats} SurfaceStats */
/** @typedef {import('./plane-window.js').PlaneWindow} PlaneWindow */

/**
 * What the surface asks of the lens that made it: the key claim, asked first
 * for every key pressed in the surface, and where its events are reported.
 * @typedef {object} PageSurfaceHost
 * @property {(event: KeyboardEvent) => boolean} claimKey
 * @property {(event: import('../abstract-surface.js').SurfaceEventMsg) => void} onSurfaceEvent
 */

/** The zoom factor of one press of a zoom key or button. */
const ZOOM_STEP = 1.25

/** Zoom per pixel of wheel travel with Ctrl or Cmd held: a factor of exp(-deltaY · this). */
const WHEEL_ZOOM = 0.002

/** CSS pixels a wheel event counts per line when it reports lines. */
const WHEEL_LINE_PX = 16

/** The most pages the pager shows a dot each for; past it the pager counts the unseen ones. */
const MAX_DOTS = 12

/** What the sheet says when the note has no page. */
const NO_PAGES = 'This note has no pages yet.'

/** What is said of each outcome of Open in e-ink but opened and refused. */
const OPENING_WORDS = Object.freeze({
  [InkOpening.NO_TABLET]: 'No tablet connected',
  [InkOpening.OTHER_TABLET]: 'Connected to another tablet',
  [InkOpening.NO_ANSWER]: 'The tablet did not answer',
})

/** What is said of each reason the tablet gives for refusing Open in e-ink. */
const REFUSAL_WORDS = Object.freeze({
  [InkRefusal.NOT_FOREGROUND]: 'SieveInk is not open on the tablet',
  [InkRefusal.NOT_OFFERED]: 'This note is not shared with this Sieve',
})

export class PageSurface extends AbstractSurface {
  /** The mode this surface presents. */
  static MODE = 'page'

  /** How a fixed page's sheet is sized: to the surround's width, or one grid unit to a CSS pixel. */
  static Scale = Object.freeze({ FIT: InkSheet.Scale.FIT, ACTUAL: InkSheet.Scale.ACTUAL })

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

  .ink-page__pages { display: flex; align-items: center; gap: 6px; }

  .ink-page__chrome button {
    border: 1px solid transparent;
    border-radius: 4px;
    background: none;
    color: var(--theme-textDim);
    font: inherit;
    padding: 2px 8px;
    cursor: pointer;
  }

  .ink-page__chrome button:hover:not(:disabled) {
    color: var(--theme-text);
    border-color: var(--theme-border2);
  }

  .ink-page__chrome button:disabled { opacity: 0.4; cursor: default; }

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

  .ink-page__actions { display: flex; align-items: center; gap: 6px; }

  .ink-page__status { flex-shrink: 100; color: var(--theme-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .ink-page__chrome .ink-page__open-live { color: var(--theme-muted); font-size: 0.9em; }

  .ink-page__open-live::before,
  .ink-page__indicator::before {
    content: '';
    display: inline-block;
    width: 6px;
    height: 6px;
    margin-right: 6px;
    border-radius: 50%;
    background: var(--theme-accentRed);
    vertical-align: 1px;
  }

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
  /** @type {HTMLElement} */ #title
  /** @type {HTMLElement} */ #device
  /** @type {HTMLElement} */ #notice
  /** @type {HTMLElement} the page turning: previous, position, next and the dots */ #paging
  /** @type {HTMLElement} */ #position
  /** @type {HTMLElement} */ #dots
  /** @type {HTMLButtonElement} */ #prev
  /** @type {HTMLButtonElement} */ #next
  /** @type {HTMLButtonElement} */ #scaleButton
  /** @type {HTMLElement} the whiteboard's zoom and framing buttons */ #viewTools
  /** @type {HTMLButtonElement} */ #openLive
  /** @type {HTMLButtonElement} */ #openOnTablet
  /** @type {ActionStatus} */ #status = new ActionStatus()
  /** @type {string} the name of the device the note was written on; '' when unknown */ #deviceName = ''
  /** @type {Promise<void>|null} the Open in e-ink under way */ #opening = null

  /** @type {boolean} whether a page, or the note's having none, has been shown */ #painted = false
  /** @type {Set<string>} pages with ink not seen since it arrived */ #unseen = new Set()
  /** @type {string|null} the Live view mirroring this note while it is live; null when it is not */ #liveView = null

  /** @type {{id: number, x: number, y: number}|null} the pointer dragging the sheet */ #drag = null
  /** @type {number} the scale the last WebKit gesture event reported */ #gestureScale = 1

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
    this.#sheet = new InkSheet(provider, { onSheetChanged: () => this.#sheetChanged() }, InkSheet.Policy.READER, InkSheet.Scale.FIT)
    this.#root = this.#el('div', 'ink-page ink-page--reader')
    this.#root.tabIndex = 0
    const chrome = this.#el('header', 'ink-page__chrome')
    const heading = this.#el('div', 'ink-page__heading')
    this.#title = this.#el('span', 'ink-page__title')
    this.#device = this.#el('span', 'ink-page__device')
    heading.append(this.#title, this.#device, this.#status.element)
    this.#notice = this.#el('span', 'ink-page__notice')
    this.#notice.hidden = true
    this.#notice.textContent = 'Unknown template, drawn blank'
    const pager = this.#el('nav', 'ink-page__pager')
    pager.setAttribute('aria-label', 'Pages')
    this.#paging = this.#el('span', 'ink-page__pages')
    this.#prev = this.#button('prev', '‹', 'Previous page')
    this.#position = this.#el('span', 'ink-page__position')
    this.#next = this.#button('next', '›', 'Next page')
    this.#dots = this.#el('span', 'ink-page__dots')
    this.#paging.append(this.#prev, this.#position, this.#next, this.#dots)
    this.#scaleButton = this.#button('scale', '', '')
    this.#viewTools = this.#el('span', 'ink-page__view')
    this.#viewTools.hidden = true
    this.#viewTools.append(
      this.#button('zoom-out', '−', 'Zoom out'),
      this.#button('zoom-in', '+', 'Zoom in'),
      this.#button('actual', '100%', 'One grid unit to a pixel'),
      this.#button('fit', 'Fit all', 'Frame all the ink'),
    )
    this.#openLive = this.#button('open-live', 'Live', 'Open the Live view')
    this.#openLive.className = 'ink-page__open-live'
    this.#openLive.title = 'This note is being written: open the Live view'
    this.#openLive.hidden = true
    pager.append(this.#paging, this.#scaleButton, this.#viewTools, this.#openLive)
    const actions = this.#el('span', 'ink-page__actions')
    const copy = this.#button('copy-page', 'Copy page', 'Copy the page as an image')
    copy.title = 'Copy the page as an image'
    this.#openOnTablet = this.#button('open-on-tablet', 'Open in e-ink', '')
    this.#openOnTablet.title = 'Open this note on the tablet it was written on'
    this.#openOnTablet.hidden = true
    actions.append(copy, this.#openOnTablet)
    chrome.append(heading, this.#notice, pager, actions)
    this.#root.append(chrome, this.#sheet.element)
  }

  /** @returns {string} */
  get mode() { return PageSurface.MODE }

  /**
   * Where the reader is and how much ink it holds: the page's place in the note
   * (or that it is the whiteboard) and the strokes drawn on it.
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
      ]),
    }
  }

  /** @returns {string|null} the id of the page shown */
  get shownPage() { return this.#sheet.shown }

  /** @returns {string} one of PageSurface.Scale */
  get scale() { return this.#sheet.scale }

  /** @returns {boolean} whether the page shown is drawn through a window the reader can move */
  get pannable() { return this.#sheet.pannable }

  /** @returns {InkWindow|null} the part of the plane shown; null for a fixed page */
  get window() { return this.#sheet.window }

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
    this.#status.clear()
    this.#drag = null
    this.#root.removeEventListener('click', this.#onClick)
    this.#root.removeEventListener('keydown', this.#onKeyDown)
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
   * The note's block changed: the chrome is redrawn from it, and a page is drawn
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
      this.#renderChrome()
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
    const at = Math.min(Math.max(index, 0), pages.length - 1)
    return at >= 0 ? pages[at].id : null
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
        if (!this.#sheet.takeStroke(event)) {
          this.#unseen.add(event.pageId)
          this.#renderChrome()
        }
        break
      case InkFeed.LIVE:
        this.#sheet.takeLive(event.records)
        break
      case InkFeed.LIVE_PAGE:
        this.#sheet.livePage = event.live ? event.pageId : null
        this.#liveView = event.live && event.view ? event.view : null
        this.#renderChrome()
        break
      case InkFeed.LOG_RESTARTED:
        this.#unseen.clear()
        this.#sheet.restart(NO_PAGES)
        if (this.#sheet.shown === null && this.#sheet.pages.length) this.#show(this.#sheet.pages[0].id)
        break
    }
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
   * Puts the page shown on the clipboard as an image, and says so in place.
   * @returns {Promise<void>}
   */
  copyPage() {
    const words = PageSurface.CopyWords
    return this.#sheet.copyPage().then(
      (copied) => this.#status.showResult(copied ? words.COPIED : words.NOTHING),
      (err) => {
        console.warn('[ink] the page could not be copied', err)
        this.#status.showResult(words.FAILED)
      })
  }

  /**
   * Asks the tablet the note came from to open it, saying in place that it is
   * asking and then what came of it. A second ask while one is under way is the
   * same ask.
   * @returns {Promise<void>}
   */
  openOnTablet() {
    if (this.#opening) return this.#opening
    const device = this.#deviceName || 'the tablet'
    this.#openOnTablet.disabled = true
    this.#status.showPending(`Opening on ${device}…`)
    this.#opening = this.#provider.openOnTablet()
      .then((result) => this.#status.showResult(this.#openingWords(result, device)), (err) => {
        console.warn('[ink] the tablet could not be asked to open the note', err)
        this.#status.showResult('Could not ask the tablet')
      })
      .finally(() => {
        this.#opening = null
        this.#openOnTablet.disabled = false
      })
    return this.#opening
  }

  /** @param {InkOpeningResult} result @param {string} device @returns {string} */
  #openingWords(result, device) {
    if (result.outcome === InkOpening.OPENED) return `Opened on ${device}`
    if (result.outcome === InkOpening.REFUSED) {
      return Object.hasOwn(REFUSAL_WORDS, result.reason)
        ? REFUSAL_WORDS[/** @type {keyof typeof REFUSAL_WORDS} */ (result.reason)]
        : `The tablet refused (${result.reason || 'no reason given'})`
    }
    return Object.hasOwn(OPENING_WORDS, result.outcome)
      ? OPENING_WORDS[/** @type {keyof typeof OPENING_WORDS} */ (result.outcome)]
      : 'Could not ask the tablet'
  }

  /** Switches a fixed page's sheet between fitting the surround's width and actual size. */
  toggleScale() {
    this.#sheet.scale = this.#sheet.scale === PageSurface.Scale.FIT ? PageSurface.Scale.ACTUAL : PageSurface.Scale.FIT
    this.#renderChrome()
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
    this.#title.textContent = String(attrs.title || 'Untitled note')
    this.#deviceName = String((attrs.note_device && attrs.note_device.name) || '')
    this.#device.textContent = this.#deviceName
    this.#openOnTablet.hidden = !attrs.note_source_id
  }

  /** @param {string|null} pageId */
  #show(pageId) {
    this.#painted = true
    if (pageId !== null) this.#unseen.delete(pageId)
    this.#sheet.show(pageId, NO_PAGES)
    this.#renderChrome()
  }

  #sheetChanged() {
    this.#notice.hidden = !this.#sheet.unknownTemplate
    this.#measured()
  }

  #renderChrome() {
    const sheet = this.#sheet
    const pages = sheet.pages
    const index = sheet.indexOf(sheet.shown)
    const count = pages.length
    const whiteboard = sheet.isUnbounded(sheet.shown)
    this.#paging.hidden = whiteboard && count === 1
    this.#position.textContent = count ? `${index + 1} / ${count}` : '0 / 0'
    this.#prev.disabled = index <= 0
    this.#next.disabled = index < 0 || index >= count - 1
    this.#dots.replaceChildren(...(count > MAX_DOTS ? this.#unseenCount() : this.#pageDots()))
    const actual = sheet.scale === PageSurface.Scale.ACTUAL
    this.#scaleButton.hidden = whiteboard
    this.#scaleButton.textContent = actual ? 'Fit width' : '100%'
    this.#scaleButton.title = actual ? 'Fit the page to the width' : 'Show the page at actual size'
    this.#viewTools.hidden = !whiteboard
    this.#openLive.hidden = this.#liveView === null
  }

  /** @returns {HTMLButtonElement[]} one dot per page */
  #pageDots() {
    return this.#sheet.pages.map((page, i) => {
      const dot = this.#button('', '', `Page ${i + 1}`)
      dot.className = 'ink-page__dot'
      dot.dataset.inkPage = page.id
      if (page.id === this.#sheet.shown) dot.setAttribute('aria-current', 'page')
      if (this.#unseen.has(page.id)) dot.dataset.unseen = ''
      return dot
    })
  }

  /** @returns {HTMLButtonElement[]} the count of pages with unseen ink, as the button that
   *  shows the next of them; none while there are none */
  #unseenCount() {
    const unseen = this.#sheet.pages.filter((page) => this.#unseen.has(page.id)).length
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
      if (target && this.#sheet.sheetElement.contains(target)) this.#root.focus()
      return
    }
    const page = button.getAttribute('data-ink-page')
    if (page !== null) {
      if (page !== this.#sheet.shown) this.#show(page)
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
      case 'open-live': this.openLive(); break
      case 'copy-page': this.copyPage(); break
      case 'open-on-tablet': this.openOnTablet(); break
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
   * page the wheel scrolls.
   * @param {WheelEvent} event
   */
  #onWheel = (event) => {
    if (!this.pannable) return
    event.preventDefault()
    const px = event.deltaMode === 1 ? WHEEL_LINE_PX : event.deltaMode === 2 ? this.#sheet.element.clientHeight : 1
    let [dx, dy] = [event.deltaX * px, event.deltaY * px]
    if (event.ctrlKey || event.metaKey) {
      this.#zoomAt(Math.exp(-dy * WHEEL_ZOOM), event.clientX, event.clientY)
      return
    }
    if (event.shiftKey && !dx) [dx, dy] = [dy, 0]
    const u = this.#sheet.unitsPerPixel()
    if (u && (dx || dy)) this.#sheet.moveWindow((plane) => plane.pan(dx * u, dy * u))
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
