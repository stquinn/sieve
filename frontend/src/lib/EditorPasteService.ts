import { Editor } from '@tiptap/react'
import { StorableDataService } from './StorableDataService'
import { AiService } from './AiService'
import { JobID, AiListener } from './AiJob'
import { detectLanguage } from '../utils/pasteHeuristics'
import { sieve as stash } from '../../wailsjs/go/models'

export class EditorPasteService {
  constructor(
    private dataService: StorableDataService,
    private aiService: AiService,
    private tier: 'dumb' | 'smart'
  ) {}

  // handlePaste must be synchronous to match Tiptap's expected editorProps signature.
  // It returns true if it handled the event (starting async operations in background).
  public handlePaste(editor: Editor, uuid: string, event: ClipboardEvent): boolean {
    if (!event.clipboardData || !editor) return false

    const html = event.clipboardData.getData('text/html')
    const files = Array.from(event.clipboardData.files)
    const imageFile = files.find(f => f.type.startsWith('image/'))

    let imgSrc: string | null = null
    if (!imageFile && html) {
      const div = document.createElement('div')
      div.innerHTML = html
      const imgs = div.querySelectorAll('img')
      if (imgs.length === 1 && imgs[0].src) {
        imgSrc = imgs[0].src
      }
    }

    if (imageFile || imgSrc) {
      event.preventDefault()
      const saveDataUrl = async (dataUrl: string) => {
        const id = 'blk-' + Math.random().toString(16).substring(2, 6)
        try {
          const path = this.dataService.get(uuid)?.path || ''
          const asset = await this.dataService.saveAsset(path, id, dataUrl)
          const mdPath = asset.externalRef

          editor.commands.insertContent({
            type: 'image',
            attrs: { src: mdPath, id, detect: 'pending' }
          })

          if (this.tier === 'smart') {
            const job: JobID = { docId: uuid, blkId: id }
            const listener = this.createImageDescListener(editor, id)
            this.aiService.describeImage(job, mdPath, listener)
          }
        } catch (err) {
          console.error('[EditorPasteService] paste save failed', err)
        }
      }

      if (imageFile) {
        const reader = new FileReader()
        reader.onload = e => saveDataUrl(e.target?.result as string)
        reader.readAsDataURL(imageFile)
      } else if (imgSrc) {
        if (imgSrc.startsWith('data:')) {
          saveDataUrl(imgSrc)
        } else {
          const id = 'blk-' + Math.random().toString(16).substring(2, 6)
          const path = this.dataService.get(uuid)?.path || 'new'
          this.dataService.downloadAsset(path, imgSrc, id).then(asset => {
            const mdPath = asset.externalRef
            editor.commands.insertContent({
              type: 'image',
              attrs: { src: mdPath, id, detect: 'pending' }
            })

            if (this.tier === 'smart') {
              const job: JobID = { docId: uuid, blkId: id }
              const listener = this.createImageDescListener(editor, id)
              this.aiService.describeImage(job, mdPath, listener)
            }
          }).catch(console.error)
        }
      }
      return true
    }

    // Text paste heuristic
    const text = event.clipboardData.getData('text/plain')
    if (text && !editor.isActive('codeBlock')) {
      const result = detectLanguage(text)
      if (result.tier <= 3) {
        event.preventDefault()
        const id = 'blk-' + Math.random().toString(16).substring(2, 6)
        
        editor.commands.insertContent({
          type: 'codeBlock',
          attrs: { language: result.language || '', id, detect: 'heuristic' },
          content: [{ type: 'text', text }]
        })

        if (this.tier === 'smart') {
          const listener: AiListener<string> = {
            onComplete: (jobId, lang) => {
              const { state } = editor
              let tr = state.tr
              if (!lang || !editor) return
              state.doc.descendants((node, pos) => {
                if (node.type.name === 'codeBlock' && node.attrs.id === id) {
                  tr = tr.setNodeMarkup(pos, null, { ...node.attrs, language: lang, detect: 'ai' })
                }
              })
              if (tr.docChanged) editor.view.dispatch(tr)
            },
            onError: (jobId, err) => {
              console.error('[stash:ai] Language refinement failed', jobId, err)
            }
          }
          const job: JobID = { docId: uuid, blkId: id }
          this.aiService.refineLanguage(job, text, listener)
        }
        return true
      }
    }
    return false
  }

