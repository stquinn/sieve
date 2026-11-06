// @ts-check
// The reader's surface of a Digital Note's transcript: the page the reader is on,
// the transcript as text and diagrams, drawn read-only by the renderers every block kind
// has, on the editor's own background and at its text width. Beside the transcript
// it offers to transcribe the page, and to make a new document from the transcript;
// the workspace toolbar is offered its pager, and a right-click on it asks its
// lens for the lens's menu.
// What it draws is what the host says of the page's transcript: it never decides
// whether a transcript is current, and hears the feed so that a transcript that
// changes, or ink that lands on the page, is asked of the host again.

import { AbstractSurface, SurfaceEvent, SurfaceIntent } from '../abstract-surface.js'
import { InkFeed, InkTranscriptState } from '../../contract/ink-container-provider.js'
import { rendererStyles } from '../../renderers/renderer-style-registry.js'
import { QuestionListView } from '../../renderers/question-list-view.js'
import { ActionStatus } from './action-status.js'
import { InkPlace } from './ink-place.js'
import { NotePager } from './note-pager.js'
import { PageSurface } from './page-surface.js'

/** @typedef {import('../../contract/ink-container-provider.js').InkContainerProvider} InkContainerProvider */
/** @typedef {import('../../contract/ink-container-provider.js').InkFeedEvent} InkFeedEvent */
/** @typedef {import('../../contract/ink-container-provider.js').InkTranscript} InkTranscript */
/** @typedef {import('./page-surface.js').ReaderView} ReaderView */
/** @typedef {import('./page-surface.js').PageSurfaceHost} PageSurfaceHost */
/** @typedef {import('../abstract-surface.js').SurfaceStats} SurfaceStats */
/** @typedef {import('./note-pager.js').NotePage} NotePage */

export class TranscriptSurface extends AbstractSurface {
  /** The mode this surface presents. */
  static MODE = 'transcript'

  /** What the surface says, by the state of the page's transcript. */
  static Words = Object.freeze({
    NO_PAGES: 'This note has no pages yet.',
    INVITE: 'This page has not been transcribed yet. Transcribing it turns the handwriting into text and the sketches into diagrams.',
    RUNNING: 'Transcribing this page…',
    STALE: 'This page has changed since it was transcribed.',
    LOADING: 'Asking for this page’s transcript…',
    UNANSWERED: 'The transcript of this page could not be asked for.',
    MAKING: 'Making a document…',
    NOT_MADE: 'Could not make a document',
  })

  static styles = /* css */ `
  .ink-page--transcript .ink-transcript {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    background: var(--theme-bg);
  }

  .ink-transcript__page {
    box-sizing: border-box;
    max-width: var(--theme-editorMeasure, 46rem);
    padding: 20px 24px 48px;
    font-size: var(--doc-size, 16px);
    color: var(--theme-text);
  }

  .ink-transcript__bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px 12px;
    margin-bottom: 16px;
    font-family: var(--theme-uiFont);
    font-size: 0.85em;
    color: var(--theme-textDim);
  }

  .ink-transcript__bar [hidden] { display: none; }

  .ink-transcript__notice { flex: 1 1 auto; }

  .ink-transcript__bar .ink-page__status { color: var(--theme-text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .ink-transcript__notice[data-tone="warn"] { color: var(--theme-accentYellow); }

  .ink-transcript__bar button {
    border: 1px solid var(--theme-border2);
    border-radius: 4px;
    background: none;
    color: var(--theme-text);
    font: inherit;
    padding: 3px 10px;
    cursor: pointer;
  }

  .ink-transcript__bar button:hover { background: var(--theme-bgAlt); }

  .ink-transcript__bar button:focus-visible {
    outline: 2px solid var(--theme-accentPrimary);
    outline-offset: 1px;
  }

  .ink-transcript__blocks.tiptap {
    min-height: 0;
    padding: 0;
    max-width: none;
  }

  .ink-transcript__blocks > .ai-block__element + .ai-block__element { margin-top: 0.75rem; }

  .ink-transcript__blocks[data-stale] { opacity: 0.75; }
`

  /** @type {InkContainerProvider} */ #provider
  /** @type {PageSurfaceHost} */ #host
  /** @type {QuestionListView} */ #list
  /** @type {ActionStatus} what is under way, or came of the last New document */ #status = new ActionStatus()
  /** @type {NotePager} */ #pager = new NotePager(this)
  /** @type {string} the name of the device the note was written on; '' when unknown */ #device = ''

