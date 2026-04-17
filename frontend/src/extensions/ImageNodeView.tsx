import React from 'react'
import { NodeViewWrapper } from '@tiptap/react'

/**
 * Resolves a store-relative or markdown-relative image src to a /store/... display URL.
 * - src starting with /store/ → used as-is
 * - src starting with blob:, data:, http → used as-is
 * - relative src (e.g. "assets/blk.png", "../assets/blk.png") → resolved using activeTabPath
 */
function resolveDisplaySrc(src: string, activeTabPath: string): string {
  if (!src) return ''
  if (src.startsWith('http')) {
    return window.location.origin + '/stash-image-proxy?url=' + encodeURIComponent(src)
  }
  if (src.startsWith('/store/') || src.startsWith('blob:') || src.startsWith('data:')) {
    return src
  }
  if (!activeTabPath) return src

  // Compute absolute store-relative path from the tab's directory
  const tabDir = activeTabPath.split('/').slice(0, -1)
  const srcParts = src.split('/')
  const parts = [...tabDir]
  for (const part of srcParts) {
    if (part === '..') { parts.pop() }
    else if (part !== '.') { parts.push(part) }
  }
  return '/store/' + parts.join('/')
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
