// @ts-check
// tab.js — Tab shell object (P1: zero-behavior skeleton).
// A Tab is the identity of one open document session. It holds a uuid, a mode
// preference (persisted across mode toggles — retiring the tabModes global in
// a later phase), and a reference to its Editor shell object once the editor
// is mounted. In P1 it is a thin holder; no business logic lives here yet.
// Dual-use ES module (block-position.js pattern): `export` for vitest imports,
// window.* assignment for classic-script access. Loaded in index.html with
// type="module" — a plain <script> tag would fail at parse on `export`.

import { SieveEditor } from './editor-shell.js'

export class SieveTab {
  /** @type {string} */
  #uuid

  /** @type {SieveEditor|null} */
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
   * The Editor shell object for this tab, or null before the editor mounts.
   * @returns {SieveEditor|null}
   */
  get editor() { return this.#editor }

  /**
   * Called by editor.js when initEditor mounts for this tab's uuid.
   * @param {SieveEditor} ed
   */
  attachEditor(ed) {
    if (!(ed instanceof SieveEditor)) throw new Error('SieveTab.attachEditor: expected SieveEditor')
    this.#editor = ed
  }

  /**
   * Called by editor.js when the tab is torn down (initEditor with empty uuid,
   * or a tab close). Detaches the editor reference so the Tab is inert.
   */
  detachEditor() {
    this.#editor = null
  }
}

// Expose on window for classic-script access.
window.SieveTab = SieveTab
