import {
  LoadBuffer, SaveBuffer, NewBuffer, FileBuffer, RefileNote, DiscardBuffer,
  MoveNote, CreateFolder, DeleteFolder, RenameFolder, RenameNote, DeletePrompt, DeleteNote,
  GetNotes, GetPrompts, GetStoreInfo, EvaluateBuffer, SaveSettings,
  GetDocumentVersion, SaveAsset, DownloadAsset,
  SearchStore, Ask, Explain, LoadByUUID
} from '../../wailsjs/go/main/App'
import { main } from '../../wailsjs/go/models'
import { Storable } from '../types'

/**
 * STORABLE DATA SERVICE
 *
 * This is the central hub and factory for all document data (Storables).
 * It separates the mutable Data layer from the reactive UI layer (Tabs).
 *
 * Architecture:
 * 1. UI (Tabs) only holds a static UUID address.
 * 2. This Service holds the authoritative Storable instance for that UUID.
 * 3. Persistence flow (Save/Load/File/Discard) is managed exclusively here.
 */
export class StorableDataService {
  private registry = new Map<string, Storable>()
  private transientState = new Map<string, { isWaitingAI?: boolean; aiJobName?: string }>()
  private onNotify: (uuid: string) => void

  findIdByPath(path: string): string | undefined {
    for (const [id, doc] of this.registry.entries()) {
      if (doc.path === path) return id
    }
    return undefined
  }

  constructor(onNotify: (uuid: string) => void) {
    this.onNotify = onNotify
  }

  getTransient(uuid: string) {
    return this.transientState.get(uuid) || {}
  }

  setTransient(uuid: string, state: { isWaitingAI?: boolean; aiJobName?: string }) {
    this.transientState.set(uuid, { ...this.getTransient(uuid), ...state })
    this.onNotify(uuid)
  }

  /**
   * Get a live storable by its UUID
   */
  get(uuid: string): Storable | undefined {
    return this.registry.get(uuid)
  }

  /**
   * Load a document from disk by its opaque ID (UUID for notes/buffers,
   * "prompt:name" for prompts) and check it into the registry.
   */
  async loadByID(id: string): Promise<Storable> {
    if (id.startsWith('prompt:')) {
      const name = id.split(':')[1]
      const { LoadPrompt } = await import('../../wailsjs/go/main/App')
      const content = await LoadPrompt(name)
      const { PromptStorable } = await import('./PromptStorable')
      const doc = new PromptStorable(name, content)
      this.registry.set(doc.id, doc)
      this.onNotify(doc.id)
      return doc
    }

    const existing = this.registry.get(id)
    if (existing) return existing

    const raw = await LoadByUUID(id)
    const doc = (raw.meta?.status === 'filed')
      ? main.NoteDTO.createFrom(raw) as any
      : main.BufferDTO.createFrom(raw) as any
    doc.kind = raw.meta?.status === 'filed' ? 'note' : 'buffer'
    this.registry.set(doc.id, doc)
    this.onNotify(doc.id)
    return doc
  }

  /**
   * Load a document from disk by path (ExternalRef) — for session restoration only.
   * Prefer loadByID for all other callers.
   */
  async load(path: string): Promise<Storable> {
    if (path.startsWith('prompt:')) {
      return this.loadByID(path)
    }

    const existing = this.findIdByPath(path)
    if (existing) return this.registry.get(existing)!

    const raw = await LoadBuffer(path)
    const doc = (raw.meta?.status === 'filed')
      ? main.NoteDTO.createFrom(raw) as any
      : main.BufferDTO.createFrom(raw) as any
    doc.kind = raw.meta?.status === 'filed' ? 'note' : 'buffer'
    this.registry.set(doc.id, doc)
    this.onNotify(doc.id)
    return doc
  }

  /**
   * Create a NEW document and check it into the registry
   */
  async create(): Promise<Storable> {
    const raw = await NewBuffer()
    const doc = main.BufferDTO.createFrom(raw) as unknown as Storable
    doc.kind = 'buffer'
    this.registry.set(doc.id, doc)
    this.onNotify(doc.id)
    return doc
  }

  /**
   * Check in a specific DTO
   */
  set(uuid: string, dto: any) {
    const doc = (dto.meta?.status === 'filed')
      ? main.NoteDTO.createFrom(dto) as any
      : main.BufferDTO.createFrom(dto) as any
    doc.kind = dto.meta?.status === 'filed' ? 'note' : 'buffer'
    this.registry.set(uuid, doc)
    this.onNotify(uuid)
  }

