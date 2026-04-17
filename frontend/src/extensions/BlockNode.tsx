import React from 'react'
import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer, NodeViewWrapper, NodeViewContent } from '@tiptap/react'

/**
 * Generic block target node — a transparent wrapper with a stable id.
 *
 * When the user selects content and triggers Ask/Explain, the selected
 * block(s) are wrapped in this node.  The inserted aiBlock carries a ref
 * back to the block's id so the threading chain can resolve the original
 * source content.
 *
 * Visual behaviour
 *   • At rest   — renders identically to unwrapped content; no border/badge.
 *   • On hover/focus inside a referencing aiBlock — receives the CSS class
 *     `block-ref-active` via direct DOM manipulation in AiBlockView, which
 *     fades in a subtle background highlight.
 *
 * Store markdown:
 *   [!block] id="blk-abc"
 *
 *   Content lives here as normal markdown blocks.
 *
 *   [!block-end]
 */

function BlockNodeView({ node }: any) {
  return (
    <NodeViewWrapper>
      <div className="block-node" data-block-id={node.attrs.id}>
        <NodeViewContent />
      </div>
    </NodeViewWrapper>
  )
}

export const BlockNode = Node.create({
  name: 'blockRef',
  group: 'block',
  content: 'block+',
  defining: true,

  addAttributes() {
    return {
      id: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-id') ?? '',
        renderHTML: (attrs: any) => ({ 'data-id': attrs.id }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="blockRef"]' }]
  },

  renderHTML({ HTMLAttributes }: any) {
    return ['div', mergeAttributes({ 'data-type': 'blockRef' }, HTMLAttributes), 0]
  },

  addNodeView() {
    return ReactNodeViewRenderer(BlockNodeView)
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          state.write(`[!block] id="${node.attrs.id}"`)
          state.closeBlock(node)
          state.renderContent(node)
          state.write('[!block-end]')
          state.closeBlock(node)
        },
        parse: {
          updateDOM(element: HTMLElement) {
            // Repeatedly scan for [!block]...[!block-end] paragraph pairs and
            // wrap their content in a <div data-type="blockRef"> for Tiptap to parse.
            let changed = true
            while (changed) {
              changed = false
              const children = Array.from(element.children) as HTMLElement[]

              for (let i = 0; i < children.length; i++) {
                const child = children[i]
                if (child.tagName !== 'P') continue
                const text = child.textContent ?? ''
                if (!text.startsWith('[!block]')) continue

                let endIdx = -1
                for (let j = i + 1; j < children.length; j++) {
                  if (
                    children[j].tagName === 'P' &&
                    (children[j].textContent ?? '').startsWith('[!block-end]')
                  ) {
                    endIdx = j
                    break
                  }
                }
                if (endIdx === -1) break

                const idMatch = text.match(/id="([^"]+)"/)

                const wrapper = document.createElement('div')
                wrapper.setAttribute('data-type', 'blockRef')
                wrapper.setAttribute('data-id', idMatch?.[1] ?? '')

                for (let k = i + 1; k < endIdx; k++) {
                  wrapper.appendChild(children[k])
                }

                element.insertBefore(wrapper, child)
                child.remove()
                children[endIdx].remove()

                changed = true
                break
              }
            }
          },
        },
      },
    }
  },
})
