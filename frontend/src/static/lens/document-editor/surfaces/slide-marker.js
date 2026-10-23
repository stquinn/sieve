// @ts-check
// The slide marker: a block-level prose atom that divides a document into
// slides. On disk it is the HTML comment `<!-- SLIDE MARKER -->` inside an
// ordinary prose span; in the editor it is a subtle dashed rule.
//
// Reading is lenient — any `<!-- slide -->` or `<!-- slide marker -->`, in any
// case and spacing — and writing is always the canonical form.
//
// The markdown-it rewrite is required, not cosmetic: with `html: true` the
// comment reaches the DOM as a Comment node, which ProseMirror's parser drops.

import { T } from './tiptap-vendor.js'

export class SlideMarker {
  /** The node type's name in the schema. */
  static NAME = 'slideMarker'

  /** What a marker is written as. */
  static MARKDOWN = '<!-- SLIDE MARKER -->'

  /** The element a marker is drawn as and parsed from. */
  static HTML = '<div data-slide-marker></div>'

  /** An `html_block` token that is a slide marker. */
  static #COMMENT = /^<!--\s*slide(\s+marker)?\s*-->\s*$/i

  /** The shipping `slideMarker` node.
   *  @returns {any} */
  static node() {
    return T.Node.create({
      name: SlideMarker.NAME,
      group: 'block',
      atom: true,
      selectable: true,
      draggable: false,
      parseHTML() { return [{ tag: 'div[data-slide-marker]' }] },
      renderHTML() { return ['div', { 'data-slide-marker': '', class: 'slide-marker', contenteditable: 'false' }] },
      addStorage() {
        return {
          markdown: {
            /** @param {any} state @param {any} node */
            serialize(state, node) {
              state.write(SlideMarker.MARKDOWN)
              state.closeBlock(node)
            },
            parse: {
              /** @param {any} md a markdown-it instance */
              setup(md) { md.core.ruler.push('slide_marker', SlideMarker.rewriteTokens) },
            },
          },
        }
      },
    })
  }

  /** A markdown-it core rule: every `html_block` token that is a slide-marker
   *  comment becomes the marker's element.
   *  @param {{tokens: Array<{type: string, content: string}>}} state
   *  @returns {void} */
  static rewriteTokens(state) {
    for (const token of state.tokens) {
      if (token.type === 'html_block' && SlideMarker.#COMMENT.test(token.content)) {
        token.content = SlideMarker.HTML + '\n'
      }
    }
  }
}
