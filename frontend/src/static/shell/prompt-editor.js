// @ts-check
// prompt-editor.js — the editor type for prompt: documents (P2.A).
// A prompt has NO WebSocket. Its mode is fixed 'markdown' and it saves over HTTP
// (POST /api/editor/save). This is faithful code motion of editor.js's doSave path
// (the `if (currentUuid.startsWith('prompt:'))` branch of the old flushSave).
// Dual-use ES module: `export` for vitest imports; reached in the app via the
// SieveTab.createEditor factory.

import { AbstractEditor } from './abstract-editor.js'

/**
 * @typedef {object} PromptEditorOptions
 * @property {(uuid: string, body: string, mode: string) => Promise<unknown>} [saveFn] — injected for tests; defaults to the HTTP POST
 */

export class PromptEditor extends AbstractEditor {
  /** @type {(uuid: string, body: string, mode: string) => Promise<unknown>} */
  #saveFn

  /**
   * @param {string}              uuid
   * @param {import('./abstract-editor.js').EditorAccessors} accessors
   * @param {PromptEditorOptions} [options]
   */
  constructor(uuid, accessors, options = {}) {
    super(uuid, accessors)
    this.#saveFn = options.saveFn || PromptEditor.#defaultSave
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
    // race the reload (faithful to doSave's aiReloadInProgress guard).
    const suppressed = this._accessors.isSaveSuppressed
    if (suppressed && suppressed()) return Promise.resolve()

    const getBody = this._accessors.getBody
    const body = getBody ? getBody() : ''
    return this.#saveFn(this.uuid, body, this.mode)
      .then(() => {
        this.clearDirty()
        document.dispatchEvent(new CustomEvent('sieve:meta-dirty', { detail: { dirty: false } }))
        document.dispatchEvent(new CustomEvent('editor:saved', { detail: { uuid: this.uuid } }))
      })
      .catch((err) => { console.error('[editor] save failed', err) })
  }

  /** No transport and no timers — teardown is a no-op. */
  destroy() {}
}
