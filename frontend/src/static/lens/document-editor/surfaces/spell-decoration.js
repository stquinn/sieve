// @ts-check
// Spelling marks as inline decorations: one squiggle per mark the server pushed
// that still resolves in what the surface draws.
//
// NOT A CLASS ON A PROSE NODE. A native prose node belongs to ProseMirror, which
// reconciles away anything set on it from outside, so the squiggle is a
// decoration — the same rule `MentionDecorations` and `AiTargetDecoration`
// follow.
//
// MARKS ARE PUSHED PER BLOCK AND REPLACE. Plugin state holds one entry per block
// id, written through meta by `apply`. A push carrying no marks is the CLEAR for
// that block, which is how a corrected block loses its squiggle. A block nobody
// has pushed for draws nothing, so a mount that never hears from the checker —
// a prompt, a pinned version — is inert without a gate.
//
// ANCHORED BY QUOTE, NOT BY OFFSET. The offsets a mark carries are into the
// block's stored markdown; the surface draws the parsed reading of it. Each mark
// is placed by finding its quote at its occurrence in the block's own reading,
// and one that no longer resolves is DROPPED.
//
// THE SET IS REBUILT, NEVER MAPPED. It is recomputed whenever the document or
// the marks change, so a squiggle follows its word through an edit and leaves
// the moment the word stops being the word that was flagged. Mapping the old
// positions forward would keep a decoration stretched over text nobody flagged.
//
// ONE INSTANCE PER SURFACE, holding its own plugin key. Two live editors on a
// page draw different documents, and a shared key would let one document's marks
// address the other's state.

import { QuoteAnchor } from '../../../renderers/quote-anchor.js'
import { FlatText } from './flat-text.js'

/** The class the squiggle carries. */
export const SPELL_MARK_CLASS = 'sieve-spell-mark'

export class SpellDecorations {
  /** @type {any} the plugin key this surface's state lives under */ #key
  /** @type {any} the extension the editor is built with */ #extension

  /** @param {any} T the TipTap/ProseMirror vendor bag */
  constructor(T) {
    this.#key = new T.PluginKey('sieveSpell')
    const key = this.#key
    const Decoration = T.Decoration
    const DecorationSet = T.DecorationSet
    this.#extension = T.Extension.create({
      name: 'sieveSpellDecoration',
      addProseMirrorPlugins: function () {
        return [
          new T.Plugin({
            key: key,
            state: {
              init: function () { return { marks: new Map(), hits: [], decos: DecorationSet.empty } },
              apply: function (/** @type {any} */ tr, /** @type {any} */ prev, /** @type {any} */ _old, /** @type {any} */ next) {
                const meta = tr.getMeta(key)
                if (!meta && !tr.docChanged) return prev
                const marks = meta ? SpellDecorations.#replaced(prev.marks, meta) : prev.marks
                const hits = SpellDecorations.hits(next.doc, marks)
                if (!hits.length) return { marks: marks, hits: hits, decos: DecorationSet.empty }
                /** @type {any[]} */ const decos = []
                for (const hit of hits) {
                  for (const range of hit.ranges) {
                    decos.push(Decoration.inline(range.from, range.to, { class: SPELL_MARK_CLASS }))
                  }
                }
                return { marks: marks, hits: hits, decos: DecorationSet.create(next.doc, decos) }
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

  /**
   * Tells the view one block's COMPLETE mark set, replacing what it held for
   * that block; an empty list clears it. A meta-only transaction: the document
   * does not change, so nothing here dirties the buffer or enters undo history.
   * @param {any} view a ProseMirror view
   * @param {string} blockId
   * @param {ReadonlyArray<{quote?: string, occurrence?: number}>} marks
   */
  apply(view, blockId, marks) {
    if (!view || !blockId) return
    view.dispatch(view.state.tr.setMeta(this.#key, { blockId: blockId, marks: marks || [] }))
  }

  /**
   * The marks this surface draws that `[from, to]` sits on, each carrying the
   * block it was pushed for — what an affordance acting on "the word under the
   * caret" reads. Only marks that RESOLVE are in it, so a caller acts on text
   * the reader can see.
   *
   * A collapsed caret touches a mark it sits anywhere within, its edges
   * included: the caret in a flagged word is how a reader points at it, and a
   * right-click lands it wherever in the word the pointer was. A ranged
   * selection has to genuinely overlap.
   *
   * It READS the hits the state already holds rather than walking the document
   * again — they are recomputed on the same transactions this could be asked
   * about, so a second walk could only produce the same answer.
   * @param {any} state a ProseMirror editor state
   * @param {number} from @param {number} to
   * @returns {Array<Record<string, any>>}
   */
  marksAt(state, from, to) {
    const held = state ? this.#key.getState(state) : null
    if (!held || !held.hits || !held.hits.length) return []
    const lo = Math.min(from, to)
    const hi = Math.max(from, to)
    /** @type {Array<Record<string, any>>} */ const on = []
    for (const hit of held.hits) {
      const touches = hit.ranges.some((/** @type {{from: number, to: number}} */ r) =>
        (lo === hi) ? (lo >= r.from && lo <= r.to) : (lo < r.to && hi > r.from))
      if (touches) on.push(Object.assign({ blockId: hit.blockId }, hit.mark))
    }
    return on
  }

  /**
   * Where each held mark resolves in `doc`: the block it was pushed for, the
   * mark itself, and the document ranges its quote occupies. A block id the
   * document does not hold, a mark whose quote no longer resolves at its
   * occurrence, and one that resolves onto no document position at all
   * contribute nothing.
   * @param {any} doc a ProseMirror document node
   * @param {Map<string, ReadonlyArray<{quote?: string, occurrence?: number}>>} marksByBlock
   * @returns {Array<{blockId: string, mark: any, ranges: Array<{from: number, to: number}>}>}
   */
  static hits(doc, marksByBlock) {
    /** @type {Array<{blockId: string, mark: any, ranges: Array<{from: number, to: number}>}>} */ const hits = []
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
