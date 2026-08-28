// @ts-check
// What a live ProseMirror caret can answer for the `@` picker hosted in the
// document — the PM half of shell's `ProseMirrorHost`. Nothing PM crosses out of
// it: what leaves here is a rect, a string, an offset.

import { T } from './tiptap-vendor.js'
import { FlatText } from './flat-text.js'
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
   * the picker. Eligibility is ASKED of `interaction-policy.js`, never decided
   * here.
   *
   * Both halves come from the FlatText reading of the caret's block, the same
   * ruler every other flat-text reader uses — a hard break is a character in
   * the text AND a position in the document, so the caret cannot drift one
   * place per break the way a `textContent` reading does.
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
    const flat = FlatText.ofBlock($from.parent, $from.start())
    return { text: flat.text, caret: flat.flatOffsetOf(sel.from) }
  }

  /**
   * Whether the caret sits inside the container's FIRST top-level block. A mount
   * whose trigger is a verb over the whole container asks this: such a verb
   * opens what is being written and cannot appear part-way down it.
   * @returns {boolean}
   */
  caretInFirstBlock() {
    const pane = this.#pane
    if (!pane.view || pane.view.isDestroyed) return false
    const sel = pane.state.selection
    return !!sel && sel.$from.index(0) === 0
  }

  /**
   * The caret in viewport pixels, or null when the view cannot answer — the host
   * then falls back to the editor's own box. `coordsAtPos` THROWS for a position
   * it has no DOM for, which happens mid-teardown and inside a detached node view.
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
    // The same FlatText ruler the scan used: block-local flat offsets back to
    // document positions, exact across hard breaks.
    const $from = pane.state.selection.$from
    const flat = FlatText.ofBlock($from.parent, $from.start())
    const from = flat.pmOf(start)
    const to = flat.pmOf(end)
    const tr = pane.state.tr
    if (text) tr.insertText(text, from, to)
    else if (from !== to) tr.delete(from, to)
    const caret = Math.min(from + text.length, tr.doc.content.size)
    tr.setSelection(T.TextSelection.create(tr.doc, caret))
    pane.view.dispatch(tr.scrollIntoView())
  }

  /**
   * Acceptance in the document: the token goes and a block takes its place.
   *
   * The FLUSH is load-bearing — Go's shadow must hold the token deletion before
   * the create arrives on the same socket. The create itself is the editor's,
   * which owns the id→index math; nothing here computes a document position, and
   * the anchor argument is omitted deliberately so the standard placement rule
   * (consume an empty paragraph, else the next line) applies.
   * @param {number} start @param {number} end
   * @param {string} kind @param {Record<string, any>} attrs
   */
  createBlock(start, end, kind, attrs) {
    this.replaceRange(start, end, '')
    this.#flush()
    if (this.#editor) this.#editor.createBlock(kind, attrs)
  }

  /**
   * DOC CHANGES ONLY — a caret MOVE must not arm the picker, or clicking into an
   * `@` written months ago ambushes the user with one.
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
