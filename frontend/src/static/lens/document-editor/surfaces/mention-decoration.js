// @ts-check
// The `@Title` mark inside a draft: an inline decoration over every token of
// every title the mount says is attached.
//
// NOT A CLASS ON A PROSE NODE. A native prose node belongs to ProseMirror, which
// reconciles away anything set on it from outside, so the mark is a decoration —
// the same rule `AiTargetDecoration` follows for the ref-chain glow.
//
// TITLES ARE PUSHED, NOT PULLED. The set is plugin state written through meta by
// `apply`, so the decoration is recomputed exactly when the manifest changes and
// never asks anything outside the document for its answer. An empty set draws
// nothing, which is what EVERY mount that keeps no manifest — the note editor
// first among them — gets without a gate: inertness here is a fact about the
// data, not a branch somebody has to remember to take.
//
// ONE INSTANCE PER SURFACE, holding its own plugin key. Two live editors on a
// page attach different documents, and a key shared between them would let one
// draft's manifest address the other's state.

import { MentionRanges } from './mention-ranges.js'

/** The class the mark carries. Its look is the ai-block's `@Title` mark, so a
 *  name in a draft and the same name in the sent question read alike. */
export const MENTION_CLASS = 'sieve-mention'

export class MentionDecorations {
  /** @type {any} the plugin key this surface's state lives under */ #key
  /** @type {any} the extension the editor is built with */ #extension

  /** @param {any} T the TipTap/ProseMirror vendor bag */
  constructor(T) {
    this.#key = new T.PluginKey('sieveMention')
    const key = this.#key
    const Decoration = T.Decoration
    const DecorationSet = T.DecorationSet
    this.#extension = T.Extension.create({
      name: 'sieveMentionDecoration',
      addProseMirrorPlugins: function () {
        return [
          new T.Plugin({
            key: key,
            state: {
              init: function () { return { titles: [] } },
              apply: function (/** @type {any} */ tr, /** @type {any} */ prev) {
                const meta = tr.getMeta(key)
                return meta && meta.titles ? { titles: meta.titles } : prev
              },
            },
            props: {
              decorations: function (/** @type {any} */ state) {
                const ps = key.getState(state)
                if (!ps || !ps.titles.length) return DecorationSet.empty
                const ranges = MentionRanges.of(state.doc, ps.titles)
                if (!ranges.length) return DecorationSet.empty
                return DecorationSet.create(state.doc, ranges.map(function (r) {
                  return Decoration.inline(r.from, r.to, { class: MENTION_CLASS })
                }))
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
   * Tells the view which titles its draft has attached. A meta-only transaction:
   * the document does not change, so nothing here dirties the draft or enters
   * undo history.
   * @param {any} view a ProseMirror view
   * @param {ReadonlyArray<string|undefined>} titles
   */
  apply(view, titles) {
    if (!view) return
    view.dispatch(view.state.tr.setMeta(this.#key, { titles: titles || [] }))
  }

  /**
   * The title of the `@Title` token spanning `pos`, or null where no token does.
   * Read from the SAME titles the marks are drawn from, so what can be acted on
   * is exactly what is marked — a document nobody attached is not a mention, and
   * an unmarked mount answers null everywhere.
   * @param {any} view a ProseMirror view
   * @param {number} pos a document position
   * @returns {string|null}
   */
  titleAt(view, pos) {
    const state = view && view.state
    const plugin = state && this.#key.getState(state)
    if (!plugin || !plugin.titles.length) return null
    for (const range of MentionRanges.of(state.doc, plugin.titles)) {
      if (pos < range.from || pos > range.to) continue
      // The token IS `@` + the title, so its own text names it.
      return state.doc.textBetween(range.from, range.to).slice(1)
    }
    return null
  }
}
