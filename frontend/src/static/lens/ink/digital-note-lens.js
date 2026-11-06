// @ts-check
// The lens of a Digital Note: one page at a time as the tablet drew it, the
// committed strokes and the stroke under the pen arriving as they are written,
// and the page being written followed while the note is live. It is read-only
// by construction: mounted over an InkContainerProvider, which has no verbs, it
// declares no capability and writes nothing.

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

/** The page each key this mount claims turns by. Only bare keys are claimed. */
const PAGE_KEYS = Object.freeze({ PageUp: -1, PageDown: 1 })

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
   * PageUp and PageDown turn the page; nothing else is claimed.
   * @param {KeyboardEvent} event
   * @returns {boolean}
   */
  claimKey(event) {
    const surface = this.surface
    if (!(surface instanceof PageSurface)) return false
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return false
    if (!Object.hasOwn(PAGE_KEYS, event.key)) return false
    surface.turn(PAGE_KEYS[/** @type {keyof typeof PAGE_KEYS} */ (event.key)])
    return true
  }

  /**
   * @protected
   * @param {string} _mode
   * @returns {PageSurface}
   */
  _createSurface(_mode) { return new PageSurface(this.provider, (event) => this.claimKey(event)) }
}
