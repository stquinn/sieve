import { Mark, mergeAttributes } from '@tiptap/core'

/**
 * Preserves <span id="blk-..."> inline block ID markers through the round-trip.
 *
 * Parse:  markdown-it passes inline HTML through (html: true), Tiptap matches
 *         span[id] elements via parseHTML and stores the id as a mark attribute.
 * Serialize: the markdown serializer writes the span tags back literally.
 */
export const BlockIdMark = Mark.create({
  name: 'blockId',

  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute('id'),
        renderHTML: (attributes) => ({ id: attributes.id }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'span[id]' }]
  },

  renderHTML({ HTMLAttributes }) {
    return ['span', mergeAttributes(HTMLAttributes), 0]
  },

  addStorage() {
    return {
      markdown: {
        serialize: {
          open(_state: any, mark: any) {
            return `<span id="${mark.attrs.id}">`
          },
          close() {
            return '</span>'
          },
        },
        parse: {},
      },
    }
  },
})
