// @ts-check
// note-editor.js — the editor type for regular notes (P2.A, P2.B, P2.B.2).
// Since issue #49 Phase 1 the transport lives in the SERVICE PAIR (BlockService
// owns the wire; DocumentService fronts the uuid-addressed lifecycle).
// NoteEditor's whole definition is: the editor type that DECLARES a live
// channel (connect: true — AbstractEditor opens it via documentService.open)
// and edits rich notes through the mode-swappable surfaces. It contains zero
// transport vocabulary — that a WebSocket underlies the channel is not its
// business (nor any caller's).
//
// The WS protocol (message shapes, reconnect policy) is FROZEN — owned and
// enveloped by the BlockService alone.
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
 * @property {import('../block/document-service.js').DocumentService} [documentService] — the service half the channel opens through (composition root wiring; test seams live on BlockService's constructor)
 * @property {(msg: object) => void}      [onServerMessage] — routing for the remaining messages (Workspace owns it)
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
   * editor.js's makeSurface, P2.C.2). Each surface receives THIS editor (`host`)
   * as its single constructor arg and calls the editor's public API directly
   * (onSurfaceEvent / setRawContent / takeInsertPos / flushSave / softReload /
   * insertIndexForBlock / insertIndexForBlockAt / clearInsertPos — plus the
   * service pair through the documentService/blockService getters) — the
   * pre-bound `deps` closure bag is dissolved (P4.F).
   * @protected
   * @param {import('./editor-mode.js').EditorModeValue} mode
   * @returns {import('./surfaces/abstract-surface.js').AbstractSurface}
   */
  _createSurface(mode) {
    if (mode === EditorMode.MARKDOWN) return new MarkdownSurface(this)
    return new WysiwygSurface(this)
  }
}