  /**
   * Register an existing DTO (e.g. from session restoration)
   */
  register(doc: Storable) {
    this.registry.set(doc.id, doc)
    this.onNotify(doc.id)
  }

  /**
   * Update the body of a document
   */
  setBody(uuid: string, body: string) {
    const doc = this.registry.get(uuid)
    if (!doc) return
    doc.setBody(body)
    this.onNotify(uuid)
  }

  /**
   * Update the metadata of a document
   */
  setMeta(uuid: string, meta: main.DocumentMetaDTO) {
    const doc = this.registry.get(uuid)
    if (!doc) return
    doc.setMeta(meta)
    this.onNotify(uuid)
  }

  /**
   * Update User Filing Intent
   */
  setIntent(uuid: string, intent: any) {
    const doc = this.registry.get(uuid)
    if (!doc || !doc.meta) return
    doc.meta.userIntent = intent
    doc.isModified = true
    this.onNotify(uuid)
  }

  /**
   * Update specifically the scroll metadata
   */
  updateScroll(uuid: string, scroll: number) {
    const doc = this.registry.get(uuid)
    if (!doc || !doc.meta) return
    if (doc.meta.scroll === scroll) return
    doc.meta.scroll = scroll
    // No notification on scroll updates to avoid expensive re-renders while scrolling
  }

  /**
   * Save a document to disk if it is modified
   */
  async save(uuid: string): Promise<Storable | null> {
    const doc = this.registry.get(uuid)
    if (!doc) return null

    if (!doc.isModified) {
      return doc
    }

    try {
      if (doc.kind === 'prompt') {
        const name = uuid.split(':')[1]
        const { SavePrompt } = await import('../../wailsjs/go/main/App')
        await SavePrompt(name, doc.body || '')
        doc.isModified = false
        this.onNotify(uuid)
        return doc
      }

      const saved = await SaveBuffer(doc as any)
      const updated = (doc instanceof main.BufferDTO)
        ? main.BufferDTO.createFrom(saved) as any
        : main.NoteDTO.createFrom(saved) as any
      updated.kind = (updated instanceof main.BufferDTO) ? 'buffer' : 'note'

      // Update the cache with the fresh data from the backend (versions, meta, etc.)
      this.registry.set(uuid, updated)
      this.onNotify(uuid)
      return updated
    } catch (err) {
      console.error(`[StorableDataService] Failed to save ${uuid}:`, err)
      throw err
    }
  }

  /**
   * Promote a buffer to a permanent note
   */
  async file(uuid: string): Promise<Storable | null> {
    const doc = this.registry.get(uuid)
    if (!doc) return null
    try {
      const saved = await FileBuffer(doc.path)
      const updated = main.NoteDTO.createFrom(saved) as any
      updated.kind = 'note'
      this.registry.set(uuid, updated)
      this.onNotify(uuid)
      return updated
    } catch (err) {
      console.error(`[StorableDataService] Failed to file ${uuid}:`, err)
      throw err
    }
  }

  /**
   * Update filing/location for an already filed note
   */
  async refile(uuid: string): Promise<Storable | null> {
    const doc = this.registry.get(uuid)
    if (!doc) return null
    try {
      const saved = await RefileNote(doc as any)
      const updated = main.NoteDTO.createFrom(saved) as any
      updated.kind = 'note'
      this.registry.set(uuid, updated)
      this.onNotify(uuid)
      return updated
    } catch (err) {
      console.error(`[StorableDataService] Failed to refile ${uuid}:`, err)
      throw err
    }
  }

  /**
   * Delete a buffer or filed note by UUID
   */
  async discard(uuid: string): Promise<void> {
    const doc = this.registry.get(uuid)
    if (!doc) return
    try {
      if (doc.meta?.status === 'filed') {
        await DeleteNote(uuid)
      } else {
        await DiscardBuffer(doc.path)
      }
      this.evict(uuid)
    } catch (err) {
      console.error(`[StorableDataService] Failed to discard ${uuid}:`, err)
      throw err
    }
  }

  /**
   * Explicitly evict a document (e.g. when tab is closed)
   */
  evict(uuid: string) {
    this.registry.delete(uuid)
  }

  // ── Store Operations ───────────────────────────────────────────────────────

