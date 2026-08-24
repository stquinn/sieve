// selection-context.js — test adapter (P3.C/P3.F). Builds a full SelectionContext
// from a fixture editor by running the SAME production PM→descriptor path the app
// uses — WysiwygSurface.feedSelection — so the ai-target tests exercise the REAL
// path and cannot drift from what the app produces.
//
// P3.F folded the PM→descriptor core (buildSelectionDescriptor et al.) into
// WysiwygSurface as #private methods, so the adapter now drives it exactly as the
// app does: it constructs a WysiwygSurface over the fixture editor (injecting it via
// a `get editorPane()` override — the existing TestWysiwygSurface seam, no construction
// backdoor) and calls feedSelection(). The fixtures ({editor:{state}}) have no
// block-chrome / live DOM. P4.F: the surface takes its parent editor (`host`) and
// IMPORTS `T` from the vendor bag directly — the descriptor helpers
// (getSieveBlockLabel / getBlockSelectionRange / domSelectionBlockRange) are ES
// imports the caller mocks. The block-chrome fallback range + no-fold path run
// exactly as before (getBlockSelectionRange mocked to the live selection,
// domSelectionBlockRange mocked to null). The only added field is an inert
// `blockCursor: null` (happy-dom has no `.sieve-block__edit` active element), part of
// the real SelectionContext shape and untouched by any assertion.

import { WysiwygSurface } from '../../src/static/lens/document-editor/surfaces/wysiwyg-surface.js'

// Minimal test surface: inject the fixture editor as the live PM instance so
// feedSelection runs the REAL PM→descriptor path (fallback er, no block-chrome)
// — the same seam surfaces.test.js's TestWysiwygSurface drives. The host carries
// only the uuid (feedSelection calls no host methods); the descriptor helpers are
// ES imports the caller mocks.
class ContextSurface extends WysiwygSurface {
  constructor(editor) {
    super({
      uuid: 't', applyBlockOps() {}, flushSave() {},
      takeInsertPos() { return null }, onSurfaceEvent() {},
    })
    this._ed = editor
  }
  get editorPane() { return this._ed }
}

/**
 * @param {{state:any}} editor  a fixture editor (docWithCaret/… → {editor:{state}})
 * @param {boolean} [isMarkdownMode]
 * @returns {import('../../src/static/lens/document-editor/selection-model.js').SelectionContext}
 */
export function contextFor(editor, isMarkdownMode = false) {
  if (isMarkdownMode) {
    // Markdown fixture (no textarea in Node): the document target.
    return /** @type {any} */ ({
      docUuid: 't', focusZone: 'markdown',
      selectionType: 'none', caret: null, range: null, selectedText: null,
      blockId: null, blockIds: [], blockKind: null, ref: null,
      target: { kind: 'document', ref: 'doc', range: null, label: 'Document' },
    })
  }
  const raw = new ContextSurface(editor).feedSelection()
  return /** @type {any} */ (Object.assign({ docUuid: 't', focusZone: 'editor' }, raw))
}
