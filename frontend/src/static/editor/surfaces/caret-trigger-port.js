// @ts-check
// caret-trigger-port.js — CaretTriggerPort: what a live ProseMirror caret can
// answer for the `@` picker hosted in the document (#38).
//
// THE HOST IS SHELL'S, THE PORT IS THE SURFACE'S. `ProseMirrorHost`
// (shell/trigger-host.js) belongs to the TriggerPopover/TriggerProvider/
// TriggerHost family and must be constructible where the popover is, so it
// touches no PM API at all; this class is the half that does. The split is the
// package rule stated as code: editor/surfaces/ is THE PM package, and nothing
// PM crosses out of it — what leaves here is a rect, a string, an offset.
//
// SelectionModel is deliberately NOT the source for any of it. It is a DOCUMENT
// coordinate and never a PM node ("the PM/DOM split is insulated inside the
// surface"), so it can say which block the caret is in but not where that is in
// pixels, nor what text surrounds it. Both come from the view.
//
// It is a CLASS, not four closures on the surface, because it is a cohesive
// thing with its own data (the pane, the editor, the flush) and because a test
// can then drive the SHIPPED port against a real TipTap editor rather than a
// re-typed copy of it.

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
   * token scan, read from ONE state so they cannot straddle a transaction.
   *
   * Null means "there is nothing here to scan", and it answers four cases at
   * once: no live view, a ranged or node selection (no caret), a parent that is
   * not a textblock, and — the policy one — a block whose kind declares
   * `suppressTriggers`, which is why `@Override` inside a code or diagram block
   * never arms the picker. That last one is asked of `interaction-policy.js`
   * rather than decided here: eligibility is a POLICY decision, and a port that
   * judged it would be a second declaration mechanism beside `interactionPolicy`.
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
   * The caret in viewport pixels, via `view.coordsAtPos` — the same measurement
   * block-chrome already places gutter decorations with. Null (the host falls
   * back to the editor's own box) when the view cannot answer: coordsAtPos
   * throws for a position it has no DOM for, which happens mid-teardown and
   * inside a detached node view, and a picker is never worth an exception.
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
   * Substitutes over a BLOCK-LOCAL range as one TRACKED transaction. Block-local
   * because that is the coordinate the scan produced; tracked because it is the
   * user's own edit — a completion has to be one Ctrl+Z away, exactly as it is
   * in the composer.
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
   * THE BACKEND IS THE SOURCE OF TRUTH and this obeys it exactly (CLAUDE.md's
   * non-obvious rules): nothing here computes a document position or splices a
   * node in. It deletes the token as an ordinary tracked prose edit, flushes so
   * Go's shadow holds that deletion BEFORE the create arrives on the same
   * socket, and then asks the EDITOR to create — which owns the id→index math,
   * resolves the index from the caret, and renders the server's authoritative
   * node back at the server's index. No `softReloadContent`, so undo survives.
   *
   * The placement rule falls out of that rather than being restated: the caret
   * is left where the token was, so a line the token had to itself is now an
   * empty paragraph and gets consumed — the block becomes that node — while a
   * line with prose still on it puts the block on the next one. That is the rule
   * every Sieve block already follows, which is why the anchor argument is
   * OMITTED: passing an index here would take the math off the one owner of it.
   * @param {number} start @param {number} end
   * @param {string} kind @param {Record<string, any>} attrs
   */
  createBlock(start, end, kind, attrs) {
    this.replaceRange(start, end, '')
    this.#flush()
    if (this.#editor) this.#editor.createBlock(kind, attrs)
  }

  /**
   * DOC CHANGES ONLY, which is a textarea's `input` exactly: a caret MOVE must
   * not arm the picker. Clicking into an `@` written months ago and having a
   * picker open on it is the ambush the abandonment machine exists to prevent,
   * and a document — unlike a two-line message — is full of legitimate `@`s.
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
