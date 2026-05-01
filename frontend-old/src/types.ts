import { main } from '../wailsjs/go/models'

export type TabMode = 'wysiwyg' | 'markdown'
export type BufferStatus = 'unfiled' | 'filed' | 'error'
export type UserIntent = 'trash' | 'keep' | null

// Storable is the unified interface for Notes, Buffers, and Prompts.
// The "DOC knows" its own state through internal isModified tracking.
export interface Storable {
  kind: 'buffer' | 'note' | 'prompt'
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

// Mirrors stash.NoteEntry from Go — the sidebar navigation tree.
// Files carry a UUID id; folders carry an opaque ExternalRef id.
export interface NoteEntry {
  id?: string          // UUID for files; opaque folder ID for dirs (ExternalRef — never parsed)
  name: string
  displayName?: string
  status?: string
  userIntent?: string
  isDir: boolean
  children?: NoteEntry[]
}

// Mirrors stash.PromptEntry from Go.
export interface PromptEntry {
  id: string           // "prompt:name" — opaque, from Go
  name: string
  displayName: string
  path: string
  isVirtual: boolean
}

