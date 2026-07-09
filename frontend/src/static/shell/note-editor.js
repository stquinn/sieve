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
// The concrete surfaces are the note editor's private input surfaces; importing
// them here also assigns their window.* handles for the classic-script
// editor.js factory (no index.html change needed).
import './surfaces/wysiwyg-surface.js'
import './surfaces/markdown-surface.js'

/**
 * @typedef {object} NoteEditorOptions
 * @property {(url: string) => WebSocket} [socketFactory] — injected for tests; defaults to `new WebSocket(url)`
 * @property {() => string}               [wsUrl]         — injected for tests; defaults to the /api/ws URL for this uuid
 * @property {(msg: object) => void}      [onServerMessage] — routing for the remaining messages (editor.js owns it)
 * @property {(mode: string, services: import('./abstract-editor.js').EditorSurfaceServices) => import('./surfaces/abstract-surface.js').AbstractSurface} [surfaceFactory]
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
}
