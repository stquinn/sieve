// @ts-check
// The mirror's surface: the page the tablet is writing on, on an InkSheet that
// follows the tablet — on a whiteboard the tablet's window, on a fixed page the
// stroke under the pen — under a chrome that names the device, the note and the
// page and says whether the tablet is live. The Live view's block says which
// note and page those are; the container's feed brings what is drawn on them.
// Nothing here turns, pans or zooms: the reader's only gesture is Open this note.

import { AbstractSurface, SurfaceEvent, SurfaceIntent } from '../abstract-surface.js'
import { InkFeed } from '../../contract/ink-container-provider.js'
import { rendererStyles } from '../../renderers/renderer-style-registry.js'
import { InkSheet } from './ink-sheet.js'
import { PageSurface } from './page-surface.js'

/** @typedef {import('../../contract/ink-container-provider.js').InkContainerProvider} InkContainerProvider */
/** @typedef {import('../../contract/ink-container-provider.js').InkFeedEvent} InkFeedEvent */
/** @typedef {import('../../renderers/ink-renderer.js').InkWindow} InkWindow */
/** @typedef {import('../abstract-surface.js').SurfaceStats} SurfaceStats */

/**
 * What the surface asks of the lens that made it.
 * @typedef {object} LiveSurfaceHost
 * @property {(event: import('../abstract-surface.js').SurfaceEventMsg) => void} onSurfaceEvent
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

  static styles = /* css */ `
  .ink-page__indicator { color: var(--theme-accentRed); white-space: nowrap; }

  .ink-page__indicator[data-waiting] { color: var(--theme-muted); }

  .ink-page__indicator[data-waiting]::before { background: none; box-shadow: inset 0 0 0 1px var(--theme-muted); }
`

  /** @type {InkContainerProvider} */ #provider
  /** @type {LiveSurfaceHost} */ #host
  /** @type {InkSheet} */ #sheet

  /** @type {boolean} between mount and unmount */ #mounted = false
  /** @type {HTMLElement} */ #root
  /** @type {HTMLElement} */ #title
  /** @type {HTMLElement} */ #device
  /** @type {HTMLElement} */ #position
  /** @type {HTMLElement} */ #indicator
  /** @type {HTMLButtonElement} */ #openNote

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
    rendererStyles.register(LiveSurface)
    this.#sheet = new InkSheet(provider, { onSheetChanged: () => this.#measured() }, InkSheet.Policy.MIRROR, InkSheet.Scale.WHOLE)
    this.#root = this.#el('div', 'ink-page ink-page--mirror')
    const chrome = this.#el('header', 'ink-page__chrome')
    const heading = this.#el('div', 'ink-page__heading')
    this.#title = this.#el('span', 'ink-page__title')
    this.#device = this.#el('span', 'ink-page__device')
    heading.append(this.#title, this.#device)
    this.#position = this.#el('span', 'ink-page__position')
    this.#indicator = this.#el('span', 'ink-page__indicator')
    this.#openNote = document.createElement('button')
    this.#openNote.type = 'button'
    this.#openNote.dataset.inkAction = 'open-note'
    this.#openNote.textContent = 'Open this note'
    chrome.append(heading, this.#position, this.#indicator, this.#openNote)
    this.#root.append(chrome, this.#sheet.element)
  }

  /** @returns {string} */
  get mode() { return LiveSurface.MODE }

  /** @returns {string|null} the id of the page shown */
  get shownPage() { return this.#sheet.shown }

  /** @returns {Mirrored} what the view mirrors */
  get mirrored() { return this.#mirrored }

  /** @returns {InkWindow|null} the part of the plane shown; null for a fixed page */
  get window() { return this.#sheet.window }

  /**
   * That the view is live or waiting, where the page is in the note, and the ink on it.
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
        Object.freeze({ text: this.#mirrored.waiting ? 'Waiting' : 'Live', title: 'The tablet' }),
        Object.freeze({ text: where, title: 'Page' }),
        Object.freeze({ text: `${count} stroke${count === 1 ? '' : 's'}`, title: 'Strokes on this page' }),
      ]),
    }
  }

  /**
   * Puts the view in the editor's root and starts hearing the feed.
   * @param {HTMLElement} rootEl
   */
  mount(rootEl) {
    this.#root.addEventListener('click', this.#onClick)
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
    this.#root.removeEventListener('click', this.#onClick)
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
      this.#renderChrome()
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
    this.#title.textContent = this.#mirrored.title || (container ? 'Untitled note' : 'Live')
    this.#device.textContent = String((attrs.note_device && attrs.note_device.name) || '')
  }

  /** @param {string|null} pageId */
  #show(pageId) {
    this.#painted = true
    this.#sheet.show(pageId, NOTHING)
    this.#renderChrome()
  }

  #renderChrome() {
    const sheet = this.#sheet
    const index = sheet.indexOf(sheet.shown)
    const count = sheet.pages.length
    this.#position.hidden = index < 0
    this.#position.textContent = sheet.isUnbounded(sheet.shown) ? 'Whiteboard' : `Page ${index + 1} / ${count}`
    const waiting = this.#mirrored.waiting
    this.#indicator.textContent = waiting ? 'Waiting for the tablet…' : 'Live'
    if (waiting) this.#indicator.dataset.waiting = ''
    else delete this.#indicator.dataset.waiting
    this.#openNote.disabled = !this.#mirrored.container
  }

  /** Reports that what stats() measures may have changed. */
  #measured() {
    this.#host.onSurfaceEvent(SurfaceEvent.DOC_PROJECTED)
  }

  /** @param {Event} event */
  #onClick = (event) => {
    const target = /** @type {Element} */ (event.target)
    const button = target && typeof target.closest === 'function' ? target.closest('button') : null
    if (button && button.getAttribute('data-ink-action') === 'open-note') this.openNote()
  }

  /** @param {string} tag @param {string} className @returns {HTMLElement} */
  #el(tag, className) {
    const el = document.createElement(tag)
    el.className = className
    return el
  }
}
