// @ts-check
// The lens a block container gets when its kind has no lens of its own, so that
// no block is unopenable. It presents the container's block as a record, in one
// mode, and is read-only by construction: it is mounted over a provider with no
// verbs and declares no capability.

import { AbstractEditor } from '../abstract-editor.js'
import { LensCapability } from '../../contract/lens-capabilities.js'
import { BlockRecordSurface } from './block-record-surface.js'

/** The one mode a record is presented in. */
const MODES = Object.freeze([BlockRecordSurface.MODE])

const NO_CAPABILITY = Object.freeze({
  [LensCapability.MARKDOWN]: false,
  [LensCapability.MENTIONS]: false,
  [LensCapability.COMMANDS]: false,
  [LensCapability.BLOCKS]: false,
})

export class BlockLens extends AbstractEditor {
  /** @protected @returns {Readonly<import('../../contract/lens-capabilities.js').LensCapabilities>} */
  get _innateCapabilities() { return NO_CAPABILITY }

  /** @protected @returns {ReadonlyArray<string>} */
  get _modes() { return MODES }

  /** @protected @returns {string} */
  get _defaultMode() { return BlockRecordSurface.MODE }

  /** @protected @returns {string} */
  get _blockMode() { return BlockRecordSurface.MODE }

  /** @returns {string} */
  get placeholder() { return '' }

  /**
   * @protected
   * @param {string} _mode
   * @returns {BlockRecordSurface}
   */
  _createSurface(_mode) { return new BlockRecordSurface(this.uuid) }
}
