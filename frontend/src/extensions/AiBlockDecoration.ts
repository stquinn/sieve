import { Extension } from '@tiptap/core'
import { Plugin, PluginKey } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'

/**
 * Adds the `ai-block-ask` CSS class to any paragraph inside an aiBlock node
 * whose text starts with "Ask: ", so CSS can style it as the question line.
 * The border/background of the block itself is handled by the AiBlock NodeView.
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
              if (node.type.name !== 'aiBlock') return
              let offset = pos + 1 // +1 for the aiBlock open token
              node.forEach((child: any) => {
                if (
                  child.type.name === 'paragraph' &&
                  child.textContent.startsWith('Ask: ')
                ) {
                  decorations.push(
                    Decoration.node(offset, offset + child.nodeSize, { class: 'ai-block-ask' })
                  )
                }
                offset += child.nodeSize
              })
              return false // don't recurse further into aiBlock children
            })

            return DecorationSet.create(state.doc, decorations)
          },
        },
      }),
    ]
  },
})
