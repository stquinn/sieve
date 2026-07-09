// @ts-check
// abstract-editor.js — base of the editor component hierarchy (P2.A, P2.B).
// AbstractEditor is the stable identity for one open document's editing session:
// it owns the uuid (identity), dirty state, the save/destroy contract, and —
// since P2.B — the document's INPUT SURFACE (a WysiwygSurface or
// MarkdownSurface, created via the injected surfaceFactory and swapped in
// place). Mode and the TipTap handle are DERIVED from the mounted surface:
// there is no stored mode to fall out of sync, which is what makes the old
// torn-down-limbo mode-toggle state unrepresentable. Concrete subclasses supply
// the transport: NoteEditor owns a WebSocket + flush protocol (and the awaited
// setMode handshake), PromptEditor saves over HTTP (fixed markdown).
// The P2.A accessor-bag seam into editor.js module state is retired.
// Dual-use ES module (block-position.js pattern): `export` for vitest imports;
// window.* assignment happens in editor-shell.js (which re-exports this as the
// P1 `SieveEditor` name for backward compatibility).

import { AbstractSurface } from './surfaces/abstract-surface.js'

/**
 * @typedef {import('./surfaces/abstract-surface.js').SurfaceEventMsg} SurfaceEventMsg
 */

/**
 * The editor-owned services a surface receives (threaded through the
 * surfaceFactory). All DOMAIN-shaped: no wire envelopes, no transport
 * vocabulary, no uuid-for-transport — the WS contract is owned exclusively by
 * NoteEditor. If a dep's implementation would change when the transport
 * changes, it belongs here, not in a surface.
 * @typedef {object} EditorSurfaceServices
 * @property {(event: SurfaceEventMsg) => void} notify — outbound editor-domain events → editor registrants
 * @property {(ops: object[]) => void} submitBlockOps — block-domain ops (create/update/delete-block) → transport
 * @property {(markdown: string) => void} updateText — whole-buffer text update (markdown mode) → transport
 */

/**
 * @typedef {object} AbstractEditorOptions
 * @property {(mode: string, services: EditorSurfaceServices) => AbstractSurface} [surfaceFactory]
 *   — builds a fresh surface for a mode ('wysiwyg' | 'markdown'); injected by
 *   editor.js with the content-service dependency bag closed over. The editor
 *   passes its own domain services so surface output flows through the editor.
 */

export class AbstractEditor {
  /** @type {string} */
  #uuid

  /** @type {boolean} */
  #dirty = false

  /** @type {AbstractSurface|null} */
  #surface = null

  /** @type {HTMLElement|null} the editor-owned root the surfaces mount under */
  #rootEl = null

  /** @type {((mode: string, services: EditorSurfaceServices) => AbstractSurface)|null} */
  #surfaceFactory

  /** @type {Array<(event: SurfaceEventMsg) => void>} surface-event registrants */
  #eventListeners = []

  /**
   * @param {string}                uuid    — document uuid; the editor's fixed identity
   * @param {AbstractEditorOptions} [options]
   */
  constructor(uuid, options = {}) {
    if (!uuid) throw new Error('AbstractEditor: uuid is required')
    this.#uuid = uuid
    this.#surfaceFactory = options.surfaceFactory || null
  }

