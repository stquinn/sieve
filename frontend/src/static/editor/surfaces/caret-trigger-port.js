// @ts-check
// caret-trigger-port.js — CaretTriggerPort: what a live ProseMirror caret can
// answer for the `@` picker hosted in the document (#38).
//
// This is the PM half of shell's `ProseMirrorHost`: editor/surfaces/ is THE PM
// package and nothing PM crosses out of it — what leaves here is a rect, a
// string, an offset.
//
// SelectionModel is deliberately NOT the source for any of it. It is a DOCUMENT
// coordinate and never a PM node, so it can say which block the caret is in but
// not where that is in pixels, nor what text surrounds it. Both come from the
// view.

import { T } from './tiptap-vendor.js'
import { triggersSuppressed } from '../interaction-policy.js'

export class CaretTriggerPort {
  /** @type {any} the live TipTap Editor the caret lives in */ #pane
  /** @type {any} the surface's parent editor — the OWNER of all index math */ #editor
  /** @type {() => void} flush the surface's debounced block-sync */ #flush

  /**
   * @param {any} pane    the live TipTap Editor (the surface's #editorPane)
   * @param {any} editor  the parent AbstractEditor (createBlock's owner)
   * @param {() => void} [flush]  the surface's flushPending; omitted in tests
   *   that have no sync spine, where there is nothing to flush.
   */
  constructor(pane, editor, flush) {
    if (!pane) throw new Error('CaretTriggerPort: a TipTap pane is required')
    this.#pane = pane
    this.#editor = editor || null
    this.#flush = flush || (() => {})
  }

  /** The editable root — where the host's capture-phase key listener lands.
   *  @returns {HTMLElement} */
  element() { return this.#pane.view.dom }

  /**
   * The caret's own textblock and the offset within it — the two halves of a
   * token scan, read from ONE state so they cannot straddle a transaction. Null
   * means there is nothing here to scan.
   *
   * The last guard is why `@Override` inside a code or diagram block never arms
   * the picker, and it is ASKED of `interaction-policy.js` rather than decided
   * here: judging eligibility would be a second declaration mechanism beside
   * `interactionPolicy`.
   * @returns {{text: string, caret: number}|null}
   */
  caretText() {
    const pane = this.#pane
    if (!pane.view || pane.view.isDestroyed) return null
    const sel = pane.state.selection
    if (!sel || !sel.empty || sel.node) return null
    const $from = sel.$from
    if (!$from.parent || !$from.parent.isTextblock) return null
    if (triggersSuppressed(pane.state, pane.view)) return null
    return { text: $from.parent.textContent, caret: $from.parentOffset }
  }

  /**
   * The caret in viewport pixels. Null (the host falls back to the editor's own
   * box) when the view cannot answer: `coordsAtPos` THROWS for a position it has
   * no DOM for, which happens mid-teardown and inside a detached node view, and
   * a picker is never worth an exception.
   * @returns {DOMRect|null}
   */
  caretRect() {
    const pane = this.#pane
    if (!pane.view || pane.view.isDestroyed) return null
    try {
      const c = pane.view.coordsAtPos(pane.state.selection.from)
      if (!c) return null
      return /** @type {any} */ ({
        left: c.left, right: c.right, top: c.top, bottom: c.bottom,
        x: c.left, y: c.top,
        width: Math.max(0, c.right - c.left), height: Math.max(0, c.bottom - c.top),
      })
    } catch (e) {
      return null
    }
  }

  /**
   * Substitutes over a BLOCK-LOCAL range — the coordinate the scan produced — as
   * one TRACKED transaction, so a completion is one Ctrl+Z away.
   * @param {number} start @param {number} end @param {string} text
   */
  replaceRange(start, end, text) {
    const pane = this.#pane
    if (!pane.view || pane.view.isDestroyed) return
    const blockStart = pane.state.selection.$from.start()
    const from = blockStart + start
    const to = blockStart + end
    const tr = pane.state.tr
    if (text) tr.insertText(text, from, to)
    else if (from !== to) tr.delete(from, to)
    const caret = Math.min(from + text.length, tr.doc.content.size)
    tr.setSelection(T.TextSelection.create(tr.doc, caret))
    pane.view.dispatch(tr.scrollIntoView())
  }

  /**
   * ACCEPTANCE, THE DOCUMENT VERSION: the token goes and a block takes its place.
   *
   * The FLUSH is load-bearing — Go's shadow must hold the token deletion before
   * the create arrives on the same socket. The create itself is the editor's,
   * because it owns the id→index math and renders the server's authoritative
   * node back at the server's index; nothing here computes a document position.
   *
   * The anchor argument is OMITTED deliberately: the caret is left where the
   * token was, so the standard placement rule (consume an empty paragraph, else
   * the next line) already lands the block correctly, and passing an index would
   * take that math off its one owner.
   * @param {number} start @param {number} end
   * @param {string} kind @param {Record<string, any>} attrs
   */
  createBlock(start, end, kind, attrs) {
    this.replaceRange(start, end, '')
    this.#flush()
    if (this.#editor) this.#editor.createBlock(kind, attrs)
  }

  /**
   * DOC CHANGES ONLY — a caret MOVE must not arm the picker. Clicking into an
   * `@` written months ago and having a picker open on it is an ambush, and a
   * document is full of legitimate `@`s.
   * @param {() => void} fn @returns {() => void}
   */
  onDocChange(fn) {
    const handler = () => fn()
    this.#pane.on('update', handler)
    return () => this.#pane.off('update', handler)
  }

  /** @param {() => void} fn @returns {() => void} */
  onBlur(fn) {
    const handler = () => fn()
    this.#pane.on('blur', handler)
    return () => this.#pane.off('blur', handler)
  }
}
