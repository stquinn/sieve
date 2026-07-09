// @ts-check
// tab.js — Tab shell object + editor factory (P2.A).
// A Tab is the identity of one open document session. It holds a uuid and a
// reference to its editor (an AbstractEditor subclass) once mounted. The Tab is
// also the editor FACTORY: createEditor is the ONE place that decides NoteEditor
// vs PromptEditor from the uuid — every other former `prompt:` guard becomes type
// dispatch. Dual-use ES module: `export` for vitest imports, window.* for
// classic-script access.

import { AbstractEditor } from './abstract-editor.js'
import { NoteEditor } from './note-editor.js'
import { PromptEditor } from './prompt-editor.js'

export class SieveTab {
  /** @type {string} */
  #uuid

  /** @type {AbstractEditor|null} */
  #editor = null

  /**
   * @param {string} uuid — document uuid for this tab
   */
  constructor(uuid) {
    if (!uuid) throw new Error('SieveTab: uuid is required')
    this.#uuid = uuid
  }

  /** @returns {string} The document uuid this tab holds. */
  get uuid() { return this.#uuid }

  /**
   * The editor for this tab, or null before it mounts.
   * @returns {AbstractEditor|null}
   */
  get editor() { return this.#editor }

  /**
   * Editor factory — the SOLE place the `prompt:` prefix decides an editor type.
   * A prompt document has no WebSocket (PromptEditor); everything else is a
   * NoteEditor that owns a WS channel.
   * @param {string} uuid — document uuid (matches this tab's uuid)
   * @param {object} [options] — passed to the concrete editor constructor
   *   (surfaceFactory, onServerMessage, socketFactory/wsUrl, saveFn, …)
   * @returns {AbstractEditor}
   */
  createEditor(uuid, options = {}) {
    return uuid.startsWith('prompt:')
      ? new PromptEditor(uuid, options)
      : new NoteEditor(uuid, options)
  }

  /**
   * Called by editor.js when initEditor mounts an editor for this tab.
   * @param {AbstractEditor} ed
   */
  attachEditor(ed) {
    if (!(ed instanceof AbstractEditor)) throw new Error('SieveTab.attachEditor: expected SieveEditor')
    this.#editor = ed
  }

  /**
   * Called by editor.js when the editor is torn down. Detaches the reference so
   * the Tab is inert (the caller is responsible for editor.destroy()).
   */
  detachEditor() {
    this.#editor = null
  }
}

// Expose on window for classic-script access.
window.SieveTab = SieveTab
