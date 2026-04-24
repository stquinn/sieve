import { NoteEntry } from '../types'

export function getAncestorFolderIDs(noteID: string, entries: NoteEntry[]): string[] {
  function search(nodes: NoteEntry[], acc: string[]): string[] | null {
    for (const node of nodes) {
      if (node.isDir && node.children) {
        const found = search(node.children, [...acc, node.id!])
        if (found) return found
      } else if (node.id === noteID) {
        return acc
      }
    }
    return null
  }
  return search(entries, []) ?? []
}