  /**
   * Move a note to a different folder. noteUUID identifies the note;
   * targetFolderID is the opaque folder ID from GetNotes (e.g. "store/ai-stuff"
   * or "store" for the Library root).
   */
  async move(noteUUID: string, targetFolderID: string): Promise<void> {
    try {
      const dto = await MoveNote(noteUUID, targetFolderID)
      // Update registry path to reflect the new location
      const existing = this.registry.get(noteUUID)
      if (existing) {
        existing.path = dto.path
        this.onNotify(noteUUID)
      }
    } catch (err) {
      console.error(`[StorableDataService] Failed to move ${noteUUID}:`, err)
      throw err
    }
  }

  /**
   * Create a new folder. parentFolderID is the opaque folder ID from GetNotes
   * ("store" or "" for Library root). name is the new folder name.
   */
  async createFolder(parentFolderID: string, name: string): Promise<void> {
    try {
      await CreateFolder(parentFolderID, name)
    } catch (err) {
      console.error(`[StorableDataService] Failed to create folder:`, err)
      throw err
    }
  }

  /**
   * Delete a folder by its opaque ID
   */
  async deleteFolder(folderID: string): Promise<void> {
    try {
      await DeleteFolder(folderID)
    } catch (err) {
      console.error(`[StorableDataService] Failed to delete folder ${folderID}:`, err)
      throw err
    }
  }

  /**
   * Rename a document or folder by its opaque ID.
   * For folders: returns the new folder ID (for updating openFolders state).
   * For notes: updates the registry path from the returned DTO.
   */
  async rename(id: string, newName: string, isDir: boolean): Promise<string | void> {
    try {
      if (isDir) {
        const newFolderID = await RenameFolder(id, newName)
        // Cascade registry path updates for any open docs in this folder
        const oldPrefix = id + '/'
        const newPrefix = newFolderID + '/'
        for (const storable of this.registry.values()) {
          if (storable.path.startsWith(oldPrefix)) {
            storable.path = newPrefix + storable.path.substring(oldPrefix.length)
            this.onNotify(storable.id)
          }
        }
        return newFolderID
      } else {
        const dto = await RenameNote(id, newName)
        const existing = this.registry.get(id)
        if (existing) {
          existing.path = dto.path
          this.onNotify(id)
        }
      }
    } catch (err) {
      console.error(`[StorableDataService] Failed to rename ${id}:`, err)
      throw err
    }
  }

  /**
   * Rename a document or folder by its opaque ID.
   * Delegates to rename() — no path construction.
   */
  async renameDoc(id: string, newName: string, isDir: boolean): Promise<string | void> {
    return this.rename(id, newName, isDir)
  }

  // ── Prompt Operations ──────────────────────────────────────────────────────

  /**
   * Delete a prompt template
   */
  async deletePrompt(name: string): Promise<void> {
    try {
      await DeletePrompt(name)
      // Evict from registry if open
      const uuid = `prompt:${name}`
      if (this.registry.has(uuid)) {
        this.evict(uuid)
        this.onNotify(uuid)
      }
    } catch (err) {
      console.error(`[StorableDataService] Failed to delete prompt ${name}:`, err)
      throw err
    }
  }

  // ── Retrieval & Evaluation ─────────────────────────────────────────────────

  /**
   * Fetch all notes (sidebar tree)
   */
  async getNotes() {
    return GetNotes()
  }

  /**
   * Fetch all custom prompts
   */
  async getPrompts() {
    return GetPrompts()
  }

  /**
   * Get store information/config
   */
  async getStoreInfo() {
    return GetStoreInfo()
  }

  /**
   * Evaluate a buffer for filing recommendations
   */
  async evaluate(path: string) {
    return EvaluateBuffer(path)
  }

  // ── Document Versions ──────────────────────────────────────────────────────

  async getDocumentVersion(path: string, version: any) {
    return GetDocumentVersion(path, version)
  }

  // ── Asset Management ───────────────────────────────────────────────────────

  async saveAsset(path: string, id: string, dataUrl: string) {
    return SaveAsset(path, id, dataUrl)
  }

  async downloadAsset(path: string, url: string, id: string) {
    return DownloadAsset(path, url, id)
  }

  // ── Search ─────────────────────────────────────────────────────────────────

  async searchStore(query: string) {
    return SearchStore(query)
  }

  /**
   * Save global settings
   */
  async saveSettings(settings: any) {
    return SaveSettings(settings)
  }
}
