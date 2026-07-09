// @ts-check
// abstract-editor.js — base of the editor component hierarchy (P2.A).
// AbstractEditor is the stable identity for one open document's editing session:
// it owns the uuid (identity), dirty state, and the save/destroy contract that
// every editor type must honour. Concrete subclasses (NoteEditor, PromptEditor)
// supply the transport: NoteEditor owns a WebSocket + flush protocol, PromptEditor
// saves over HTTP. Mode/tiptap are read from the still-module-level editor.js vars
// via injected accessor closures (the transitional seam P2.B removes).
// Dual-use ES module (block-position.js pattern): `export` for vitest imports;
// window.* assignment happens in editor-shell.js (which re-exports this as the P1
// `SieveEditor` name for backward compatibility).

/**
 * Read closures into editor.js's still-module-level state. The bag is shared by
 * every editor type; each type reads only the members it needs. (P2.B retires
 * this seam once mountWysiwyg/mountMarkdown state moves onto the editor.)
 * @typedef {object} EditorAccessors
 * @property {() => string}                      getMode              — current mode ('wysiwyg' | 'markdown')
 * @property {() => unknown|null}                getTiptap            — live TipTap instance, or null in markdown mode
 * @property {() => (() => void)|null}           [getDocSyncFlush]    — wysiwyg pending-block-sync flush, or null (NoteEditor)
 * @property {() => string|null}                 [takePendingMarkdown] — pending markdown body to flush (cancels the debounce timer), or null (NoteEditor)
 * @property {() => string}                      [getBody]            — plain-text/markdown body for HTTP save (PromptEditor)
 * @property {() => boolean}                     [isSaveSuppressed]   — true while an AI reload is mid-flight (PromptEditor)
 */

export class AbstractEditor {
  /** @type {string} */
  #uuid

  /** @type {EditorAccessors} */
  #accessors

  /** @type {boolean} */
  #dirty = false

  /**
   * @param {string}          uuid      — document uuid; the editor's fixed identity
   * @param {EditorAccessors} accessors — live read closures into editor.js state
   */
  constructor(uuid, accessors) {
    if (!uuid) throw new Error('AbstractEditor: uuid is required')
    if (!accessors) throw new Error('AbstractEditor: accessors are required')
    this.#uuid = uuid
    this.#accessors = accessors
  }

  /** @returns {string} The document uuid this editor session is for. */
  get uuid() { return this.#uuid }

  /** @returns {string} Current editing mode ('wysiwyg' | 'markdown'). */
  get mode() { return this.#accessors.getMode() }

  /** @returns {unknown|null} The live TipTap instance, or null in markdown mode. */
  get tiptap() { return this.#accessors.getTiptap() }

  /** @returns {boolean} Whether the document has unsaved changes. */
  get isDirty() { return this.#dirty }

  /**
   * The injected accessor bag, for subclasses only.
   * @protected
   * @returns {EditorAccessors}
   */
  get _accessors() { return this.#accessors }

  /** Marks the document dirty (unsaved changes present). */
  markDirty() { this.#dirty = true }

  /** Clears the dirty flag (called when a save is acknowledged). */
  clearDirty() { this.#dirty = false }

  /**
   * Flushes any pending edits and persists the document.
   * @abstract
   * @returns {Promise<unknown>}
   */
  flushSave() {
    throw new Error(this.constructor.name + ' must implement flushSave()')
  }

  /**
   * Tears the editor session down — closes any transport and cancels timers.
   * @abstract
   */
  destroy() {
    throw new Error(this.constructor.name + ' must implement destroy()')
  }
}
