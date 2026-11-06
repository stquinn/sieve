// @ts-check
// The reader's lens of a Digital Note: one page at a time as the tablet drew it,
// the committed strokes and the stroke under the pen arriving as they are written,
// and a whiteboard through a window the reader moves and zooms. The reader is
// never moved: what is shown changes only by the reader's hand. It is read-only by
// construction: mounted over an InkContainerProvider, which has no verb that
// writes, it declares no capability and writes nothing. Its chrome copies the page
// as an image and asks the tablet the note came from to open it.

import { AbstractEditor } from '../abstract-editor.js'
import { LensCapability } from '../../contract/lens-capabilities.js'
import { ContractViolation } from '../../contract/sieve-block.js'
import { PageSurface } from './page-surface.js'

/** The one mode a note is presented in. */
const MODES = Object.freeze([PageSurface.MODE])

const NO_CAPABILITY = Object.freeze({
  [LensCapability.MARKDOWN]: false,
  [LensCapability.MENTIONS]: false,
  [LensCapability.COMMANDS]: false,
  [LensCapability.BLOCKS]: false,
})

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

export class DigitalNoteLens extends AbstractEditor {
  /**
   * @param {string} uuid the note's container
   * @param {import('../abstract-editor.js').AbstractEditorOptions} [options]
   *   `provider` must be an InkContainerProvider
   */
  constructor(uuid, options = {}) {
    super(uuid, options)
    if (typeof this.provider.loadPage !== 'function') {
      throw new ContractViolation('DigitalNoteLens: construct with an InkContainerProvider')
    }
  }

  /** @protected @returns {Readonly<import('../../contract/lens-capabilities.js').LensCapabilities>} */
  get _innateCapabilities() { return NO_CAPABILITY }

  /** @protected @returns {ReadonlyArray<string>} */
  get _modes() { return MODES }

  /** @protected @returns {string} */
  get _defaultMode() { return PageSurface.MODE }

  /** @protected @returns {string} */
  get _blockMode() { return PageSurface.MODE }

  /** @returns {string} */
  get placeholder() { return '' }

  /**
   * Bare PageUp and PageDown turn the page. On a whiteboard, where the surround
   * does not scroll, the bare arrows move the window and `+`/`=` and `-`/`_`
   * zoom it, Shift allowed since it is how `+` is typed. Nothing with Alt, Ctrl
   * or Cmd is claimed.
   * @param {KeyboardEvent} event
   * @returns {boolean}
   */
  claimKey(event) {
    const surface = this.surface
    if (!(surface instanceof PageSurface)) return false
    if (event.altKey || event.ctrlKey || event.metaKey) return false
    const key = event.key
    if (Object.hasOwn(ZOOM_KEYS, key)) return surface.zoomBy(ZOOM_KEYS[/** @type {keyof typeof ZOOM_KEYS} */ (key)])
    if (event.shiftKey) return false
    if (Object.hasOwn(PAN_KEYS, key)) {
      const [fx, fy] = PAN_KEYS[/** @type {keyof typeof PAN_KEYS} */ (key)]
      return surface.panBy(fx, fy)
    }
    if (!Object.hasOwn(PAGE_KEYS, key)) return false
    surface.turn(PAGE_KEYS[/** @type {keyof typeof PAGE_KEYS} */ (key)])
    return true
  }

  /**
   * @protected
   * @param {string} _mode
   * @returns {PageSurface}
   */
  _createSurface(_mode) {
    return new PageSurface(this.provider, this, /** @type {import('./page-surface.js').ReaderView|null} */ (this._handedViewState))
  }
}
