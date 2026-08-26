// @ts-check
// tab.js — a Tab is the identity of one open document session: a uuid, the mount
// bound to it, and its editor once one is attached. The Tab is also the editor
// FACTORY: createEditor is the ONE place that decides NoteEditor vs PromptEditor
// from the uuid.

import { AbstractEditor } from '../lens/abstract-editor.js'
import { NoteEditor } from '../lens/document-editor/note-editor.js'
import { PromptEditor } from '../lens/prompt/prompt-editor.js'
import { EditorMode } from '../lens/document-editor/editor-mode.js'
import { MountBinding } from './mount-binding.js'

/** @typedef {import('../lens/document-editor/editor-mode.js').EditorModeValue} EditorModeValue */

export class SieveTab {
  /** @type {string} */
  #uuid

  /** @type {AbstractEditor|null} */
  #editor = null

  /**
   * The tab's editing mode — the CLIENT-SIDE record that survives a tab switch:
   * the editor is destroyed on switch, the Tab identity persists. The server
   * persists mode independently, so this is a hint, not the source of truth.
   * @type {EditorModeValue}
   */
  #mode = EditorMode.WYSIWYG

  /** @type {(() => void)|null} unsubscribe from the attached editor's event stream */
  #unsubEditor = null

  /**
   * The MOUNT this tab's editor is bound to: one container, its follower model,
   * its provider and its presence seam. It is the tab's, not the editor's,
   * because it outlives an editor swap and because closing it is a host act.
   * @type {MountBinding|null}
   */
  #mount = null

  /** @type {(() => void)|null} unsubscribe from the mount's selection adverts */
  #unsubAdvert = null

  /**
   * Republishes the attached editor's `selection-update` context. This registry
   * and #statsListeners belong to the Tab IDENTITY, not the editor, so their
   * subscribers keep working when a new editor attaches after a mode flip.
   * @type {Array<(ctx: import('../lens/document-editor/selection-model.js').SelectionContext) => void>}
   */
  #selectionListeners = []

  /** @type {Array<(ev: { chars: number, lines: number, blockCount: number }) => void>} */
  #statsListeners = []

  /** @param {string} uuid — document uuid for this tab */
  constructor(uuid) {
    if (!uuid) throw new Error('SieveTab: uuid is required')
    this.#uuid = uuid
  }

  /** @returns {string} */
  get uuid() { return this.#uuid }

  /** @returns {EditorModeValue} */
  get mode() { return this.#mode }

  /**
   * Records the tab's editing mode. Needed on the load path because
   * `mode-changed` does not fire on the initial surface present.
   * @param {EditorModeValue} mode
   */
  recordMode(mode) { this.#mode = mode }

  /** @returns {AbstractEditor|null} null before one mounts */
  get editor() { return this.#editor }

  /** @returns {MountBinding|null} null before one is attached */
  get mount() { return this.#mount }

  /**
   * Records the mount and takes up its presence stream.
   * @param {MountBinding} mount
   */
  attachMount(mount) {
    if (!(mount instanceof MountBinding)) throw new Error('SieveTab.attachMount: expected a MountBinding')
    if (this.#unsubAdvert) { this.#unsubAdvert(); this.#unsubAdvert = null }
    this.#mount = mount
    this.#unsubAdvert = mount.onSelectionAdvert((ctx) => this.#notifySelectionListeners(ctx))
  }

  /**
   * Closes and forgets this tab's mount: the container's channel closes and its
   * follower model is discarded. Idempotent.
   */
  detachMount() {
    if (this.#unsubAdvert) { this.#unsubAdvert(); this.#unsubAdvert = null }
    if (this.#mount) { this.#mount.close(); this.#mount = null }
  }

  /**
   * The last advert the mounted lens made.
   * @returns {any|null}
   */
  getSelectionContext() { return this.#mount ? this.#mount.getSelectionContext() : null }

  /**
   * Editor factory — the SOLE place the `prompt:` prefix decides a lens type. It
   * is a CAPABILITY decision: a prompt's container speaks whole-content only, so
   * it gets the lens whose constructor demands only that.
   * @param {string} uuid — document uuid (matches this tab's uuid)
   * @param {object} [options] — passed to the concrete editor constructor
   * @returns {AbstractEditor}
   */
  createEditor(uuid, options = {}) {
    return uuid.startsWith('prompt:')
      ? new PromptEditor(uuid, options)
      : new NoteEditor(uuid, options)
  }

  /**
   * Takes up the editor's event stream so the Tab self-records mode on each flip.
   * @param {AbstractEditor} ed
   */
  attachEditor(ed) {
    if (!(ed instanceof AbstractEditor)) throw new Error('SieveTab.attachEditor: expected SieveEditor')
    this.#editor = ed
    // Presence flows the other way: the lens advertises to the MOUNT, which
    // republishes to this tab's registry.
    if (this.#mount) ed.setSelectionListener(this.#mount)
    this.#unsubEditor = ed.onEvent((e) => {
      if (e.type === 'mode-changed') this.#mode = e.mode
      else if (e.type === 'stats') this.#notifyStatsListeners(e)
    })
  }

  /**
   * Registers a listener for this tab's selection-update stream — the mounted
   * lens's presence advert, republished here.
   * @param {(ctx: import('../lens/document-editor/selection-model.js').SelectionContext) => void} fn
   * @returns {() => void} unsubscribe
   */
  onSelectionUpdate(fn) {
    this.#selectionListeners.push(fn)
    return () => { this.#selectionListeners = this.#selectionListeners.filter((l) => l !== fn) }
  }

  /** @param {import('../lens/document-editor/selection-model.js').SelectionContext} ctx */
  #notifySelectionListeners(ctx) {
    for (const fn of this.#selectionListeners) {
      try { fn(ctx) } catch (e) { console.error('[SieveTab] selectionUpdate listener threw', e) }
    }
  }

  /**
   * Registers a listener for this tab's `stats` stream — the attached editor's
   * doc-stats event, forwarded here.
   * @param {(ev: { chars: number, lines: number, blockCount: number }) => void} fn
   * @returns {() => void} unsubscribe
   */
  onStats(fn) {
    this.#statsListeners.push(fn)
    return () => { this.#statsListeners = this.#statsListeners.filter((l) => l !== fn) }
  }

  /** @param {{ chars: number, lines: number, blockCount: number }} ev */
  #notifyStatsListeners(ev) {
    for (const fn of this.#statsListeners) {
      try { fn(ev) } catch (e) { console.error('[SieveTab] stats listener threw', e) }
    }
  }

  /**
   * Detaches the editor reference and unsubscribes from its event stream; the
   * caller still owns editor.destroy(). The recorded #mode is KEPT.
   */
  detachEditor() {
    if (this.#unsubEditor) { this.#unsubEditor(); this.#unsubEditor = null }
    this.#editor = null
  }
}

window.SieveTab = SieveTab
