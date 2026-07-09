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

/**
 * @typedef {object} PromptEditorOptions
 * @property {(uuid: string, body: string, mode: string) => Promise<unknown>} [saveFn] — injected for tests; defaults to the HTTP POST
 * @property {() => boolean} [isSaveSuppressed] — true while an AI reload is mid-flight
 * @property {(mode: string) => import('./surfaces/abstract-surface.js').AbstractSurface} [surfaceFactory]
 */

export class PromptEditor extends AbstractEditor {
  /** @type {(uuid: string, body: string, mode: string) => Promise<unknown>} */
  #saveFn

  /** @type {() => boolean} */
  #isSaveSuppressed

  /**
   * @param {string}              uuid
   * @param {PromptEditorOptions} [options]
   */
  constructor(uuid, options = {}) {
    super(uuid, options)
    this.#saveFn = options.saveFn || PromptEditor.#defaultSave
    this.#isSaveSuppressed = options.isSaveSuppressed || (() => false)
  }

  /**
   * A prompt is fixed markdown — the pre-mount default matches the only
   * surface it ever presents.
   * @protected
   * @returns {string}
   */
  get _defaultMode() { return 'markdown' }

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
    // race the reload (faithful to doSave's aiReloadInProgress guard).
    if (this.#isSaveSuppressed()) return Promise.resolve()

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
