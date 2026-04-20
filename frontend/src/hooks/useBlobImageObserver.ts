import { useEffect } from 'react'
import type React from 'react'
import type { Editor } from '@tiptap/core'
import { SaveAsset, DescribeImage } from '../../wailsjs/go/main/App'
import { stash } from '../../wailsjs/go/models'
import type { TabState } from '../types'
import { assetMarkdownPath } from '../lib/fmUtils'

interface UseBlobImageObserverParams {
  editor: Editor | null
  activeTabRef: React.MutableRefObject<TabState | undefined>
  tierRef: React.MutableRefObject<'dumb' | 'smart'>
  pendingAiCount: React.MutableRefObject<number>
}

export function useBlobImageObserver({
  editor,
  activeTabRef,
  tierRef,
  pendingAiCount,
}: UseBlobImageObserverParams) {
  useEffect(() => {
    if (!editor) return
    const editorEl = editor.view.dom as HTMLElement

    const processImg = (img: HTMLImageElement) => {
      const blobSrc = img.getAttribute('src') || ''
      if (!blobSrc.startsWith('blob:') && !blobSrc.startsWith('data:')) return
      if ((img as any).__stashProcessing) return
      ;(img as any).__stashProcessing = true

      console.debug('[stash] mutation observer: intercepting img', blobSrc.substring(0, 60))

      const canvas = document.createElement('canvas')
      const image = new Image()
      image.onload = () => {
        canvas.width = image.naturalWidth
        canvas.height = image.naturalHeight
        const ctx = canvas.getContext('2d')
        if (!ctx) { console.error('[stash] mutation: no canvas ctx'); return }
        ctx.drawImage(image, 0, 0)
        canvas.toBlob(async (blob) => {
          if (!blob) { console.error('[stash] mutation: toBlob returned null'); return }
          const reader = new FileReader()
          reader.onload = async (e) => {
            const dataUrl = e.target?.result as string
            const id = 'blk-' + Math.random().toString(16).substring(2, 6)
            const tab = activeTabRef.current
            if (!tab) { console.error('[stash] mutation: no active tab'); return }

            try {
              const asset = await SaveAsset(tab.path, id, dataUrl)
              const mdPath = assetMarkdownPath(tab.path, asset.externalRef)
              console.debug('[stash] mutation: image saved', { id, externalRef: asset.externalRef, mdPath })

              editor.chain()
                .command(({ tr, state }) => {
                  state.doc.descendants((node, pos) => {
                    if (node.type.name === 'image' && (node.attrs.src === blobSrc || node.attrs.src === img.src)) {
                      tr.setNodeMarkup(pos, undefined, {
                        ...node.attrs,
                        src: mdPath,
                        id,
                        detect: 'pending',
                      })
                    }
                  })
                  return true
                })
                .run()

              if (tierRef.current === 'smart') {
                const capturedId = id
                pendingAiCount.current++
                DescribeImage(asset.externalRef)
                  .then((desc: stash.ImageDesc) => {
                    console.log('[stash:ai] DescribeImage (mutation): response', { id: capturedId, desc })
                    if (!desc || !editor) return
                    let found = false
                    editor.commands.command(({ tr, state }) => {
                      state.doc.descendants((node, pos) => {
                        if (node.type.name === 'image' && node.attrs.id === capturedId) {
                          found = true
                          if (node.attrs.detect !== 'user') {
                            tr.setNodeMarkup(pos, null, { ...node.attrs, alt: desc.alt, summary: desc.summary, detect: 'cli' })
                          }
                          return false
                        }
                      })
                      return found
                    })
                    if (!found) console.warn('[stash:ai] DescribeImage (mutation): node not found', { id: capturedId })
                  })
                  .catch((e: unknown) => {
                    console.error('[stash:ai] DescribeImage (mutation): call failed', e)
                    editor.commands.command(({ tr, state }) => {
                      let found = false
                      state.doc.descendants((node, pos) => {
                        if (node.type.name === 'image' && node.attrs.id === capturedId && node.attrs.detect === 'pending') {
                          found = true
                          tr.setNodeMarkup(pos, null, { ...node.attrs, detect: 'heuristic' })
                          return false
                        }
                      })
                      return found
                    })
                  })
                  .finally(() => {
                    pendingAiCount.current--
                  })
              }
            } catch (err) {
              console.error('[stash] mutation: save asset failed', err)
            }
          }
          reader.readAsDataURL(blob)
        }, 'image/png')
      }
      image.onerror = (e) => console.error('[stash] mutation: image load failed', e)
      image.src = blobSrc
    }

    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of Array.from(mutation.addedNodes)) {
          if (node instanceof HTMLImageElement) {
            processImg(node)
          } else if (node instanceof Element) {
            node.querySelectorAll('img').forEach(processImg)
          }
        }
      }
    })

    observer.observe(editorEl, { childList: true, subtree: true })
    console.debug('[stash] blob img observer attached')
    return () => observer.disconnect()
  }, [editor])
}