  private createImageDescListener(editor: Editor, id: string): AiListener<stash.ImageDesc> {
    return {
      onComplete: (jobId, desc) => {
        const { state } = editor
        let tr = state.tr
        state.doc.descendants((node, pos) => {
          if (node.type.name === 'image' && node.attrs.id === id) {
            tr = tr.setNodeMarkup(pos, null, { 
              ...node.attrs, 
              alt: desc.alt, 
              summary: desc.summary, 
              detect: 'ai' 
            })
          }
        })
        if (tr.docChanged) editor.view.dispatch(tr)
      },
      onError: (jobId, err) => {
        console.error('[stash:ai] Image description failed', jobId, err)
      }
    }
  }

  /**
   * Initializes a MutationObserver to intercept blob images that are pasted directly into the DOM
   * (e.g., from some browsers or via native paste actions that bypass handlePaste).
   */
  public initBlobInterceptor(editor: Editor, uuid: string): () => void {
    const editorEl = editor.view.dom as HTMLElement

    const processImg = (img: HTMLImageElement) => {
      const blobSrc = img.getAttribute('src') || ''
      if (!blobSrc.startsWith('blob:') && !blobSrc.startsWith('data:')) return
      if ((img as any).__stashProcessing) return
      ;(img as any).__stashProcessing = true

      const canvas = document.createElement('canvas')
      const image = new Image()
      image.onload = () => {
        canvas.width = image.naturalWidth
        canvas.height = image.naturalHeight
        const ctx = canvas.getContext('2d')
        if (!ctx) return
        ctx.drawImage(image, 0, 0)
        canvas.toBlob(async (blob) => {
          if (!blob) return
          const reader = new FileReader()
          reader.onload = async (e) => {
            const dataUrl = e.target?.result as string
            const id = 'blk-' + Math.random().toString(16).substring(2, 6)
            try {
              const path = this.dataService.get(uuid)?.path || ''
              const asset = await this.dataService.saveAsset(path, id, dataUrl)
              const mdSrc = asset.externalRef

              editor.chain()
                .command(({ tr, state }) => {
                  state.doc.descendants((node, pos) => {
                    if (node.type.name === 'image' && (node.attrs.src === blobSrc || node.attrs.src === img.src)) {
                      tr.setNodeMarkup(pos, undefined, { ...node.attrs, src: mdSrc, id, detect: 'pending' })
                    }
                  })
                  return true
                })
                .run()

              if (this.tier === 'smart') {
                const listener: AiListener<stash.ImageDesc> = {
                  onComplete: (jobId, desc) => {
                    console.log('[stash:ai] Image description complete (blob)', jobId)
                    if (!desc || !editor) return
                    editor.commands.command(({ tr, state }) => {
                      let found = false
                      state.doc.descendants((node, pos) => {
                        if (node.type.name === 'image' && node.attrs.id === id) {
                          found = true
                          if (node.attrs.detect !== 'user') {
                            tr.setNodeMarkup(pos, null, { ...node.attrs, alt: desc.alt, summary: desc.summary, detect: 'cli' })
                          }
                          return false
                        }
                      })
                      return found
                    })
                  },
                  onError: (jobId, err) => console.error('[stash:ai] Image description error (blob)', jobId, err)
                }
                const job: JobID = { docId: uuid, blkId: id }
                this.aiService.describeImage(job, asset.externalRef, listener)
              }
            } catch (err) {
              console.error('[EditorPasteService] blob paste save failed', err)
            }
          }
          reader.readAsDataURL(blob)
        }, 'image/png')
      }
      image.src = blobSrc
    }

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of Array.from(mutation.addedNodes)) {
          if (node instanceof HTMLImageElement) processImg(node)
          else if (node instanceof Element) node.querySelectorAll('img').forEach(processImg)
        }
      }
    })

    observer.observe(editorEl, { childList: true, subtree: true })
    return () => observer.disconnect()
  }
}
