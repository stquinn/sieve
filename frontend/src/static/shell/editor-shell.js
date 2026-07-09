// @ts-check
// editor-shell.js — Editor shell object (P1: zero-behavior skeleton).
// The Editor object is the stable identity for one open tab's editing session.
// In P1 it wraps what already exists in editor.js via read-only accessor
// closures injected at construction time; no logic moves in this phase.
// Dual-use ES module (block-position.js pattern): `export` for vitest imports,
// window.* assignment for the classic-script editor.js. Loaded in index.html
// with type="module" — a plain <script> tag would fail at parse on `export`.

/**
 * P1 accessors are READ-ONLY by design: the shell is a structured view over
 * editor.js's live vars; nothing writes through it until P2 internalizes state.
 * @typedef {object} EditorAccessors
 * @property {() => string}       getMode
 * @property {() => unknown|null} getTiptap
 */

export class SieveEditor {
  /** @type {string} */
  #uuid

  /** @type {EditorAccessors} */
  #accessors

  /**
   * @param {string}          uuid      — document uuid this Editor is for
   * @param {EditorAccessors} accessors — live read closures into editor.js vars
   */
  constructor(uuid, accessors) {
    if (!uuid) throw new Error('SieveEditor: uuid is required')
    if (!accessors) throw new Error('SieveEditor: accessors are required')
    this.#uuid = uuid
    this.#accessors = accessors
  }

  /** @returns {string} The document uuid this editor session is for. */
  get uuid() { return this.#uuid }

  /**
   * Current editing mode ('wysiwyg' | 'markdown').
   * Reads the live editor.js var via the injected accessor.
   * @returns {string}
   */
  get mode() { return this.#accessors.getMode() }

  /**
   * The live TipTap Editor instance, or null in markdown mode.
   * Reads the live editor.js var via the injected accessor.
   * @returns {unknown|null}
   */
  get tiptap() { return this.#accessors.getTiptap() }
}

// Expose on window for classic-script access from editor.js and the console.
// The singleton workspace is the canonical handle; this constructor is also
// exposed so editor.js can call `new window.SieveEditor(uuid, accessors)`.
window.SieveEditor = SieveEditor
