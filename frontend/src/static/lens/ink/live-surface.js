// @ts-check
// The mirror's surface: the page the tablet is writing on, on an InkSheet that
// follows the tablet — on a whiteboard the tablet's window, on a fixed page the
// stroke under the pen. The Live view's block says which note and page those
// are; the container's feed brings what is drawn on them. Whether the tablet is
// live, the note, the page and the device are its readout. Nothing here turns,
// pans or zooms; it offers the toolbar nothing of its own, and a right-click on
// it asks its lens for the lens's menu.

import { AbstractSurface, SurfaceEvent, SurfaceIntent } from '../abstract-surface.js'
import { InkFeed } from '../../contract/ink-container-provider.js'
import { rendererStyles } from '../../renderers/renderer-style-registry.js'
import { InkPlace } from './ink-place.js'
import { InkSheet } from './ink-sheet.js'
import { PageSurface } from './page-surface.js'

/** @typedef {import('../../contract/ink-container-provider.js').InkContainerProvider} InkContainerProvider */
/** @typedef {import('../../contract/ink-container-provider.js').InkFeedEvent} InkFeedEvent */
/** @typedef {import('../../renderers/ink-renderer.js').InkWindow} InkWindow */
/** @typedef {import('../abstract-surface.js').SurfaceStats} SurfaceStats */

/**
 * What the surface asks of the lens that made it: where its events are
 * reported, and where what came of an action is said.
 * @typedef {object} LiveSurfaceHost
 * @property {(event: import('../abstract-surface.js').SurfaceEventMsg) => void} onSurfaceEvent
 * @property {import('./action-status.js').ActionStatus} actionStatus
 */

/**
 * What the Live view's block says it mirrors: the note's container ('' before
 * one holds it), its title, the page written on ('' when none) and whether the
 * view is waiting for the tablet.
 * @typedef {Readonly<{container: string, title: string, page: string, waiting: boolean}>} Mirrored
 */

/** What the sheet says when the view mirrors no page. */
const NOTHING = 'Nothing has been written yet.'

export class LiveSurface extends AbstractSurface {
  /** The mode this surface presents. */
  static MODE = 'mirror'

  /** @type {InkContainerProvider} */ #provider
  /** @type {LiveSurfaceHost} */ #host
  /** @type {InkSheet} */ #sheet

  /** @type {boolean} between mount and unmount */ #mounted = false
  /** @type {HTMLElement} */ #root
  /** @type {string} the name of the device the note is written on; '' when unknown */ #device = ''

  /** @type {Mirrored} */ #mirrored = Object.freeze({ container: '', title: '', page: '', waiting: false })
  /** @type {boolean} whether a page, or there being none, has been shown */ #painted = false

  /**
   * @param {InkContainerProvider} provider the Live view's provider; its feed is
   *   heard from mount to unmount
   * @param {LiveSurfaceHost} host
   */
  constructor(provider, host) {
    super()
    this.#provider = provider
    this.#host = host
    rendererStyles.register(PageSurface)
    this.#sheet = new InkSheet(provider, { onSheetChanged: () => this.#measured() }, InkSheet.Policy.MIRROR, InkSheet.Scale.PAGE)
    this.#root = this.#el('div', 'ink-page ink-page--mirror')
    this.#root.append(this.#sheet.element)
  }

  /** @returns {string} */
  get mode() { return LiveSurface.MODE }

