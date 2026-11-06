// @ts-check
// The reader's surface of a Digital Note's reading: the page the reader is on,
// read as text and diagrams, drawn read-only by the renderers every block kind
// has, on the editor's own background and at its text width. Beside the reading
// it offers to read the page, and to make a new document from what was read;
// the workspace toolbar is offered its pager and Open in e-ink.
// What it draws is what the host says of the page's reading: it never decides
// whether a reading is current, and hears the feed so that a reading that
// changes, or ink that lands on the page, is asked of the host again.

import { AbstractSurface, SurfaceEvent, SurfaceIntent } from '../abstract-surface.js'
import { InkFeed, InkReadingState } from '../../contract/ink-container-provider.js'
import { rendererStyles } from '../../renderers/renderer-style-registry.js'
import { QuestionListView } from '../../renderers/question-list-view.js'
import { ButtonGroup, ToolbarLabel } from '../../renderers/toolbar-button.js'
import { ActionStatus } from './action-status.js'
import { NotePager } from './note-pager.js'
import { PageSurface } from './page-surface.js'
import { TabletOpener } from './tablet-opener.js'

/** @typedef {import('../../contract/ink-container-provider.js').InkContainerProvider} InkContainerProvider */
/** @typedef {import('../../contract/ink-container-provider.js').InkFeedEvent} InkFeedEvent */
/** @typedef {import('../../contract/ink-container-provider.js').InkReading} InkReading */
/** @typedef {import('./page-surface.js').ReaderView} ReaderView */
/** @typedef {import('./page-surface.js').PageSurfaceHost} PageSurfaceHost */
/** @typedef {import('../abstract-surface.js').SurfaceStats} SurfaceStats */

export class ReadingSurface extends AbstractSurface {
  /** The mode this surface presents. */
  static MODE = 'reading'

  /** What the surface says, by the state of the page's reading. */
  static Words = Object.freeze({
    NO_PAGES: 'This note has no pages yet.',
    INVITE: 'This page has not been read yet. Reading it turns the handwriting into text and the sketches into diagrams.',
    RUNNING: 'Reading this page…',
    STALE: 'This page has changed since it was read.',
    LOADING: 'Asking for this page’s reading…',
    UNANSWERED: 'The reading of this page could not be asked for.',
    MAKING: 'Making a document…',
    NOT_MADE: 'Could not make a document',
  })

  static styles = /* css */ `
  .ink-page--reading .ink-reading {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    background: var(--theme-bg);
  }

  .ink-reading__page {
    box-sizing: border-box;
    max-width: var(--theme-editorMeasure, 46rem);
    padding: 20px 24px 48px;
    font-size: var(--doc-size, 16px);
    color: var(--theme-text);
  }

  .ink-reading__bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    margin-bottom: 16px;
    font-family: var(--theme-uiFont);
    font-size: 0.85em;
    color: var(--theme-textDim);
  }

  .ink-reading__bar [hidden] { display: none; }

  .ink-reading__notice { flex: 1 1 auto; }

  .ink-reading__bar .ink-page__status { color: var(--theme-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .ink-reading__notice[data-tone="warn"] { color: var(--theme-accentYellow); }

  .ink-reading__bar button {
    border: 1px solid var(--theme-border2);
    border-radius: 4px;
    background: none;
    color: var(--theme-text);
    font: inherit;
    padding: 3px 10px;
    cursor: pointer;
  }

  .ink-reading__bar button:hover { background: var(--theme-bgAlt); }

  .ink-reading__bar button:focus-visible {
    outline: 2px solid var(--theme-accentPrimary);
    outline-offset: 1px;
  }

  .ink-reading__blocks.tiptap {
    min-height: 0;
    padding: 0;
    max-width: none;
  }

  .ink-reading__blocks > .ai-block__element + .ai-block__element { margin-top: 0.75rem; }

  .ink-reading__blocks[data-stale] { opacity: 0.75; }
`

