import { main } from '../../wailsjs/go/models'
import { LoadBuffer, SaveBuffer, NewBuffer } from '../../wailsjs/go/main/App'
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
 * 3. Persistence flow (Save/Load) is managed exclusively here.
 */
export class StorableDataService {
  private registry = new Map<string, Storable>()
  private transientState = new Map<string, { isWaitingAI?: boolean; aiJobName?: string }>()
  private onNotify: (uuid: string) => void

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
   * Load a document from disk and check it into the registry
   */
  async load(path: string): Promise<Storable> {
    if (path.startsWith('prompt:')) {
      const name = path.split(':')[1]
      const { LoadPrompt } = await import('../../wailsjs/go/main/App')
      const content = await LoadPrompt(name)
      const { PromptStorable } = await import('./PromptStorable')
      const doc = new PromptStorable(name, content)
      this.registry.set(doc.id, doc)
      this.onNotify(doc.id)
      return doc
    }
    const raw = await LoadBuffer(path)
    const doc = main.BufferDTO.createFrom(raw) as unknown as Storable
    doc.kind = 'note'
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
    doc.kind = 'note'
    this.registry.set(doc.id, doc)
    this.onNotify(doc.id)
    return doc
  }

  /**
   * Check in a specific DTO
   */
  set(uuid: string, dto: any) {
    const doc = main.BufferDTO.createFrom(dto) as unknown as Storable
    doc.kind = 'note'
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
      const updated = main.BufferDTO.createFrom(saved) as unknown as Storable
      updated.kind = 'note'

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
   * Explicitly evict a document (e.g. when tab is closed)
   */
  evict(uuid: string) {
    this.registry.delete(uuid)
  }
}
