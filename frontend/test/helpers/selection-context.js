// selection-context.js — test adapter (P3.C). Builds a full SelectionContext from
// a fixture editor by running the SAME production PM→descriptor core the surface
// uses (buildSelectionDescriptor) — so the ai-target tests exercise the REAL path
// and cannot drift from what the app produces.
//
// The fixtures ({editor:{state}}) have no block-chrome / live DOM, so the effective
// range is the plain live selection (exactly the fallback WysiwygSurface.feedSelection
// uses when block-chrome is absent). docUuid/focusZone are the model's to inject; we
// stamp coherent values here.

import { buildSelectionDescriptor } from '../../src/static/shell/surfaces/selection-descriptor.js'

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
  const state = editor.state
  const sel = state.selection
  const er = { from: sel.from, to: sel.to, active: !sel.empty, isBlockRange: false, isNodeSelection: !!sel.node }
  const T = (typeof window !== 'undefined') ? window.TipTap : undefined
  const raw = buildSelectionDescriptor(state.doc, sel, er, T)
  return /** @type {any} */ (Object.assign({ docUuid: 't', focusZone: 'editor' }, raw))
}
