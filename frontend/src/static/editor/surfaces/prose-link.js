// @ts-check
// prose-link.js — ONE hyperlink in the document, and every verb that owns it.
//
// A link is ORDINARY MARKDOWN, not a Sieve block
// (docs/design/specs/2026-07-27-inline-block-removal-links-decision.md), so in the
// WYSIWYG surface it is a TipTap `link` MARK over a text range — it has no block
// id, no NodeView, no processor. That makes it the one document thing with no
// owning type, which is exactly how the knowledge of it ended up smeared across a
// context menu and a key handler. This class IS that owning type: resolve one
// (`at` / `forSelection`), then ask it for its href, its label, its document
// range, its clipboard views, or tell it to change (`apply`), be edited
// (`edit`), or be copied (`copy`). #67.
//
// Every consumer goes through it — the interaction policy's Mod+K, the editor
// context menu's "Edit Link…"/"Copy Link", and the context menu's Convert offers
// (which need the range so the playback can consume it). None of them re-derives
// a mark range.
//
// It lives in editor/surfaces/ because it reads and dispatches ProseMirror
// (surfaces is THE PM package). It takes a live `view`, never a global.

import { esc } from '../../block/renderers/html-escape.js'
import { openLinkEditor } from '../../ui/link-edit-dialog.js'

/** @typedef {{ from: number, to: number }} DocRange */

export class ProseLink {
  /** @type {any} */ #view
  /** @type {number} */ #from
  /** @type {number} */ #to
  /** @type {string} */ #href
  /** @type {string} */ #label
  /** @type {boolean} */ #isNew

  /**
   * Prefer the `at` / `forSelection` factories — they are the only things that
   * know how a mark range is found.
   * @param {any} view — the ProseMirror EditorView
   * @param {{from: number, to: number, href: string, label: string, isNew: boolean}} fields
   */
  constructor(view, fields) {
    this.#view = view
    this.#from = fields.from
    this.#to = fields.to
    this.#href = fields.href
    this.#label = fields.label
    this.#isNew = fields.isNew
  }

  // ── Factories ───────────────────────────────────────────────────────────────

  /**
   * The link mark covering document position `pos`, or null. Walks outward over
   * adjacent text nodes carrying the SAME href, so a link whose label is partly
   * bold still resolves to one range.
   * @param {any} view @param {number} pos @returns {ProseLink|null}
   */
  static at(view, pos) {
    const state = view && view.state
    const type = state && state.schema.marks.link
    if (!type) return null
    let $pos
    try { $pos = state.doc.resolve(pos) } catch (e) { return null }
    const parent = $pos.parent
    if (!parent.isTextblock) return null

    // childAfter, falling back to childBefore when the position sits exactly on a
    // child boundary (the caret at the end of a link is the common case, and the
    // mark is inclusive:false so it is not in $pos.marks()).
    let child = parent.childAfter($pos.parentOffset)
    if (!child.node || ($pos.parentOffset === child.offset && child.offset !== 0)) {
      const before = parent.childBefore($pos.parentOffset)
      if (before.node && type.isInSet(before.node.marks)) child = before
    }
    if (!child.node) return null
    const mark = type.isInSet(child.node.marks)
    if (!mark) return null

    /** @param {any} node */
    const sameLink = (node) => {
      const m = type.isInSet(node.marks)
      return !!m && m.attrs.href === mark.attrs.href
    }
    let startIndex = child.index
    let startPos = $pos.start() + child.offset
    let endIndex = startIndex + 1
    let endPos = startPos + child.node.nodeSize
    while (startIndex > 0 && sameLink(parent.child(startIndex - 1))) {
      startIndex -= 1
      startPos -= parent.child(startIndex).nodeSize
    }
    while (endIndex < parent.childCount && sameLink(parent.child(endIndex))) {
      endPos += parent.child(endIndex).nodeSize
      endIndex += 1
    }
    return new ProseLink(view, {
      from: startPos,
      to: endPos,
      href: mark.attrs.href || '',
      label: state.doc.textBetween(startPos, endPos, ''),
      isNew: false,
    })
  }