  /** @type {InkContainerProvider} */ #provider
  /** @type {PageSurfaceHost} */ #host
  /** @type {QuestionListView} */ #list
  /** @type {ActionStatus} what is under way, or came of the last New document */ #status = new ActionStatus()
  /** @type {ActionStatus} what came of Open in e-ink */ #opened = new ActionStatus(() => this.#toolbarChanged())
  /** @type {TabletOpener} */ #opener
  /** @type {NotePager} */ #pager = new NotePager(this)

  /** @type {boolean} between mount and unmount */ #mounted = false
  /** @type {HTMLElement} */ #root
  /** @type {HTMLElement} */ #bar
  /** @type {HTMLElement} */ #notice
  /** @type {HTMLButtonElement} */ #newDocument
  /** @type {HTMLButtonElement} */ #read
  /** @type {HTMLElement} */ #blocks

  /** @type {ReadonlyArray<Readonly<{id: string}>>} the note's pages */ #pages = []
  /** @type {string|null} the page the reader is on */ #shown = null
  /** @type {Set<string>} pages with ink not seen since it arrived */ #unseen = new Set()
  /** @type {ReaderView|null} the view handed to this surface */ #handed
  /** @type {number} the highest log seq heard */ #heardSeq = 0
  /** @type {number} the latest stroke start heard; -1 before any */ #heardMillis = -1
  /** @type {InkReading|null} the reading of the page shown, as last told */ #reading = null
  /** @type {number} numbers the asks, so only the answer to the latest is drawn */ #asked = 0
  /** @type {Promise<void>|null} the New document under way */ #making = null

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
    this.#opener = new TabletOpener(provider, this.#opened, () => this.#toolbarChanged())
    this.#handed = view
    if (view) {
      this.#unseen = new Set(view.unseen)
      this.#heardSeq = view.seq
      this.#heardMillis = view.startMillis
    }
    rendererStyles.register(PageSurface)
    rendererStyles.register(ReadingSurface)
    this.#list = new QuestionListView(provider.getUuid())
    this.#root = this.#element('div', 'ink-page ink-page--reading')
    this.#root.tabIndex = 0
    const body = this.#element('div', 'ink-reading')
    const page = this.#element('div', 'ink-reading__page')
    this.#bar = this.#element('div', 'ink-reading__bar')
    this.#notice = this.#element('span', 'ink-reading__notice')
    this.#newDocument = this.#button('new-document', 'New document', 'Make an ordinary document from this reading')
    this.#read = this.#button('read', 'Read this page', '')
    this.#bar.append(this.#notice, this.#status.element, this.#newDocument, this.#read)
    this.#blocks = this.#element('div', 'ink-reading__blocks tiptap')
    page.append(this.#bar, this.#blocks)
    body.append(page)
    this.#root.append(body)
  }

  /** @returns {string} */
  get mode() { return ReadingSurface.MODE }

