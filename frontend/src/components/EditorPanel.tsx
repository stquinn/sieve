import { useEditor, EditorContent, BubbleMenu } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import { Markdown } from 'tiptap-markdown'
import { common, createLowlight } from 'lowlight'
import React, { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'
import { stash } from '../../wailsjs/go/models'
import { DescribeImage, SaveAsset, DownloadAsset, RefineLanguage } from '../../wailsjs/go/main/App'
import { CodeBlockWithAttrs } from '../extensions/CodeBlockWithAttrs'
import { ImageWithAttrs } from '../extensions/ImageWithAttrs'
import { AiBlockDecoration } from '../extensions/AiBlockDecoration'
import { AiBlock } from '../extensions/AiBlock'
import { BlockNode } from '../extensions/BlockNode'
import { Search } from '../extensions/Search'
import { detectLanguage } from '../utils/pasteHeuristics'
import { StorableDataService } from '../lib/StorableDataService'

const lowlight = createLowlight(common)

interface EditorPanelProps {
  uuid: string
  mode: 'wysiwyg' | 'markdown'
  ds: StorableDataService
  isActive: boolean
  tier: 'dumb' | 'smart'
  autosaveMs: number
  onSearchUpdate?: (results: any[], index: number) => void
  tick: number
}

export interface EditorPanelHandle {
  getEditor: () => import('@tiptap/react').Editor | null | undefined
  getMarkdown: () => string
  getSelection: () => import('@tiptap/pm/state').Selection | { from: number; to: number }
  getDocSize: () => number
  getStorage: (ext: string) => any
  setContent: (content: string) => void
  setTextSelection: (pos: number) => void
  clearSearch: () => void
  setSearchTerm: (term: string) => void
  on: (event: string, cb: any) => void
  off: (event: string, cb: any) => void
  focus: () => void
}

export const EditorPanel = forwardRef<EditorPanelHandle, EditorPanelProps>(({
  uuid,
  mode: propMode,
  ds,
  isActive,
  tier,
  autosaveMs,
  onSearchUpdate,
  tick
}, ref) => {
  const isMarkdownInitially = (propMode === 'markdown' || uuid.startsWith('prompt:'))
  const [mode, setMode] = useState<'wysiwyg' | 'markdown'>(isMarkdownInitially ? 'markdown' : 'wysiwyg')
  const [rawMd, setRawMd] = useState('')
  const [linkUrl, setLinkUrl] = useState('')
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const isInitialLoad = useRef(true)
  const lastSelection = useRef<{ pos: number; text: string | null } | null>(null)

  const editor = useEditor({
    extensions: [
      StarterKit.configure({ codeBlock: false, history: { depth: 10_000, newGroupDelay: 500 } }),
      CodeBlockWithAttrs.configure({ lowlight }),
      Link.configure({ openOnClick: false }),
      Placeholder.configure({
        placeholder: ({ editor }) => editor.isEmpty ? 'Start writing…' : '',
      }),
      BlockNode,
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      ImageWithAttrs,
      Search,
      AiBlock,
      AiBlockDecoration,
      Markdown.configure({
        html: true,
        transformPastedText: false,
      }),
    ],
    content: '',
    editorProps: {
      attributes: {
        spellcheck: 'true',
      },
      handlePaste(view, event) {
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
              const path = ds.get(uuid)?.path || ''
              const asset = await SaveAsset(path, id, dataUrl)
              const mdPath = asset.externalRef

              queueMicrotask(() => {
                editor.commands.insertContent({
                  type: 'image',
                  attrs: { src: mdPath, id, detect: 'pending' }
                })
              })

              if (tier === 'smart') {
                DescribeImage(mdPath).then((desc: stash.ImageDesc) => {
                  if (!desc || !editor) return
                  editor.commands.command(({ tr, state }) => {
                    let found = false
                    state.doc.descendants((node, pos) => {
                      if (node.type.name === 'image' && node.attrs.id === id) {
                        found = true
                        tr.setNodeMarkup(pos, null, { ...node.attrs, alt: desc.alt, summary: desc.summary, detect: 'cli' })
                        return false
                      }
                    })
                    return found
                  })
                }).catch(console.error)
              }
            } catch (err) {
              console.error('[EditorPanel] paste save failed', err)
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
              const path = ds.get(uuid)?.path || 'new'
              DownloadAsset(path, imgSrc, id).then(asset => {
                queueMicrotask(() => {
                  editor.commands.insertContent({
                    type: 'image',
                    attrs: { src: asset.externalRef, id, detect: 'pending' }
                  })
                })
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
            queueMicrotask(() => editor.commands.insertContent({
              type: 'codeBlock',
              attrs: { language: result.language || '', id, detect: 'heuristic' },
              content: [{ type: 'text', text }]
            }))
            if (tier === 'smart') {
              RefineLanguage(text).then(lang => {
                if (!lang || !editor) return
                editor.commands.command(({ tr, state }) => {
                  let found = false
                  state.doc.descendants((node, pos) => {
                    if (node.type.name === 'codeBlock' && node.attrs.id === id) {
                      found = true
                      tr.setNodeMarkup(pos, null, { ...node.attrs, language: lang, detect: 'ai' })
                      return false
                    }
                  })
                  return found
                })
              }).catch(console.error)
            }
            return true
          }
        }
        return false
      },
      handleKeyDown(view, event) {
        if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          if (editor?.isActive('listItem')) return false
          // Simple tab insertion for prose
          if (event.shiftKey) return false
          event.preventDefault()
          view.dispatch(view.state.tr.insertText('    '))
          return true
        }
        return false
      }
    },
    onUpdate: ({ editor }) => {
      const content = editor.storage.markdown.getMarkdown() || ''
      ds.setBody(uuid, content)

      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        ds.save(uuid).catch(console.error)
      }, autosaveMs)
    }
  })

  // Sync scroll path for image display
  useEffect(() => {
    if (editor) {
      editor.storage.imageWithAttrs = editor.storage.imageWithAttrs ?? {}
      editor.storage.imageWithAttrs.activeTabPath = ds.get(uuid)?.path || ''
    }
  }, [editor, uuid])

  // Synchronize internal rawMd with authoritative DS content on load/switch
  useEffect(() => {
    const doc = ds.get(uuid)
    if (doc) {
      if (mode === 'markdown' || uuid.startsWith('prompt:')) {
        setRawMd(doc.body)
        
        // Restore cursor if it was captured from WYSIWYG
        if (lastSelection.current && lastSelection.current.pos !== -1) {
          requestAnimationFrame(() => {
            const ta = document.getElementById(`ta-${uuid}`) as HTMLTextAreaElement
            if (ta) {
              ta.focus()
              const pos = Math.min(lastSelection.current!.pos, doc.body.length)
              ta.setSelectionRange(pos, pos)
              lastSelection.current = null
            }
          })
        }
      } else if (editor && (isInitialLoad.current || lastSelection.current)) {
        isInitialLoad.current = false
        editor.commands.setContent(doc.body, false)
        
        // Initial Scroll Restore
        requestAnimationFrame(() => {
          const scroll = doc.meta?.scroll ?? 0
          const el = document.getElementById(`app-${uuid}`)
          if (el) el.scrollTop = scroll
        })

        // Restore cursor if it was captured from Markdown
        if (lastSelection.current && lastSelection.current.pos !== -1) {
          const pos = Math.min(lastSelection.current.pos, doc.body.length)
          editor.commands.setTextSelection(pos)
          editor.commands.focus()
          lastSelection.current = null
        }
      }
    }
  }, [uuid, mode, editor, ds, tick])

  // Sync mode state with prop changes, ensuring prompts stay in markdown
  useEffect(() => {
    const isMarkdownInitially = (propMode === 'markdown' || uuid.startsWith('prompt:'))
    const targetMode = isMarkdownInitially ? 'markdown' : propMode
    if (targetMode !== mode) {
      // CAPTURE CURSOR BEFORE SWITCH
      if (mode === 'wysiwyg' && editor) {
        lastSelection.current = { pos: editor.state.selection.from, text: null }
      } else if (mode === 'markdown') {
        const ta = document.getElementById(`ta-${uuid}`) as HTMLTextAreaElement
        if (ta) {
          lastSelection.current = { pos: ta.selectionStart, text: null }
        }
      }
      setMode(targetMode)
    }
  }, [propMode, uuid])

  // Sync Search state up to App
  useEffect(() => {
    if (!editor || !onSearchUpdate) return
    const updateSearch = () => {
      const storage = editor.storage.search
      if (storage) {
        onSearchUpdate(storage.results || [], storage.currentIndex || 0)
      }
    }
    editor.on('transaction', updateSearch)
    return () => { editor.off('transaction', updateSearch) }
  }, [editor, onSearchUpdate])

  // Focus management
  useEffect(() => {
    if (isActive && editor && mode === 'wysiwyg') {
      // Use a slightly longer timeout to ensure display: contents transitions are complete
      const timer = setTimeout(() => {
        if (!editor.isFocused) editor.commands.focus()
      }, 50)
      return () => clearTimeout(timer)
    }
  }, [isActive, editor, mode])

  // Explicit focus for markdown mode
  useEffect(() => {
    if (isActive && mode === 'markdown') {
      const timer = setTimeout(() => {
        const ta = document.getElementById(`ta-${uuid}`) as HTMLTextAreaElement
        if (ta && document.activeElement !== ta) ta.focus()
      }, 50)
      return () => clearTimeout(timer)
    }
  }, [isActive, mode, uuid])

  // Blob Image Paste Interceptor
  useEffect(() => {
    if (!editor || mode === 'markdown') return
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
              const path = ds.get(uuid)?.path || ''
              const asset = await SaveAsset(path, id, dataUrl)
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

              if (tier === 'smart') {
                DescribeImage(asset.externalRef).then((desc: stash.ImageDesc) => {
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
                }).catch(console.error)
              }
            } catch (err) {
              console.error('[EditorPanel] blob paste save failed', err)
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
  }, [editor, mode, uuid, tier, ds])

  useImperativeHandle(ref, () => ({
    getEditor: () => editor,
    getMarkdown: () => editor?.storage.markdown.getMarkdown() || '',
    getSelection: () => editor?.state.selection || { from: 0, to: 0 },
    getDocSize: () => editor?.state.doc.content.size || 0,
    getStorage: (ext: string) => editor?.storage[ext],
    setContent: (content: string) => {
      if (mode === 'markdown') {
        setRawMd(content)
        ds.setBody(uuid, content)
      } else {
        editor?.commands.setContent(content)
      }
    },
    setTextSelection: (pos: number) => editor?.commands.setTextSelection(pos),
    clearSearch: () => editor?.commands.clearSearch(),
    setSearchTerm: (term: string) => editor?.commands.setSearchTerm(term),
    on: (event: any, cb: any) => editor?.on(event, cb),
    off: (event: any, cb: any) => editor?.off(event, cb),
    focus: () => {
      const timer = setTimeout(() => {
        if (mode === 'markdown') {
          const ta = document.querySelector(`#ta-${uuid}`) as HTMLTextAreaElement
          ta?.focus()
        } else {
          editor?.commands.focus()
        }
      }, 50)
    }
  }))

  if (mode === 'markdown') {
    return (
      <textarea
        id={`ta-${uuid}`}
        spellCheck={true}
        className="markdown-raw"
        value={rawMd}
        onChange={e => {
          const val = e.target.value
          setRawMd(val)
          ds.setBody(uuid, val)
          if (saveTimer.current) clearTimeout(saveTimer.current)
          saveTimer.current = setTimeout(() => ds.save(uuid).catch(console.error), autosaveMs)
        }}
        placeholder="Raw markdown — Ctrl+Shift+M to return"
        autoFocus={isActive}
        autoComplete="off"
        autoCorrect="off"
      />
    )
  }

  return (
    <div 
      id={`app-${uuid}`}
      spellCheck={true} 
      lang="en-US" 
      style={{ 
        display: 'flex',
        flexDirection: 'column', 
        height: '100%', 
        overflowY: 'auto' 
      }}
    >
      {editor && (
        <BubbleMenu
          editor={editor}
          shouldShow={({ editor }) => editor.isActive('link')}
          tippyOptions={{ placement: 'bottom', onShow: () => setLinkUrl(editor.getAttributes('link').href ?? '') }}
        >
          <div className="link-bubble">
            <input className="link-bubble__input" value={linkUrl}
              onChange={e => setLinkUrl(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter') editor.chain().focus().extendMarkRange('link').setLink({ href: linkUrl }).run()
                if (e.key === 'Escape') editor.chain().focus().run()
              }}
              placeholder="https://..." />
            <button className="link-bubble__btn"
              onClick={() => editor.chain().focus().extendMarkRange('link').setLink({ href: linkUrl }).run()}>Set</button>
            <button className="link-bubble__btn link-bubble__btn--remove"
              onClick={() => editor.chain().focus().extendMarkRange('link').unsetLink().run()}>Remove</button>
          </div>
        </BubbleMenu>
      )}
      <EditorContent editor={editor} />
    </div>
  )
})