  /** @type {boolean} between mount and unmount */ #mounted = false
  /** @type {HTMLElement} */ #root
  /** @type {HTMLElement} */ #bar
  /** @type {HTMLElement} */ #notice
  /** @type {HTMLButtonElement} */ #newDocument
  /** @type {HTMLButtonElement} */ #transcribeButton
  /** @type {HTMLElement} */ #blocks

  /** @type {ReadonlyArray<NotePage>} the note's pages */ #pages = []
  /** @type {string|null} the page the reader is on */ #shown = null
  /** @type {Set<string>} pages with ink not seen since it arrived */ #unseen = new Set()
  /** @type {ReaderView|null} the view handed to this surface */ #handed
  /** @type {number} the highest log seq heard */ #heardSeq = 0
  /** @type {number} the latest stroke start heard; -1 before any */ #heardMillis = -1
  /** @type {InkTranscript|null} the transcript of the page shown, as last told */ #transcript = null
  /** @type {number} numbers the asks, so only the answer to the latest is drawn */ #asked = 0
  /** @type {Promise<void>|null} the New document under way */ #making = null
  /** @type {string} what the transcribe button says; '' while the transcript offers no transcribing */ #transcribeLabel = ''
  /** @type {boolean} whether the page is to be transcribed once its transcript says there is none */ #transcribeOnArrival = false

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
    this.#handed = view
    if (view) {
      this.#unseen = new Set(view.unseen)
      this.#heardSeq = view.seq
      this.#heardMillis = view.startMillis
    }
    rendererStyles.register(PageSurface)
    rendererStyles.register(TranscriptSurface)
    this.#list = new QuestionListView(provider.getUuid())
    this.#root = this.#element('div', 'ink-page ink-page--transcript')
    this.#root.tabIndex = 0
    const body = this.#element('div', 'ink-transcript')
    const page = this.#element('div', 'ink-transcript__page')
    this.#bar = this.#element('div', 'ink-transcript__bar')
    this.#notice = this.#element('span', 'ink-transcript__notice')
    this.#newDocument = this.#button('new-document', 'New document', 'Make an ordinary document from this transcript')
    this.#transcribeButton = this.#button('transcribe', 'Transcribe this page', '')
    this.#bar.append(this.#notice, this.#status.element, this.#newDocument, this.#transcribeButton)
    this.#blocks = this.#element('div', 'ink-transcript__blocks tiptap')
    page.append(this.#bar, this.#blocks)
    body.append(page)
    this.#root.append(body)
  }

  /** @returns {string} */
  get mode() { return TranscriptSurface.MODE }

