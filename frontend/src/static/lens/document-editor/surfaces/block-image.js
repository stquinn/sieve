// @ts-check
// The editor's markdown image: a block node, one image on its own line.
//
// An ordinary markdown image may name a file by its path within the store. The
// browser would resolve that against the app shell, so the src is pointed at the
// store's route on the way OUT and read back on the way IN. Both halves are
// attribute-level on purpose: the node's attrs — what tiptap-markdown serialises
// — keep the path the document was written with.
//
// It is written as a block: tiptap-markdown's default image serializer is the
// inline one and never closes the block, which glues whatever follows onto the
// image's line and turns a following slide marker into inline HTML.

import { T } from './tiptap-vendor.js'
import { storeFileSrc, storeFileRef } from '../../../renderers/asset-urls.js'

export class BlockImage {
  /** The markdown an image node is written as.
   *  @param {any} state a prosemirror-markdown serializer state
   *  @param {any} node */
  static serialize(state, node) {
    const { alt, src, title } = node.attrs
    const dest = String(src || '').replace(/[()]/g, '\\$&')
    const titled = title ? ' "' + String(title).replace(/"/g, '\\"') + '"' : ''
    state.write('![' + state.esc(alt || '') + '](' + dest + titled + ')')
    state.closeBlock(node)
  }

  /** The shipping image node.
   *  @returns {any} */
  static node() {
    return T.Image.extend({
      addAttributes() {
        const parent = this.parent ? this.parent() : {}
        return Object.assign({}, parent, {
          src: Object.assign({}, parent.src, {
            parseHTML: (/** @type {HTMLElement} */ el) => storeFileRef(el.getAttribute('src')),
            renderHTML: (/** @type {any} */ attrs) => (attrs.src ? { src: storeFileSrc(attrs.src) } : {}),
          }),
        })
      },
      addStorage() {
        return { markdown: { serialize: BlockImage.serialize } }
      },
    }).configure({ inline: false, allowBase64: true, HTMLAttributes: { class: 'editor-image' } })
  }
}
