// @ts-check
// The editor whose surfaces are ProseMirror: it holds the TipTap handle and turns
// that editor's caret into the ANCHOR the container accepts. Nothing here computes
// a document position for Go — every anchor it hands the container is a BLOCK ID.
//
// Abstract: a concrete subclass still declares its repertoire (`_modes`,
// `_defaultMode`) and builds its surfaces (`_createSurface`).

import { AbstractEditor } from '../abstract-editor.js'
import { EditorMode } from './editor-mode.js'
import { blockInsertPos } from './surfaces/ai-target.js'
import { emptyParagraphAnchor, blockIndexForInsert } from './surfaces/block-position.js'

export class ProseMirrorEditor extends AbstractEditor {
  /** @override
   *  @returns {any} the mounted surface's TipTap Editor (the vendor bundle is
   *  untyped); null when no surface is mounted or the surface has none. */
  get editorPane() { return super.editorPane }

  /** @protected @returns {import('./editor-mode.js').EditorModeValue} */
  get _blockMode() { return EditorMode.WYSIWYG }

  /**
   * @override — OMITTED derives the anchor from the caret with the
   * empty-paragraph consume; a mode with no caret to read appends.
   * @param {string} kind
   * @param {object} [attrs]
   * @param {string|null} [afterBlockId] a stable block id, never a position
   */
  createBlock(kind, attrs, afterBlockId) {
    if (afterBlockId === undefined && this.canEditBlocks) afterBlockId = this.#anchorFromCaret()
    super.createBlock(kind, attrs, afterBlockId)
  }

  /**
   * Captures the caret's insert ANCHOR for an async insert that outlives the caret:
   * the image insert opens a file dialog, which blurs the editor. NON-consuming,
   * because a cancelled upload must leave the blank line.
   * @returns {string|null|undefined} the block the upload should follow
   */
  captureImageInsert() {
    const ed = this.editorPane
    if (!ed) return undefined
    return this.#anchorAtIndex(blockIndexForInsert(ed.state.doc, this.captureInsertPos()))
  }

  // The anchor vocabulary is three-valued: `undefined` = "no anchor, append";
  // `null` = "the front"; an id = "after that one".

  /** Resolves WHERE the next inserted block goes — the single way every additive
   *  creation path stamps the insert position. Block answers always land after the
   *  top-level block, never at the caret.
   *  @returns {number|null} */
  captureInsertPos() {
    const ed = this.editorPane
    return ed ? blockInsertPos(ed.state) : null
  }

