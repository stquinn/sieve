// @ts-check
// prompt-editor.js — the editor type for prompt: documents (P2.A, P2.B).
//
// A prompt IS its text: it has no block tree, so its container's provider offers
// the whole-content extension and nothing else (issue #96). That is the whole
// difference between this type and NoteEditor — the mode is fixed 'markdown'
// because there is no other shape to be in, and saving is `setContents`, which is
// the only way to state a container whose entire truth is a buffer.
//
// It legally never receives a container cue: nothing but its own lens mutates a
// prompt. Its SAVED-SIGNAL still arrives, because that rides the workspace wire
// rather than the container's, so a prompt clears its dirty state by the same
// route a note does. The reload save guard reads AbstractEditor's own
// isSaveSuppressed.
// Dual-use ES module: `export` for vitest imports; reached in the app via the
// SieveTab.createEditor factory.

import { AbstractEditor } from '../abstract-editor.js'
import { EditorMode } from '../document-editor/editor-mode.js'
// MarkdownSurface is the prompt's ONLY surface (its fixed mode) — its whole
// repertoire, built by _createSurface below.
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
   * A prompt is fixed markdown — the pre-mount default matches the only
   * surface it ever presents.
   * @protected
   * @returns {import('../document-editor/editor-mode.js').EditorModeValue}
   */
  get _defaultMode() { return EditorMode.MARKDOWN }

  /**
   * A prompt's repertoire is markdown ONLY (its fixed mode) — `mode` is
   * deliberately ignored; there is no other surface this type can present. The
   * surface receives THIS editor (`host`) and calls its public API directly
   * (onSurfaceEvent / setRawContent / reload).
   * @protected
   * @param {import('../document-editor/editor-mode.js').EditorModeValue} mode
   * @returns {import('../document-editor/surfaces/abstract-surface.js').AbstractSurface}
   */
  _createSurface(mode) {
    return new MarkdownSurface(this)
  }

  /** @returns {Promise<unknown>} */
  flushSave() {
    // Guard: a reload replaces the whole document; a save mid-reload would race
    // it (isSaveSuppressed reads AbstractEditor's own load flag).
    if (this.isSaveSuppressed()) return Promise.resolve()

    const s = this.surface
    const body = (s && s.body) || ''
    const provider = this.provider
    // A prompt persists by STATING ITSELF: the buffer is the container, so the
    // only way to save it is to hand the whole thing over. The base's
    // requestPersist would be asking a container to write down what it holds, and
    // what a prompt holds is whatever this lens last said it was.
    // A bare construction (no provider) resolves quietly.
    // The dirty-clear is NOT chained here. A successful save announces itself as
    // `container-saved` on the workspace wire, and AbstractEditor reacts to that
    // for every editor type alike — so clearing it here as well would be a
    // second, private saved-signal that a failed save could still fire.
    const saved = provider ? provider.setContents(body) : Promise.resolve()
    return Promise.resolve(saved).catch((err) => { console.error('[editor] save failed', err) })
  }
}
