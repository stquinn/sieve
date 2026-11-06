// @ts-check
// The lens of the Live view: a strict mirror of the tablet — the note being
// written, the page written on and, on a whiteboard, the tablet's window — that
// the reader cannot turn, pan or zoom. What it can do is open the note in a tab
// of its own and copy the page as an image, from the toolbar or its context
// menu.

import { InkLens } from './ink-lens.js'
import { ActionList } from '../../renderers/action-list.js'
import { LiveSurface } from './live-surface.js'

/** The one mode the Live view is presented in. */
const MODES = Object.freeze([LiveSurface.MODE])

export class LiveInkLens extends InkLens {
  /** @protected @returns {ReadonlyArray<string>} */
  get _modes() { return MODES }

  /** @protected @returns {string} */
  get _defaultMode() { return LiveSurface.MODE }

  /** @protected @returns {string} */
  get _blockMode() { return LiveSurface.MODE }

  /** @returns {string} */
  get placeholder() { return '' }

  /** @override @protected @returns {ActionList} */
  _declareActions() {
    const live = () => (this.surface instanceof LiveSurface ? this.surface : null)
    return new ActionList([
      {
        id: 'open-note', label: 'Open this note', title: 'Open the note being written in a tab of its own', modes: MODES,
        enabled: () => !!live()?.mirrored.container, run: () => live()?.openNote(),
      },
      {
        id: 'copy-page', label: 'Copy page', title: 'Copy the page as an image', modes: MODES,
        run: () => live()?.copyPage(),
      },
    ])
  }

  /**
   * @protected
   * @param {string} _mode
   * @returns {LiveSurface}
   */
  _createSurface(_mode) { return new LiveSurface(this.provider, this) }
}
