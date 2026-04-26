import { Editor } from '@tiptap/core'
import { DOMParser as ProseMirrorDOMParser } from '@tiptap/pm/model'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import { Markdown } from 'tiptap-markdown'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import { common, createLowlight } from 'lowlight'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'
import { CodeBlockWithAttrs } from '../extensions/CodeBlockWithAttrs'
import { ImageWithAttrs } from '../extensions/ImageWithAttrs'
import { AiBlock, AiQuestion } from '../extensions/AiBlock'
import { AiShortcuts } from '../extensions/AiShortcuts'
import { BlockNode } from '../extensions/BlockNode'
import { Search } from '../extensions/Search'
import { isMod } from '../utils/platform'
import { StorableDataService } from '../lib/StorableDataService'
import { AiService } from '../lib/AiService'
import { JobID } from '../lib/AiJob'
import { buildAiContext } from '../lib/aiContextBuilder'
import { EditorPasteService } from '../lib/EditorPasteService'
import { BrowserOpenURL } from '../../wailsjs/runtime/runtime'

const lowlight = createLowlight(common)

export class SieveEditor {
  editor: Editor | null = null

  private editorEl: HTMLElement | null = null
  private mdWrapper: HTMLElement | null = null
  private textarea: HTMLTextAreaElement | null = null
  private taGutter: HTMLElement | null = null
  private linkBubble: HTMLElement | null = null
  private askDialog: HTMLDialogElement | null = null

  private currentUuid = ''
  private mode: 'wysiwyg' | 'markdown' = 'wysiwyg'
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private lastSyncedBody = ''
  private showAiBlocks = true
  private pasteService: EditorPasteService

  constructor(
    private container: HTMLElement,
    private dataService: StorableDataService,
    private aiService: AiService,
    private tier: 'dumb' | 'smart',
    private autosaveMs: number
  ) {
    this.pasteService = new EditorPasteService(dataService, aiService, tier)
    this.initEditor()
    this.initMarkdownArea()
    this.initAskDialog()
    this.initLinkBubble()
  }

  // ── Initialization ──────────────────────────────────────────────────────────

