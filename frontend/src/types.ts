export type TabMode = 'wysiwyg' | 'markdown'
export type BufferStatus = 'unfiled' | 'filed'
export type UserIntent = 'trash' | 'keep' | null

export interface TabState {
  uuid: string            // stable identity for this tab instance — used to route async AI callbacks to the right tab without relying on current state
  path: string            // relative to vault root
  scroll: number
  active: boolean
  mode: TabMode
  // Populated on first load from buffer meta block
  status?: BufferStatus
  userIntent?: UserIntent
  displayName?: string    // "Untitled N" label from display_name meta field
  isEmpty?: boolean       // body has no non-whitespace content
  isModified?: boolean    // true if body has unsaved edits
  isEvaluating?: boolean  // true if executing backend smart AI evaluations (force-file)
  isClosing?: boolean     // true while smart-close AI evaluation is in flight
}
