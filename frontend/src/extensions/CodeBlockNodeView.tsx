import { NodeViewWrapper, NodeViewContent } from '@tiptap/react'
import type { NodeViewProps } from '@tiptap/core'

export function CodeBlockNodeView({ node }: NodeViewProps) {
  const text: string = node.textContent
  const lines = text.split('\n')
  // Trailing newline produces an empty last element — don't count it
  const lineCount = lines[lines.length - 1] === '' ? lines.length - 1 : lines.length

  console.debug('[stash] CodeBlockNodeView', {
    lineCount,
    splitLen: lines.length,
    textLen: text.length,
    preview: JSON.stringify(text.slice(0, 120)),
  })

  return (
    <NodeViewWrapper as="div" className="code-block">
      <div className="code-block__gutter" contentEditable={false} aria-hidden="true">
        {Array.from({ length: Math.max(lineCount, 1) }, (_, i) => (
          <span key={i}>{i + 1}</span>
        ))}
      </div>
      <NodeViewContent as="code" />
    </NodeViewWrapper>
  )
}