  /** The block id a new child taking top-level index `index` should follow. Walks
   *  BACK past any node with no id: the trailing editing surface is not a block Go
   *  knows about, so it cannot anchor anything.
   *  @param {number} index @returns {string|null|undefined} */
  #anchorAtIndex(index) {
    const ed = this.editorPane
    if (!ed || index < 0) return undefined     // no document / no anchor → append
    if (index === 0) return null               // the front of the container
    const doc = ed.state.doc
    for (let i = Math.min(index, doc.childCount) - 1; i >= 0; i--) {
      const id = doc.child(i).attrs && doc.child(i).attrs.id
      if (id) return id
    }
    return null
  }

  /**
   * Maps a captured insert position to the anchor a new block should follow,
   * applying the empty-paragraph placement rule AT COMMIT TIME — never at capture,
   * because a cancelled dialog must not eat the blank line. A bare empty paragraph
   * there is deleted and the new block anchored where it was, then the sync is
   * flushed so Go's shadow applies the delete BEFORE the create arrives.
   *
   * UNDO SANCTITY: a PLAIN TRACKED prose edit — never addToHistory:false.
   * @param {number|null} pos
   * @returns {string|null|undefined}
   */
  #commitAnchor(pos) {
    const ed = this.editorPane
    if (!ed) return undefined
    const anchor = emptyParagraphAnchor(ed.state.doc, pos)
    if (!anchor) return this.#anchorAtIndex(blockIndexForInsert(ed.state.doc, pos))
    // Sole-block doc: keep the paragraph (deleting the doc's only child is
    // schema-invalid).
    if (ed.state.doc.childCount > 1) {
      ed.view.dispatch(ed.state.tr.delete(anchor.from, anchor.to))
      this.flushEdits()
    }
    return this.#anchorAtIndex(anchor.index)
  }

  /** The caret-derived anchor, with the empty-paragraph consume. createBlock's
   *  default. @returns {string|null|undefined} */
  #anchorFromCaret() { return this.#commitAnchor(this.captureInsertPos()) }

  /** The caret-derived anchor, for a surface that creates blocks of its own.
   *  @returns {string|null|undefined} */
  insertAnchorForBlock() { return this.#anchorFromCaret() }

  /** @param {number} pos @returns {string|null|undefined} */
  insertAnchorAt(pos) { return this.#commitAnchor(pos) }

  // #commitAnchor eats the empty-paragraph anchor EAGERLY, which is right when
  // the call point IS the confirmation (a dialog). A paste commits BEFORE it knows
  // the server matched, and on a no-match the eager delete has already remapped
  // the orphaned caret into the adjacent block. So: peek, ask Go, and consume ONLY
  // on the `block` outcome.

  /** The SIDE-EFFECT-FREE half: the anchor plus a HANDLE to the empty paragraph,
   *  to consume once the server confirms. Null handle when there is none, or it is
   *  the doc's sole child.
   *  @param {number|null} pos
   *  @returns {{ afterBlockId: string|null|undefined, anchor: {id: string}|null }} */
  peekInsertAnchor(pos) {
    const ed = this.editorPane
    if (!ed) return { afterBlockId: undefined, anchor: null }
    const anchor = emptyParagraphAnchor(ed.state.doc, pos)
    if (!anchor) {
      return { afterBlockId: this.#anchorAtIndex(blockIndexForInsert(ed.state.doc, pos)), anchor: null }
    }
    if (ed.state.doc.childCount <= 1) return { afterBlockId: this.#anchorAtIndex(anchor.index), anchor: null }
    const node = ed.state.doc.child(anchor.index)
    const id = ((node && node.attrs) || {}).id || ''
    // The anchor sits AT `anchor.index`, so the new block follows whatever
    // precedes it.
    return { afterBlockId: this.#anchorAtIndex(anchor.index), anchor: id ? { id: id } : null }
  }

  /** @returns {{ afterBlockId: string|null|undefined, anchor: {id: string}|null }} */
  peekInsertAnchorForBlock() { return this.peekInsertAnchor(this.captureInsertPos()) }

  /** @param {number} pos
   *  @returns {{ afterBlockId: string|null|undefined, anchor: {id: string}|null }} */
  peekInsertAnchorAt(pos) { return this.peekInsertAnchor(pos) }

  /**
   * The DEFERRED second half: once the server CONFIRMED the insert, delete the
   * empty paragraph that held its place, as a TRACKED prose edit. Located BY ID,
   * never by a captured position — the arrival can shift positions first. No-op
   * when the handle is absent, not found, the doc's sole child, or no longer
   * empty.
   *
   * With `tr` — the transaction placing the confirmed block — the delete is added
   * to it, so the placement and the consume are one undo step however late the
   * block arrives; the caller dispatches and flushes. Without it, the delete is
   * dispatched and flushed here.
   * @param {{id: string}|null} anchor
   * @param {any} [tr]
   */
  consumeInsertAnchor(anchor, tr) {
    if (!anchor || !anchor.id) return
    const ed = this.editorPane
    if (!ed) return
    const doc = tr ? tr.doc : ed.state.doc
    if (doc.childCount <= 1) return
    let pos = -1
    /** @type {any} */
    let node = null
    doc.forEach((/** @type {any} */ child, /** @type {number} */ offset) => {
      if (pos >= 0) return
      if (child && child.attrs && child.attrs.id === anchor.id) {
        pos = offset
        node = child
      }
    })
    if (pos < 0 || !node) return
    // Only ever consume a still-empty paragraph: a stray blank line is benign,
    // losing typed content is not.
    if ((node.textContent || '').trim() !== '') return
    const deleting = tr || ed.state.tr
    deleting.delete(pos, pos + node.nodeSize)
    if (tr) return
    ed.view.dispatch(deleting)
    this.flushEdits()
  }
}
