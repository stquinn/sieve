import { Node, mergeAttributes } from '@tiptap/core'

function makeBlockNodeView({ node }: any) {
  const dom = document.createElement('div')
  dom.className = 'block-node'
  dom.setAttribute('data-block-id', node.attrs.id ?? '')

  const contentEl = document.createElement('div')
  dom.appendChild(contentEl)

  return {
    dom,
    contentDOM: contentEl,
    update(updatedNode: any) {
      if (updatedNode.type.name !== 'blockRef') return false
      dom.setAttribute('data-block-id', updatedNode.attrs.id ?? '')
      return true
    },
  }
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
    return makeBlockNodeView
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
                  if (children[j].tagName === 'P' && (children[j].textContent ?? '').startsWith('[!block-end]')) {
                    endIdx = j; break
                  }
                }
                if (endIdx === -1) break
                const idMatch = text.match(/id="([^"]+)"/)
                const wrapper = document.createElement('div')
                wrapper.setAttribute('data-type', 'blockRef')
                wrapper.setAttribute('data-id', idMatch?.[1] ?? '')
                for (let k = i + 1; k < endIdx; k++) wrapper.appendChild(children[k])
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
