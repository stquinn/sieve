import { useEditor, EditorContent } from '@tiptap/react'
import { DOMParser as ProseMirrorDOMParser } from '@tiptap/pm/model'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import { Markdown } from 'tiptap-markdown'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { common, createLowlight } from 'lowlight'
import React, { useEffect, useRef, useState, useImperativeHandle, forwardRef, useCallback } from 'react'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'
import { stash } from '../../wailsjs/go/models'
import { CodeBlockWithAttrs } from '../extensions/CodeBlockWithAttrs'
import { ImageWithAttrs } from '../extensions/ImageWithAttrs'
import { AiBlock, AiQuestion } from '../extensions/AiBlock'
import { AiShortcuts } from '../extensions/AiShortcuts'
import { BlockNode } from '../extensions/BlockNode'
import { Search } from '../extensions/Search'
import { AskPopup } from './AskPopup'
import { isMod } from '../utils/platform'
import { detectLanguage } from '../utils/pasteHeuristics'
import { StorableDataService } from '../lib/StorableDataService'
import { AiService } from '../lib/AiService'
import { JobID, AiContext, AiListener } from '../lib/AiJob'
import { buildAiContext } from '../lib/aiContextBuilder'
import { useNoteOperations } from '../hooks/useNoteOperations'
import { MarkdownEditor } from './Editor/MarkdownEditor'
import { LinkBubbleMenu } from './Editor/LinkBubbleMenu'
import { BrowserOpenURL } from '../../wailsjs/runtime/runtime'
import { EditorPasteService } from '../lib/EditorPasteService'
import { useMemo } from 'react'

const lowlight = createLowlight(common)

interface EditorPanelProps {
  uuid: string
  mode: 'wysiwyg' | 'markdown'
  dataService: StorableDataService
  isActive: boolean
  tier: 'dumb' | 'smart'
  autosaveMs: number
  aiService: AiService
  onSearchUpdate?: (results: any[], index: number) => void
  onToggleAiBlocks?: () => void
  tick: number
}

