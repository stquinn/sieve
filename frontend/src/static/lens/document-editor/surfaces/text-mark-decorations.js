// @ts-check
// One producer's text marks as inline decorations. Every feature that pushes
// marks draws them this way; what differs between features is the classes they
// paint and what else they keep track of, which is the one thing a subclass says.
//
// NOT A CLASS ON A PROSE NODE. A native prose node belongs to ProseMirror, which
// reconciles away anything set on it from outside, so a mark is a decoration —
// the same rule `MentionDecorations` and `AiTargetDecoration` follow.
//
// MARKS ARE PUSHED PER BLOCK AND REPLACE. Plugin state holds one entry per block
// id, written through meta by `apply`. A push carrying no marks is the CLEAR for
// that block. A block nobody has pushed for draws nothing, so a mount that never
// hears from a producer — a prompt, a pinned version — is inert without a gate.
//
// ANCHORED BY QUOTE, NOT BY OFFSET. The offsets a mark carries are into the
// block's stored text; the surface draws the parsed reading of it. Each mark is
// placed by finding its quote at its occurrence and grain in the block's own
// reading, and one that no longer resolves is DROPPED.
//
// THE SET IS REBUILT, NEVER MAPPED. It is recomputed whenever the document or
// the marks change, so a mark follows its text through an edit and leaves the
// moment that text stops being what was flagged. Mapping the old positions
// forward would keep a decoration stretched over text nobody flagged.
//
// ONE INSTANCE PER SURFACE, holding its own plugin key. Two live editors on a
// page draw different documents, and a shared key would let one document's marks
// address the other's state.

import { QuoteAnchor } from '../../../renderers/quote-anchor.js'
import { FlatText } from './flat-text.js'

/**
 * @typedef {{quote?: string, occurrence?: number, grain?: string}} AnchoredMark
 * @typedef {{blockId: string, mark: any, ranges: Array<{from: number, to: number}>}} MarkHit
 */

export class TextMarkDecorations {
  /** @type {any} the plugin key this surface's state lives under */ #key
  /** @type {any} the extension the editor is built with */ #extension
  /** @type {string} the producer whose marks this set draws */ #feature

