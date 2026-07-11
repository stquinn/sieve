// @ts-check
// prompt-editor.js — the editor type for prompt: documents (P2.A, P2.B).
// A prompt has NO WebSocket. Its mode is fixed 'markdown' (setMode inherits the
// base no-op) and it saves over HTTP (POST /api/editor/save). This is faithful
// code motion of editor.js's doSave path (the `prompt:` branch of the old
// flushSave). Since P2.B the body comes from the mounted MarkdownSurface —
// the P2.A accessor bag is retired; the AI-reload save guard is an injected
// closure (aiReloadInProgress stays editor.js AI machinery).
// Dual-use ES module: `export` for vitest imports; reached in the app via the
// SieveTab.createEditor factory.

import { AbstractEditor } from './abstract-editor.js'
import { EditorMode } from './editor-mode.js'
// MarkdownSurface is the prompt's ONLY surface (its fixed mode) — its whole
// repertoire, built by _createSurface below.
import { MarkdownSurface } from './surfaces/markdown-surface.js'

/**
 * @typedef {object} PromptEditorOptions
 * @property {(uuid: string, body: string, mode: string) => Promise<unknown>} [saveFn] — injected for tests; defaults to the HTTP POST
 */

export class PromptEditor extends AbstractEditor {
  /** @type {(uuid: string, body: string, mode: string) => Promise<unknown>} */
  #saveFn

  /**
   * @param {string}              uuid
   * @param {PromptEditorOptions} [options]
   */
  constructor(uuid, options = {}) {
    // A prompt never declares `connect` — AbstractEditor's default is
    // disconnected, so no channel exists and domain methods are safe no-ops.
    // Persistence is handled by flushSave's HTTP POST override below (proper
    // OOP: per-type behavior as a method override on the type).
    super(uuid, options)
    this.#saveFn = options.saveFn || PromptEditor.#defaultSave
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
   * deliberately ignored; there is no other surface this type can present.
   * @protected
   * @param {import('./editor-mode.js').EditorModeValue} mode
   * @param {import('./abstract-editor.js').EditorSurfaceServices} services
   * @returns {import('./surfaces/abstract-surface.js').AbstractSurface}
   */
  _createSurface(mode, services) {
    // P4.A: takeInsertPos / requestReload are editor-sourced (the surfaceCollaborators
    // IIFE bag is dissolved) — the surface calls UP to the editor's own methods.
    return new MarkdownSurface({
      notify: services.notify,
      takeInsertPos: () => this.takeInsertPos(),
      updateText: services.updateText,
      requestReload: () => this.softReload(),
    })
  }

  /**
   * @param {string} uuid
   * @param {string} body
   * @param {string} mode
   * @returns {Promise<unknown>}
   */
  static #defaultSave(uuid, body, mode) {
    return fetch('/api/editor/save?uuid=' + encodeURIComponent(uuid), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: body, mode: mode }),
    })
  }

  /** @returns {Promise<unknown>} */
  flushSave() {
    // Guard: an AI reload replaces the whole document; a save mid-reload would
    // race the reload (P4.A: isSaveSuppressed reads AbstractEditor's own
    // #reloadInProgress, set by softReload — no injected closure).
    if (this.isSaveSuppressed()) return Promise.resolve()

    const s = this.surface
    const body = (s && s.body) || ''
    return this.#saveFn(this.uuid, body, this.mode)
      .then(() => {
        this.clearDirty()
        document.dispatchEvent(new CustomEvent('sieve:meta-dirty', { detail: { dirty: false } }))
        document.dispatchEvent(new CustomEvent('editor:saved', { detail: { uuid: this.uuid } }))
      })
      .catch((err) => { console.error('[editor] save failed', err) })
  }
}
