/**
 * Resolves a store-relative or markdown-relative image src to a /sieve/... display URL.
 */
export function resolveDisplaySrc(src: string, activeTabPath: string): string {
  if (!src) return ''
  if (src.startsWith('http')) {
    return window.location.origin + '/sieve-image-proxy?url=' + encodeURIComponent(src)
  }
  if (src.startsWith('blob:') || src.startsWith('data:') || src.startsWith('/')) {
    return src
  }

  if (src.includes('dash/') || src.includes('store/') || src.startsWith('.assets/') || src.includes('/buffers/')) {
    const cleanSrc = src.startsWith('/') ? src.substring(1) : src
    return '/sieve/' + cleanSrc
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
  return '/sieve/' + parts.join('/')
}
