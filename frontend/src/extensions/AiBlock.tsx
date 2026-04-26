import { Node, mergeAttributes } from '@tiptap/core'

/**
 * Custom sub-node for the "Question" part of an AI block.
 */
export const AiQuestion = Node.create({
  name: 'aiQuestion',
  group: 'block',
  content: 'block+',
  selectable: false,
  parseHTML() {
    return [{ tag: 'div[data-type="aiQuestion"]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-type': 'aiQuestion', class: 'ai-question' }), 0]
  },
})

function makeAiBlockNodeView({ node }: any) {
  const dom = document.createElement('div')
  dom.className = 'ai-block'
  dom.setAttribute('data-ai-id', node.attrs.id ?? '')
  dom.setAttribute('data-ai-ref', node.attrs.ref ?? 'doc')

  const badge = document.createElement('span')
  badge.className = `ai-block__badge${node.textContent.includes('(thinking…)') ? ' ai-block__badge--thinking' : ''}`
  badge.textContent = 'AI'

  const contentEl = document.createElement('div')
  contentEl.className = 'ai-block__content'

  dom.appendChild(badge)
  dom.appendChild(contentEl)

  const applyChain = (action: 'add' | 'remove') => {
    const refs = (dom.getAttribute('data-ai-ref') ?? '').split(',').map((r: string) => r.trim()).filter(Boolean)
    const ids = gatherChain(dom.getAttribute('data-ai-id') ?? '', refs)
    ids.forEach(id => {
      if (id === dom.getAttribute('data-ai-id')) return
      document.querySelector(`[data-block-id="${id}"]`)?.classList[action]('block-ref-active')
      document.querySelector(`.ai-block[data-ai-id="${id}"]`)?.classList[action]('ai-block--chain-active')
    })
  }

  dom.addEventListener('mouseenter', () => applyChain('add'))
  dom.addEventListener('mouseleave', () => applyChain('remove'))
  dom.addEventListener('focus',      () => applyChain('add'))
  dom.addEventListener('blur',       () => applyChain('remove'))

  return {
    dom,
    contentDOM: contentEl,
    update(updatedNode: any) {
      if (updatedNode.type.name !== 'aiBlock') return false
      dom.setAttribute('data-ai-id', updatedNode.attrs.id ?? '')
      dom.setAttribute('data-ai-ref', updatedNode.attrs.ref ?? 'doc')
      badge.className = `ai-block__badge${updatedNode.textContent.includes('(thinking…)') ? ' ai-block__badge--thinking' : ''}`
      return true
    },
  }
}

function gatherChain(startId: string, startRefs: string[]): Set<string> {
  const ids = new Set<string>()
  function visit(id: string) {
    if (!id || id === 'doc' || ids.has(id)) return
    ids.add(id)
    const el = document.querySelector(`.ai-block[data-ai-id="${id}"]`)
    if (el) {
      el.getAttribute('data-ai-ref')?.split(',').forEach(r => visit(r.trim()))
    }
  }
  visit(startId)
  startRefs.forEach(visit)
  return ids
}

export const AiBlock = Node.create({
  name: 'aiBlock',
  group: 'block',
  content: '(aiQuestion | block)+', // Allow aiQuestion as the first block
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
    return makeAiBlockNodeView
  },

  addStorage() {
    return {
      markdown: {
        serialize(state: any, node: any) {
          state.ensureNewLine()
          state.write(`[!ai] id="${node.attrs.id}" ref="${node.attrs.ref}"`)
          state.closeBlock(node)
          
          node.content.forEach((child: any) => {
            if (child.type.name === 'aiQuestion') {
              child.content.forEach((inner: any) => {
                state.render(inner)
              })
            } else {
              state.render(child)
            }
          })

          state.ensureNewLine()
          state.write('[!ai-end]')
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
                const text = (child.textContent ?? '').trim()
                if (!text.startsWith('[!ai]') || text.startsWith('[!ai-end]')) continue

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

                // Move content nodes into wrapper.
                for (let k = i + 1; k < endIdx; k++) {
                  wrapper.appendChild(children[k])
                }
                
                // Wrap content in aiQuestion box using HR as the definitive marker
                const firstChild = wrapper.firstChild as HTMLElement
                if (firstChild && 
                    firstChild.getAttribute?.('data-type') !== 'aiQuestion' &&
                    (firstChild.textContent ?? '').trim().startsWith('Ask: ')) {
                  
                  const qWrapper = document.createElement('div')
                  qWrapper.setAttribute('data-type', 'aiQuestion')
                  
                  if (wrapper.querySelector('hr')) {
                    while (wrapper.firstChild && 
                           wrapper.firstChild instanceof HTMLElement &&
                           wrapper.firstChild.tagName !== 'HR') {
                      qWrapper.appendChild(wrapper.firstChild)
                    }
                  } else {
                    // FALLBACK: For legacy blocks without HR, wrap consecutive short paragraphs
                    while (wrapper.firstChild && wrapper.firstChild instanceof HTMLElement) {
                      const text = (wrapper.firstChild.textContent ?? '').trim()
                      if (text === '' || text.length > 120) break
                      qWrapper.appendChild(wrapper.firstChild)
                    }
                  }
                  wrapper.insertBefore(qWrapper, wrapper.firstChild)
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