  /** @returns {string|null} the id of the page shown */
  get shownPage() { return this.#sheet.shown }

  /** @override @returns {Readonly<import('../document-editor/selection-model.js').RawSelectionDescriptor>} the page shown */
  feedSelection() {
    const shown = this.#sheet.shown
    return InkPlace.describe(this.mode, shown, this.#sheet.indexOf(shown), this.#sheet.pages.length)
  }

  /** @returns {Mirrored} what the view mirrors */
  get mirrored() { return this.#mirrored }

  /** @returns {InkWindow|null} the part of the plane shown; null for a fixed page */
  get window() { return this.#sheet.window }

  /**
   * That the view is live or waiting, the note mirrored, where the page is in it,
   * the ink on it, and the device, when each is known.
   * @returns {SurfaceStats}
   */
  stats() {
    const shown = this.#sheet.shown
    const index = this.#sheet.indexOf(shown)
    const where = index < 0 ? 'No page'
      : this.#sheet.isUnbounded(shown) ? 'Whiteboard'
        : `Page ${index + 1} of ${this.#sheet.pages.length}`
    const count = this.#sheet.strokeCount
    return {
      chars: 0, lines: 0, blockCount: 0,
      readout: Object.freeze([
        Object.freeze({ text: this.#mirrored.waiting ? 'Waiting for the tablet' : 'Live', title: 'The tablet' }),
        ...(this.#mirrored.container ? [Object.freeze({ text: this.#mirrored.title || 'Untitled notebook', title: 'The notebook' })] : []),
        Object.freeze({ text: where, title: 'Page' }),
        Object.freeze({ text: `${count} stroke${count === 1 ? '' : 's'}`, title: 'Strokes on this page' }),
        ...(this.#device ? [Object.freeze({ text: this.#device, title: 'Written on' })] : []),
      ]),
    }
  }

  /**
   * Puts the view in the editor's root and starts hearing the feed.
   * @param {HTMLElement} rootEl
   */
  mount(rootEl) {
    this.#root.addEventListener('contextmenu', this.#onContextMenu)
    rootEl.appendChild(this.#root)
    this.#mounted = true
    this.#sheet.attach()
    this.#provider.subscribeFeed(this)
  }

  /** Stops hearing the feed, drops every pending frame, timer and load, and removes the DOM. */
  unmount() {
    this.#provider.unsubscribeFeed(this)
    this.#mounted = false
    this.#sheet.detach()
    this.#root.removeEventListener('contextmenu', this.#onContextMenu)
    this.#root.remove()
  }

  /**
   * The Live view's block changed: the page it names is drawn when it is another
   * page, of another note, drawn otherwise than before, or not drawn yet.
   * @param {unknown} _change @param {InkContainerProvider} provider
   */
  applyContainerChange(_change, provider) {
    const sheet = this.#sheet
    const before = { container: this.#mirrored.container, drawnWith: sheet.drawnWith(sheet.shown) }
    this.#read(provider)
    const target = this.#target()
    const undrawn = target !== null && target !== sheet.drawn && !sheet.loading
    const moved = target !== sheet.shown || this.#mirrored.container !== before.container
    if (!this.#painted || undrawn || moved || sheet.drawnWith(target) !== before.drawnWith) this.#show(target)
    else {
      this.#toolbarChanged()
      this.#measured()
    }
  }

  /** Draws the page named again. @param {InkContainerProvider} provider */
  paintContainer(provider) {
    this.#read(provider)
    this.#show(this.#target())
  }

  flushPending() {}

  /**
   * One event of the mirrored note's feed.
   * @param {InkFeedEvent} event
   */
  onFeed(event) {
    if (!this.#mounted) return
    switch (event.type) {
      case InkFeed.STROKE_ADDED:
      case InkFeed.STROKE_REMOVED:
        this.#sheet.takeStroke(event)
        break
      case InkFeed.LIVE:
        this.#sheet.takeLive(event.records)
        break
      case InkFeed.LOG_RESTARTED:
        this.#sheet.restart(NOTHING)
        break
    }
  }

  /** Asks the host to open the mirrored note in a tab of its own. Does nothing
   *  before a note is mirrored. */
  openNote() {
    const container = this.#mirrored.container
    if (container) this.#host.onSurfaceEvent({ type: SurfaceIntent.OPEN_CONTAINER, uuid: container })
  }

  /**
   * Puts the page shown, as the tablet's window frames it, on the clipboard as an
   * image, and says so.
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

  /** @returns {string|null} the page to show: the page named while the note lists it */
  #target() {
    const page = this.#mirrored.page
    return page && this.#sheet.indexOf(page) >= 0 ? page : null
  }

  /** @param {InkContainerProvider} provider */
  #read(provider) {
    const id = provider.getOrder()[0]
    const block = id ? provider.getBlock(id) : null
    const attrs = (block && block.attrs) || {}
    const live = attrs.live || {}
    const container = String(live.container || '')
    this.#mirrored = Object.freeze({
      container, title: String(live.title || ''), page: String(live.page || ''), waiting: live.waiting === true,
    })
    this.#sheet.setNote(attrs.note)
    this.#sheet.livePage = this.#mirrored.waiting || !this.#mirrored.page ? null : this.#mirrored.page
    this.#device = String((attrs.note_device && attrs.note_device.name) || '')
  }

  /** @param {string|null} pageId */
  #show(pageId) {
    this.#painted = true
    this.#sheet.show(pageId, NOTHING)
    this.#toolbarChanged()
  }

  /** Reports that what toolbarContents() offers may have changed. */
  #toolbarChanged() {
    if (this.#mounted) this.#host.onSurfaceEvent(SurfaceEvent.TOOLBAR_CHANGED)
  }

  /** Reports that what stats() measures may have changed. */
  #measured() {
    this.#host.onSurfaceEvent(SurfaceEvent.DOC_PROJECTED)
  }

  /** A right-click, or the menu key, asks the lens for its menu. @param {MouseEvent} event */
  #onContextMenu = (event) => {
    event.preventDefault()
    event.stopPropagation()
    this.#host.onSurfaceEvent(this.contextMenuIntent(event, this.#root))
  }

  /** @param {string} tag @param {string} className @returns {HTMLElement} */
  #el(tag, className) {
    const el = document.createElement(tag)
    el.className = className
    return el
  }
}
