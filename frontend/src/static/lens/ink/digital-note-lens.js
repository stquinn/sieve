// @ts-check
// The reader's lens of a Digital Note, in two modes. In `page`, one page at a time
// as the tablet drew it, the committed strokes and the stroke under the pen
// arriving as they are written, and a whiteboard through a window the reader
// moves and zooms. In `reading`, the page the reader is on read as text and
// diagrams, which the reader asks for and can take away as a new document.
// The reader is never moved: what is shown changes only by the reader's hand, and
// the page and the marks carry from one mode to the other. What it can do — open
// the page on the tablet, copy it, read it, make a document of the reading, go
// to the Live view, have the note named and summarised again — is one list,
// drawn in the toolbar and as its context menu. It writes nothing of the note.

import { InkLens } from './ink-lens.js'
import { SurfaceEvent } from '../abstract-surface.js'
import { ActionList } from '../../renderers/action-list.js'
import { PageSurface } from './page-surface.js'
import { ReadingSurface } from './reading-surface.js'
import { TabletOpener } from './tablet-opener.js'

/** The modes a note is presented in; neither needs a seed. */
const MODES = Object.freeze([PageSurface.MODE, ReadingSurface.MODE])

/** How the mode toggle is drawn in each mode: what pressing it shows. */
const MODE_TOGGLE = Object.freeze({
  [PageSurface.MODE]: Object.freeze({ text: 'Reading', title: 'Show the page read as text and diagrams' }),
  [ReadingSurface.MODE]: Object.freeze({ text: 'Page', title: 'Show the page as it was written' }),
})

const PAGE_ONLY = Object.freeze([PageSurface.MODE])
const READING_ONLY = Object.freeze([ReadingSurface.MODE])

/** The page each page key turns by. */
const PAGE_KEYS = Object.freeze({ PageUp: -1, PageDown: 1 })

/** The fraction of a whiteboard's window each arrow key moves it by, across and down. */
const PAN_KEYS = Object.freeze({
  ArrowLeft: Object.freeze([-0.1, 0]),
  ArrowRight: Object.freeze([0.1, 0]),
  ArrowUp: Object.freeze([0, -0.1]),
  ArrowDown: Object.freeze([0, 0.1]),
})

/** The factor each zoom key zooms a whiteboard's window by, about its centre. */
const ZOOM_KEYS = Object.freeze({ '+': 1.25, '=': 1.25, '-': 0.8, '_': 0.8 })

export class DigitalNoteLens extends InkLens {
  /** What Refresh name and summary says: asking, asked, or that nothing could be asked. */
  static RefreshWords = Object.freeze({
    ASKING: 'Asking for a new name and summary…',
    ASKED: 'A new name and summary were asked for',
    FAILED: 'Could not ask for a new name and summary',
  })

  /** @type {TabletOpener} */ #opener = new TabletOpener(this.provider, this.actionStatus, () => this.onSurfaceEvent(SurfaceEvent.TOOLBAR_CHANGED))
  /** @type {Promise<void>|null} the Refresh name and summary under way */ #refreshing = null

  /** @protected @returns {ReadonlyArray<string>} */
  get _modes() { return MODES }

  /** The mode the reader left the note in, else `page`.
   *  @protected @returns {string} */
  get _defaultMode() {
    const view = /** @type {{mode?: string}|null} */ (this._handedViewState)
    return view && view.mode === ReadingSurface.MODE ? ReadingSurface.MODE : PageSurface.MODE
  }

  /** @protected @returns {string} */
  get _blockMode() { return PageSurface.MODE }

  /** @protected @returns {ReadonlyArray<string>} */
  get _seedlessModes() { return MODES }

  /** @returns {string} */
  get placeholder() { return '' }

  /** @override @protected @returns {ActionList} */
  _declareActions() {
    const page = () => (this.surface instanceof PageSurface ? this.surface : null)
    const reading = () => (this.surface instanceof ReadingSurface ? this.surface : null)
    const opener = this.#opener
    return new ActionList([
      {
        id: 'open-on-tablet', label: 'Open in e-ink', title: 'Open this page on the tablet the note was written on', modes: MODES,
        applies: () => opener.offered, enabled: () => !opener.opening, run: () => this.openOnTablet(),
      },
      {
        id: 'copy-page', label: 'Copy page', title: 'Copy the page as an image', modes: PAGE_ONLY,
        run: () => page()?.copyPage(),
      },
      {
        id: 'read-page', label: () => reading()?.readLabel || 'Read this page', title: 'Read this page as text and diagrams', modes: MODES,
        applies: () => (reading() ? reading()?.readLabel !== '' : page()?.shownPage != null), run: () => this.readThisPage(),
      },
      {
        id: 'new-document', label: 'New document', title: 'Make an ordinary document from this reading', modes: READING_ONLY,
        applies: () => !!reading()?.documentOffered, enabled: () => !reading()?.making, run: () => reading()?.newDocument(),
      },
      {
        id: 'open-live', label: 'Go to Live', short: 'Live', className: 'tb-live', modes: PAGE_ONLY,
        title: 'This note is being written on the tablet: open the Live view',
        applies: () => !!page()?.liveView, run: () => page()?.openLive(),
      },
      {
        id: 'refresh-description', label: 'Refresh name and summary', short: 'Refresh name', modes: MODES,
        title: 'Ask for the note to be named and summarised again from its ink',
        enabled: () => this.#refreshing === null, run: () => this.refreshDescription(),
      },
    ])
  }

