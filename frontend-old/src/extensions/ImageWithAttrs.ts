import Image from '@tiptap/extension-image'
import { resolveDisplaySrc } from './ImageNodeView'

export const ImageWithAttrs = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-block-id'),
        renderHTML: (attrs) => attrs.id ? { 'data-block-id': attrs.id } : {},
      },
      detect: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-detect'),
        renderHTML: (attrs) => attrs.detect ? { 'data-detect': attrs.detect } : {},
      },
      summary: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-summary'),
        renderHTML: (attrs) => attrs.summary ? { 'data-summary': attrs.summary } : {},
      },
      width: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-width'),
        renderHTML: (attrs) => attrs.width ? { 'data-width': attrs.width } : {},
      },
      height: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-height'),
        renderHTML: (attrs) => attrs.height ? { 'data-height': attrs.height } : {},
      },
    }
  },

  addNodeView() {
    return ({ node, updateAttributes }: any) => {
      const wrapper = document.createElement('div')
      wrapper.style.display = 'inline-block'

      const img = document.createElement('img')
      const resizer = document.createElement('div')
      resizer.className = 'image-resizer'

      const applyAttrs = (n: any) => {
        const { src, alt, width, height, summary, id } = n.attrs
        const activeTabPath = (window as any).__stashActiveTabPath ?? ''
        wrapper.className = `image-block node-image`
        if (id) wrapper.setAttribute('data-block-id', id)
        else wrapper.removeAttribute('data-block-id')
        if (summary) wrapper.setAttribute('data-tooltip', summary)
        else wrapper.removeAttribute('data-tooltip')
        img.src = resolveDisplaySrc(src, activeTabPath)
        img.alt = alt ?? ''
        img.style.maxWidth = '100%'
        img.style.display = 'block'
        img.style.width  = width  ? (width.match(/^[0-9]+$/)  ? width + 'px'  : width)  : ''
        img.style.height = height ? (height.match(/^[0-9]+$/) ? height + 'px' : height) : ''
      }

      applyAttrs(node)

      resizer.addEventListener('mousedown', (e) => {
        e.preventDefault()
        e.stopPropagation()
        const startX = e.clientX
        const startW = img.clientWidth
        const startH = img.clientHeight
        const ratio = startW / startH
        const onMove = (ev: MouseEvent) => {
          const w = Math.max(40, startW + ev.clientX - startX)
          const h = Math.round(w / ratio)
          img.style.width = w + 'px'
          img.style.height = h + 'px'
          updateAttributes({ width: String(w), height: String(h) })
        }
        const onUp = () => {
          window.removeEventListener('mousemove', onMove)
          window.removeEventListener('mouseup', onUp)
          document.body.style.cursor = ''
        }
        document.body.style.cursor = 'nwse-resize'
        window.addEventListener('mousemove', onMove)
        window.addEventListener('mouseup', onUp)
      })

      wrapper.appendChild(img)
      wrapper.appendChild(resizer)

      return {
        dom: wrapper,
        update(updatedNode: any) {
          if (updatedNode.type.name !== node.type.name) return false
          applyAttrs(updatedNode)
          return true
        },
      }
    }
  },

  addStorage() {
    return {
      ...this.parent?.(),
      activeTabPath: '' as string,
      markdown: {
        serialize(state: any, node: any) {
          // src is the markdown-relative path (e.g. ".assets/blk.png" or "../.assets/blk.png")
          // The node view handles display conversion; serializer writes the path as-is.
          let alt = state.esc(node.attrs.alt || '')
          let src = node.attrs.src || ''
          let title = node.attrs.title ? ' ' + state.quote(node.attrs.title) : ''
          let idAttr = node.attrs.id ? `id="${node.attrs.id}"` : ''
          let detectAttr = node.attrs.detect ? `detect="${node.attrs.detect}"` : ''
          let summaryAttr = node.attrs.summary ? `summary="${node.attrs.summary}"` : ''
          let widthAttr = node.attrs.width ? `width="${node.attrs.width}"` : ''
          let heightAttr = node.attrs.height ? `height="${node.attrs.height}"` : ''
          
          let attrs = [idAttr, detectAttr, summaryAttr, widthAttr, heightAttr].filter(Boolean).join(' ')
          let attrsSuffix = attrs ? `{${attrs}}` : ''
          state.write(`![${alt}](${src}${title})${attrsSuffix}`)
          state.closeBlock(node)
        },
        parse: {
          setup(markdownit: any) {
            markdownit.core.ruler.after('inline', 'image_attrs', (state: any) => {
              for (const token of state.tokens) {
                if (token.type !== 'inline') continue
                for (let i = 0; i < token.children.length; i++) {
                  const child = token.children[i]
                  if (child.type === 'image') {
                    const next = token.children[i + 1]
                    if (next && next.type === 'text' && next.content.trim().startsWith('{')) {
                      const match = next.content.match(/^\s*\{([^}]+)\}/)
                      if (match) {
                        const attrsStr = match[1]
                        const idMatch = attrsStr.match(/\bid="([^"]*)"/)
                        const detectMatch = attrsStr.match(/\bdetect="([^"]*)"/)
                        const summaryMatch = attrsStr.match(/\bsummary="([^"]*)"/)
                        const widthMatch = attrsStr.match(/\bwidth="([^"]*)"/)
                        const heightMatch = attrsStr.match(/\bheight="([^"]*)"/)

                        if (idMatch) { child.attrPush(['data-block-id', idMatch[1]]) }
                        if (detectMatch) { child.attrPush(['data-detect', detectMatch[1]]) }
                        if (summaryMatch) { child.attrPush(['data-summary', summaryMatch[1]]) }
                        if (widthMatch) { child.attrPush(['data-width', widthMatch[1]]) }
                        if (heightMatch) { child.attrPush(['data-height', heightMatch[1]]) }

                        next.content = next.content.substring(match[0].length)
                      }
                    }
                  }
                }
              }
            })
          },
          tokens: {
            image: {
              node: 'image',
              getAttrs: (token: any) => ({
                src: token.attrGet('src'),
                title: token.attrGet('title') || null,
                alt: token.children?.[0]?.content || '',
                id: token.attrGet('data-block-id') || null,
                detect: token.attrGet('data-detect') || null,
                summary: token.attrGet('data-summary') || null,
                width: token.attrGet('data-width') || null,
                height: token.attrGet('data-height') || null,
              }),
            },
          },
        }
      }
    }
  }
})