  /** @returns {string} The document uuid this editor session is for. */
  get uuid() { return this.#uuid }

  /** @returns {AbstractSurface|null} The mounted input surface, or null. */
  get surface() { return this.#surface }

  /**
   * Current editing mode — DERIVED from the mounted surface; the subclass
   * default applies before any surface mounts.
   * @returns {string} 'wysiwyg' | 'markdown'
   */
  get mode() { return this.#surface ? this.#surface.mode : this._defaultMode }

  /**
   * The pre-mount default mode. PromptEditor overrides to 'markdown' (fixed).
   * @protected
   * @returns {string}
   */
  get _defaultMode() { return 'wysiwyg' }

  /** @returns {unknown|null} The live TipTap instance, or null (markdown / unmounted). */
  get tiptap() { return this.#surface ? this.#surface.tiptap : null }

  /** @returns {boolean} Whether the document has unsaved changes. */
  get isDirty() { return this.#dirty }

  /**
   * The editor-owned root element, for subclasses (setMode remounts into it).
   * @protected
   * @returns {HTMLElement|null}
   */
  get _rootEl() { return this.#rootEl }

  /** Marks the document dirty (unsaved changes present). */
  markDirty() { this.#dirty = true }

  /** Clears the dirty flag (called when a save is acknowledged). */
  clearDirty() { this.#dirty = false }

  /**
   * Registers a listener for the surface's editor-domain events
   * (doc-changed / selection-changed / transaction / focus-changed — see
   * SurfaceEvent). The editor forwards every event its mounted surface reports.
   * This is the seed of the P3 SelectionModel stream; today its one production
   * registrant is editor.js's transitional legacy-chrome fan-out.
   * @param {(event: SurfaceEventMsg) => void} fn
   * @returns {() => void} unsubscribe
   */
  onEvent(fn) {
    this.#eventListeners.push(fn)
    return () => {
      this.#eventListeners = this.#eventListeners.filter((l) => l !== fn)
    }
  }

  /** @param {SurfaceEventMsg} event */
  #emitEvent(event) {
    for (const fn of this.#eventListeners) {
      try { fn(event) } catch (e) { console.error('[editor] surface-event listener threw', e) }
    }
  }

  /**
   * Presents the input surface for a mode: unmounts the current surface (if
   * any), creates a fresh one via the factory, and mounts it on the root. The
   * ONE place surfaces are swapped — initEditor's initial mount and setMode's
   * in-place flip both land here.
   * @param {string}      mode    — 'wysiwyg' | 'markdown'
   * @param {HTMLElement} rootEl  — the editor's root (today: #tiptap-mount)
   * @param {unknown}     content — surface seed (markdown string, or {body, blocks})
   * @returns {AbstractSurface} the mounted surface
   */
  presentSurface(mode, rootEl, content) {
    if (!this.#surfaceFactory) throw new Error('AbstractEditor: no surfaceFactory injected')
    if (this.#surface) this.#surface.unmount()
    this.#rootEl = rootEl
    const next = this.#surfaceFactory(mode, {
      notify: (event) => this.#emitEvent(event),
      submitBlockOps: (ops) => this.submitBlockOps(ops),
      updateText: (markdown) => this.updateText(markdown),
    })
    if (!(next instanceof AbstractSurface)) throw new Error('AbstractEditor: surfaceFactory must return an AbstractSurface')
    next.mount(rootEl, content)
    this.#surface = next
    return next
  }

  /**
   * Submits block-domain ops (create-block / update-block / delete-block plain
   * objects) produced by the surface. Base implementation DROPS them — an
   * editor without a document channel has nowhere to send ops (a prompt never
   * round-trips blocks; faithful to the old prompt no-op wsSend). NoteEditor
   * overrides with the WS block-op enveloping.
   * @param {object[]} _ops
   */
  submitBlockOps(_ops) {}

  /**
   * Submits a whole-buffer text update (markdown mode). Base implementation
   * drops it (prompts persist via flushSave's HTTP path instead). NoteEditor
   * overrides with the WS doc-update enveloping.
   * @param {string} _markdown
   */
  updateText(_markdown) {}

  /**
   * Switches the editing mode in place. Base implementation is a NO-OP
   * resolving false — PromptEditor inherits it (a prompt is fixed markdown).
   * NoteEditor overrides with the awaited WS handshake.
   * @param {string} _target — 'wysiwyg' | 'markdown'
   * @returns {Promise<boolean>} whether the mode changed
   */
  setMode(_target) { return Promise.resolve(false) }

  /**
   * Flushes any pending edits and persists the document.
   * @abstract
   * @returns {Promise<unknown>}
   */
  flushSave() {
    throw new Error(this.constructor.name + ' must implement flushSave()')
  }

  /**
   * Tears the editor session down: unmounts the surface. Subclasses extend
   * (NoteEditor also closes its WebSocket) and must call super.destroy().
   */
  destroy() {
    if (this.#surface) {
      this.#surface.unmount()
      this.#surface = null
    }
    this.#rootEl = null
  }
}