  /**
   * Asks the tablet the note came from to open it at the page the reader is on.
   * @returns {Promise<void>}
   */
  openOnTablet() {
    const surface = this.surface
    const shown = surface instanceof PageSurface || surface instanceof ReadingSurface ? surface.shownPage : null
    return this.#opener.open(shown)
  }

  /**
   * Reads the page the reader is on: in the reading, as its read button does;
   * on the page, by showing the reading, which has the page read when it has
   * no reading yet.
   * @returns {Promise<void>}
   */
  readThisPage() {
    if (this.surface instanceof ReadingSurface) return this.surface.readPage()
    return this.setMode(ReadingSurface.MODE).then((changed) => {
      const surface = this.surface
      if (!(surface instanceof ReadingSurface)) return
      surface.readIfUnread()
      if (changed) this.focus()
    })
  }

  /**
   * Asks for the note to be named and summarised again, saying in the action
   * status that it is asking and then what came of it. A second ask while one is
   * under way is the same ask.
   * @returns {Promise<void>}
   */
  refreshDescription() {
    if (this.#refreshing) return this.#refreshing
    const W = DigitalNoteLens.RefreshWords
    const status = this.actionStatus
    this.#refreshing = new Promise((resolve) => { resolve(this.provider.refreshDescription()) })
      .then(() => status.showResult(W.ASKED), (err) => {
        console.warn('[ink] the note could not be named again', err)
        const said = typeof err === 'string' ? err : err instanceof Error ? err.message : ''
        status.showResult(said || W.FAILED)
      })
      .finally(() => {
        this.#refreshing = null
        this.onSurfaceEvent(SurfaceEvent.TOOLBAR_CHANGED)
      })
    status.showPending(W.ASKING)
    return this.#refreshing
  }

  /** @override @protected @param {string} mode
   *  @returns {import('../abstract-editor.js').ModeToggleFace} */
  _modeToggleFace(mode) {
    return mode === ReadingSurface.MODE ? MODE_TOGGLE[ReadingSurface.MODE] : MODE_TOGGLE[PageSurface.MODE]
  }

  /**
   * Mod+Enter switches between the two modes. Bare PageUp and PageDown turn the
   * page in either. On a whiteboard shown as a page, where the surround does not
   * scroll, the bare arrows move the window and `+`/`=` and `-`/`_` zoom it,
   * Shift allowed since it is how `+` is typed. Nothing else with Alt, Ctrl or
   * Cmd is claimed.
   * @param {KeyboardEvent} event
   * @returns {boolean}
   */
  claimKey(event) {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !event.altKey && !event.shiftKey) {
      this.toggleMode()
      return true
    }
    const surface = this.surface
    if (!(surface instanceof PageSurface) && !(surface instanceof ReadingSurface)) return false
    if (event.altKey || event.ctrlKey || event.metaKey) return false
    const key = event.key
    if (surface instanceof PageSurface) {
      if (Object.hasOwn(ZOOM_KEYS, key)) return surface.zoomBy(ZOOM_KEYS[/** @type {keyof typeof ZOOM_KEYS} */ (key)])
      if (event.shiftKey) return false
      if (Object.hasOwn(PAN_KEYS, key)) {
        const [fx, fy] = PAN_KEYS[/** @type {keyof typeof PAN_KEYS} */ (key)]
        return surface.panBy(fx, fy)
      }
    }
    if (event.shiftKey || !Object.hasOwn(PAGE_KEYS, key)) return false
    surface.turn(PAGE_KEYS[/** @type {keyof typeof PAGE_KEYS} */ (key)])
    return true
  }

  /**
   * @override — the keyboard goes to the surface the flip presents.
   * @returns {Promise<boolean>} whether the mode changed
   */
  toggleMode() {
    return super.toggleMode().then((changed) => {
      if (changed) this.focus()
      return changed
    })
  }

  /**
   * @protected
   * @param {string} mode
   * @returns {PageSurface|ReadingSurface}
   */
  _createSurface(mode) {
    const view = /** @type {import('./page-surface.js').ReaderView|null} */ (this._handedViewState)
    if (mode === ReadingSurface.MODE) return new ReadingSurface(this.provider, this, view)
    return new PageSurface(this.provider, this, view)
  }
}
