// selection-context.js — test adapter (P3.C/P3.F). Builds a full SelectionContext
// from a fixture editor by running the SAME production PM→descriptor path the app
// uses — WysiwygSurface.feedSelection — so the ai-target tests exercise the REAL
// path and cannot drift from what the app produces.
//
// P3.F folded the PM→descriptor core (buildSelectionDescriptor et al.) into
// WysiwygSurface as #private methods, so the adapter now drives it exactly as the
// app does: it constructs a WysiwygSurface over the fixture editor (injecting it via
// a `get tiptap()` override — the existing TestWysiwygSurface seam, no construction
// backdoor) and calls feedSelection(). The fixtures ({editor:{state}}) have no
// block-chrome / live DOM, so we inject a `deps.T` that carries ONLY the vendor bits
// feedSelection's fallback path reads (getSieveBlockLabel for rich labels) and
// deliberately OMITS getBlockSelectionRange/domSelectionBlockRange — so the surface
// takes its fallback effective range (the plain live selection) and skips the DOM
// fold, byte-identical to the old hand-built `er` the adapter used to pass. The only
// added field is an inert `blockCursor: null` (happy-dom has no `.sieve-block__edit`
// active element), part of the real SelectionContext shape and untouched by any
// assertion.

import { WysiwygSurface } from '../../src/static/shell/surfaces/wysiwyg-surface.js'
import { getSieveBlockLabel } from '../../src/static/block/sieve-block-extension.js'

// Minimal test surface: inject the fixture editor as the live PM instance so
// feedSelection runs the REAL PM→descriptor path (fallback er, no block-chrome)
// — the same seam surfaces.test.js's TestWysiwygSurface drives. deps.T forwards
// only getSieveBlockLabel (a real/mocked ES import — the bus is retired), with the
// block-chrome methods absent so the fallback range/no-fold path runs
// (er-equivalence, plan §1.4).
class ContextSurface extends WysiwygSurface {
  constructor(editor) {
    const T = { getSieveBlockLabel }
    super('t', {
      applyBlockOps() {}, requestSave() {}, onPaste() { return false },
      onDrop() { return false }, takeInsertPos() { return null }, notify() {}, T,
    })
    this._ed = editor
  }
  get tiptap() { return this._ed }
}

/**
 * @param {{state:any}} editor  a fixture editor (docWithCaret/… → {editor:{state}})
 * @param {boolean} [isMarkdownMode]
 * @returns {import('../../src/static/shell/selection-model.js').SelectionContext}
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
