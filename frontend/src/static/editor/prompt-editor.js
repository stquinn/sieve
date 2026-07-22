// @ts-check
// prompt-editor.js — the editor type for prompt: documents (P2.A, P2.B).
// A prompt has NO live channel. Its mode is fixed 'markdown' (setMode inherits
// the base no-op) and it saves through DocumentService.save — whose
// channel-less routing IS the HTTP POST /api/editor/save the prompt path
// always used (issue #49 Phase 1: the WS-vs-HTTP, note-vs-prompt split is
// service-internal; this type just reads its surface body and asks the
// service to save). The AI-reload save guard reads AbstractEditor's own
// isSaveSuppressed (armed by softReload).
// Dual-use ES module: `export` for vitest imports; reached in the app via the
// SieveTab.createEditor factory.

import { AbstractEditor } from './abstract-editor.js'
import { EditorMode } from './editor-mode.js'
// MarkdownSurface is the prompt's ONLY surface (its fixed mode) — its whole
// repertoire, built by _createSurface below.
import { MarkdownSurface } from './surfaces/markdown-surface.js'

/**
 * @typedef {object} PromptEditorOptions
 * @property {import('../block/document-service.js').DocumentService} [documentService] — the service half save routes through (composition root wiring)
 */

export class PromptEditor extends AbstractEditor {
  /**
   * A prompt never declares `connect` — AbstractEditor's default is
   * disconnected, so no channel exists and verbs are safe no-ops. Persistence
   * is flushSave's DocumentService.save override below (proper OOP: per-type
   * behavior as a method override on the type).
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
   * @returns {import('./editor-mode.js').EditorModeValue}
   */
  get _defaultMode() { return EditorMode.MARKDOWN }

  /**
   * A prompt's repertoire is markdown ONLY (its fixed mode) — `mode` is
   * deliberately ignored; there is no other surface this type can present. The
   * surface receives THIS editor (`host`) and calls its public API directly
   * (onSurfaceEvent / setRawContent / takeInsertPos / softReload) — the
   * pre-bound `deps` closure bag is dissolved (P4.F).
   * @protected
   * @param {import('./editor-mode.js').EditorModeValue} mode
   * @returns {import('./surfaces/abstract-surface.js').AbstractSurface}
   */
  _createSurface(mode) {
    return new MarkdownSurface(this)
  }

  /** @returns {Promise<unknown>} */
  flushSave() {
    // Guard: an AI reload replaces the whole document; a save mid-reload would
    // race the reload (P4.A: isSaveSuppressed reads AbstractEditor's own
    // #reloadInProgress, set by softReload — no injected closure).
    if (this.isSaveSuppressed()) return Promise.resolve()

    const s = this.surface
    const body = (s && s.body) || ''
    const ds = this.documentService
    // A prompt has no channel, so DocumentService.save routes to its HTTP POST
    // path. A bare construction (no service) resolves quietly — save parity
    // with every other disconnected verb.
    const saved = ds ? ds.save(this.uuid, body) : Promise.resolve()
    return saved
      .then(() => {
        this.clearDirty()
        document.dispatchEvent(new CustomEvent('sieve:meta-dirty', { detail: { dirty: false } }))
        document.dispatchEvent(new CustomEvent('editor:saved', { detail: { uuid: this.uuid } }))
      })
      .catch((err) => { console.error('[editor] save failed', err) })
  }
}
