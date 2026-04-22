import Image from '@tiptap/extension-image'
import { ReactNodeViewRenderer } from '@tiptap/react'
import { ImageNodeView } from './ImageNodeView'

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

  // Custom node view resolves relative markdown paths to /stash/... display URLs.
  // The active tab path is kept in extension.storage.activeTabPath (updated by App.tsx).
  addNodeView() {
    return ReactNodeViewRenderer(ImageNodeView)
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
