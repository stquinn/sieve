import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

/**
 * Adds the `ai-block` CSS class to any blockquote whose first paragraph
 * text starts with `[!ai]`. This is a pure decoration — nothing in the
 * stored document is changed; the class only exists in the rendered DOM.
 */
export const AiBlockDecoration = Extension.create({
  name: 'aiBlockDecoration',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('aiBlockDecoration'),
        props: {
          decorations(state) {
            const decorations: Decoration[] = []
            state.doc.descendants((node, pos) => {
              if (node.type.name === 'blockquote') {
                const firstLine = node.firstChild?.textContent ?? ''
                if (!firstLine.startsWith('[!ai]')) return

                // Mark the blockquote itself
                decorations.push(
                  Decoration.node(pos, pos + node.nodeSize, { class: 'ai-block' })
                )

                // Mark any child paragraph starting with "Ask: " so CSS can
                // style it as the question line without affecting response paragraphs.
                let childOffset = pos + 1 // +1 for the blockquote open token
                node.forEach(child => {
                  if (
                    child.type.name === 'paragraph' &&
                    child.textContent.startsWith('Ask: ')
                  ) {
                    decorations.push(
                      Decoration.node(
                        childOffset,
                        childOffset + child.nodeSize,
                        { class: 'ai-question' }
                      )
                    )
                  }
                  childOffset += child.nodeSize
                })
              }
            })
            return DecorationSet.create(state.doc, decorations)
          },
        },
      }),
    ]
  },
})
