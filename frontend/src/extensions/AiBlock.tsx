import { Node, mergeAttributes } from '@tiptap/core'
import { ReactNodeViewRenderer, NodeViewWrapper, NodeViewContent } from '@tiptap/react'

/**
 * Custom block node for AI responses.
 *
 * In the editor the node renders as a styled container div via a React NodeView —
 * all content inside gets normal markdown styling without any padding/margin
 * interference from decoration classes on individual child nodes.
 *
 * In the store markdown file the node serializes as:
 *
 *   \[!ai\] id="ai-xxx" ref="doc"
 *
 *   Ask: question
 *
 *   Response content here...
 *
 *   \[!ai-end\]
 *
 * The markdown parser's updateDOM pass wraps the content between those markers
 * into a <div data-type="aiBlock"> before Tiptap's ProseMirror parser runs.
 */

// Traverses the full chain of AI blocks connected to the hovered block.
// data-ai-id / data-ai-ref are placed directly on .ai-block divs (not on the
// outer ProseMirror wrapper) so queries are reliable regardless of how Tiptap
// layers its wrapper elements.
function gatherChain(startId: string, startRefs: string[]): Set<string> {
  const ids = new Set<string>()

  function visit(id: string) {
    if (!id || id === 'doc' || ids.has(id)) return
    ids.add(id)
    // Follow refs downward only — source blocks and any AI blocks they chain to
    const el = document.querySelector(`.ai-block[data-ai-id="${id}"]`)
    if (el) {
      el.getAttribute('data-ai-ref')?.split(',').forEach(r => visit(r.trim()))
    }
  }

  visit(startId)
  startRefs.forEach(visit)
  return ids
}

function AiBlockView({ node }: any) {
  const applyChain = (action: 'add' | 'remove') => {
    const refs = (node.attrs.ref ?? '').split(',').map((r: string) => r.trim()).filter(Boolean)
    const ids = gatherChain(node.attrs.id, refs)
    ids.forEach(id => {
      if (id === node.attrs.id) return
      document.querySelector(`[data-block-id="${id}"]`)
        ?.classList[action]('block-ref-active')
      document.querySelector(`.ai-block[data-ai-id="${id}"]`)
        ?.classList[action]('ai-block--chain-active')
    })
  }

  const activate   = () => applyChain('add')
  const deactivate = () => applyChain('remove')

  return (
    <NodeViewWrapper>
      <div
        className="ai-block"
        data-ai-id={node.attrs.id}
        data-ai-ref={node.attrs.ref}
        onMouseEnter={activate}
        onMouseLeave={deactivate}
        onFocus={activate}
        onBlur={deactivate}
      >
        <span className="ai-block__badge">AI</span>
        <NodeViewContent className="ai-block__content" />
      </div>
    </NodeViewWrapper>
  )
}

export const AiBlock = Node.create({
  name: 'aiBlock',
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
      ref: {
        default: 'doc',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-ref') ?? 'doc',
        renderHTML: (attrs: any) => ({ 'data-ref': attrs.ref }),
      },
    }
  },

  parseHTML() {
    return [{ tag: 'div[data-type="aiBlock"]' }]
  },

  renderHTML({ HTMLAttributes }: any) {
    return ['div', mergeAttributes({ 'data-type': 'aiBlock' }, HTMLAttributes), 0]
  },

  addNodeView() {
    return ReactNodeViewRenderer(AiBlockView)
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          state.write(`[!ai] id="${node.attrs.id}" ref="${node.attrs.ref}"`)
          state.closeBlock(node)
          state.renderContent(node)
          state.write('[!ai-end]')
          state.closeBlock(node)
        },
        parse: {
          updateDOM(element: HTMLElement) {
            // Repeatedly scan for [!ai]...[!ai-end] paragraph pairs and wrap
            // their content in a <div data-type="aiBlock"> for Tiptap to parse.
            let changed = true
            while (changed) {
              changed = false
              const children = Array.from(element.children) as HTMLElement[]

              for (let i = 0; i < children.length; i++) {
                const child = children[i]
                if (child.tagName !== 'P') continue
                const text = child.textContent ?? ''
                if (!text.startsWith('[!ai]') || text.startsWith('[!ai-end]')) continue

                // Find matching [!ai-end] paragraph.
                let endIdx = -1
                for (let j = i + 1; j < children.length; j++) {
                  if (
                    children[j].tagName === 'P' &&
                    (children[j].textContent ?? '').startsWith('[!ai-end]')
                  ) {
                    endIdx = j
                    break
                  }
                }
                if (endIdx === -1) break

                const idMatch = text.match(/id="([^"]+)"/)
                const refMatch = text.match(/ref="([^"]+)"/)

                const wrapper = document.createElement('div')
                wrapper.setAttribute('data-type', 'aiBlock')
                wrapper.setAttribute('data-id', idMatch?.[1] ?? '')
                wrapper.setAttribute('data-ref', refMatch?.[1] ?? 'doc')

                // Move content nodes (between header and end marker) into wrapper.
                for (let k = i + 1; k < endIdx; k++) {
                  wrapper.appendChild(children[k])
                }

                element.insertBefore(wrapper, child)
                child.remove()             // remove [!ai] header paragraph
                children[endIdx].remove()  // remove [!ai-end] paragraph

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
