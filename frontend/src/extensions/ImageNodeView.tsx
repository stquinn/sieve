import React from 'react'
import { NodeViewWrapper } from '@tiptap/react'

/**
 * Resolves a vault-relative or markdown-relative image src to a /vault/... display URL.
 * - src starting with /vault/ → used as-is
 * - src starting with blob:, data:, http → used as-is
 * - relative src (e.g. "assets/blk.png", "../assets/blk.png") → resolved using activeTabPath
 */
function resolveDisplaySrc(src: string, activeTabPath: string): string {
  if (!src) return ''
  if (src.startsWith('/vault/') || src.startsWith('blob:') || src.startsWith('data:') || src.startsWith('http')) {
    return src
  }
  if (!activeTabPath) return src

  // Compute absolute vault-relative path from the tab's directory
  const tabDir = activeTabPath.split('/').slice(0, -1)
  const srcParts = src.split('/')
  const parts = [...tabDir]
  for (const part of srcParts) {
    if (part === '..') { parts.pop() }
    else if (part !== '.') { parts.push(part) }
  }
  return '/vault/' + parts.join('/')
}

export function ImageNodeView({ node, extension }: any) {
  const { src, alt, title } = node.attrs
  // Read synchronously from the global set by App.tsx during tab render
  const activeTabPath = (window as any).__stashActiveTabPath ?? ''
  const displaySrc = resolveDisplaySrc(src, activeTabPath)

  return (
    <NodeViewWrapper as="div" style={{ display: 'inline-block' }} data-block-id={node.attrs.id}>
      <img
        src={displaySrc}
        alt={alt ?? ''}
        title={title ?? undefined}
        style={{ maxWidth: '100%', display: 'block' }}
      />
    </NodeViewWrapper>
  )
}