  /**
   * @param {any} T the TipTap/ProseMirror vendor bag
   * @param {string} name the extension and plugin-key name, one per feature
   * @param {string} feature the wire word this set's marks were pushed under
   */
  constructor(T, name, feature) {
    this.#feature = feature
    this.#key = new T.PluginKey(name)
    const key = this.#key
    const self = this
    const Decoration = T.Decoration
    const DecorationSet = T.DecorationSet
    this.#extension = T.Extension.create({
      name: name,
      addProseMirrorPlugins: function () {
        return [
          new T.Plugin({
            key: key,
            state: {
              init: function () { return { marks: new Map(), hits: [], cursor: null, decos: DecorationSet.empty } },
              apply: function (/** @type {any} */ tr, /** @type {any} */ prev, /** @type {any} */ _old, /** @type {any} */ next) {
                const meta = tr.getMeta(key)
                if (!meta && !tr.docChanged) return prev
                const marks = (meta && meta.marks) ? TextMarkDecorations.#replaced(prev.marks, meta) : prev.marks
                const hits = TextMarkDecorations.hits(next.doc, marks)
                const painted = self.paintHits(hits, meta, prev.cursor, Decoration)
                return {
                  marks: marks,
                  hits: hits,
                  cursor: painted.cursor,
                  decos: painted.decorations.length ? DecorationSet.create(next.doc, painted.decorations) : DecorationSet.empty,
                }
              },
            },
            props: {
              decorations: function (/** @type {any} */ state) {
                const ps = key.getState(state)
                return ps ? ps.decos : DecorationSet.empty
              },
            },
          }),
        ]
      },
    })
  }

  /** @returns {any} the extension to build the editor with */
  get extension() { return this.#extension }

  /** @returns {string} the producer whose marks this set draws */
  get feature() { return this.#feature }

  /**
   * What this feature draws over the hits it now has, and whatever scalar it
   * keeps alongside them. Subclasses override; the base draws nothing, which is
   * a feature that has been given no look.
   *
   * `meta` is the transaction's own message — the push that carried marks, or
   * whatever else a subclass sends itself — and is null on a plain document
   * change. `cursor` is what this returned last time.
   * @protected
   * @param {ReadonlyArray<MarkHit>} _hits
   * @param {any} _meta
   * @param {any} _cursor
   * @param {any} _Decoration the vendor's Decoration factory
   * @returns {{cursor: any, decorations: any[]}}
   */
  paintHits(_hits, _meta, _cursor, _Decoration) { return { cursor: null, decorations: [] } }

  /**
   * Tells the view one block's COMPLETE mark set, replacing what it held for
   * that block; an empty list clears it. A meta-only transaction: the document
   * does not change, so nothing here dirties the buffer or enters undo history.
   * @param {any} view a ProseMirror view
   * @param {string} blockId
   * @param {ReadonlyArray<AnchoredMark>} marks
   */
  apply(view, blockId, marks) {
    if (!view || !blockId) return
    view.dispatch(view.state.tr.setMeta(this.#key, { blockId: blockId, marks: marks || [] }))
  }

  /**
   * Sends this feature a message of its own — what `paintHits` reads as `meta`
   * on a transaction that carries no marks. A meta-only transaction, for the
   * reason `apply` is.
   * @protected
   * @param {any} view @param {Record<string, any>} message
   */
  signal(view, message) {
    if (!view) return
    view.dispatch(view.state.tr.setMeta(this.#key, message))
  }

  /**
   * The hits this surface currently draws, in document order. Only marks that
   * RESOLVE are in it, so a caller acts on text the reader can see.
   * @param {any} state a ProseMirror editor state
   * @returns {ReadonlyArray<MarkHit>}
   */
  heldHits(state) {
    const held = state ? this.#key.getState(state) : null
    return (held && held.hits) ? held.hits : []
  }

  /**
   * The marks this set draws that `[from, to]` sits on, each carrying the block
   * it was pushed for and the FEATURE that drew it — the one field the wire mark
   * lacks, because it rides the frame envelope rather than the mark. Only marks
   * that RESOLVE are in it, so a caller acts on text the reader can see.
   *
   * A collapsed caret touches a mark it sits anywhere within, its edges
   * included: the caret in a marked word is how a reader points at it, and a
   * right-click lands it wherever in the word the pointer was. A ranged
   * selection has to genuinely overlap.
   * @param {any} state a ProseMirror editor state
   * @param {number} from @param {number} to
   * @returns {Array<Record<string, any>>}
   */
  marksAt(state, from, to) {
    const hits = this.heldHits(state)
    if (!hits.length) return []
    const lo = Math.min(from, to)
    const hi = Math.max(from, to)
    /** @type {Array<Record<string, any>>} */ const on = []
    for (const hit of hits) {
      const touches = hit.ranges.some((/** @type {{from: number, to: number}} */ r) =>
        (lo === hi) ? (lo >= r.from && lo <= r.to) : (lo < r.to && hi > r.from))
      if (touches) on.push(Object.assign({ blockId: hit.blockId, feature: this.#feature }, hit.mark))
    }
    return on
  }

  /**
   * Whatever `paintHits` last returned as its cursor.
   * @protected
   * @param {any} state @returns {any}
   */
  heldCursor(state) {
    const held = state ? this.#key.getState(state) : null
    return held ? held.cursor : null
  }

  /**
   * Where each held mark resolves in `doc`: the block it was pushed for, the
   * mark itself, and the document ranges its quote occupies. A block id the
   * document does not hold, a mark whose quote no longer resolves at its
   * occurrence, and one that resolves onto no document position at all
   * contribute nothing.
   * @param {any} doc a ProseMirror document node
   * @param {Map<string, ReadonlyArray<AnchoredMark>>} marksByBlock
   * @returns {Array<MarkHit>}
   */
  static hits(doc, marksByBlock) {
    /** @type {Array<MarkHit>} */ const hits = []
    if (!doc || !marksByBlock || marksByBlock.size === 0) return hits
    doc.forEach((/** @type {any} */ node, /** @type {number} */ offset) => {
      const id = (node.attrs && node.attrs.id) || ''
      const marks = id ? marksByBlock.get(id) : null
      if (!marks || !marks.length) return
      const flat = FlatText.ofNode(node, offset)
      for (const hit of QuoteAnchor.spansFor(flat.text, marks)) {
        const ranges = flat.ranges(hit.start, hit.end)
        if (ranges.length) hits.push({ blockId: id, mark: hit.mark, ranges: ranges })
      }
    })
    return hits
  }

  /**
   * The mark table with one block's entry replaced. A push carrying no marks
   * RETIRES the entry rather than storing an empty one, so an unmarked block is
   * a block the table does not name.
   * @param {Map<string, ReadonlyArray<any>>} held
   * @param {{blockId: string, marks: ReadonlyArray<any>}} push
   * @returns {Map<string, ReadonlyArray<any>>}
   */
  static #replaced(held, push) {
    const next = new Map(held)
    if (push.marks && push.marks.length) next.set(push.blockId, push.marks)
    else next.delete(push.blockId)
    return next
  }
}
