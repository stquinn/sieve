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
 */

export class NoteEditor extends AbstractEditor {
  /**
   * Declares the live channel (faithful to editor.js: openEditorWs ran at the
   * end of initEditor for every non-prompt uuid). Everything else is inherited.
   * @param {string}           uuid
   * @param {NoteEditorOptions} [options]
   */
  constructor(uuid, options = {}) {
    super(uuid, Object.assign({}, options, { connect: true }))
  }

  /**
   * NoteEditor's repertoire: BOTH surfaces, mode-mapped (moved verbatim from
   * editor.js's makeSurface, P2.C.2). Deps = the editor's own domain services
   * plus the transitional IIFE collaborators bag (P3/P4 death dates unchanged).
   * @protected
   * @param {import('./editor-mode.js').EditorModeValue} mode
   * @param {import('./abstract-editor.js').EditorSurfaceServices} services
   * @returns {import('./surfaces/abstract-surface.js').AbstractSurface}
   */
  _createSurface(mode, services) {
    const c = this._surfaceCollaborators
    const deps = {
      notify: services.notify,
      takeInsertPos: c.takeInsertPos,
    }
    if (mode === EditorMode.MARKDOWN) {
      deps.updateText = services.updateText
      deps.requestReload = c.requestReload
      return new MarkdownSurface(deps)
    }
    deps.applyBlockOps = services.applyBlockOps
    // requestSave backs the PM-internal Mod+S (editorProps handleKeyDown must
    // run pre-core inside ProseMirror's key routing — the interaction contract).
    deps.requestSave = c.requestSave
    deps.onPaste = c.onPaste
    deps.onDrop = c.onDrop
    return new WysiwygSurface(this.uuid, deps)
  }
}
