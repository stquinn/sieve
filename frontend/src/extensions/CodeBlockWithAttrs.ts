import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight'
import { ReactNodeViewRenderer } from '@tiptap/react'
import { CodeBlockNodeView } from './CodeBlockNodeView'

/**
 * Parse a fenced code block info string into its parts.
 * Input:  'python id="blk-test" detect="ai"'
 * Output: { language: 'python', id: 'blk-test', detect: 'ai' }
 */
function parseInfoString(info: string) {
  const trimmed = info.trim()
  const language = trimmed.split(/\s/)[0] || ''
  const idMatch = trimmed.match(/\bid="([^"]*)"/)
  const detectMatch = trimmed.match(/\bdetect="([^"]*)"/)
  return {
    language,
    id: idMatch ? idMatch[1] : null,
    detect: detectMatch ? detectMatch[1] : null,
  }
}

/**
 * Extends CodeBlockLowlight with `id` and `detect` node attributes so that
 * fenced code block custom attrs survive the Tiptap markdown round-trip.
 *
 * Parse path:
 *   markdown-it fence renderer is overridden in parse.setup to encode id/detect
 *   as data attributes on the <code> element, which Tiptap's parseHTML then reads.
 *
 * Serialize path:
 *   The markdown serializer writes them back into the info string:
 *   ```python id="blk-test" detect="heuristic"
 */
export const CodeBlockWithAttrs = CodeBlockLowlight.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      id: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-block-id'),
        renderHTML: (attrs) => (attrs.id ? { 'data-block-id': attrs.id } : {}),
      },
      detect: {
        default: null,
        parseHTML: (element) => element.getAttribute('data-detect'),
        renderHTML: (attrs) => (attrs.detect ? { 'data-detect': attrs.detect } : {}),
      },
    }
  },

  addKeyboardShortcuts() {
    return {
      Tab: () => {
        if (!this.editor.isActive(this.name)) return false
        return this.editor.commands.command(({ tr, state }) => {
          tr.insertText('\t', state.selection.from, state.selection.to)
          return true
        })
      },
      'Shift-Tab': () => {
        if (!this.editor.isActive(this.name)) return false
        return this.editor.commands.command(({ tr, state }) => {
          const blockStart = state.selection.$from.start()
          const cursorPos  = state.selection.$from.pos
          const textBefore = state.doc.textBetween(blockStart, cursorPos)
          const lineStart  = blockStart + textBefore.lastIndexOf('\n') + 1
          if (state.doc.textBetween(lineStart, lineStart + 1) !== '\t') return false
          tr.delete(lineStart, lineStart + 1)
          return true
        })
      },
    }
  },

  addNodeView() {
    return ReactNodeViewRenderer(CodeBlockNodeView)
  },

  addStorage() {
    return {
      ...this.parent?.(),
      markdown: {
        serialize(state: any, node: any) {
          const lang = node.attrs.language || ''
          const id = node.attrs.id ? ` id="${node.attrs.id}"` : ''
          const detect = node.attrs.detect ? ` detect="${node.attrs.detect}"` : ''
          state.write(`\`\`\`${lang}${id}${detect}\n`)
          state.text(node.textContent, false)
          state.ensureNewLine()
          state.write('```')
          state.closeBlock(node)
        },
        parse: {
          setup(markdownit: any) {
            markdownit.set({ langPrefix: 'language-' })

            // Wrap the fence renderer (already patched by tiptap-markdown's
            // withPatchedRenderer) to inject data-block-id / data-detect onto
            // the rendered <code> element when they appear in the info string.
            const upstream = markdownit.renderer.rules.fence?.bind(markdownit.renderer)
            markdownit.renderer.rules.fence = (
              tokens: any[],
              idx: number,
              options: any,
              env: any,
              self: any,
            ) => {
              const token = tokens[idx]
              const info = token.info
              const parsed = parseInfoString(info)

              // Let upstream render with only the language (avoids garbled class names)
              token.info = parsed.language
              const html: string = upstream
                ? upstream(tokens, idx, options, env, self)
                : self.renderToken(tokens, idx, options)
              token.info = info // restore

              if (!parsed.id && !parsed.detect) return html

              // Inject data attributes onto the <code> element
              const dataAttrs = [
                parsed.id ? `data-block-id="${parsed.id}"` : '',
                parsed.detect ? `data-detect="${parsed.detect}"` : '',
              ]
                .filter(Boolean)
                .join(' ')

              return html.replace('<pre>', `<pre ${dataAttrs}>`)
            }
          },
          // Preserve tiptap-markdown's default updateDOM for code blocks
          updateDOM(element: Element) {
            ;(element as HTMLElement).innerHTML = (element as HTMLElement).innerHTML.replace(
              /\n<\/code><\/pre>/g,
              '</code></pre>',
            )
          },
        },
      },
    }
  },
})
