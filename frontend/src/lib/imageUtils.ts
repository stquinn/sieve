// Converts a markdown-relative image src to a store-relative path the backend
// can resolve. Returns '' for remote/blob/data URLs that don't need resolution.
export function mdSrcToStoreRelPath(src: string, tabPath: string): string {
  if (!src || src.startsWith('http') || src.startsWith('blob:') || src.startsWith('data:')) return ''
  if (src.startsWith('/')) return src.substring(1)
  const tabDir = tabPath.split('/').slice(0, -1)
  const parts = [...tabDir]
  for (const part of src.split('/')) {
    if (part === '..') parts.pop()
    else if (part !== '.') parts.push(part)
  }
  return parts.join('/')
}