export interface EditorPanelHandle {
  explain: () => void
  ask: (question?: string) => void
  getContextLabel: () => string
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
  dataService,
  isActive,
  tier,
  autosaveMs,
  aiService,
  onSearchUpdate,
  tick
}, ref) => {
  const isMarkdownInitially = (propMode === 'markdown' || uuid.startsWith('prompt:'))
  const [mode, setMode] = useState<'wysiwyg' | 'markdown'>(isMarkdownInitially ? 'markdown' : 'wysiwyg')
  const [rawMd, setRawMd] = useState('')
  const [showAskPopup, setShowAskPopup] = useState(false)
  const [askContext, setAskContext] = useState<{ contextLabel: string } | null>(null)
  const [showAiBlocks, setShowAiBlocks] = useState(true)
  
  const toggleAiBlocks = useCallback(() => setShowAiBlocks(prev => !prev), [])
  
  // ── Render ──────────────────────────────────────────────────────────────────
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastSyncedBody = useRef<string>('')
  const isInitialLoad = useRef(true)
  const lastSelection = useRef<{ pos: number; text: string | null } | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const runAiJob = (type: 'explain' | 'ask', question?: string) => {
    const blkId = 'ai-' + Math.random().toString(16).substring(2, 6)
    const job: JobID = { docId: uuid, blkId }
    const doc = dataService.get(uuid)
    const ctx = buildAiContext(
      editor!, 
      mode === 'markdown', 
      doc?.body || '', 
      doc?.path || ''
    )

    const lines = question ? question.split('\n') : []

    // 1. Insert Placeholder
    if (mode === 'markdown') {
      const ta = taRef.current
      if (!ta) return
      const end = ta.selectionEnd
      const thinking = `\n\n[!ai] id="${blkId}"\n${question ? `***Ask:*** ${question}\n\n---\n\n` : ''}_(thinking…)_\n[!ai-end]\n\n`
      const next = ta.value.substring(0, end) + thinking + ta.value.substring(end)
      dataService.setBody(uuid, next)
      setRawMd(next)
    } else if (editor) {
      let insertPos = editor.state.selection.to
      
      // Prevent nesting: if inside an aiBlock, jump to after it
      const $pos = editor.state.selection.$from
      for (let d = $pos.depth; d >= 0; d--) {
        if ($pos.node(d).type.name === 'aiBlock') {
          insertPos = $pos.after(d)
          break
        }
      }
      const questionNodes = lines.map((line, idx) => ({
        type: 'paragraph',
        content: line.trim().length > 0 ? [
          ...(idx === 0) ? [
            { type: 'text', text: 'Ask: ', marks: [{ type: 'bold' }, { type: 'italic' }] },
            { type: 'text', text: (line.startsWith('Ask: ') ? line.substring(5) : line) }
          ] : [
            { type: 'text', text: line }
          ]
        ] : []
      }))

      editor.commands.insertContentAt(insertPos, {
        type: 'aiBlock',
        attrs: { id: blkId },
        content: [
          ...(questionNodes.length > 0 ? [{ type: 'aiQuestion', content: questionNodes }] : []),
          { type: 'horizontalRule' },
          { type: 'paragraph', content: [{ type: 'text', text: '(thinking…)', marks: [{ type: 'italic' }] }] }
        ]
      })
    }

    // 2. Trigger Service
    const listener = {
      onComplete: (jobId: JobID, response: string) => {
        if (mode === 'markdown') {
          const body = dataService.get(uuid)?.body || ''
          const idEscaped = blkId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const pattern = new RegExp(`(\\[!ai\\] id="${idEscaped}"[^\\n]*)\\s*[\\s\\S]*?\\s*\\[!ai-end\\]`)
          
          const qlines = lines.map((l: string, i: number) => {
            if (l.trim().length === 0) return ''
            const cleanL = (i === 0 && l.startsWith('Ask: ')) ? l.substring(5) : l
            return i === 0 ? `***Ask:*** ${cleanL}` : cleanL
          }).filter(Boolean).join('\n\n')
          
          const updatedBody = body.replace(pattern, `$1\n\n${qlines}\n\n---\n\n${response}\n\n[!ai-end]`)
          dataService.setBody(uuid, updatedBody)
          setRawMd(updatedBody)
        } else if (editor) {
          let foundPos = -1
          let foundSize = 0
          editor.state.doc.descendants((node: import('@tiptap/pm/model').Node, pos: number) => {
            if (node.type.name === 'aiBlock' && node.attrs.id === blkId) {
              foundPos = pos
              foundSize = node.nodeSize
              return false
            }
          })
          if (foundPos !== -1) {
            const { schema } = editor.state
            const md = (editor.storage as any).markdown
            const html = md.parser.md.render(response.trim())
            const tempDiv = document.createElement('div')
            tempDiv.innerHTML = html
            const parsedDoc = ProseMirrorDOMParser.fromSchema(schema).parse(tempDiv)
            
            // Wrap in aiBlock to preserve structure and metadata
            const questionNodes = lines.map((line, idx) => ({
              type: 'paragraph',
              content: line.trim().length > 0 ? [
                ...(idx === 0) ? [
                  { type: 'text', text: 'Ask: ', marks: [{ type: 'bold' }, { type: 'italic' }] },
                  { type: 'text', text: (line.startsWith('Ask: ') ? line.substring(5) : line) }
                ] : [
                  { type: 'text', text: line }
                ]
              ] : []
            }))

            const aiBlockNode = {
              type: 'aiBlock',
              attrs: { id: blkId, ref: ctx.blockRef },
              content: [
                ...(questionNodes.length > 0 ? [{ type: 'aiQuestion', content: questionNodes }] : []),
                { type: 'horizontalRule' },
                ...parsedDoc.toJSON().content
              ]
            }
            editor.commands.insertContentAt({ from: foundPos, to: foundPos + foundSize }, aiBlockNode)
          }
        }
        // Scroll to bottom
        const el = mode === 'markdown' ? taRef.current : document.getElementById(`app-${uuid}`)
        if (el) el.scrollTop = el.scrollHeight
      },
      onError: (jobId: JobID, err: string) => {
        console.error('AI Job Error:',JSON.stringify(jobId), err)
      }
    }

    if (type === 'explain') aiService.explain(job, ctx, listener)
    else aiService.ask(job, ctx, question || 'Ask AI...', listener)
  }

  const getContextLabel = () => {
    const doc = dataService.get(uuid)
    return buildAiContext(editor!, mode === 'markdown', doc?.body || '', doc?.path || '').contextLabel
  }
  
  const pasteService = useMemo(() => new EditorPasteService(dataService, aiService, tier), [dataService, aiService, tier])
  const pasteServiceRef = useRef(pasteService)
  useEffect(() => { pasteServiceRef.current = pasteService }, [pasteService])

  const editor: any = useEditor({
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
      AiQuestion,
      TaskList,
      TaskItem.configure({
        nested: true,
      }),
      Markdown.configure({
        html: true,
        transformPastedText: false,
      
      }),
      AiShortcuts.configure({
        onExplain: () => runAiJob('explain'),
        onAsk: () => {
          const label = getContextLabel()
          setAskContext({ contextLabel: label })
          setShowAskPopup(true)
        },
        onSmartFile: () => aiService.smartFile(uuid),
        onKeepAndSmartFile: () => aiService.keepAndFile(uuid),
        onToggleAiBlocks: toggleAiBlocks,
      })
    ],
    content: '',
    editorProps: {
      attributes: {
        spellcheck: 'true',
      },
      handleDOMEvents: {
        click: (view, event) => {
          if (isMod(event)) {
            const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
            if (pos !== undefined) {
              const marks = view.state.doc.resolve(pos).marks()
              const linkMark = marks.find(m => m.type.name === 'link')
              if (linkMark) {
                // Use a tiny timeout to let the click event fully settle in the OS 
                // before handing off control to the browser.
                setTimeout(() => {
                  BrowserOpenURL(linkMark.attrs.href)
                }, 50)
                event.preventDefault()
                event.stopPropagation()
                return true
              }
            }
          }
          return false
        }
      },
      handlePaste(view, event) {
        return pasteServiceRef.current.handlePaste(editor!, uuid, event)
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
      console.log("doc updated")
      const content = editor.storage.markdown.getMarkdown() || ''
      
      if (content === lastSyncedBody.current) return
      lastSyncedBody.current = content
      dataService.setBody(uuid, content)

      if (saveTimer.current) clearTimeout(saveTimer.current)
      
      const delay = autosaveMs || 30000
      console.log('saveTimer', delay)
      saveTimer.current = setTimeout(() => {
        dataService.save(uuid).catch(console.error)
      }, delay)
    }
  })

  // Sync scroll path for image display
  useEffect(() => {
    if (editor) {
      editor.storage.imageWithAttrs = editor.storage.imageWithAttrs ?? {}
      editor.storage.imageWithAttrs.activeTabPath = dataService.get(uuid)?.path || ''
    }
  }, [editor, uuid])

  // Synchronize internal rawMd with authoritative DS content on load/switch
  useEffect(() => {
    const doc = dataService.get(uuid)
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
  }, [uuid, mode, editor, dataService])

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
    return pasteService.initBlobInterceptor(editor, uuid)
  }, [editor, mode, uuid, pasteService])

  useImperativeHandle(ref, () => ({
    explain: () => runAiJob('explain'),
    ask: (q) => runAiJob('ask', q),
    getContextLabel,
    getEditor: () => editor,
    getMarkdown: () => editor?.storage.markdown.getMarkdown() || '',
    getSelection: () => editor?.state.selection || { from: 0, to: 0 },
    getDocSize: () => editor?.state.doc.content.size || 0,
    getStorage: (ext: string) => editor?.storage[ext],
    setContent: (content: string) => {
      if (mode === 'markdown') {
        setRawMd(content)
        dataService.setBody(uuid, content)
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
      <MarkdownEditor
        uuid={uuid}
        value={rawMd}
        isActive={isActive}
        onToggleAiBlocks={toggleAiBlocks}
        textareaRef={taRef}
        onExplain={() => runAiJob('explain')}
        onAsk={(q?: string) => runAiJob('ask', q)}
        onChange={(val) => {
          if (val === lastSyncedBody.current) return
          setRawMd(val)
          lastSyncedBody.current = val
          dataService.setBody(uuid, val)
          if (saveTimer.current) clearTimeout(saveTimer.current)
          const delay = autosaveMs || 3000
          saveTimer.current = setTimeout(() => dataService.save(uuid).catch(console.error), delay)
        }}
      />
    )
  }

  return (
    <div 
      className={`editor-panel ${!showAiBlocks ? 'hide-ai-blocks' : ''}`}
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
      {editor && <LinkBubbleMenu editor={editor} />}
      <EditorContent editor={editor} />
      
      {showAskPopup && askContext && (
        <AskPopup
          contextLabel={askContext.contextLabel}
          onSend={(question) => {
            runAiJob('ask', question)
            setShowAskPopup(false)
          }}
          onClose={() => setShowAskPopup(false)}
        />
      )}
    </div>
  )
})
