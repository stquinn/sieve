// @ts-check
// note-editor.js — the editor type for regular notes (P2.A, P2.B, P2.B.2).
// Since P2.B.2 the transport lives ENTIRELY inside AbstractEditor as #private
// state behind domain methods (applyBlockOps / updateText / flush /
// enterMarkdown / enterWysiwyg / retryBlockJob / extract). NoteEditor's whole
// definition is: the editor type that DECLARES a live channel (connect: true)
// and edits rich notes through the mode-swappable surfaces. It contains zero
// transport vocabulary — that a WebSocket underlies the channel is not its
// business (nor any caller's).
//
// The WS protocol (message shapes, reconnect policy) is FROZEN — owned and
// enveloped by AbstractEditor alone.
// Dual-use ES module: `export` for vitest imports; the class is reached in the
// app via the SieveTab.createEditor factory.

import { AbstractEditor } from './abstract-editor.js'
import { EditorMode } from './editor-mode.js'
import { EditorToolbar } from './editor-toolbar.js'
// The concrete surfaces are the note editor's private input surfaces — used
// directly by _createSurface below (its type-defining repertoire). Importing
// the modules also assigns their window.* handles as a side effect (still read
// by any remaining classic-script consumers; no index.html change needed).
import { WysiwygSurface } from './surfaces/wysiwyg-surface.js'
import { MarkdownSurface } from './surfaces/markdown-surface.js'

/**
 * @typedef {object} NoteEditorOptions
 * @property {(url: string) => WebSocket} [socketFactory] — injected for tests; defaults to `new WebSocket(url)`
 * @property {() => string}               [wsUrl]         — injected for tests; defaults to the /api/ws URL for this uuid
 * @property {(msg: object) => void}      [onServerMessage] — routing for the remaining messages (editor.js owns it)
 * @property {import('./editor-toolbar.js').EditorToolbar|null} [toolbar] — injected toolbar (tests); defaults to a live EditorToolbar
 */

export class NoteEditor extends AbstractEditor {
  /**
   * The editor-owned toolbar (P4.D). Mounted lazily on the first present into the
   * #editor-toolbar host; re-renders its surface section on each present + on a
   * mode flip (its own onEvent subscription). Injectable for tests.
   * @type {EditorToolbar|null}
   */
  #toolbar = null

  /**
   * Declares the live channel (faithful to editor.js: openEditorWs ran at the
   * end of initEditor for every non-prompt uuid). Everything else is inherited.
   * @param {string}           uuid
   * @param {NoteEditorOptions} [options]
   */
  constructor(uuid, options = {}) {
    super(uuid, Object.assign({}, options, { connect: true }))
    // The toolbar is a NoteEditor concern (PromptEditor has none). Injected in
    // tests via options.toolbar; in the app it lazily binds the #editor-toolbar
    // host on the first present. A null host (headless / ShowToolbar off) → all
    // toolbar methods no-op.
    this.#toolbar = options.toolbar !== undefined ? options.toolbar : new EditorToolbar(this)
  }

  /**
   * Presents the surface (inherited behaviour) then binds the toolbar: mount it on
   * the first present, else re-render its surface section for the new surface (a
   * same-mode re-init that does not fire mode-changed). The flip's surface swap is
   * handled by the toolbar's own mode-changed subscription.
   * @override
   * @param {import('./editor-mode.js').EditorModeValue} mode
   * @param {HTMLElement} rootEl
   * @param {unknown}     content
   */
  presentSurface(mode, rootEl, content) {
    const surface = super.presentSurface(mode, rootEl, content)
    if (this.#toolbar) {
      if (this.#toolbar.mounted) this.#toolbar.refreshSurfaceSection()
      else this.#toolbar.mount()
    }
    return surface
  }

  /** @override — tears down the toolbar subscription alongside the surface + socket. */
  destroy() {
    if (this.#toolbar) { this.#toolbar.destroy(); this.#toolbar = null }
    super.destroy()
  }

  /**
   * NoteEditor's repertoire: BOTH surfaces, mode-mapped (moved verbatim from
   * editor.js's makeSurface, P2.C.2). Every former surfaceCollaborators dep is
   * now sourced from the editor's OWN methods (P4.A) — the IIFE bag is dissolved.
   * takeInsertPos / requestSave / requestReload survive by NAME as surface deps
   * (the surface genuinely calls UP to the editor: applyServerOp fallback, Mod+S,
   * replace-block reload) but are editor-method closures, uniform with the
   * applyBlockOps / updateText services. Paste/drop are surface #private now — no
   * onPaste/onDrop dep; the surface's smart-paste/drop use the editor's insert-
   * index methods (insertIndexForBlock / insertIndexForBlockAt / clearInsertPos).
   * @protected
   * @param {import('./editor-mode.js').EditorModeValue} mode
   * @param {import('./abstract-editor.js').EditorSurfaceServices} services
   * @returns {import('./surfaces/abstract-surface.js').AbstractSurface}
   */
  _createSurface(mode, services) {
    const deps = {
      notify: services.notify,
      takeInsertPos: () => this.takeInsertPos(),
    }
    if (mode === EditorMode.MARKDOWN) {
      deps.updateText = services.updateText
      deps.requestReload = () => this.softReload()
      return new MarkdownSurface(deps)
    }
    deps.applyBlockOps = services.applyBlockOps
    // requestSave backs the PM-internal Mod+S (editorProps handleKeyDown must
    // run pre-core inside ProseMirror's key routing — the interaction contract).
    deps.requestSave = () => this.flushSave()
    // Editor-sourced insert-index math for the surface's #handleSmartPaste/Drop.
    deps.insertIndexForBlock = () => this.insertIndexForBlock()
    deps.insertIndexForBlockAt = (pos) => this.insertIndexForBlockAt(pos)
    deps.clearInsertPos = () => this.clearInsertPos()
    return new WysiwygSurface(this.uuid, deps)
  }
}
