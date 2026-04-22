import React, { useRef } from 'react'
import { NodeViewWrapper } from '@tiptap/react'

/**
 * Resolves a store-relative or markdown-relative image src to a /stash/... display URL.
 */
function resolveDisplaySrc(src: string, activeTabPath: string): string {
  if (!src) return ''
  if (src.startsWith('http')) {
    return window.location.origin + '/stash-image-proxy?url=' + encodeURIComponent(src)
  }
  if (src.startsWith('blob:') || src.startsWith('data:') || src.startsWith('/')) {
    return src
  }

  // Handle known store-relative prefixes by mapping to our /stash/ asset server.
  // Note: the URL becomes /stash/PATH (e.g. /stash/store/.assets/img.png)
  if (src.includes('dash/') || src.includes('store/') || src.startsWith('.assets/') || src.includes('/buffers/')) {
    const cleanSrc = src.startsWith('/') ? src.substring(1) : src
    return '/stash/' + cleanSrc
  }

  if (!activeTabPath) return src

  // Legacy fallback: resolve markdown-relative paths
  const tabDir = activeTabPath.split('/').slice(0, -1)
  const srcParts = src.split('/')
  const parts = [...tabDir]
  for (const part of srcParts) {
    if (part === '..') { parts.pop() }
    else if (part !== '.') { parts.push(part) }
  }
  return '/stash/' + parts.join('/')
}

export function ImageNodeView({ node, updateAttributes, selected }: any) {
  const { src, alt, title, width, height, summary } = node.attrs
  const imgRef = useRef<HTMLImageElement>(null)

  // Read synchronously from the global set by App.tsx during tab render
  const activeTabPath = (window as any).__stashActiveTabPath ?? ''
  const displaySrc = resolveDisplaySrc(src, activeTabPath)

  const onMouseDown = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()

    const startX = e.clientX
    const startY = e.clientY
    const startWidth = imgRef.current?.clientWidth || 0
    const startHeight = imgRef.current?.clientHeight || 0
    const aspectRatio = startWidth / startHeight

    const onMouseMove = (moveEvent: MouseEvent) => {
      const deltaX = moveEvent.clientX - startX
      const currentWidth = Math.max(40, startWidth + deltaX)
      // Lock aspect ratio by default for images
      const currentHeight = Math.round(currentWidth / aspectRatio)

      updateAttributes({ 
        width: String(currentWidth), 
        height: String(currentHeight) 
      })
    }

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      document.body.style.cursor = ''
    }

    document.body.style.cursor = 'nwse-resize'
    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }

  const imgStyle: React.CSSProperties = {
    maxWidth: '100%',
    display: 'block',
  }
  if (width) {
    imgStyle.width = width.match(/^[0-9]+$/) ? width + 'px' : width
  }
  if (height) {
    imgStyle.height = height.match(/^[0-9]+$/) ? height + 'px' : height
  }

  return (
    <NodeViewWrapper 
      as="div" 
      className={`image-block node-image ${selected ? 'ProseMirror-selectednode' : ''}`} 
      style={{ display: 'inline-block' }} 
      data-block-id={node.attrs.id}
      data-tooltip={summary || undefined}
    >
      <img
        ref={imgRef}
        src={displaySrc}
        alt={alt ?? ''}
        style={imgStyle}
      />
      <div className="image-resizer" onMouseDown={onMouseDown} />
    </NodeViewWrapper>
  )
}
