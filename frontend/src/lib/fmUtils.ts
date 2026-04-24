export function getAncestorPaths(path: string): string[] {
  // Strip "store/" prefix to treat the store directory as a virtual root.
  const prefix = 'store/'
  const workingPath = path.startsWith(prefix) ? path.substring(prefix.length) : path

  const parts = workingPath.split('/')
  const ancestors: string[] = []
  for (let i = 0; i < parts.length - 1; i++) {
    ancestors.push(parts.slice(0, i + 1).join('/'))
  }
  return ancestors
}