  /**
   * The link the current selection is ABOUT: the mark under the caret if there is
   * one, else the selected text as a link waiting to be created (`isNew`), else
   * null. A NodeSelection or a selection spanning textblocks yields null — there
   * is no single inline range to mark.
   * @param {any} view @returns {ProseLink|null}
   */
  static forSelection(view) {
    const state = view && view.state
    if (!state) return null
    const sel = state.selection
    if (sel.node) return null
    const existing = ProseLink.at(view, sel.from)
    if (existing) return existing
    if (sel.empty) return null
    const $from = sel.$from, $to = sel.$to
    if (!$from.parent.isTextblock || $from.parent !== $to.parent) return null
    if (!state.schema.marks.link) return null
    const text = state.doc.textBetween(sel.from, sel.to, '')
    if (!text.trim()) return null
    return new ProseLink(view, { from: sel.from, to: sel.to, href: '', label: text, isNew: true })
  }

  // ── Read ────────────────────────────────────────────────────────────────────

  /** @returns {string} */ get href() { return this.#href }
  /** @returns {string} */ get label() { return this.#label }
  /** @returns {number} */ get from() { return this.#from }
  /** @returns {number} */ get to() { return this.#to }
  /** True when no mark exists yet — the selected text is a link-to-be. @returns {boolean} */
  get isNew() { return this.#isNew }
  /** The document range this link occupies. @returns {DocRange} */
  get range() { return { from: this.#from, to: this.#to } }

  /**
   * The clipboard/detection views of this link — what Go's `ContentEntry.Link()`
   * reads to decide what a link can become.
   *
   * text/html FIRST and NON-NEGOTIABLE: the rendered link's plain text is the
   * LABEL ALONE ("Title") with the URL nowhere in it, so a text/plain-only entry
   * set carries no href and every processor declines — zero offers, silently.
   * The `<a href>` view is the only one that survives the round trip, and it is
   * the first form `Link()` looks for. text/plain rides along as the markdown
   * form for anything that reads text.
   * @returns {{mimeType: string, content: string}[]}
   */
  contentEntries() {
    const label = this.#label || this.#href
    return [
      { mimeType: 'text/html', content: '<a href="' + esc(this.#href) + '">' + esc(label) + '</a>' },
      { mimeType: 'text/plain', content: '[' + label.replace(/[[\]]/g, '') + '](' + this.#href + ')' },
    ]
  }

  // ── Write ───────────────────────────────────────────────────────────────────

  /**
   * Writes the link into the document as an ORDINARY TRACKED prose edit — it
   * rides the existing prose→Go block-sync, exactly like typing (no wire verb of
   * its own, nothing to render back). Blank href → no-op.
   *
   * Label unchanged → only the mark is swapped, so any other inline marks on the
   * text (bold, code) survive. Label changed → the range is replaced by the new
   * text carrying the link mark, which is the user asking for that text.
   * @param {string} href @param {string} label @returns {boolean} applied
   */
  apply(href, label) {
    const view = this.#view
    const state = view && view.state
    const type = state && state.schema.marks.link
    if (!type || !href) return false
    const text = (label && label.trim()) || href
    const mark = type.create({ href })
    const current = state.doc.textBetween(this.#from, this.#to, '')
    const tr = (text === current)
      ? state.tr.removeMark(this.#from, this.#to, type).addMark(this.#from, this.#to, mark)
      : state.tr.replaceWith(this.#from, this.#to, state.schema.text(text, [mark]))
    view.dispatch(tr.scrollIntoView())
    view.focus()
    return true
  }

  /** Opens the shared link dialog bound to this link's `apply`. @returns {boolean} */
  edit() {
    openLinkEditor({
      title: this.#isNew ? 'Add Link' : 'Edit Link',
      href: this.#href,
      label: this.#label,
      onSave: (href, label) => { this.apply(href, label) },
    })
    return true
  }

  /** Puts the href on the system clipboard. @returns {boolean} */
  copy() {
    if (!this.#href) return false
    if (typeof navigator === 'undefined' || !navigator.clipboard) return false
    navigator.clipboard.writeText(this.#href).catch(() => {})
    return true
  }
}
