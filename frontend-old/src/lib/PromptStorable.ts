import { Storable } from '../types'
import { main } from '../../wailsjs/go/models'

export class PromptStorable implements Storable {
  kind: 'prompt' = 'prompt'
  id: string
  path: string
  name: string
  body: string
  meta: main.DocumentMetaDTO | null = null
  versions: main.VersionRefDTO[] = []
  isModified: boolean = false

  constructor(name: string, content: string) {
    this.id = `prompt:${name}`
    this.path = `prompt:${name}`
    this.name = name
    this.body = content
    this.isModified = false
  }

  setBody(v: string) {
    if (this.body !== v) {
      this.body = v
      this.isModified = true
    }
  }

  setMeta(m: main.DocumentMetaDTO) {
    // Prompts don't have structured meta yet, but we allow holding it for future-proofing
    this.meta = m
    this.isModified = true
  }

  addAsset(_v: main.AssetDTO) {
    // Prompts don't support assets yet
    console.warn('[PromptStorable] assets not supported for prompts')
  }
}
