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
import { EditorMode } from './editor-mode.js'

/** @typedef {import('./editor-mode.js').EditorModeValue} EditorModeValue */

export class SieveTab {
  /** @type {string} */
  #uuid

  /** @type {AbstractEditor|null} */
  #editor = null

  /**
   * The tab's editing mode — the CLIENT-SIDE record that survives a tab switch
   * (the editor instance is destroyed on switch; the Tab identity persists).
   * P2.D: this is where mode lives now — the retired `tabModes` module global.
   * The server persists mode independently (Tab.Mode on flip / editor/load), so
   * this is a fast local hint, not the source of truth. Kept in sync by the
   * editor's `mode-changed` event (subscribed in attachEditor) plus the
   * editor.js load-path seed (recordMode after the initial present).
   * @type {EditorModeValue}
   */
  #mode = EditorMode.WYSIWYG

  /** @type {(() => void)|null} unsubscribe from the attached editor's event stream */
  #unsubEditor = null

  /**
   * Tab-level selection-update registry (P3.B). Mirrors the workspace's
   * onActiveTabChanged shape: republishes the attached editor's
   * `selection-update` context. The registry belongs to the Tab IDENTITY (not the
   * editor), so its subscribers keep working when a new editor attaches after a
   * mode flip / re-init — attachEditor re-subscribes the forward, the listeners
   * are untouched.
   * @type {Array<(ctx: import('./selection-model.js').SelectionContext) => void>}
   */
  #selectionListeners = []

  /**
   * @param {string} uuid — document uuid for this tab
   */
  constructor(uuid) {
    if (!uuid) throw new Error('SieveTab: uuid is required')
    this.#uuid = uuid
  }

  /** @returns {string} The document uuid this tab holds. */
  get uuid() { return this.#uuid }

  /** @returns {EditorModeValue} The tab's current editing mode. */
  get mode() { return this.#mode }

  /**
   * Records the tab's editing mode. Called by editor.js's load-path seed after
   * the initial surface present (mode-changed does not fire on initial present).
   * The editor's `mode-changed` event keeps it in sync thereafter.
   * @param {EditorModeValue} mode
   */
  recordMode(mode) { this.#mode = mode }

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
   *   (surfaceCollaborators, onServerMessage, socketFactory/wsUrl, saveFn, …)
   * @returns {AbstractEditor}
   */
  createEditor(uuid, options = {}) {
    return uuid.startsWith('prompt:')
      ? new PromptEditor(uuid, options)
      : new NoteEditor(uuid, options)
  }

  /**
   * Called by editor.js when initEditor mounts an editor for this tab.
   * Subscribes to the editor's event stream so the Tab self-records mode on each
   * flip (`mode-changed` — emitted by AbstractEditor.setMode). The Tab is the
   * mode record-keeper; editor.js no longer keeps a per-uuid map.
   * @param {AbstractEditor} ed
   */
  attachEditor(ed) {
    if (!(ed instanceof AbstractEditor)) throw new Error('SieveTab.attachEditor: expected SieveEditor')
    this.#editor = ed
    this.#unsubEditor = ed.onEvent((e) => {
      if (e.type === 'mode-changed') this.#mode = e.mode
      else if (e.type === 'selection-update') this.#notifySelectionListeners(e.context)
    })
  }

  /**
   * Registers a listener for this tab's selection-update stream (the attached
   * editor's SelectionModel push, forwarded here). Returns an unsubscribe.
   * Mirrors SieveWorkspace.onActiveTabChanged. Survives editor swaps — the
   * registry lives on the Tab identity, not the editor.
   * @param {(ctx: import('./selection-model.js').SelectionContext) => void} fn
   * @returns {() => void} unsubscribe
   */
  onSelectionUpdate(fn) {
    this.#selectionListeners.push(fn)
    return () => { this.#selectionListeners = this.#selectionListeners.filter((l) => l !== fn) }
  }

  /** @param {import('./selection-model.js').SelectionContext} ctx */
  #notifySelectionListeners(ctx) {
    for (const fn of this.#selectionListeners) {
      try { fn(ctx) } catch (e) { console.error('[SieveTab] selectionUpdate listener threw', e) }
    }
  }

  /**
   * Called by editor.js when the editor is torn down. Detaches the reference and
   * unsubscribes from its event stream so the Tab is inert (the caller is
   * responsible for editor.destroy()). The recorded #mode is KEPT — it is the
   * client-side record that survives across a tab switch.
   */
  detachEditor() {
    if (this.#unsubEditor) { this.#unsubEditor(); this.#unsubEditor = null }
    this.#editor = null
  }
}

// Expose on window for classic-script access.
window.SieveTab = SieveTab