  /** @returns {string|null} the id of the page the reader is on */
  get shownPage() { return this.#shown }

  /** @returns {ReadonlySet<string>} the pages marked as holding ink not yet seen */
  get unseenPages() { return this.#unseen }

  /** @returns {InkReading|null} the reading drawn, as the host last told it */
  get reading() { return this.#reading }

  /**
   * Where the reader is, how much of the page was read, and the device the note
   * was written on, when it is known.
   * @returns {SurfaceStats}
   */
  stats() {
    const index = this.#index()
    const where = index < 0 ? 'No pages' : `Page ${index + 1} of ${this.#pages.length}`
    const count = this.#reading ? this.#reading.blocks.length : 0
    return {
      chars: 0, lines: 0, blockCount: count,
      readout: Object.freeze([
        Object.freeze({ text: where, title: 'Page' }),
        Object.freeze({ text: this.#reading && this.#reading.state !== InkReadingState.NONE ? `Read, ${count} block${count === 1 ? '' : 's'}` : 'Not read', title: 'Reading' }),
        ...(this.#opener.device ? [Object.freeze({ text: this.#opener.device, title: 'Written on' })] : []),
      ]),
    }
  }

  /**
   * What the surface offers the toolbar: the pager, then Open in e-ink for a
   * note from a tablet and what came of it.
   * @returns {ButtonGroup[]}
   */
  toolbarContents() {
    const groups = [this.#pager.group(this.#pages, this.#shown, this.#unseen)]
    /** @type {Array<import('../../renderers/toolbar-button.js').ToolbarItem>} */
    const actions = []
    if (this.#opener.offered) actions.push(this.#opener.button(() => this.#shown))
    if (this.#opened.text) actions.push(new ToolbarLabel({ id: 'tb-ink-status', text: () => this.#opened.text, live: true }))
    if (actions.length) groups.push(new ButtonGroup(actions))
    return groups
  }

  /**
   * Where the reader is, for the next surface over the note: the page and the
   * marks are this surface's, and how the page was framed is passed on as it was
   * handed over.
   * @returns {ReaderView}
   */
  viewState() {
    const handed = this.#handed
    return Object.freeze({
      mode: ReadingSurface.MODE,
      page: this.#shown ?? (handed ? handed.page : null),
      window: handed ? handed.window : null,
      scale: handed ? handed.scale : PageSurface.Scale.PAGE,
      unseen: Object.freeze([...this.#unseen]),
      seq: this.#heardSeq,
      startMillis: this.#heardMillis,
    })
  }

  /** Puts the surface in the editor's root and starts hearing the feed.
   *  @param {HTMLElement} rootEl */
  mount(rootEl) {
    this.#root.addEventListener('click', this.#onClick)
    this.#root.addEventListener('keydown', this.#onKeyDown)
    rootEl.appendChild(this.#root)
    this.#mounted = true
    this.#provider.subscribeFeed(this)
  }

  /** Stops hearing the feed, drops every answer still to come, and removes the DOM. */
  unmount() {
    this.#provider.unsubscribeFeed(this)
    this.#mounted = false
    this.#asked++
    this.#status.clear()
    this.#opened.clear()
    this.#list.destroy()
    this.#root.removeEventListener('click', this.#onClick)
    this.#root.removeEventListener('keydown', this.#onKeyDown)
    this.#root.remove()
  }

  /** Puts the keyboard on the surface. */
  focusEditor() { this.#root.focus() }

  flushPending() {}

  /**
   * The note's block changed: the toolbar is asked again, and the reading asked
   * for again when the page to show is another one.
   * @param {unknown} _change @param {InkContainerProvider} provider
   */
  applyContainerChange(_change, provider) {
    const before = this.#shown
    this.#readNote(provider)
    const target = this.#target()
    if (target !== before || this.#reading === null) this.#show(target)
    else this.#toolbarChanged()
  }

  /** @param {InkContainerProvider} provider */
  paintContainer(provider) {
    this.#readNote(provider)
    this.#show(this.#target())
  }

  /**
   * One event of the note's feed. Ink on another page marks it unseen; ink on
   * the page shown has the page's reading asked for again, which is how a reading
   * of the page as it was becomes one of a page that has changed.
   * @param {InkFeedEvent} event
   */
  onFeed(event) {
    if (!this.#mounted) return
    switch (event.type) {
      case InkFeed.STROKE_ADDED:
      case InkFeed.STROKE_REMOVED:
        this.#heardSeq = Math.max(this.#heardSeq, event.seq)
        if (event.type === InkFeed.STROKE_ADDED) this.#heardMillis = Math.max(this.#heardMillis, event.stroke.startMillis)
        if (event.pageId === this.#shown) this.#ask()
        else {
          this.#unseen.add(event.pageId)
          this.#toolbarChanged()
        }
        break
      case InkFeed.READING:
        if (event.reading.pageId === this.#shown) this.#draw(event.reading)
        break
      case InkFeed.LOG_RESTARTED:
        this.#unseen.clear()
        this.#heardSeq = 0
        this.#ask()
        break
    }
  }

  /** Shows the page `pageId`. @param {string} pageId */
  showPage(pageId) {
    if (pageId !== this.#shown) this.#show(pageId)
  }

  /**
   * Asks the tablet the note came from to open it at the page shown.
   * @returns {Promise<void>}
   */
  openOnTablet() { return this.#opener.open(this.#shown) }

  /**
   * Shows the page `delta` pages on from the shown one, clamped to the note.
   * @param {number} delta
   */
  turn(delta) {
    const index = this.#index()
    const to = Math.min(Math.max(index + delta, 0), this.#pages.length - 1)
    if (to < 0 || to === index) return
    this.#show(this.#pages[to].id)
  }

  /** Shows the first page with unseen ink after the shown one, from the start
   *  again past the last. */
  showNextUnseen() {
    const from = this.#index()
    for (let i = 1; i <= this.#pages.length; i++) {
      const page = this.#pages[(from + i) % this.#pages.length]
      if (this.#unseen.has(page.id)) {
        this.#show(page.id)
        return
      }
    }
  }

  /**
   * Asks for the page shown to be read, and draws what is then known of it.
   * @returns {Promise<void>}
   */
  readPage() {
    const page = this.#shown
    if (page === null) return Promise.resolve()
    const asked = ++this.#asked
    return this.#provider.readPage(page).then(
      (reading) => { if (asked === this.#asked) this.#draw(reading) },
      (err) => { if (asked === this.#asked) this.#unanswered(err) })
  }

  /**
   * Asks for a new document made from the reading of the page shown and, once
   * it is made, for the host to open it. A second ask while one is under way is
   * the same ask.
   * @returns {Promise<void>}
   */
  newDocument() {
    if (this.#making) return this.#making
    const page = this.#shown
    if (page === null) return Promise.resolve()
    const status = this.#status
    status.showPending(ReadingSurface.Words.MAKING)
    this.#newDocument.disabled = true
    this.#making = this.#provider.newDocumentFromReading(page)
      .then((uuid) => {
        status.clear()
        this.#host.onSurfaceEvent({ type: SurfaceIntent.OPEN_CONTAINER, uuid: uuid })
      }, (err) => {
        console.warn('[ink] a document could not be made from the reading', err)
        status.showResult(ReadingSurface.Words.NOT_MADE)
      })
      .finally(() => {
        this.#making = null
        this.#newDocument.disabled = false
      })
    return this.#making
  }

  /** @param {InkContainerProvider} provider */
  #readNote(provider) {
    const id = provider.getOrder()[0]
    const block = id ? provider.getBlock(id) : null
    const attrs = (block && block.attrs) || {}
    const pages = attrs.note && Array.isArray(attrs.note.pages) ? attrs.note.pages : []
    this.#pages = pages.map((/** @type {Record<string, any>} */ p) => Object.freeze({ id: String(p.id) }))
    this.#opener.setNote(attrs)
  }

  /** @returns {string|null} the page to show: the page shown while the note lists it,
   *  else the page handed over, else the first, else none */
  #target() {
    const listed = (/** @type {string|null} */ id) => id !== null && this.#pages.some((p) => p.id === id)
    if (listed(this.#shown)) return this.#shown
    const handed = this.#handed ? this.#handed.page : null
    if (listed(handed)) return handed
    return this.#pages.length ? this.#pages[0].id : null
  }

  /** @returns {number} the index of the page shown; -1 when none is */
  #index() { return this.#pages.findIndex((p) => p.id === this.#shown) }

  /** @param {string|null} pageId */
  #show(pageId) {
    if (pageId !== this.#shown) this.#reading = null
    this.#shown = pageId
    if (pageId !== null) this.#unseen.delete(pageId)
    this.#toolbarChanged()
    if (pageId === null) {
      this.#drawNothing(ReadingSurface.Words.NO_PAGES)
      return
    }
    if (!this.#reading) this.#drawNothing(ReadingSurface.Words.LOADING)
    this.#ask()
  }

  /** Asks the host what is known of the reading of the page shown. */
  #ask() {
    const page = this.#shown
    if (page === null) return
    const asked = ++this.#asked
    this.#provider.loadReading(page).then(
      (reading) => { if (asked === this.#asked && this.#mounted) this.#draw(reading) },
      (err) => { if (asked === this.#asked && this.#mounted) this.#unanswered(err) })
  }

  /**
   * Draws a reading of the page shown: what is known of it in the bar, and its
   * blocks below.
   * @param {InkReading} reading
   */
  #draw(reading) {
    this.#reading = reading
    const W = ReadingSurface.Words
    const read = reading.state !== InkReadingState.NONE
    let notice = ''
    let tone = ''
    let readLabel = ''
    if (reading.running) this.#status.showPending(W.RUNNING)
    else if (!this.#making) this.#status.clear()
    if (reading.running) {
      notice = read && reading.state === InkReadingState.STALE ? W.STALE : ''
    } else if (!reading.available) {
      notice = reading.unavailable
    } else if (reading.failed) {
      notice = reading.failed
      tone = 'warn'
      readLabel = 'Try again'
    } else if (reading.state === InkReadingState.STALE) {
      notice = W.STALE
      tone = 'warn'
      readLabel = 'Read again'
    } else if (!read) {
      notice = W.INVITE
      readLabel = 'Read this page'
    }
    this.#notice.textContent = notice
    this.#notice.hidden = notice === ''
    if (tone) this.#notice.dataset.tone = tone
    else delete this.#notice.dataset.tone
    this.#read.hidden = readLabel === ''
    this.#read.textContent = readLabel
    this.#newDocument.hidden = reading.state !== InkReadingState.READY || reading.running
    this.#fill(reading.blocks, reading.state === InkReadingState.STALE)
    this.#host.onSurfaceEvent(SurfaceEvent.DOC_PROJECTED)
  }

  /** The reading could not be asked for. @param {unknown} err */
  #unanswered(err) {
    console.warn('[ink] the reading of a page could not be asked for', err)
    this.#reading = null
    this.#drawNothing(ReadingSurface.Words.UNANSWERED)
  }

  /** Draws no reading and says `text`. @param {string} text */
  #drawNothing(text) {
    this.#notice.textContent = text
    this.#notice.hidden = false
    delete this.#notice.dataset.tone
    this.#read.hidden = true
    this.#newDocument.hidden = true
    this.#fill([], false)
  }

  /** @param {InkReading['blocks']} blocks @param {boolean} stale */
  #fill(blocks, stale) {
    this.#list.fill(this.#blocks, blocks.map((b) => ({ kind: b.kind, attrs: b.attrs })))
    this.#blocks.hidden = blocks.length === 0
    if (stale) this.#blocks.dataset.stale = ''
    else delete this.#blocks.dataset.stale
  }

  /** Reports that what toolbarContents() offers, and what stats() measures, may have changed. */
  #toolbarChanged() {
    if (!this.#mounted) return
    this.#host.onSurfaceEvent(SurfaceEvent.TOOLBAR_CHANGED)
    this.#host.onSurfaceEvent(SurfaceEvent.DOC_PROJECTED)
  }

  /** @param {Event} event */
  #onClick = (event) => {
    const target = /** @type {Element} */ (event.target)
    const button = target && typeof target.closest === 'function' ? target.closest('button') : null
    if (!button || !this.#root.contains(button)) return
    switch (button.getAttribute('data-ink-action')) {
      case 'read': this.readPage(); break
      case 'new-document': this.newDocument(); break
    }
  }

  /** @param {KeyboardEvent} event */
  #onKeyDown = (event) => {
    if (this.#host.claimKey(event)) event.preventDefault()
  }

  /** @param {string} tag @param {string} className @returns {HTMLElement} */
  #element(tag, className) {
    const el = document.createElement(tag)
    el.className = className
    return el
  }

  /** @param {string} action @param {string} text @param {string} label @returns {HTMLButtonElement} */
  #button(action, text, label) {
    const button = document.createElement('button')
    button.type = 'button'
    button.dataset.inkAction = action
    button.textContent = text
    if (label) button.setAttribute('aria-label', label)
    return button
  }
}