  /** @returns {string|null} the id of the page the reader is on */
  get shownPage() { return this.#shown }

  /** @override @returns {Readonly<import('../document-editor/selection-model.js').RawSelectionDescriptor>} the page shown */
  feedSelection() { return InkPlace.describe(this.mode, this.#index(), this.#pages.length) }

  /** @returns {ReadonlySet<string>} the pages marked as holding ink not yet seen */
  get unseenPages() { return this.#unseen }

  /** @returns {InkTranscript|null} the transcript drawn, as the host last told it */
  get transcript() { return this.#transcript }

  /** @returns {string} what transcript the page is offered as — `Transcribe this page`,
   *  `Transcribe again` or `Try again` — by the transcript drawn; '' while none is offered */
  get transcribeLabel() { return this.#transcribeLabel }

  /** @returns {boolean} whether the transcript drawn is one a document can be made from */
  get documentOffered() {
    const transcript = this.#transcript
    return !!transcript && transcript.state === InkTranscriptState.READY && !transcript.running
  }

  /** @returns {boolean} whether a New document is under way */
  get making() { return this.#making !== null }

  /**
   * Where the reader is, how much of the page was read, and the device the note
   * was written on, when it is known.
   * @returns {SurfaceStats}
   */
  stats() {
    const index = this.#index()
    const where = index < 0 ? 'No pages' : `Page ${index + 1} of ${this.#pages.length}`
    const count = this.#transcript ? this.#transcript.blocks.length : 0
    return {
      chars: 0, lines: 0, blockCount: count,
      readout: Object.freeze([
        Object.freeze({ text: where, title: 'Page' }),
        Object.freeze({ text: this.#transcript && this.#transcript.state !== InkTranscriptState.NONE ? `Transcript, ${count} block${count === 1 ? '' : 's'}` : 'No transcript', title: 'Transcript' }),
        ...(this.#device ? [Object.freeze({ text: this.#device, title: 'Written on' })] : []),
      ]),
    }
  }

  /**
   * What the surface offers the toolbar: the pager.
   * @returns {import('../../renderers/toolbar-button.js').ButtonGroup[]}
   */
  toolbarContents() {
    return [this.#pager.group(this.#pages, this.#shown, this.#unseen)]
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
      mode: TranscriptSurface.MODE,
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
    this.#root.addEventListener('contextmenu', this.#onContextMenu)
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
    this.#list.destroy()
    this.#root.removeEventListener('click', this.#onClick)
    this.#root.removeEventListener('keydown', this.#onKeyDown)
    this.#root.removeEventListener('contextmenu', this.#onContextMenu)
    this.#root.remove()
  }

  /** Puts the keyboard on the surface. */
  focusEditor() { this.#root.focus() }

  flushPending() {}

  /**
   * The note's block changed: the toolbar is asked again, and the transcript asked
   * for again when the page to show is another one.
   * @param {unknown} _change @param {InkContainerProvider} provider
   */
  applyContainerChange(_change, provider) {
    const before = this.#shown
    this.#readNote(provider)
    const target = this.#target()
    if (target !== before || this.#transcript === null) this.#show(target)
    else this.#toolbarChanged()
  }

  /** @param {InkContainerProvider} provider */
  paintContainer(provider) {
    this.#readNote(provider)
    this.#show(this.#target())
  }

  /**
   * One event of the note's feed. Ink on another page marks it unseen; ink on
   * the page shown has the page's transcript asked for again, which is how a transcript
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
      case InkFeed.TRANSCRIPT:
        if (event.transcript.pageId === this.#shown) this.#draw(event.transcript)
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
   * Has the page shown transcribed if its transcript says it has none, as soon as the
   * transcript is known; a page that has one, or is being transcribed, is left as it is.
   */
  transcribeIfUntranscribed() {
    this.#transcribeOnArrival = true
    if (this.#transcript) this.#transcribeOnArrivalCheck(this.#transcript)
  }

  /**
   * Asks for the page shown to be transcribed, and draws what is then known of it.
   * @returns {Promise<void>}
   */
  transcribePage() {
    const page = this.#shown
    if (page === null) return Promise.resolve()
    const asked = ++this.#asked
    return this.#provider.transcribePage(page).then(
      (transcript) => { if (asked === this.#asked) this.#draw(transcript) },
      (err) => { if (asked === this.#asked) this.#unanswered(err) })
  }

  /**
   * Asks for a new document made from the transcript of the page shown and, once
   * it is made, for the host to open it. A second ask while one is under way is
   * the same ask.
   * @returns {Promise<void>}
   */
  newDocument() {
    if (this.#making) return this.#making
    const page = this.#shown
    if (page === null) return Promise.resolve()
    const status = this.#status
    status.showPending(TranscriptSurface.Words.MAKING)
    this.#newDocument.disabled = true
    this.#toolbarChanged()
    this.#making = this.#provider.newDocumentFromTranscript(page)
      .then((uuid) => {
        status.clear()
        this.#host.onSurfaceEvent({ type: SurfaceIntent.OPEN_CONTAINER, uuid: uuid })
      }, (err) => {
        console.warn('[ink] a document could not be made from the transcript', err)
        status.showResult(TranscriptSurface.Words.NOT_MADE)
      })
      .finally(() => {
        this.#making = null
        this.#newDocument.disabled = false
        this.#toolbarChanged()
      })
    this.#toolbarChanged()
    return this.#making
  }

  /** @param {InkContainerProvider} provider */
  #readNote(provider) {
    const id = provider.getOrder()[0]
    const block = id ? provider.getBlock(id) : null
    const attrs = (block && block.attrs) || {}
    const pages = attrs.note && Array.isArray(attrs.note.pages) ? attrs.note.pages : []
    this.#pages = pages.filter((/** @type {any} */ p) => p && p.id)
      .map((/** @type {Record<string, any>} */ p) => Object.freeze({ id: String(p.id), name: typeof p.name === 'string' ? p.name : '' }))
    this.#device = String((attrs.note_device && attrs.note_device.name) || '')
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
    if (pageId !== this.#shown) {
      this.#transcript = null
      this.#transcribeOnArrival = false
    }
    this.#shown = pageId
    if (pageId !== null) this.#unseen.delete(pageId)
    this.#toolbarChanged()
    if (pageId === null) {
      this.#drawNothing(TranscriptSurface.Words.NO_PAGES)
      return
    }
    if (!this.#transcript) this.#drawNothing(TranscriptSurface.Words.LOADING)
    this.#ask()
  }

  /** Asks the host what is known of the transcript of the page shown. */
  #ask() {
    const page = this.#shown
    if (page === null) return
    const asked = ++this.#asked
    this.#provider.loadTranscript(page).then(
      (transcript) => { if (asked === this.#asked && this.#mounted) this.#draw(transcript) },
      (err) => { if (asked === this.#asked && this.#mounted) this.#unanswered(err) })
  }

  /**
   * Draws a transcript of the page shown: what is known of it in the bar, and its
   * blocks below.
   * @param {InkTranscript} transcript
   */
  #draw(transcript) {
    this.#transcript = transcript
    const W = TranscriptSurface.Words
    const hasTranscript = transcript.state !== InkTranscriptState.NONE
    let notice = ''
    let tone = ''
    let transcribeLabel = ''
    if (transcript.running) this.#status.showPending(W.RUNNING)
    else if (!this.#making) this.#status.clear()
    if (transcript.running) {
      notice = hasTranscript && transcript.state === InkTranscriptState.STALE ? W.STALE : ''
    } else if (!transcript.available) {
      notice = transcript.unavailable
    } else if (transcript.failed) {
      notice = transcript.failed
      tone = 'warn'
      transcribeLabel = 'Try again'
    } else if (transcript.state === InkTranscriptState.STALE) {
      notice = W.STALE
      tone = 'warn'
      transcribeLabel = 'Transcribe again'
    } else if (!hasTranscript) {
      notice = W.INVITE
      transcribeLabel = 'Transcribe this page'
    }
    this.#notice.textContent = notice
    this.#notice.hidden = notice === ''
    if (tone) this.#notice.dataset.tone = tone
    else delete this.#notice.dataset.tone
    this.#transcribeLabel = transcribeLabel
    this.#transcribeButton.hidden = transcribeLabel === ''
    this.#transcribeButton.textContent = transcribeLabel
    this.#newDocument.hidden = !this.documentOffered
    this.#fill(transcript.blocks, transcript.state === InkTranscriptState.STALE)
    this.#toolbarChanged()
    this.#transcribeOnArrivalCheck(transcript)
  }

  /** Transcribes the page when it was asked to be, if it has none and `transcript` says it is.
   *  @param {InkTranscript} transcript */
  #transcribeOnArrivalCheck(transcript) {
    if (!this.#transcribeOnArrival) return
    this.#transcribeOnArrival = false
    if (transcript.state === InkTranscriptState.NONE && transcript.available && !transcript.running && !transcript.failed) this.transcribePage()
  }

  /** The transcript could not be asked for. @param {unknown} err */
  #unanswered(err) {
    console.warn('[ink] the transcript of a page could not be asked for', err)
    this.#transcript = null
    this.#drawNothing(TranscriptSurface.Words.UNANSWERED)
  }

  /** Draws no transcript and says `text`. @param {string} text */
  #drawNothing(text) {
    this.#notice.textContent = text
    this.#notice.hidden = false
    delete this.#notice.dataset.tone
    this.#transcribeLabel = ''
    this.#transcribeButton.hidden = true
    this.#newDocument.hidden = true
    this.#fill([], false)
    this.#toolbarChanged()
  }

  /** @param {InkTranscript['blocks']} blocks @param {boolean} stale */
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
      case 'transcribe': this.transcribePage(); break
      case 'new-document': this.newDocument(); break
    }
  }

  /** @param {KeyboardEvent} event */
  #onKeyDown = (event) => {
    if (this.#host.claimKey(event)) event.preventDefault()
  }

  /** A right-click, or the menu key, anywhere in the transcript — on one of its
   *  blocks included — asks the lens for its menu. @param {MouseEvent} event */
  #onContextMenu = (event) => {
    event.preventDefault()
    event.stopPropagation()
    this.#host.onSurfaceEvent(this.contextMenuIntent(event, this.#root))
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
