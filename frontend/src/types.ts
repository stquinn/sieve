import { main } from '../wailsjs/go/models'

export type TabMode = 'wysiwyg' | 'markdown'
export type BufferStatus = 'unfiled' | 'filed' | 'error'
export type UserIntent = 'trash' | 'keep' | null

// Storable is the unified interface for Notes, Buffers, and Prompts.
// The "DOC knows" its own state through internal isModified tracking.
export interface Storable {
  kind: 'note' | 'prompt'
  id: string              // UUID for notes/buffers, Name for prompts
  path: string
  body: string
  meta: main.DocumentMetaDTO | null
  versions: main.VersionRefDTO[]
  isModified: boolean

  setBody(v: string): void
  setMeta(m: main.DocumentMetaDTO): void
  addAsset?(v: main.AssetDTO): void // Optional for prompts
}

export interface TabState {
  uuid: string
  mode: TabMode
  isVirtual?: boolean
}