  private initEditor() {
    this.editorEl = document.createElement('div')
    this.editorEl.className = 'editor-panel'
    this.editorEl.setAttribute('spellcheck', 'true')
    this.editorEl.setAttribute('lang', 'en-US')
    this.editorEl.style.cssText = 'flex:1;min-height:0;overflow-y:auto;display:flex;flex-direction:column;height:100%'
    this.container.appendChild(this.editorEl)

    this.editor = new Editor({
      element: this.editorEl,
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
        TaskItem.configure({ nested: true }),
        Markdown.configure({ html: true, transformPastedText: false }),
        AiShortcuts.configure({
          onExplain:          () => this.runAiJob('explain'),
          onAsk:              () => this.openAskPopup(),
          onSmartFile:        () => this.aiService.smartFile(this.currentUuid),
          onKeepAndSmartFile: () => this.aiService.keepAndFile(this.currentUuid),
          onToggleAiBlocks:   () => this.toggleAiBlocks(),
        }),
      ],
      content: '',
      editorProps: {
        attributes: { spellcheck: 'true' },
        handleDOMEvents: {
          click: (view, event) => {
            if (isMod(event)) {
              const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos
              if (pos !== undefined) {
                const marks = view.state.doc.resolve(pos).marks()
                const linkMark = marks.find((m: any) => m.type.name === 'link')
                if (linkMark) {
                  setTimeout(() => BrowserOpenURL(linkMark.attrs.href), 50)
                  event.preventDefault()
                  event.stopPropagation()
                  return true
                }
              }
            }
            return false
          },
        },
        handlePaste: (_view, event) => {
          return this.editor ? this.pasteService.handlePaste(this.editor as any, this.currentUuid, event) : false
        },
        handleKeyDown: (view, event) => {
          if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
            if (this.editor?.isActive('listItem')) return false
            if (event.shiftKey) return false
            event.preventDefault()
            view.dispatch(view.state.tr.insertText('    '))
            return true
          }
          return false
        },
      },
      onUpdate: ({ editor }) => {
        const content = (editor.storage as any).markdown.getMarkdown() || ''
        if (content === this.lastSyncedBody) return
        this.lastSyncedBody = content
        this.dataService.setBody(this.currentUuid, content)
        this.scheduleAutosave()
        document.dispatchEvent(new CustomEvent('editor:changed'))
        this.dispatchStats()
      },
      onSelectionUpdate: () => {
        this.updateLinkBubble()
      },
    })
  }

  private initMarkdownArea() {
    this.mdWrapper = document.createElement('div')
    this.mdWrapper.className = 'markdown-wrapper'
    this.mdWrapper.style.cssText = 'display:none;flex-direction:row;height:100%;overflow:hidden;background:var(--theme-bg);position:relative'

    this.taGutter = document.createElement('div')
    this.taGutter.className = 'markdown-gutter'
    this.taGutter.style.cssText = 'width:2.75rem;padding:40px 0.6rem 0.85em;background-color:var(--theme-bgDark);border-right:1px solid var(--theme-border);color:var(--theme-muted);font-family:var(--theme-monoFont);font-size:14px;line-height:1.6;text-align:right;user-select:none;overflow:hidden'

    this.textarea = document.createElement('textarea')
    this.textarea.className = 'markdown-editor markdown-raw'
    this.textarea.spellcheck = true
    this.textarea.placeholder = 'Raw markdown — Mod+Shift+M to return'
    this.textarea.setAttribute('autocomplete', 'off')
    this.textarea.setAttribute('autocorrect', 'off')
    this.textarea.style.cssText = 'flex:1;padding-top:40px;padding-left:1rem;padding-right:1rem;padding-bottom:1rem'

    this.textarea.addEventListener('input', () => {
      const val = this.textarea!.value
      if (val === this.lastSyncedBody) return
      this.lastSyncedBody = val
      this.dataService.setBody(this.currentUuid, val)
      this.scheduleAutosave()
      document.dispatchEvent(new CustomEvent('editor:changed'))
      this.updateMarkdownGutter(val)
      this.dispatchStats()
    })

    this.textarea.addEventListener('scroll', () => {
      if (this.taGutter) this.taGutter.scrollTop = this.textarea!.scrollTop
    })

    this.textarea.addEventListener('keydown', (e) => {
      const key = e.key.toLowerCase()
      const mod = isMod(e as any)
      if (mod && key === 'e' && !e.shiftKey) { e.preventDefault(); this.runAiJob('explain') }
      if (mod && e.shiftKey && key === 'a')  { e.preventDefault(); this.openAskPopup() }
      if (mod && key === 'j')                { e.preventDefault(); this.toggleAiBlocks() }
    })

    this.mdWrapper.appendChild(this.taGutter)
    this.mdWrapper.appendChild(this.textarea)
    this.container.appendChild(this.mdWrapper)
  }

  private initAskDialog() {
    const dialog = document.createElement('dialog') as HTMLDialogElement
    dialog.className = 'ask-popup'

    const header = document.createElement('div')
    header.className = 'ask-popup__header'

    const label = document.createElement('span')
    label.className = 'ask-popup__label'

    const closeBtn = document.createElement('button')
    closeBtn.className = 'ask-popup__close'
    closeBtn.textContent = '✕'
    closeBtn.title = 'Close (Esc)'
    closeBtn.addEventListener('click', () => dialog.close())

    header.appendChild(label)
    header.appendChild(closeBtn)

    const textarea = document.createElement('textarea')
    textarea.className = 'ask-popup__input'
    textarea.placeholder = 'Ask a question… (Enter to send, Shift+Enter for new line)'
    textarea.rows = 3
    textarea.spellcheck = false

    const footer = document.createElement('div')
    footer.className = 'ask-popup__footer'

    const hint = document.createElement('span')
    hint.className = 'ask-popup__hint'
    hint.textContent = 'Enter to send · Shift+Enter for new line'

    const sendBtn = document.createElement('button')
    sendBtn.className = 'ask-popup__send'
    sendBtn.textContent = 'Send'

    const doSend = () => {
      const val = textarea.value.trim()
      if (val) { this.runAiJob('ask', val); dialog.close() }
    }

    sendBtn.addEventListener('click', doSend)
    textarea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend() }
      if (e.key === 'Escape') { e.preventDefault(); dialog.close() }
    })

    dialog.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') dialog.close()
    })

    footer.appendChild(hint)
    footer.appendChild(sendBtn)
    dialog.appendChild(header)
    dialog.appendChild(textarea)
    dialog.appendChild(footer)
    document.body.appendChild(dialog)
    this.askDialog = dialog
  }

  private initLinkBubble() {
    const bubble = document.createElement('div')
    bubble.className = 'link-bubble'
    bubble.style.cssText = 'position:fixed;display:none;z-index:1000;align-items:center;gap:4px'

    const input = document.createElement('input')
    input.className = 'link-bubble__input'
    input.placeholder = 'https://...'

    const btnSet = document.createElement('button')
    btnSet.className = 'link-bubble__btn'
    btnSet.textContent = 'Set'

    const btnRemove = document.createElement('button')
    btnRemove.className = 'link-bubble__btn link-bubble__btn--remove'
    btnRemove.textContent = 'Remove'

    const btnOpen = document.createElement('button')
    btnOpen.className = 'link-bubble__btn'
    btnOpen.textContent = 'Open'

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        this.editor?.chain().focus().extendMarkRange('link').setLink({ href: input.value }).run()
      }
      if (e.key === 'Escape') {
        this.editor?.chain().focus().run()
        bubble.style.display = 'none'
      }
    })

    btnSet.addEventListener('click', () => {
      this.editor?.chain().focus().extendMarkRange('link').setLink({ href: input.value }).run()
    })
    btnRemove.addEventListener('click', () => {
      this.editor?.chain().focus().extendMarkRange('link').unsetLink().run()
    })
    btnOpen.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      if (input.value) BrowserOpenURL(input.value)
    })

    // Hide on outside click
    document.addEventListener('mousedown', (e) => {
      if (bubble.style.display !== 'none' && !bubble.contains(e.target as Node)) {
        bubble.style.display = 'none'
      }
    })

    bubble.appendChild(input)
    bubble.appendChild(btnSet)
    bubble.appendChild(btnRemove)
    bubble.appendChild(btnOpen)
    document.body.appendChild(bubble)
    this.linkBubble = bubble
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  load(uuid: string, mode: 'wysiwyg' | 'markdown') {
    // Flush any pending save for the previous document
    if (this.currentUuid && this.currentUuid !== uuid) {
      this.flushSave()
    }

    this.currentUuid = uuid
    this.mode = mode

    const doc = this.dataService.get(uuid)
    const body = doc?.body || ''
    this.lastSyncedBody = body

    // Update global for image src resolution
    ;(window as any).__stashActiveTabPath = doc?.path || ''

    const isMarkdown = mode === 'markdown' || uuid.startsWith('prompt:')
    if (isMarkdown) {
      this.showMarkdownMode(body)
    } else {
      this.showWysiwygMode(body, (doc as any)?.meta?.scroll ?? 0)
    }

    this.dispatchStats()
  }

  save(uuid?: string): Promise<void> {
    return this.dataService.save(uuid ?? this.currentUuid).catch(console.error) as Promise<void>
  }

  focus() {
    setTimeout(() => {
      if (this.mode === 'markdown') {
        this.textarea?.focus()
      } else {
        this.editor?.commands.focus()
      }
    }, 50)
  }

  explain() {
    this.runAiJob('explain')
  }

  ask(question?: string) {
    if (question) {
      this.runAiJob('ask', question)
    } else {
      this.openAskPopup()
    }
  }

  setSearchTerm(term: string) {
    this.editor?.commands.setSearchTerm(term)
  }

  clearSearch() {
    this.editor?.commands.clearSearch()
  }

  setContent(content: string) {
    if (this.mode === 'markdown') {
      if (this.textarea) this.textarea.value = content
      this.dataService.setBody(this.currentUuid, content)
      this.lastSyncedBody = content
    } else {
      this.editor?.commands.setContent(content)
    }
  }

  getMarkdown(): string {
    if (this.mode === 'markdown') return this.textarea?.value || ''
    return (this.editor?.storage as any)?.markdown?.getMarkdown() || ''
  }

  getStats(): { chars: number; lines: number } {
    const text = this.getMarkdown()
    const chars = text.length
    const lines = text === '' ? 0 : text.split('\n').length
    return { chars, lines }
  }

  destroy() {
    this.flushSave()
    this.editor?.destroy()
    this.linkBubble?.remove()
    this.askDialog?.remove()
  }

  // ── Mode switching ──────────────────────────────────────────────────────────

  private showWysiwygMode(body: string, scroll: number) {
    this.mode = 'wysiwyg'
    if (this.mdWrapper) this.mdWrapper.style.display = 'none'
    if (this.editorEl)  this.editorEl.style.display = ''

    if (this.editor) {
      this.editor.commands.setContent(body, false)
      requestAnimationFrame(() => {
        if (this.editorEl) this.editorEl.scrollTop = scroll
      })
      const editorContainer = this.editorEl?.querySelector('.ProseMirror')
      if (editorContainer) (editorContainer as HTMLElement).id = `app-${this.currentUuid}`
    }
  }

  private showMarkdownMode(body: string) {
    this.mode = 'markdown'
    if (this.editorEl)  this.editorEl.style.display = 'none'
    if (this.mdWrapper) this.mdWrapper.style.cssText = this.mdWrapper.style.cssText.replace('display:none', 'display:flex')

    if (this.textarea) {
      this.textarea.value = body
      this.textarea.id = `ta-${this.currentUuid}`
      this.updateMarkdownGutter(body)
      requestAnimationFrame(() => this.textarea?.focus())
    }
  }

  // ── AI Jobs ─────────────────────────────────────────────────────────────────

  private runAiJob(type: 'explain' | 'ask', question?: string) {
    const blkId = 'ai-' + Math.random().toString(16).substring(2, 6)
    const job: JobID = { docId: this.currentUuid, blkId }
    const doc = this.dataService.get(this.currentUuid)
    const ctx = buildAiContext(
      this.editor as any,
      this.mode === 'markdown',
      doc?.body || '',
      doc?.path || ''
    )

    const lines = question ? question.split('\n') : []

    // 1. Insert placeholder
    if (this.mode === 'markdown') {
      const ta = this.textarea
      if (!ta) return
      const end = ta.selectionEnd
      const thinking = `\n\n[!ai] id="${blkId}" thinking="true"\n${question ? `***Ask:*** ${question}\n\n---\n\n` : ''}_(thinking…)_\n[!ai-end]\n\n`
      const next = ta.value.substring(0, end) + thinking + ta.value.substring(end)
      this.dataService.setBody(this.currentUuid, next)
      ta.value = next
      this.lastSyncedBody = next
      this.updateMarkdownGutter(next)
    } else if (this.editor) {
      let insertPos = this.editor.state.selection.to
      const $pos = this.editor.state.selection.$from
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
            { type: 'text', text: line.startsWith('Ask: ') ? line.substring(5) : line },
          ] : [
            { type: 'text', text: line },
          ],
        ] : [],
      }))
      this.editor.commands.insertContentAt(insertPos, {
        type: 'aiBlock',
        attrs: { id: blkId, thinking: true },
        content: [
          ...(questionNodes.length > 0 ? [{ type: 'aiQuestion', content: questionNodes }] : []),
          { type: 'horizontalRule' },
          { type: 'paragraph', content: [{ type: 'text', text: '(thinking…)', marks: [{ type: 'italic' }] }] },
        ],
      })
    }

    // 2. Fire AI service
    const listener = {
      onComplete: (_jobId: JobID, response: string) => {
        if (this.mode === 'markdown') {
          const body = this.dataService.get(this.currentUuid)?.body || ''
          const idEscaped = blkId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const pattern = new RegExp(`(\\[!ai\\] id="${idEscaped}"[^\\n]*)\\s*[\\s\\S]*?\\s*\\[!ai-end\\]`)
          const qlines = lines.map((l, i) => {
            if (l.trim().length === 0) return ''
            const cleanL = (i === 0 && l.startsWith('Ask: ')) ? l.substring(5) : l
            return i === 0 ? `***Ask:*** ${cleanL}` : cleanL
          }).filter(Boolean).join('\n\n')
          const updatedBody = body.replace(pattern, `$1\n\n${qlines}\n\n---\n\n${response}\n\n[!ai-end]`.replace(/\s*thinking="true"/, ''))
          this.dataService.setBody(this.currentUuid, updatedBody)
          if (this.textarea) { this.textarea.value = updatedBody; this.updateMarkdownGutter(updatedBody) }
          this.lastSyncedBody = updatedBody
          if (this.textarea) this.textarea.scrollTop = this.textarea.scrollHeight
        } else if (this.editor) {
          let foundPos = -1
          let foundSize = 0
          this.editor.state.doc.descendants((node: any, pos: number) => {
            if (node.type.name === 'aiBlock' && node.attrs.id === blkId) {
              foundPos = pos; foundSize = node.nodeSize; return false
            }
          })
          if (foundPos !== -1) {
            const { schema } = this.editor.state
            const md = (this.editor.storage as any).markdown
            const html = md.parser.md.render(response.trim())
            const tempDiv = document.createElement('div')
            tempDiv.innerHTML = html
            const parsedDoc = ProseMirrorDOMParser.fromSchema(schema).parse(tempDiv)
            const qNodes = lines.map((line, idx) => ({
              type: 'paragraph',
              content: line.trim().length > 0 ? [
                ...(idx === 0) ? [
                  { type: 'text', text: 'Ask: ', marks: [{ type: 'bold' }, { type: 'italic' }] },
                  { type: 'text', text: line.startsWith('Ask: ') ? line.substring(5) : line },
                ] : [{ type: 'text', text: line }],
              ] : [],
            }))
            const aiBlockNode = {
              type: 'aiBlock',
              attrs: { id: blkId, ref: ctx.blockRef, thinking: false },
              content: [
                ...(qNodes.length > 0 ? [{ type: 'aiQuestion', content: qNodes }] : []),
                { type: 'horizontalRule' },
                ...parsedDoc.toJSON().content,
              ],
            }
            this.editor.commands.insertContentAt({ from: foundPos, to: foundPos + foundSize }, aiBlockNode)
            const editorEl = this.editorEl
            if (editorEl) editorEl.scrollTop = editorEl.scrollHeight
          }
        }
      },
      onError: (_jobId: JobID, err: string) => {
        console.error('AI Job Error:', JSON.stringify(job), err)
        if (this.mode === 'markdown') {
          const body = this.dataService.get(this.currentUuid)?.body || ''
          const idEscaped = blkId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          const pattern = new RegExp(`(\\[!ai\\] id="${idEscaped}"[^\\n]*)\\s*[\\s\\S]*?\\s*\\[!ai-end\\]`)
          const updatedBody = body.replace(pattern, (_, p1) =>
            p1.replace(/\s*thinking="true"/g, '') + `\n\n**Error:** ${err}\n\n[!ai-end]`
          )
          this.dataService.setBody(this.currentUuid, updatedBody)
          if (this.textarea) { this.textarea.value = updatedBody; this.updateMarkdownGutter(updatedBody) }
          this.lastSyncedBody = updatedBody
        } else if (this.editor) {
          this.editor.state.doc.descendants((node: any, _pos: number) => {
            if (node.type.name === 'aiBlock' && node.attrs.id === blkId) {
              this.editor!.commands.updateAttributes(node.type, { thinking: false })
            }
          })
        }
      },
    }

    if (type === 'explain') this.aiService.explain(job, ctx, listener)
    else this.aiService.ask(job, ctx, question || 'Ask AI...', listener)
  }

  private openAskPopup() {
    if (!this.askDialog) return
    const label = this.askDialog.querySelector('.ask-popup__label') as HTMLElement
    const textarea = this.askDialog.querySelector('.ask-popup__input') as HTMLTextAreaElement
    const doc = this.dataService.get(this.currentUuid)
    const ctx = buildAiContext(this.editor as any, this.mode === 'markdown', doc?.body || '', doc?.path || '')
    label.textContent = ctx.contextLabel + ' Inquiry'
    textarea.value = ''
    this.askDialog.showModal()
    textarea.focus()
  }

  private toggleAiBlocks() {
    this.showAiBlocks = !this.showAiBlocks
    if (this.editorEl) {
      this.editorEl.classList.toggle('hide-ai-blocks', !this.showAiBlocks)
    }
  }

  // ── Save helpers ─────────────────────────────────────────────────────────────

  private scheduleAutosave() {
    if (this.saveTimer) clearTimeout(this.saveTimer)
    const delay = this.autosaveMs || 30_000
    this.saveTimer = setTimeout(() => {
      this.dataService.save(this.currentUuid).then(() => {
        document.dispatchEvent(new CustomEvent('editor:saved', { detail: { uuid: this.currentUuid } }))
      }).catch(console.error)
    }, delay)
  }

  private flushSave() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    if (this.currentUuid) {
      this.dataService.save(this.currentUuid).catch(console.error)
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  private updateMarkdownGutter(value: string) {
    if (!this.taGutter) return
    const lines = value.split('\n')
    this.taGutter.innerHTML = ''
    for (let i = 0; i < lines.length; i++) {
      const div = document.createElement('div')
      div.textContent = String(i + 1)
      this.taGutter.appendChild(div)
    }
  }

  private dispatchStats() {
    const text = this.getMarkdown()
    const chars = text.length
    const lines = text === '' ? 0 : text.split('\n').length
    document.dispatchEvent(new CustomEvent('editor:stats', { detail: { chars, lines } }))
  }

  private updateLinkBubble() {
    if (!this.editor || !this.linkBubble) return
    if (!this.editor.isActive('link')) {
      this.linkBubble.style.display = 'none'
      return
    }
    const href = this.editor.getAttributes('link').href ?? ''
    const input = this.linkBubble.querySelector('.link-bubble__input') as HTMLInputElement
    if (input) input.value = href

    const { from } = this.editor.state.selection
    const coords = this.editor.view.coordsAtPos(from)
    this.linkBubble.style.display = 'flex'
    this.linkBubble.style.left = coords.left + 'px'
    this.linkBubble.style.top = (coords.bottom + 4) + 'px'
  }
}
