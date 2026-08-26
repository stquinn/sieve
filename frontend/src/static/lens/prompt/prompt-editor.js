// @ts-check
// A prompt IS its text: it has no block tree, so its container's provider offers
// the whole-content extension and nothing else. The mode is fixed 'markdown', and
// saving is `setContents` — the only way to state a container whose entire truth
// is a buffer.

import { AbstractEditor } from '../abstract-editor.js'
import { EditorMode } from '../document-editor/editor-mode.js'
import { MarkdownSurface } from '../document-editor/surfaces/markdown-surface.js'

/**
 * @typedef {object} PromptEditorOptions
 * @property {any} [provider] — the container's provider; a prompt demands only whole-content
 * @property {() => Promise<{body?: string, version?: number, scroll?: number}>} [loadContainer] — the host's loader (see AbstractEditor)
 */

export class PromptEditor extends AbstractEditor {
  /**
   * @param {string}              uuid
   * @param {PromptEditorOptions} [options]
   */
  constructor(uuid, options = {}) {
    super(uuid, options)
  }

  /**
   * @protected
   * @returns {import('../document-editor/editor-mode.js').EditorModeValue}
   */
  get _defaultMode() { return EditorMode.MARKDOWN }

  /**
   * Markdown ONLY — `mode` is deliberately ignored; a prompt has no other surface.
   * @protected
   * @param {import('../document-editor/editor-mode.js').EditorModeValue} mode
   * @returns {import('../document-editor/surfaces/abstract-surface.js').AbstractSurface}
   */
  _createSurface(mode) {
    return new MarkdownSurface(this)
  }

  /** @returns {Promise<unknown>} */
  flushSave() {
    // A reload replaces the whole document; a save mid-reload would race it.
    if (this.isSaveSuppressed()) return Promise.resolve()

    const s = this.surface
    const body = (s && s.body) || ''
    const provider = this.provider
    // A prompt persists by STATING ITSELF: the buffer is the container, so the only
    // way to save it is to hand the whole thing over. A bare construction (no
    // provider) resolves quietly. The dirty-clear is deliberately NOT chained here —
    // a successful save announces itself as `container-saved` on the workspace wire,
    // and AbstractEditor reacts to that for every editor type alike.
    const saved = provider ? provider.setContents(body) : Promise.resolve()
    return Promise.resolve(saved).catch((err) => { console.error('[editor] save failed', err) })
  }
}
