// @ts-check
// The `/verb` mark inside a draft: an inline decoration over the leading command
// token, and only there.
//
// THE VERB IS PUSHED, NOT DERIVED. Which verbs exist is the host's registry, so
// the host says which one this draft currently resolves to and the surface draws
// that one — the same division `MentionDecorations` makes for `@Title` titles. A
// null verb draws nothing, which is what every mount that resolves none gets
// without a gate.
//
// ONLY AT THE HEAD OF THE MESSAGE. A command OPENS a message: the token is the
// first thing in the first block that says anything, so a `/btw` further down is
// text and gets no mark. Blocks that say nothing are skipped, exactly as the
// harvest skips them, so the mark and the predicate see the same first block.
//
// ONE INSTANCE PER SURFACE, holding its own plugin key — two live editors resolve
// different drafts, and a shared key would let one address the other's state.

/** The class the mark carries. Its own colour, not the mention's: a name in a
 *  message and the verb the message runs are different things. */
export const COMMAND_VERB_CLASS = 'sieve-command-verb'

export class CommandVerbDecorations {
  /** @type {any} the plugin key this surface's state lives under */ #key
  /** @type {any} the extension the editor is built with */ #extension

  /** @param {any} T the TipTap/ProseMirror vendor bag */
  constructor(T) {
    this.#key = new T.PluginKey('sieveCommandVerb')
    const key = this.#key
    const Decoration = T.Decoration
    const DecorationSet = T.DecorationSet
    this.#extension = T.Extension.create({
      name: 'sieveCommandVerbDecoration',
      addProseMirrorPlugins: function () {
        return [
          new T.Plugin({
            key: key,
            state: {
              init: function () { return { verb: '' } },
              apply: function (/** @type {any} */ tr, /** @type {any} */ prev) {
                const meta = tr.getMeta(key)
                return meta ? { verb: meta.verb || '' } : prev
              },
            },
            props: {
              decorations: function (/** @type {any} */ state) {
                const ps = key.getState(state)
                const range = ps ? CommandVerbDecorations.rangeOf(state.doc, ps.verb) : null
                if (!range) return DecorationSet.empty
                return DecorationSet.create(state.doc, [
                  Decoration.inline(range.from, range.to, { class: COMMAND_VERB_CLASS }),
                ])
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
   * Where `/verb` sits in `doc`, as a half-open document range, or null where it
   * does not open the message.
   *
   * A LITERAL IS NOT A VERB: a fenced block, and a run carrying the `code` mark,
   * hold text somebody quoted. The token must also be a whole word — `/btw` is a
   * verb, `/btwx` is a path.
   * @param {any} doc a ProseMirror document node
   * @param {string} verb the command name, without its slash
   * @returns {{from: number, to: number}|null}
   */
  static rangeOf(doc, verb) {
    const name = String(verb || '').trim()
    if (!doc || !name) return null
    const head = CommandVerbDecorations.#head(doc)
    if (!head) return null
    const first = head.node.firstChild
    if (!first || !first.isText) return null
    if (first.marks.some((/** @type {any} */ m) => m.type.name === 'code')) return null
    const token = '/' + name
    const text = first.text || ''
    if (text.slice(0, token.length).toLowerCase() !== token.toLowerCase()) return null
    const after = text.charAt(token.length)
    if (after && !/\s/.test(after)) return null
    return { from: head.start, to: head.start + token.length }
  }

  /**
   * The first top-level block that says anything, and the document position its
   * content starts at. A block holding only whitespace is spacing rather than the
   * head of the message, and a code block cannot hold a verb at all.
   * @param {any} doc
   * @returns {{node: any, start: number}|null}
   */
  static #head(doc) {
    let offset = 0
    for (let i = 0; i < doc.childCount; i++) {
      const node = doc.child(i)
      if (node.textContent.trim()) {
        if (!node.isTextblock || node.type.spec.code) return null
        return { node: node, start: offset + 1 }
      }
      offset += node.nodeSize
    }
    return null
  }

  /**
   * Tells the view which verb this draft resolves to. A meta-only transaction:
   * the document does not change, so nothing here dirties the draft or enters
   * undo history.
   * @param {any} view a ProseMirror view
   * @param {string|null} verb the command name, or null when the draft resolves none
   */
  apply(view, verb) {
    if (!view) return
    view.dispatch(view.state.tr.setMeta(this.#key, { verb: verb || '' }))
  }
}
