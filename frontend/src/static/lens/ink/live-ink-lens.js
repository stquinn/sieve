// @ts-check
// The lens of the Live view: a strict mirror of the tablet — the note being
// written, the page written on and, on a whiteboard, the tablet's window — that
// the reader cannot turn, pan or zoom. Its gestures ask the host to open the
// note in a tab of its own and copy the page as an image. Mounted over an
// InkContainerProvider, it declares no capability and writes nothing.

import { AbstractEditor } from '../abstract-editor.js'
import { LensCapability } from '../../contract/lens-capabilities.js'
import { ContractViolation } from '../../contract/sieve-block.js'
import { LiveSurface } from './live-surface.js'

/** The one mode the Live view is presented in. */
const MODES = Object.freeze([LiveSurface.MODE])

const NO_CAPABILITY = Object.freeze({
  [LensCapability.MARKDOWN]: false,
  [LensCapability.MENTIONS]: false,
  [LensCapability.COMMANDS]: false,
  [LensCapability.BLOCKS]: false,
})

export class LiveInkLens extends AbstractEditor {
  /**
   * @param {string} uuid the Live view's container
   * @param {import('../abstract-editor.js').AbstractEditorOptions} [options]
   *   `provider` must be an InkContainerProvider
   */
  constructor(uuid, options = {}) {
    super(uuid, options)
    if (typeof this.provider.loadPage !== 'function') {
      throw new ContractViolation('LiveInkLens: construct with an InkContainerProvider')
    }
  }

  /** @protected @returns {Readonly<import('../../contract/lens-capabilities.js').LensCapabilities>} */
  get _innateCapabilities() { return NO_CAPABILITY }

  /** @protected @returns {ReadonlyArray<string>} */
  get _modes() { return MODES }

  /** @protected @returns {string} */
  get _defaultMode() { return LiveSurface.MODE }

  /** @protected @returns {string} */
  get _blockMode() { return LiveSurface.MODE }

  /** @returns {string} */
  get placeholder() { return '' }

  /**
   * @protected
   * @param {string} _mode
   * @returns {LiveSurface}
   */
  _createSurface(_mode) { return new LiveSurface(this.provider, this) }
}
