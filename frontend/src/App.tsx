import { wrapIn } from '@tiptap/pm/commands'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import { useEditor, EditorContent, BubbleMenu } from '@tiptap/react'
import StarterKit from '@tiptap/starter-kit'
import Link from '@tiptap/extension-link'
import Placeholder from '@tiptap/extension-placeholder'
import { Markdown } from 'tiptap-markdown'
import { common, createLowlight } from 'lowlight'
import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'
import { DescribeImage, DiscardBuffer, FileBuffer, FileBufferWithName, GetNotes, GetSession, GetStoreInfo, LoadBuffer, NewBuffer, RefineLanguage, RefileNote, SaveBuffer, SaveAsset, DownloadAsset, SaveSession, SaveSidebarWidth, SaveMetaWidth, SavePromptsHeight, ShowInFiles, EvaluateBuffer, LoadPrompt, SavePrompt, GetPrompts, TogglePrompts, DeletePrompt } from '../wailsjs/go/main/App'
import { stash, main } from '../wailsjs/go/models'
import { BrowserOpenURL, EventsOn } from '../wailsjs/runtime/runtime'
import { CodeBlockWithAttrs } from './extensions/CodeBlockWithAttrs'
import { ImageWithAttrs } from './extensions/ImageWithAttrs'
import { AiBlockDecoration } from './extensions/AiBlockDecoration'
import { AiBlock } from './extensions/AiBlock'
import { BlockNode } from './extensions/BlockNode'
import { detectLanguage } from './utils/pasteHeuristics'
import { TabBar } from './components/TabBar'
import { HelpModal } from './components/HelpModal'
import { Sidebar, NoteEntry, PromptEntry } from './components/Sidebar'
import { MetaPanel } from './components/MetaPanel'
import { StoreSearch } from './components/StoreSearch'
import { QuickSwitcher } from './components/QuickSwitcher'
import { TimeoutPopup } from './components/TimeoutPopup'
import { AskPopup } from './components/AskPopup'
import { TabState } from './types'
import { ConfirmModal, PromptModal } from './components/Modal'
import { ChevronUp, ChevronDown, X } from 'lucide-react'
import { Search } from './extensions/Search'
import { assetMarkdownPath, applyFilingRecToMeta, getAncestorPaths } from './lib/fmUtils'
import { EditorStats } from './components/EditorStats'
import { useNoteOperations } from './hooks/useNoteOperations'
import { useAiGestures } from './hooks/useAiGestures'
import { useBlobImageObserver } from './hooks/useBlobImageObserver'
import { useAppLifecycle } from './hooks/useAppLifecycle'
import './App.css'

const lowlight = createLowlight(common)

export default function App() {
  const [tabs, setTabs]           = useState<TabState[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const [ready, setReady]         = useState(false)
  const [rawMd, setRawMd]         = useState('')   // raw markdown for the active tab when in markdown mode
  const [linkUrl, setLinkUrl]     = useState('')
  const [showHelp, setShowHelp]   = useState(false)
  const [showSidebar, setShowSidebar] = useState(true)
  const [tier, setTier]           = useState<'dumb' | 'smart'>('dumb')
  const [sidebarWidth, setSidebarWidth]     = useState(240)
  const [isDragging, setIsDragging]         = useState(false)
  const [showMeta, setShowMeta]             = useState(false)
  const [showPrompts, setShowPrompts]       = useState(true)
  const [metaWidth, setMetaWidth]           = useState(260)
  const [promptsHeight, setPromptsHeight]   = useState(180)
  const lastSavedSessionRef = useRef<string | null>(null)
  const [isMetaDragging, setIsMetaDragging] = useState(false)
  const [showSearch, setShowSearch]         = useState(false)
  const [pendingClose, setPendingClose]     = useState(false)  // true while waiting for AI jobs before quit
  const [showQuickSwitch, setShowQuickSwitch] = useState(false)
  const [sidebarMode, setSidebarMode]       = useState<'files'|'search'>('files')
  const [confirmModal, setConfirmModal] = useState<{ title: string, message: string, onConfirm: () => void, isDestructive?: boolean } | null>(null)
  const [promptModal, setPromptModal] = useState<{ title: string, message: string, placeholder?: string, initialValue?: string, onSubmit: (val: string) => void } | null>(null)
  const [searchTerm, setSearchTerm]         = useState('')
  const [searchResults, setSearchResults]   = useState<{from: number, to: number}[]>([])
  const [searchIndex, setSearchIndex]       = useState(0)
  const [notes, setNotes]         = useState<NoteEntry[]>([])
  const [prompts, setPrompts]     = useState<PromptEntry[]>([])
  const [timeoutPopup, setTimeoutPopup] = useState<{ path: string; suggestedName: string } | null>(null)
  const [showAskPopup, setShowAskPopup] = useState(false)
  const [aiTick, setAiTick]             = useState(0)  // increments every second while AI tasks run
  // Captures the context for the pending ask — set when popup opens, read on send.
  const askContextRef = useRef<{ content: string; blockRef: string; history: string; contextLabel: string; imagePaths: string[] } | null>(null)
  const [storeInfo, setStoreInfo] = useState<{ root: string; themeName: string; } | null>(null)
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set())
  const openFoldersRef = useRef<Set<string>>(new Set())
  const autosaveMs                = useRef(30_000)  // updated from settings on mount
  const cliTimeoutLongMs          = useRef(60_000)  // updated from settings on mount (default 60s)
  const sidebarWidthRef           = useRef(240)
  const metaWidthRef              = useRef(260)
  const promptsHeightRef          = useRef(180)
  const showSidebarRef           = useRef(true)
  const showMetaRef              = useRef(false)
  const showPromptsRef           = useRef(true)
  const focusTimer                = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Caches keyed by UUID — survive tab switches without triggering re-renders
  const metaCache    = useRef<Record<string, main.DocumentMetaDTO | null>>({})  // meta DTO per uuid
  const versionsCache = useRef<Record<string, main.VersionRefDTO[]>>({})  // version list per uuid
  const mdCache      = useRef<Record<string, string>>({})  // raw markdown per uuid (when in markdown mode)
  const savedBodyCache = useRef<Record<string, string>>({}) // clean WYSIWYG body per uuid
  // UUID → path index — populated whenever a tab is loaded; used by async AI callbacks
  // to resolve a document's current file path from its permanent UUID identity.
  const uuidToPath = useRef<Map<string, string>>(new Map())
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Always-current active tab ref — avoids stale closures inside long-lived effects
  const activeTabRef = useRef<TabState | undefined>(undefined)
  const flushRef = useRef<() => void>(() => {})
  // Latest tabs/activeIdx/tier readable from async callbacks without stale-closure issues
  const tabsRef      = useRef<TabState[]>([])
  const activeIdxRef = useRef(0)
  const tierRef      = useRef<'dumb' | 'smart'>('dumb')
  // Guard: at most one AI evaluation job per UUID at a time
  const evaluatingUuids = useRef<Set<string>>(new Set())
  // Count of in-flight Explain/Ask calls (no per-UUID exclusivity needed, just close-blocking)
  const pendingAiCount  = useRef(0)
  // Timestamps (ms) when each AI task started — keyed by tab UUID
  const evalStartTimes  = useRef<Record<string, number>>({})

  useEffect(() => { showSidebarRef.current = showSidebar }, [showSidebar])
  useEffect(() => { showMetaRef.current = showMeta }, [showMeta])
  useEffect(() => { showPromptsRef.current = showPrompts }, [showPrompts])
  useEffect(() => { openFoldersRef.current = openFolders }, [openFolders])

  // Stable ref to always-current handlers — prevents stale closures in event listeners
  const H = useRef({
    newTab:     () => {},
    closeTab:   () => {},
    closeAllTabs: () => {},
    closeAllBuffers: () => {},
    flush:      () => {},
    forceFile:  () => {},
    smartSave:  () => {},
    reEval:     () => {},   // force AI re-evaluation (Ctrl+Shift+E)
    toggleMode: () => {},
    loadTab:    (_: TabState) => {},
    explain:    () => {},   // Ctrl+E — explain gesture
    ask:        () => {},   // Ctrl+Shift+A — ask gesture
    editPrompt: (name: string) => {}, // Open a prompt for editing
  })

  const activeTab      = tabs[activeIdx]
  const isMarkdownMode = activeTab?.mode === 'markdown'
  // Keep in sync every render so mutation observer / other effects never get stale tab
  activeTabRef.current = activeTab
  flushRef.current = flush
  tabsRef.current      = tabs
  activeIdxRef.current = activeIdx
  tierRef.current      = tier
  ;(window as any).__stashActiveTabPath = activeTab?.path ?? ''

  // Extract user_suggested_name from the meta cache for timeout popup pre-fill.
  function extractSuggestedName(uuid: string): string {
    return metaCache.current[uuid]?.userSuggestedName ?? ''
  }

  // Remove a tab by path using the latest tabsRef state (safe to call from async callbacks).
  function finishCloseTab(path: string) {
    const currentTabs = tabsRef.current
    const idx = currentTabs.findIndex(t => t.path === path)
    if (idx === -1) return

    const closingUuid = currentTabs[idx].uuid
    if (closingUuid) {
      delete metaCache.current[closingUuid]
      delete versionsCache.current[closingUuid]
      delete mdCache.current[closingUuid]
      delete savedBodyCache.current[closingUuid]
    }

    if (currentTabs.length === 1) {
      NewBuffer().then(dto => {
        metaCache.current[dto.uuid] = dto.meta
        savedBodyCache.current[dto.uuid] = dto.body
        const newTab: TabState = { uuid: dto.uuid, path: dto.path, scroll: 0, active: true, mode: 'wysiwyg', status: 'unfiled', userIntent: null, isEmpty: true, isModified: false, displayName: dto.meta.displayName }
        setTabs([newTab])
        setActiveIdx(0)
        H.current.loadTab(newTab)
      }).catch(console.error)
      return
    }

    const newTabs = currentTabs.filter(t => t.path !== path)
    const newIdx  = Math.min(idx, newTabs.length - 1)
    setTabs(newTabs)
    setActiveIdx(newIdx)
    if (newTabs.length > 0) {
      H.current.loadTab(newTabs[newIdx])
    }
  }

  function resurrectTab({ uuid, path, meta, body }: { uuid: string, path: string, meta: main.DocumentMetaDTO, body: string }) {
    console.warn('[stash:ai] resurrecting tab after evaluation failure', { uuid, path })
    metaCache.current[uuid] = meta
    savedBodyCache.current[uuid] = body
    
    setTabs(prev => {
      if (prev.find(t => t.uuid === uuid)) return prev
      const newTab: TabState = {
        uuid,
        path,
        scroll: 0,
        active: false,
        mode: 'wysiwyg',
        status: (meta.status as any) || 'unfiled',
        userIntent: (meta.userIntent as any) || null,
        displayName: meta.displayName,
        isEvaluating: false,
        isEmpty: body.trim().length === 0,
        isModified: false
      }
      return [...prev, newTab]
    })
  }

  // Smart-mode background evaluation for a closing tab.
  // Tab closes immediately; AI runs in background and files/discards when done.
  // forceKeep=true: always file regardless of AI vote.
  // On timeout without forceKeep: file left on disk in unfiled state (recoverable).
  function fireSmartClose(path: string, suggestedName: string, forceKeep = false) {
    console.log('[stash:ai] smartClose: closing tab immediately, eval in background', { path, forceKeep })
    // Capture UUID and content before finishCloseTab wipes the caches
    const tabUuid    = tabsRef.current.find(t => t.path === path)?.uuid ?? ''
    const savedMeta  = metaCache.current[tabUuid]
    const savedBody  = savedBodyCache.current[tabUuid] ?? ''

    // Close tab immediately — user doesn't wait
    finishCloseTab(path)

    // Background eval — no await
    ;(async () => {
      try {
        const rec = await EvaluateBuffer(path)
        const userIntent = savedMeta?.userIntent ?? null
        const shouldKeep = forceKeep || userIntent === 'keep' || (userIntent !== 'trash' && rec.keep)
        if (shouldKeep) {
          const info = await GetStoreInfo()
          const updatedMeta = applyFilingRecToMeta(savedMeta ?? {} as any, rec, info.cli)
          const dto = { uuid: tabUuid, path, slug: '', body: savedBody, meta: updatedMeta, versions: [] }
          await SaveBuffer(dto as any)
          const note = await FileBuffer(path)
          metaCache.current[tabUuid] = note.meta
          savedBodyCache.current[tabUuid] = note.body
          uuidToPath.current.set(tabUuid, note.path)
          console.log('[stash:ai] smartClose: filed', { path, newPath: note.path })
        } else {
          await DiscardBuffer(path)
          console.log('[stash:ai] smartClose: discarded', { path })
        }
      } catch(err) {
        if (forceKeep) {
          console.warn('[stash:ai] smartClose: eval timed out, filing with suggestedName', err)
          if (suggestedName) {
            FileBufferWithName(path, suggestedName).catch(console.error)
          } else {
            FileBuffer(path).catch(console.error)
          }
        } else {
          console.warn('[stash:ai] smartClose: eval timed out, restoring to tabs for next session', { path })
          setTabs(prev => {
            if (prev.some(t => t.path === path)) return prev
            const orphanTab: TabState = { uuid: '', path, scroll: 0, active: false, mode: 'wysiwyg', status: 'unfiled', userIntent: null, isEmpty: false, isModified: false }
            return [...prev, orphanTab]
          })
        }
      }
    })()
  }

  // Keep refs in sync so resize mouseup handlers read latest widths
  useEffect(() => { sidebarWidthRef.current = sidebarWidth }, [sidebarWidth])
  useEffect(() => { metaWidthRef.current = metaWidth }, [metaWidth])
  useEffect(() => { promptsHeightRef.current = promptsHeight }, [promptsHeight])

  // Suppress text selection globally while dragging either handle
  useEffect(() => {
    document.body.style.userSelect = (isDragging || isMetaDragging) ? 'none' : ''
  }, [isDragging, isMetaDragging])

  // ── Editor ─────────────────────────────────────────────────────────────────

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

        const types = Array.from(event.clipboardData.types)
        const fileCount = event.clipboardData.files.length
        const html = event.clipboardData.getData('text/html')
        const plainText = event.clipboardData.getData('text/plain')
        console.debug('[stash] handlePaste triggered', { types, fileCount, htmlLen: html.length, textLen: plainText.length })

        // 1. Image paste ─────────────────────────────────────────────────────
        const files = Array.from(event.clipboardData.files)
        const imageFile = files.find(f => f.type.startsWith('image/'))

        // Detect any <img> src in the pasted HTML (covers blob:wails://, blob:, data:, http)
        let imgSrc: string | null = null
        if (!imageFile && html) {
          const div = document.createElement('div')
          div.innerHTML = html
          const imgs = div.querySelectorAll('img')
          console.debug('[stash] paste: HTML img tags found', imgs.length, imgs.length > 0 ? imgs[0].src : '')
          if (imgs.length === 1 && imgs[0].src) {
            imgSrc = imgs[0].src
          }
        }

        if (imageFile || imgSrc) {
          console.debug('[stash] paste: intercepting as image', { isFile: !!imageFile, imgSrc })
          event.preventDefault()

          const capturedTab = activeTabRef.current  // capture at dispatch time, not in async callback
          const saveDataUrl = async (dataUrl: string, fallbackSrc?: string) => {
            const id = 'blk-' + Math.random().toString(16).substring(2, 6)
            const tab = capturedTab
            if (!tab) { console.error('[stash] paste: no active tab'); return }
            try {
              const asset = await SaveAsset(tab.path, id, dataUrl)
              const storeRelPath = asset.externalRef

              const mdPath = assetMarkdownPath(tab.path, storeRelPath)
              console.debug('[stash] paste: image saved', { id, storeRelPath, mdPath })

              queueMicrotask(() => {
                editor.commands.insertContent({
                  type: 'image',
                  attrs: { src: mdPath, id, detect: 'pending' }
                })
              })

              if (tierRef.current === 'smart') {
                const capturedId = id
                pendingAiCount.current++
                DescribeImage(storeRelPath)
                  .then((desc: stash.ImageDesc) => {
                    console.log('[stash:ai] DescribeImage: response', { id: capturedId, desc })
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
                    if (!found) console.warn('[stash:ai] DescribeImage: node not found', { id: capturedId })
                  })
                  .catch((e: unknown) => {
                    console.error('[stash:ai] DescribeImage: call failed', e)
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
              console.error('[stash] paste: save asset failed', err)
              // Fallback: insert with original src so content isn't lost
              if (fallbackSrc) {
                queueMicrotask(() => {
                  editor.commands.insertContent({ type: 'image', attrs: { src: fallbackSrc } })
                })
              }
            }
          }

          const processBlob = async (blob: Blob, fallbackSrc?: string) => {
            const reader = new FileReader()
            reader.onload = async (e) => {
              const dataUrl = e.target?.result as string
              await saveDataUrl(dataUrl, fallbackSrc)
            }
            reader.readAsDataURL(blob)
          }

          if (imageFile) {
            console.debug('[stash] paste: reading from file', imageFile.type, imageFile.size)
            processBlob(imageFile)
          } else if (imgSrc) {
            if (imgSrc.startsWith('data:')) {
              // The browser clipboard literally contained a Base64 image string!
              // Don't fetch or canvas extract it, it's ready for disk saving.
              console.debug('[stash] paste: skipping extraction for data URI')
              saveDataUrl(imgSrc, imgSrc)
            } else {
              // NEW: Use the backend to download the image directly to the stash.
              // This is much more robust than frontend fetch + data URL conversion.
              const id = 'blk-' + Math.random().toString(16).substring(2, 6)
              console.log('[stash] paste: downloading external image via backend', { id, imgSrc })
              
              DownloadAsset(capturedTab?.path ?? 'new', imgSrc, id)
                .then(asset => {
                  const storeRelPath = asset.externalRef
                  const mdPath = assetMarkdownPath(capturedTab?.path ?? 'new', storeRelPath)
                  console.debug('[stash] paste: external image downloaded', { id, storeRelPath, mdPath })
                  queueMicrotask(() => {
                    editor.commands.insertContent({
                      type: 'image',
                      attrs: { src: mdPath, id, detect: 'pending' }
                    })
                  })
                  if (tierRef.current === 'smart') {
                    const capturedId = id
                    pendingAiCount.current++
                    DescribeImage(storeRelPath)
                      .then((desc: stash.ImageDesc) => {
                        console.log('[stash:ai] DescribeImage: response', { id: capturedId, desc })
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
                        if (!found) console.warn('[stash:ai] DescribeImage: node not found', { id: capturedId })
                      })
                      .catch((e: unknown) => {
                        console.error('[stash:ai] DescribeImage: call failed', e)
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
                })
                .catch(err => {
                  console.error('[stash] paste: backend download failed', err)
                  // Fallback: Just insert the remote URL directly (will render via proxy)
                  queueMicrotask(() => {
                    editor.commands.insertContent({ type: 'image', attrs: { src: imgSrc } })
                  })
                })
            }
          }
          return true
        }

        // 2. Text paste heuristic
        const text = event.clipboardData.getData('text/plain')
        if (text && !editor.isActive('codeBlock')) {
          const result = detectLanguage(text)
          console.log('[stash] paste: heuristic result', { tier: result.tier, lang: result.language, textLen: text.length, appTier: tierRef.current })

          // Tier 4: heuristic didn't identify the language — check if the HTML
          // clipboard contains <pre>/<code> markup (e.g. copied from an IDE or
          // web page). If so, treat it as code with no language guess.
          let htmlCodeLang: string | null = null
          if (result.tier === 4 && html) {
            const div = document.createElement('div')
            div.innerHTML = html
            const hasPre  = !!div.querySelector('pre')
            const codeEl  = div.querySelector('code')
            if (hasPre || codeEl) {
              // Try to extract language from class="language-xxx" or class="lang-xxx"
              const el = codeEl ?? div.querySelector('pre')
              const langClass = Array.from(el?.classList ?? []).find(
                c => c.startsWith('language-') || c.startsWith('lang-')
              )
              htmlCodeLang = langClass
                ? langClass.replace(/^(language-|lang-)/, '')
                : ''
              console.log('[stash] paste: tier 4 — HTML has code markup, treating as code', { htmlCodeLang })
            }
          }

          const isCode = result.tier <= 3 || htmlCodeLang !== null
          if (isCode) {
            event.preventDefault()
            const id = 'blk-' + Math.random().toString(16).substring(2, 6)
            const language = result.tier <= 3 ? (result.language ?? '') : (htmlCodeLang ?? '')
            console.debug('[stash] paste: inserting as code block', { id, language, tier: result.tier })
            // Defer insertion past the current React render to avoid the
            // flushSync-during-lifecycle warning from Tiptap's ReactNodeView.
            queueMicrotask(() => editor.commands.insertContent({
              type: 'codeBlock',
              attrs: { language, id, detect: 'heuristic' },
              content: [{ type: 'text', text }]
            }))

            // Background language refinement in Smart mode — fires for all
            // code-block pastes so the CLI can confirm or correct the heuristic.
            console.log('[stash:ai] paste: tier check for refinement', { tier: tierRef.current, heuristicTier: result.tier, heuristicLang: language })
            if (tierRef.current === 'smart') {
              const capturedId   = id
              const capturedText = text
              console.log('[stash:ai] RefineLanguage: queuing background refinement', { id: capturedId, heuristic: language })
              pendingAiCount.current++
              RefineLanguage(capturedText)
                .then(lang => {
                  console.log('[stash:ai] RefineLanguage: response', { id: capturedId, lang: lang || '(empty — no change)' })
                  if (!lang || !editor) return
                  let found = false
                  editor.commands.command(({ tr, state }) => {
                    state.doc.descendants((node, pos) => {
                      if (node.type.name === 'codeBlock' && node.attrs.id === capturedId) {
                        found = true
                        if (node.attrs.detect !== 'user') {
                          tr.setNodeMarkup(pos, null, { ...node.attrs, language: lang, detect: 'ai' })
                        }
                        return false
                      }
                    })
                    return found
                  })
                  if (!found) console.warn('[stash:ai] RefineLanguage: block not found in doc', { id: capturedId })
                })
                .catch(e => console.error('[stash:ai] RefineLanguage: call failed', e))
                .finally(() => {
                  pendingAiCount.current--
                })
            } else {
              console.debug('[stash:ai] paste: skipping refinement (dumb mode)')
            }

            return true
          }
        }
        return false // Let tiptap handle naturally
      },
      handleKeyDown(view, event) {
        if (event.key === 'Tab' && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault()
          const { state } = view
          const { from, to, empty } = state.selection

          // List item: let Tiptap's ListItem extension handle Tab/Shift-Tab
          // (sinkListItem / liftListItem) — do not intercept
          if (editor?.isActive('listItem')) return false

          // Multi-line selection across prose blocks: space-indent each block
          if (!empty) {
            const tr = state.tr
            const positions: number[] = []
            state.doc.nodesBetween(from, to, (node, pos) => {
              if (node.isTextblock) positions.push(pos + 1)
            })
            if (event.shiftKey) {
              let offset = 0
              for (const pos of positions) {
                const adjustedPos = pos + offset
                const nodeText = state.doc.textBetween(adjustedPos, adjustedPos + 4)
                const spaces = nodeText.match(/^ {1,4}/)?.[0].length ?? 0
                if (spaces > 0) { tr.delete(adjustedPos, adjustedPos + spaces); offset -= spaces }
              }
            } else {
              let offset = 0
              for (const pos of positions) { tr.insertText('    ', pos + offset); offset += 4 }
            }
            view.dispatch(tr)
            return true
          }

          // Plain prose cursor: don't intercept — let the OS/browser handle focus navigation
          return false
        }
        return false
      },
    },
    onUpdate: ({ editor }) => {
      if (!ready || !activeTab || isMarkdownMode) return
      const uuid = activeTab.uuid  // permanent file identity — captured at update time
      const path = activeTab.path
      // Guard: if metaCache hasn't been populated yet, loadTab hasn't resolved — skip
      if (!metaCache.current[uuid]) return

      const body = editor.storage.markdown.getMarkdown()
      const isMod = (body !== savedBodyCache.current[uuid])
      const empty = body.trim().length === 0

      queueMicrotask(() => {
        setTabs(prev => {
          return prev.map(x => {
            if (x.path === path && (x.isModified !== isMod || x.isEmpty !== empty)) {
               return { ...x, isModified: isMod, isEmpty: empty }
            }
            return x
          })
        })
      })

      if (saveTimer.current) clearTimeout(saveTimer.current)
      saveTimer.current = setTimeout(() => {
        // uuid captured at update time — never re-read activeTab here.
        const body = editor.storage.markdown.getMarkdown()
        if (body === savedBodyCache.current[uuid]) return
        savedBodyCache.current[uuid] = body
        saveBufferSafe(uuid)
      }, autosaveMs.current)
    },
  })

  // ── Session restore ────────────────────────────────────────────────────────

  // ── Load a tab's content from disk ────────────────────────────────────────

  const loadTab = useCallback((tab: TabState) => {
    if (!editor) return

    if (tab.path.startsWith('prompt:')) {
      const name = tab.path.split(':')[1]
      LoadPrompt(name).then((content: string) => {
        const uuid = `prompt-${name}`
        setTabs(prev => prev.map(t => t.path === tab.path ? { ...t, status: 'filed', uuid: uuid, isVirtual: tab.isVirtual } : t))
        setRawMd(content)
        mdCache.current[uuid] = content
        savedBodyCache.current[uuid] = content
        metaCache.current[uuid] = null // Unblock flush()
        setActiveIdx(tabsRef.current.findIndex(t => t.path === tab.path))
      }).catch(console.error)
      return
    }

    LoadBuffer(tab.path).then(dto => {
      const { uuid: fileUuid, body, meta } = dto

      metaCache.current[fileUuid] = meta
      versionsCache.current[fileUuid] = dto.versions ?? []
      savedBodyCache.current[fileUuid] = body
      uuidToPath.current.set(fileUuid, tab.path)

      const tabMeta = {
        uuid:         fileUuid,
        status:       meta.status as TabState['status'],
        userIntent:   (meta.userIntent as TabState['userIntent']) ?? null,
        displayName:  meta.displayName || undefined,
        isEmpty:      body.trim().length === 0,
        isEvaluating: meta.aiEval === 'evaluating',
        scroll:       meta.scroll ?? 0,
        mode:         (meta.status === 'error') ? 'markdown' : tab.mode,
      }
      setTabs(prev => prev.map(t => t.path === tab.path ? { ...t, ...tabMeta } : t))
      console.debug('[stash] loadTab', { path: tab.path, mode: tabMeta.mode })

      if (tabMeta.mode === 'markdown') {
        // Markdown mode shows body only — no frontmatter in the textarea
        const cached = mdCache.current[fileUuid] ?? body
        mdCache.current[fileUuid] = cached
        setRawMd(cached)
      } else {
        queueMicrotask(() => {
          editor.commands.setContent(body)
        })
      }

      const scroll = meta.scroll ?? 0
      const applyScroll = () => {
        const el = document.getElementById('app')
        const ta = document.querySelector('.markdown-raw') as HTMLTextAreaElement
        if (tab.mode === 'markdown') {
          if (ta) ta.scrollTop = scroll
        } else {
          if (el) el.scrollTop = scroll
        }
      }

      requestAnimationFrame(() => {
        applyScroll()
        setTimeout(applyScroll, 30)
        setTimeout(applyScroll, 100)
        setTimeout(applyScroll, 250)
        setTimeout(applyScroll, 500)
      })
    }).catch(() => {
      editor.commands.setContent('')
    })
  }, [editor])

  // ── Bootstrap: Store info + Session restore ──────────────────────────────

  useEffect(() => {
    if (!editor) return

    GetStoreInfo().then(info => {
      setStoreInfo(info)
      setTier(info.tier === 1 ? 'dumb' : 'smart')
      if (info.autosaveDebounce > 0) autosaveMs.current = info.autosaveDebounce * 1000  // setting is in seconds
      if (info.cliTimeoutLong > 0) cliTimeoutLongMs.current = info.cliTimeoutLong * 1000

      if (!info.root) {
        setReady(true)
        return
      }

      GetSession().then(session => {
        if ((session as any).sidebarWidth > 0) {
          setSidebarWidth((session as any).sidebarWidth)
          sidebarWidthRef.current = (session as any).sidebarWidth
        }
        if ((session as any).metaWidth > 0) {
          setMetaWidth((session as any).metaWidth)
          metaWidthRef.current = (session as any).metaWidth
        }
        if ((session as any).promptsHeight > 0) {
          setPromptsHeight((session as any).promptsHeight)
          promptsHeightRef.current = (session as any).promptsHeight
        }
        if (session.hasOwnProperty('showSidebar')) setShowSidebar(session.showSidebar)
        if (session.hasOwnProperty('showMeta')) setShowMeta(session.showMeta)
        if (session.hasOwnProperty('showPrompts')) setShowPrompts(session.showPrompts)
        // Keep stored UUIDs — they come from frontmatter and are the document's permanent identity.
        const st = (session.tabs as TabState[])
        if (st?.length) {
          setTabs(st)
          const idx = Math.max(0, st.findIndex(t => t.active))
          setActiveIdx(idx)
          loadTab(st[idx])
        }
        if (session.openFolders) {
          setOpenFolders(new Set(session.openFolders))
        }
        setReady(true)
      })
    }).catch(console.error)

    const fetchNotes = () => GetNotes().then(res => setNotes(res || [])).catch(console.error)
    fetchNotes()

    const fetchPrompts = () => GetPrompts().then((res: stash.PromptEntry[]) => setPrompts(res || [])).catch(console.error)
    fetchPrompts()

    const unlistenNotes = EventsOn('notes:changed', () => {
      console.debug('[stash] notes:changed — refreshing sidebar')
      fetchNotes()
    })
    const unlistenPrompts = EventsOn('prompts:changed', () => {
      console.debug('[stash] prompts:changed — refreshing sidebar')
      fetchPrompts()
    })
    const unlistenShutdown = EventsOn('wails:before-close', () => {
      console.debug('[stash] emergency shutdown flush starting...')
      flush()
      return false
    })
    return () => { unlistenNotes(); unlistenPrompts(); unlistenShutdown() }
  }, [editor, loadTab])

  // Automatically expand folders to reveal the active note
  useEffect(() => {
    if (!activeTab?.path || !activeTab.path.startsWith('store/')) return
    const ancestors = getAncestorPaths(activeTab.path)
    if (ancestors.length === 0) return

    setOpenFolders(prev => {
      let changed = false
      const next = new Set(prev)
      for (const p of ancestors) {
        if (!next.has(p)) {
          next.add(p)
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [activeTab?.path])



  // Unified session persistence helper. Pulls from Refs to ensure absolute consistency
  // across all call sites (reactive saves, emergency close-saves, and backgrounds).
  const persistSession = async () => {
    const toSave = tabsRef.current.map((t, i) => ({
      path: t.path, scroll: t.scroll, active: i === activeIdxRef.current, mode: t.mode,
      displayName: t.displayName, status: t.status, userIntent: t.userIntent,
    }))
    return await SaveSession(stash.Session.createFrom({ 
      tabs: toSave,
      sidebarWidth: sidebarWidthRef.current,
      metaWidth: metaWidthRef.current,
      showSidebar: showSidebarRef.current,
      showMeta: showMetaRef.current,
      showPrompts: showPromptsRef.current,
      openFolders: Array.from(openFoldersRef.current)
    }))
  }

  // Reactive: any time tabs, layout, or sidebar folders change, persist to disk automatically.
  useEffect(() => {
    if (!ready || tabs.length === 0) return
    const toSave = tabs.map((t, i) => ({
      path: t.path, scroll: t.scroll, active: i === activeIdx, mode: t.mode,
      displayName: t.displayName, status: t.status, userIntent: t.userIntent,
    }))
    
    // De-dupe: only save if structural session data has changed.
    const openFoldersArr = Array.from(openFolders).sort()
    const sessionStr = JSON.stringify({ toSave, showSidebar, showMeta, showPrompts, sidebarWidth, metaWidth, openFolders: openFoldersArr })
    if (sessionStr === lastSavedSessionRef.current) return

    // Debounce: only save if structural session data stays stable for 1s.
    const timer = setTimeout(() => {
      lastSavedSessionRef.current = sessionStr
      persistSession().catch(console.error)
    }, 1000)

    return () => clearTimeout(timer)
  }, [tabs, activeIdx, showSidebar, showMeta, showPrompts, sidebarWidth, metaWidth, openFolders])

  // ── Safe save wrapper ─────────────────────────────────────────────────────
  // Every ambient save (autosave timer, flush, focus bump) must go through here.
  // If the path is no longer an open tab we abort rather than overwriting
  // whatever file happens to be "active" at fire time.

  // uuid is the permanent file identity (from frontmatter).
  // We resolve the current path from open tabs at call time — so renames are
  // followed automatically and we can never write to a closed or wrong document.
  function saveBufferSafe(uuid: string, options?: { force?: boolean }) {
    const tab = tabsRef.current.find(t => t.uuid === uuid)
    if (!tab) {
      console.warn('[stash] saveBufferSafe: abort — UUID not in open tabs', uuid)
      return
    }
    if (tab.path.startsWith('prompt:')) {
      const name = tab.path.split(':').pop()!
      const content = savedBodyCache.current[uuid] ?? ''
      SavePrompt(name, content).then(async () => {
         const p = await GetPrompts()
         setPrompts(p || [])
         mdCache.current[uuid] = content
         setTabs(prev => prev.map(t => t.uuid === uuid ? { ...t, isModified: false } : t))
      }).catch(console.error)
      return
    }
    const body = savedBodyCache.current[uuid] ?? ''
    const meta = metaCache.current[uuid]
    if (!meta) {
      console.warn('[stash] saveBufferSafe: no meta in cache for', uuid)
      return
    }

    // Dirty check: only save if forced or if content has actually changed from the last disk sync
    const lastSavedBody = mdCache.current[uuid]
    const isBodyDirty = body !== lastSavedBody
    if (!options?.force && !isBodyDirty && !tab.isModified) {
       return
    }
    const dto = { uuid, path: tab.path, slug: tab.path.split('/').pop()?.replace('.md','') ?? '', body, meta, versions: [] }
    SaveBuffer(dto as any).then(saved => {
      // Update cache with Store-bumped version/modified
      metaCache.current[uuid] = saved.meta
      mdCache.current[uuid] = body
      setTabs(prev => prev.map(t => t.uuid === uuid ? { ...t, isModified: false } : t))
    }).catch(console.error)
  }

  function savePromptSafe(name: string, content: string) {
    SavePrompt(name, content).then(() => {
      const uuid = `prompt-${name}`
      savedBodyCache.current[uuid] = content
      mdCache.current[uuid] = content
      setTabs(prev => prev.map(t => t.uuid === uuid ? { ...t, isModified: false } : t))
    }).catch(console.error)
  }

  // ── Flush active tab to disk immediately ───────────────────────────────────

  function flush() {
    if (!activeTab) return
    const uuid = activeTab.uuid
    // Guard: metaCache not populated yet means loadTab hasn't resolved — skip.
    if (metaCache.current[uuid] === undefined) return
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }

    const currentScrollValue = currentScroll()
    const savedScroll = metaCache.current[uuid]?.scroll ?? 0
    let scrollChanged = currentScrollValue !== savedScroll

    if (scrollChanged) {
      metaCache.current[uuid] = { ...(metaCache.current[uuid] || {}), scroll: currentScrollValue } as main.DocumentMetaDTO
    }

    if (isMarkdownMode) {
      // Markdown mode shows body only — rawMd IS the body
      const bodyChanged = rawMd !== mdCache.current[uuid]
      if (!bodyChanged && !scrollChanged) return
      savedBodyCache.current[uuid] = rawMd
      mdCache.current[uuid] = rawMd
      saveBufferSafe(uuid)
    } else {
      const body = editor?.storage.markdown.getMarkdown() ?? ''
      const bodyChanged = body !== savedBodyCache.current[uuid]
      if (!bodyChanged && !scrollChanged) return
      savedBodyCache.current[uuid] = body
      saveBufferSafe(uuid)
    }
  }

  // ── Tab operations ─────────────────────────────────────────────────────────

  function currentScroll(): number {
    const activeTabObj = tabsRef.current[activeIdxRef.current]
    if (activeTabObj?.mode === 'markdown') {
      const ta = document.querySelector('.markdown-raw') as HTMLTextAreaElement
      return ta?.scrollTop ?? 0
    }
    return document.getElementById('app')?.scrollTop ?? 0
  }

  function selectTab(idx: number) {
    if (idx === activeIdx) return
    // Snapshot scroll before switching
    const scroll = currentScroll()
    if (isMarkdownMode && activeTab) mdCache.current[activeTab.uuid] = rawMd
    flush()
    // Persist scroll into tabs state so session save captures it
    const updatedTabs = tabs.map((t, i) => i === activeIdx ? { ...t, scroll } : t)
    setTabs(updatedTabs)
    setActiveIdx(idx)
    H.current.loadTab(updatedTabs[idx])
  }

  function newTab() {
    if (!storeInfo?.root) return
    if (isMarkdownMode && activeTab) mdCache.current[activeTab.uuid] = rawMd
    flush()
    NewBuffer().then(dto => {
      metaCache.current[dto.uuid] = dto.meta
      savedBodyCache.current[dto.uuid] = dto.body
      const tab: TabState = { uuid: dto.uuid, path: dto.path, scroll: 0, active: true, mode: 'wysiwyg', status: 'unfiled', userIntent: null, isEmpty: true, isModified: false, displayName: dto.meta.displayName }
      const newIdx = tabsRef.current.length
      setTabs(prev => [...prev, tab])
      setActiveIdx(newIdx)
      H.current.loadTab(tab)
    }).catch(console.error)
  }
  function handleSelectStore() {
    // @ts-ignore
    import('../wailsjs/go/main/App').then(m => m.SelectVault()).then(path => {
      if (path) window.location.reload()
    }).catch(err => alert(err))
  }

  function handleCreateStore() {
    // @ts-ignore
    import('../wailsjs/go/main/App').then(m => m.CreateVault()).then(path => {
      if (path) window.location.reload()
    }).catch(err => alert(err))
  }


  async function closeTab(idx: number) {
    closeTabsBulk([idx])
  }

  function reorderTab(fromIdx: number, toPos: number) {
    if (fromIdx === toPos || fromIdx === toPos - 1) return
    const next = [...tabs]
    const [moved] = next.splice(fromIdx, 1)
    const insertAt = toPos > fromIdx ? toPos - 1 : toPos
    next.splice(insertAt, 0, moved)
    let newActive = activeIdx
    if (activeIdx === fromIdx) {
      newActive = insertAt
    } else {
      if (activeIdx > fromIdx) newActive -= 1
      if (newActive >= insertAt) newActive += 1
    }
    setTabs(next)
    setActiveIdx(newActive)
  }

  function setTabIntent(idx: number, intent: 'keep' | 'trash' | null) {
    const tab = tabs[idx]
    if (!tab) return
    const meta = metaCache.current[tab.uuid]
    if (meta) {
      metaCache.current[tab.uuid] = { ...meta, userIntent: intent ?? undefined }
    }
    setTabs(prev => prev.map((t, i) => i === idx ? { ...t, userIntent: intent } : t))
    // Persist to disk without bumping version — not a content edit
    saveBufferSafe(tab.uuid)
    console.debug('[stash] user_intent set', { path: tab.path, intent })
  }

  async function closeTabsBulk(indices: number[]) {
    if (indices.length === 0) return

    const sorted = [...indices].sort((a, b) => b - a)
    let finalTabs = [...tabs]
    let currentActiveIdx = activeIdx
    
    // Capture volatile state synchronously
    const capturedActivePath = activeTabRef.current?.path
    const capturedMarkdownMode = isMarkdownMode
    const capturedRawMd = rawMd

    const promises = sorted.map(async (idx) => {
        const tab = finalTabs[idx]
        const path = tab.path
        const uuid = tab.uuid

        if (tab.status !== 'filed') {
            if (tab.path === capturedActivePath) {
               flush()
            } else if (savedBodyCache.current[uuid] !== mdCache.current[uuid]) {
               // Non-active tab is dirty: flush its cache
               saveBufferSafe(uuid)
            }

            if (tab.isEmpty || tab.userIntent === 'trash' || (tab.userIntent === null && tier === 'dumb')) {
               await DiscardBuffer(path).catch(console.error)
            } else if (tier === 'smart' && tab.userIntent === null) {
               fireSmartClose(path, tab.displayName || '')
            } else if (tab.userIntent === 'keep') {
               FileBuffer(path).catch(console.error)
            }
        }
        if (uuid) {
          delete metaCache.current[uuid]
          delete mdCache.current[uuid]
          delete savedBodyCache.current[uuid]
        }
    })

    // Remove from UI immediately
    for (const idx of sorted) {
        finalTabs.splice(idx, 1)
        if (currentActiveIdx >= idx && currentActiveIdx > 0) currentActiveIdx--
    }

    if (finalTabs.length === 0) {
        const result = await NewBuffer().catch(() => null)
        if (result) {
           metaCache.current[result.uuid] = result.meta
           savedBodyCache.current[result.uuid] = result.body
           const newTab: TabState = { uuid: result.uuid, path: result.path, scroll: 0, active: true, mode: 'wysiwyg', status: 'unfiled', userIntent: null, isEmpty: true, isModified: false, displayName: result.meta.displayName }
           finalTabs = [newTab]
           currentActiveIdx = 0
           H.current.loadTab(newTab)
        }
    } else {
        if (currentActiveIdx >= finalTabs.length) currentActiveIdx = finalTabs.length - 1
        H.current.loadTab(finalTabs[currentActiveIdx])
    }
    
    setTabs(finalTabs)
    setActiveIdx(currentActiveIdx)

    await Promise.all(promises)
  }

  function closeAllTabs() {
    closeTabsBulk(tabs.map((_, i) => i))
  }

  function closeAllBuffers() {
    const bufIdxs = tabs.map((t, i) => t.status !== 'filed' ? i : -1).filter(i => i !== -1)
    closeTabsBulk(bufIdxs)
  }

  // ── Background AI evaluation ───────────────────────────────────────────────
  // Runs EvaluateBuffer off the main call-stack so the UI stays responsive.
  // fileAfter=true means move the buffer to store/ when evaluation completes.
  // Guard: at most one job per UUID — additional calls are silently dropped.

  async function runBackgroundEval(uuid: string, initialPath: string, fileAfter: boolean, allowDiscard: boolean = true) {
    if (evaluatingUuids.current.has(uuid)) {
      console.debug('[stash:ai] runBackgroundEval: already running for UUID, dropping', uuid)
      return
    }
    evaluatingUuids.current.add(uuid)
    evalStartTimes.current[uuid] = Date.now()
    setTabs(prev => prev.map(t => t.uuid === uuid ? { ...t, isEvaluating: true, aiJobName: 'Evaluating' } : t))

    // Write ai_eval:evaluating to disk so the state survives a reload
    const metaStart = metaCache.current[uuid] ?? {} as main.DocumentMetaDTO
    const evalMeta = { ...metaStart, aiEval: 'evaluating' }
    metaCache.current[uuid] = evalMeta
    const body0 = savedBodyCache.current[uuid] ?? ''
    const path0 = resolvePathByUuid(uuid) ?? initialPath
    {
      const dto = { uuid, path: path0, slug: '', body: body0, meta: evalMeta, versions: [] }
      await SaveBuffer(dto as any).catch(console.error)
    }
    setTabs(prev => prev.map(t => t.uuid === uuid ? { ...t, isEvaluating: true } : t))

    // ── Long-running AI call ──────────────────────────────────────────────────
    let rec: stash.FilingRecommendation | null = null
    try {
      rec = await EvaluateBuffer(path0)
      console.log('[stash:ai] runBackgroundEval: complete', { uuid, keep: rec?.keep, filename: rec?.filename })
    } catch(e) {
      console.error('[stash:ai] runBackgroundEval: EvaluateBuffer failed', e)
    }
    evaluatingUuids.current.delete(uuid)
    // ─────────────────────────────────────────────────────────────────────────

    const currentBody = savedBodyCache.current[uuid] ?? body0
    const currentPath = resolvePathByUuid(uuid) ?? initialPath

    // Apply results to the CURRENT meta (autosave may have updated it during eval)
    let finalMeta = metaCache.current[uuid] ?? evalMeta
    if (rec) {
      const info = await GetStoreInfo()
      finalMeta = applyFilingRecToMeta(finalMeta, rec, info.cli)
    } else {
      finalMeta = { ...finalMeta, aiEval: 'timeout' }
      // Resurrection: if we were supposed to file/discard this closed tab but AI timed out, 
      // we must bring it back so the user doesn't lose it.
      if (fileAfter) {
        resurrectTab({ uuid, path: currentPath, meta: finalMeta, body: currentBody })
        return
      }
    }
    metaCache.current[uuid] = finalMeta
    {
      const dto = { uuid, path: currentPath, slug: '', body: currentBody, meta: finalMeta, versions: [] }
      await SaveBuffer(dto as any).catch(console.error)
    }

    if (fileAfter) {
      const userIntent = finalMeta.userIntent ?? null

      if (userIntent === 'trash') {
        console.log('[stash:ai] runBackgroundEval: user_intent=trash, discarding', { uuid })
        await DiscardBuffer(currentPath)
        finishCloseTab(currentPath)
        return
      }

      const forceKeep = userIntent === 'keep'
      const aiDiscard = rec && !rec.keep

      if (aiDiscard && !forceKeep) {
        if (allowDiscard) {
          console.log('[stash:ai] runBackgroundEval: discard recommended', { uuid })
          await DiscardBuffer(currentPath)
          finishCloseTab(currentPath)
        } else {
          console.log('[stash:ai] runBackgroundEval: keep:false but discard disallowed, aborting filing', { uuid })
          setTabs(prev => prev.map(t => t.uuid === uuid ? { ...t, isEvaluating: false } : t))
        }
        return
      }
      try {
        // Route by status: already-filed notes use RefileNote (rename within Library);
        // unfiled buffers use FileBuffer (promote to Library).
        const currentStatus = finalMeta.status ?? 'unfiled'
        let note: main.BufferDTO | main.NoteDTO
        if (currentStatus === 'filed') {
          const dto = { uuid, path: currentPath, slug: '', body: currentBody, meta: finalMeta, versions: [] }
          note = await RefileNote(dto as any)
        } else {
          note = await FileBuffer(currentPath)
        }
        metaCache.current[uuid] = note.meta
        savedBodyCache.current[uuid] = note.body
        uuidToPath.current.set(uuid, note.path)

        setTabs(prev => prev.map(t => t.uuid === uuid ? {
          ...t,
          path: note.path,
          status: 'filed' as TabState['status'],
          displayName: note.meta.displayName || undefined,
          userIntent: (note.meta.userIntent as TabState['userIntent']) ?? null,
          isEmpty: note.body.trim().length === 0,
          isEvaluating: false,
        } : t))

        if (activeTab?.uuid === uuid) {
          if (isMarkdownMode) {
            setRawMd(note.body)
          } else if (editor) {
            queueMicrotask(() => { editor.commands.setContent(note.body) })
          }
        }
      } catch(e) {
        console.error('[stash:ai] runBackgroundEval: file/refile failed', e)
        // Resurrection on error
        if (fileAfter) {
           resurrectTab({ uuid, path: currentPath, meta: finalMeta, body: currentBody })
        } else {
          setTabs(prev => prev.map(t => t.uuid === uuid ? {
            ...t,
            displayName: finalMeta.displayName || undefined,
            isEvaluating: false,
          } : t))
        }
      }
    } else {
      setTabs(prev => prev.map(t => t.uuid === uuid ? {
        ...t,
        displayName: finalMeta.displayName || undefined,
        isEvaluating: false,
      } : t))
    }
  }

  // smartSave: Ctrl+S behaviour — flush content to disk.
  // AI evaluation is now only explicitly triggered via Ctrl+Shift+E or on filing.
  function smartSave() {
    if (!activeTab || activeTab.isEmpty) return
    flush()
  }

  async function forceFile(forceEval: boolean = false, skipFile: boolean = false) {
    console.log('[stash:ai] forceFile called', { path: activeTab?.path, status: activeTab?.status, isEmpty: activeTab?.isEmpty, tier, forceEval, skipFile })
    if (!activeTab || activeTab.isEmpty) {
      console.debug('[stash:ai] forceFile: early exit — no tab or empty')
      if (activeTab?.status === 'filed') flush()
      return
    }

    if (!forceEval && activeTab.status === 'filed') {
      console.debug('[stash:ai] forceFile: filed tab, flush only')
      flush()
      return
    }

    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    const path = activeTab.path
    const uuid = activeTab.uuid

    // If this is a primary filing action (Ctrl+Shift+Enter), mark intent as KEEP.
    // This makes it a "Promote" action — AI cannot quash/discard it anymore.
    if (!forceEval && !skipFile && activeTab.status === 'unfiled') {
      const meta = metaCache.current[uuid]
      if (meta) meta.userIntent = 'keep'
      setTabs(prev => prev.map(t => t.uuid === uuid ? { ...t, userIntent: 'keep' } : t))
    }
    // In markdown mode rawMd is the body; in wysiwyg get it from the editor
    const body = isMarkdownMode
      ? (mdCache.current[uuid] ?? rawMd)
      : (editor?.storage.markdown.getMarkdown() ?? '')

    const willEval = tier === 'smart' && (forceEval || activeTab.status === 'unfiled')
    if (willEval && !evaluatingUuids.current.has(uuid)) {
      setTabs(prev => prev.map(t => t.uuid === uuid ? { ...t, isEvaluating: true, aiJobName: 'Evaluating' } : t))
    }

    // Flush latest content to disk before evaluation reads it
    if (body !== savedBodyCache.current[uuid]) {
      savedBodyCache.current[uuid] = body
      if (isMarkdownMode) mdCache.current[uuid] = body
      // await so EvaluateBuffer sees the updated content
      const meta = metaCache.current[uuid]
      if (meta) {
        const dto = { uuid, path, slug: '', body, meta, versions: [] }
        await SaveBuffer(dto as any).catch(console.error)
      }
    }

    if (willEval) {
      const fileAfter = activeTab.status === 'unfiled' && !skipFile
      runBackgroundEval(uuid, path, fileAfter, /* allowDiscard */ !forceEval)
      return
    }

    if (activeTab.status === 'unfiled' && !skipFile) {
      try {
        const note = await FileBuffer(path)
        metaCache.current[uuid] = note.meta
        savedBodyCache.current[uuid] = note.body
        uuidToPath.current.set(uuid, note.path)
        setTabs(prev => prev.map(t =>
          t.path === path ? {
            ...t, path: note.path,
            status: 'filed' as TabState['status'],
            displayName: note.meta.displayName || undefined,
            userIntent: (note.meta.userIntent as TabState['userIntent']) ?? null,
          } : t
        ))
      } catch(err) {
        console.error('[stash] forceFile: FileBuffer failed', err)
      }
    }
  }

  function toggleMode() {
    if (!activeTab) return
    const uuid = activeTab.uuid
    
    // Capture cursor before toggling
    // Markdown mode shows body only — cursor position maps directly to body offset
    let cursorBodyPos = 0
    if (!isMarkdownMode) {
      if (editor) {
        const ratio = editor.state.selection.from / Math.max(1, editor.state.doc.content.size)
        const bodyContent = editor.storage.markdown.getMarkdown() || ''
        cursorBodyPos = Math.floor(ratio * bodyContent.length)
      }
    } else {
      const ta = document.querySelector('.markdown-raw') as HTMLTextAreaElement
      if (ta) cursorBodyPos = ta.selectionStart
    }

    if (isMarkdownMode) mdCache.current[uuid] = rawMd

    const oldBodyScroll = currentScroll()
    flush()

    const newMode = isMarkdownMode ? 'wysiwyg' : 'markdown'
    const newTabs = tabs.map((t, i) => i === activeIdx ? { ...t, mode: newMode as TabState['mode'] } : t)
    setTabs(newTabs)

    const applyViewScroll = () => {
      const el = document.getElementById('app')
      const ta = document.querySelector('.markdown-raw') as HTMLTextAreaElement
      if (newMode === 'markdown' && ta) {
        ta.scrollTop = oldBodyScroll
      } else if (el) {
        el.scrollTop = oldBodyScroll
      }
    }

    if (newMode === 'markdown') {
      // Switching to markdown: show body only (no frontmatter)
      const body = editor?.storage.markdown.getMarkdown() ?? ''
      mdCache.current[uuid] = body
      setRawMd(body)

      requestAnimationFrame(() => {
        const ta = document.querySelector('.markdown-raw') as HTMLTextAreaElement
        if (ta) {
          ta.setSelectionRange(cursorBodyPos, cursorBodyPos)
          ta.focus()
        }
        applyViewScroll()
        setTimeout(applyViewScroll, 30)
        setTimeout(applyViewScroll, 100)
        setTimeout(applyViewScroll, 250)
        setTimeout(applyViewScroll, 500)
      })
    } else {
      // Switching to wysiwyg: body is what was in the markdown textarea
      const body = mdCache.current[uuid] ?? rawMd
      savedBodyCache.current[uuid] = body

      requestAnimationFrame(() => {
        editor?.commands.setContent(body)
        if (editor) {
          const bodyLen = body.length
          const ratio = cursorBodyPos / Math.max(1, bodyLen)
          const pmPos = Math.min(
            editor.state.doc.content.size - 1,
            Math.max(0, Math.floor(ratio * editor.state.doc.content.size))
          )
          try { editor.commands.setTextSelection(pmPos) } catch(e) {}
          editor.commands.focus()
        }
        applyViewScroll()
        setTimeout(applyViewScroll, 30)
        setTimeout(applyViewScroll, 100)
        setTimeout(applyViewScroll, 250)
        setTimeout(applyViewScroll, 500)
      })
    }
  }

  // ── Sidebar resize ────────────────────────────────────────────────────────

  const startResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = sidebarWidthRef.current
    setIsDragging(true)

    const onMouseMove = (e: MouseEvent) => {
      const w = Math.max(160, Math.min(520, startWidth + e.clientX - startX))
      setSidebarWidth(w)
      sidebarWidthRef.current = w
    }

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      setIsDragging(false)
      SaveSidebarWidth(sidebarWidthRef.current).catch(console.error)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [])

  // ── Meta panel resize ─────────────────────────────────────────────────────

  const startMetaResize = useCallback((e: React.MouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startWidth = metaWidthRef.current
    setIsMetaDragging(true)

    const onMouseMove = (e: MouseEvent) => {
      // Dragging left increases width (handle is on the left edge of the panel)
      const w = Math.max(200, Math.min(600, startWidth - (e.clientX - startX)))
      setMetaWidth(w)
      metaWidthRef.current = w
    }

    const onMouseUp = () => {
      window.removeEventListener('mousemove', onMouseMove)
      window.removeEventListener('mouseup', onMouseUp)
      setIsMetaDragging(false)
      SaveMetaWidth(metaWidthRef.current).catch(console.error)
    }

    window.addEventListener('mousemove', onMouseMove)
    window.addEventListener('mouseup', onMouseUp)
  }, [])

  // ── Note / folder operations ──────────────────────────────────────────────

  const {
    openNote,
    handleDeleteNote,
    handleMoveNote,
    handleSmartFile,
    handleSmartMetadata,
    onEditPrompt,
    onRestorePrompt,
    handleSetIntentByPath,
    handleCreateFolder,
    handleDeleteFolder,
    handleRename,
  } = useNoteOperations({
    tabs, activeIdx, activeTab, isMarkdownMode, rawMd, tier, prompts, editor,
    tabsRef, metaCache, savedBodyCache, mdCache,
    setTabs, setActiveIdx, setNotes, setPrompts,
    setConfirmModal, setPromptModal,
    selectTab, flush,
    loadTab,
    runBackgroundEval,
    setTabIntent,
  })

  // ── AI Explain / Ask gestures ─────────────────────────────────────────────

  const {
    resolvePathByUuid,
    explainGesture,
    askGesture,
    handleAskSend,
  } = useAiGestures({
    editor, isMarkdownMode, rawMd, tier,
    activeTabRef, tabsRef, uuidToPath, metaCache, savedBodyCache,
    pendingAiCount, evalStartTimes, askContextRef,
    setTabs, setRawMd, setShowAskPopup,
  })

  // ── Keep H ref current on every render ────────────────────────────────────
  // useLayoutEffect runs synchronously after DOM commit (before paint), ensuring
  // H.current is updated before any keydown event can fire during the same frame.

  useLayoutEffect(() => {
    H.current = {
      newTab,
      closeTab:   () => closeTab(activeIdx),
      closeAllTabs,
      closeAllBuffers,
      flush,
      forceFile,
      smartSave,
      reEval:     () => forceFile(true),   // Ctrl+Shift+E — force AI re-evaluation
      toggleMode,
      loadTab: async (tab: TabState) => {
        // If we are switching to a DIFFERENT tab, flush the current one first.
        // This ensures inactive tabs always have fresh content on disk.
        if (activeTabRef.current && activeTabRef.current.path !== tab.path) {
          await flush()
        }
        loadTab(tab)
      },
      explain:    explainGesture,
      ask:        askGesture,
      editPrompt: onEditPrompt,
    }
  })

  // ── Stable keyboard listener (uses H ref) ─────────────────────────────────

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      if (e.ctrlKey && !e.shiftKey && !e.altKey && key === 'n') { e.preventDefault(); H.current.newTab() }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && key === 'w') { e.preventDefault(); H.current.closeTab() }
      if (e.ctrlKey && e.shiftKey && !e.altKey && key === 'w') { e.preventDefault(); H.current.closeAllTabs() }
      if (e.ctrlKey && e.altKey && !e.shiftKey && key === 'w') { e.preventDefault(); H.current.closeAllBuffers() }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && key === 's') { e.preventDefault(); H.current.smartSave() }
      if (e.ctrlKey && e.shiftKey && !e.altKey && e.key === 'Enter') { e.preventDefault(); H.current.forceFile() }
      if (e.ctrlKey && e.shiftKey && !e.altKey && key === 'e') { e.preventDefault(); H.current.reEval() }
      if (e.ctrlKey && e.shiftKey && !e.altKey && key === 'p') { 
        e.preventDefault(); 
        TogglePrompts().then((res: boolean) => setShowPrompts(res)).catch(console.error)
        return 
      }
      if (e.ctrlKey && e.shiftKey && !e.altKey && key === 'm') { e.preventDefault(); H.current.toggleMode() }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && key === '/') { e.preventDefault(); setShowHelp(v => !v) }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && key === 'p') { e.preventDefault(); setShowQuickSwitch(v => !v) }
      if (e.ctrlKey && e.shiftKey && !e.altKey && key === 'f') {
        e.preventDefault()
        setShowSidebar(true)
        setSidebarMode('search')
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && key === '\\') { e.preventDefault(); setShowSidebar(v => !v) }
      if (e.ctrlKey && e.shiftKey && !e.altKey && key === 'i')  { e.preventDefault(); setShowMeta(v => !v) }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && key === 'f') {
        e.preventDefault()
        setShowSearch(v => !v)
      }
      if (e.ctrlKey && !e.shiftKey && !e.altKey && key === 'e') { e.preventDefault(); H.current.explain() }
      if (e.ctrlKey && e.shiftKey && !e.altKey && key === 'a') { e.preventDefault(); H.current.ask() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  // ── Sync active tab path into ImageWithAttrs storage (for ImageNodeView display) ─
  useEffect(() => {
    if (editor && activeTab) {
      editor.storage.imageWithAttrs = editor.storage.imageWithAttrs ?? {}
      editor.storage.imageWithAttrs.activeTabPath = activeTab.path
    }
  }, [editor, activeTab])

  // ── Sync Search State ───────────────────────────────────────────────────────
  useEffect(() => {
    if (!editor) return
    const updateSearch = () => {
      const storage = editor.storage.search
      if (storage) {
        setSearchResults(storage.results || [])
        setSearchIndex(storage.currentIndex || 0)
      }
    }
    editor.on('transaction', updateSearch)
    return () => { editor.off('transaction', updateSearch) }
  }, [editor])

  useEffect(() => {
    if (editor) {
      if (!showSearch) {
        editor.commands.clearSearch()
      } else {
        editor.commands.setSearchTerm(searchTerm)
      }
    }
  }, [showSearch, searchTerm, editor])

  // ── WebKitGTK blob image paste interceptor ────────────────────────────────
  useBlobImageObserver({ editor, activeTabRef, tierRef, pendingAiCount })


  // ── App close ──────────────────────────────────────────────────────────────

  useAppLifecycle({
    activeIdx, tabs, tabsRef, activeTabRef, activeIdxRef,
    metaCache, savedBodyCache, mdCache,
    evaluatingUuids, pendingAiCount, cliTimeoutLongMs,
    flushRef, focusTimer,
    saveBufferSafe, persistSession, setPendingClose,
  })

  // ── AI status bar tick — 1s interval while any task is running ───────────────

  const hasActiveAiTasks = tabs.some(t => t.isEvaluating || t.isWaitingAI)

  useEffect(() => {
    if (!hasActiveAiTasks) return
    const id = setInterval(() => setAiTick(n => n + 1), 1000)
    return () => clearInterval(id)
  }, [hasActiveAiTasks])

  // ── Scroll position tracking ───────────────────────────────────────────────

  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const el = document.getElementById('app')
    const ta = document.querySelector('.markdown-raw')
    if (!el && !ta) return
    const onScroll = () => {
      if (scrollTimer.current) clearTimeout(scrollTimer.current)
      scrollTimer.current = setTimeout(() => {
        const scroll = currentScroll()
        setTabs(prev => prev.map((t, i) => i === activeIdxRef.current ? { ...t, scroll } : t))
      }, 250)
    }
    if (el) el.addEventListener('scroll', onScroll, { passive: true })
    if (ta) ta.addEventListener('scroll', onScroll, { passive: true })
    return () => { 
      if (el) el.removeEventListener('scroll', onScroll)
      if (ta) ta.removeEventListener('scroll', onScroll)
      if (scrollTimer.current) clearTimeout(scrollTimer.current) 
    }
  }, [activeIdx, isMarkdownMode])

  // ── Cleanup ────────────────────────────────────────────────────────────────

  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current) }, [])

  const openPaths = new Set(tabs.map(t => t.path))

  if (!ready) return <div className="loading-screen" />

  if (!storeInfo?.root) {
    return (
      <div className="bootstrap-screen">
        <div className="bootstrap-card">
          <h1>Welcome to Stash</h1>
          <p>Specify where your notes should live. Enter an absolute path to an existing folder or a new one to initialize it.</p>
          <div className="bootstrap-manual">
            <input 
              type="text" 
              placeholder="Enter absolute path (e.g. ~/Stash)" 
              id="manual-path-input"
              className="bootstrap-input"
            />
            <button className="btn btn--primary" onClick={() => {
              const el = document.getElementById('manual-path-input') as HTMLInputElement
              if (el?.value) {
                // @ts-ignore
                import('../wailsjs/go/main/App').then(m => m.InitVault(el.value)).then(() => window.location.reload()).catch(err => alert(err))
              }
            }}>Get Started</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div id="app-root" className={`theme-${storeInfo?.themeName || 'default'}`} style={{ '--sidebar-w': showSidebar ? `${sidebarWidth + 4}px` : '0px' } as React.CSSProperties}>
      {showSidebar && (
        <>
          {sidebarMode === 'files' ? (
            <Sidebar
              entries={notes}
              openPaths={openPaths}
              openFolders={openFolders}
              onToggleFolder={(path) => {
                setOpenFolders(prev => {
                  const next = new Set(prev)
                  if (next.has(path)) next.delete(path)
                  else next.add(path)
                  return next
                })
              }}
              activePath={activeTab?.path}
              onOpen={openNote}
              onShowInFiles={path => ShowInFiles(path).catch(console.error)}
              onSmartFile={handleSmartFile}
              onSmartMetadata={handleSmartMetadata}
              onDelete={handleDeleteNote}
              onMove={handleMoveNote}
              onSetIntent={handleSetIntentByPath}
              onCreateFolder={handleCreateFolder}
              onDeleteFolder={handleDeleteFolder}
              onRename={handleRename}
              width={sidebarWidth}
              showPrompts={showPrompts && tier === 'smart'}
              prompts={prompts}
              onEditPrompt={onEditPrompt}
              onRestorePrompt={onRestorePrompt}
              promptsHeight={promptsHeight}
              onPromptsResize={(h) => {
                setPromptsHeight(h)
                SavePromptsHeight(h).catch(console.error)
              }}
            />
          ) : (
            <StoreSearch
              width={sidebarWidth}
              onOpen={(p) => { openNote(p); setSidebarMode('files') }}
              onClose={() => setSidebarMode('files')}
            />
          )}
          <div
            className={`sidebar-handle${isDragging ? ' sidebar-handle--dragging' : ''}`}
            onMouseDown={startResize}
          />
        </>
      )}
      <div id="right-panel">
        <TabBar
          tabs={tabs}
          activeIdx={activeIdx}
          onSelect={selectTab}
          onClose={closeTab}
          onNew={newTab}
          onHelp={() => setShowHelp(v => !v)}
          onSetIntent={setTabIntent}
          onRename={handleRename}
          onReorder={reorderTab}
          onShowInFiles={path => ShowInFiles(path).catch(console.error)}
          onSmartFile={handleSmartFile}
          onSmartMetadata={handleSmartMetadata}
          onDelete={handleDeleteNote}
          onRestorePrompt={onRestorePrompt}
          onCloseAll={closeAllTabs}
        />
        {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
        {confirmModal && (
          <ConfirmModal
            title={confirmModal.title}
            message={confirmModal.message}
            isDestructive={confirmModal.isDestructive}
            onConfirm={confirmModal.onConfirm}
            onClose={() => setConfirmModal(null)}
          />
        )}
        {promptModal && (
          <PromptModal
            title={promptModal.title}
            message={promptModal.message}
            placeholder={promptModal.placeholder}
            initialValue={promptModal.initialValue}
            onSubmit={promptModal.onSubmit}
            onClose={() => setPromptModal(null)}
          />
        )}
        <QuickSwitcher
          isOpen={showQuickSwitch}
          onClose={() => setShowQuickSwitch(false)}
          onSelect={openNote}
          tabs={tabs}
          notesTree={notes}
        />
        <div id="editor-area">
          {showSearch && (
            <div className="search-bar">
              <input
                autoFocus
                className="search-bar__input"
                placeholder="Find in note..."
                value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Escape') setShowSearch(false)
                  if (e.key === 'Enter') {
                    if (e.shiftKey) editor?.commands.prevSearchResult()
                    else editor?.commands.nextSearchResult()
                  }
                }}
              />
              <span className="search-bar__count">
                {searchResults.length > 0 ? `${searchIndex + 1} / ${searchResults.length}` : '0 / 0'}
              </span>
              <button className="search-bar__btn" onClick={() => editor?.commands.prevSearchResult()} title="Previous (Shift+Enter)">
                <ChevronUp />
              </button>
              <button className="search-bar__btn" onClick={() => editor?.commands.nextSearchResult()} title="Next (Enter)">
                <ChevronDown />
              </button>
              <button className="search-bar__btn" style={{ marginLeft: '4px' }} onClick={() => setShowSearch(false)} title="Close (Esc)">
                <X />
              </button>
            </div>
          )}
          <div id="app" onClick={e => {
          if (!e.ctrlKey) return
          const a = (e.target as HTMLElement).closest('a')
          if (a?.href) { e.preventDefault(); BrowserOpenURL(a.href) }
        }}>
          {editor && (
            <BubbleMenu
              editor={editor}
              shouldShow={({ editor }) => !isMarkdownMode && editor.isActive('link')}
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

          {isMarkdownMode
            ? <textarea spellCheck={true} className="markdown-raw" value={rawMd} onChange={e => {
                const val = e.target.value
                setRawMd(val)
                if (activeTab) {
                  const isMod = (val !== mdCache.current[activeTab.uuid])
                  const empty = val.trim().length === 0
                  setTabs(prev => {
                    return prev.map(x => {
                      if (x.path === activeTab.path && (x.isModified !== isMod || x.isEmpty !== empty)) {
                         return { ...x, isModified: isMod, isEmpty: empty }
                      }
                      return x
                    })
                  })
                }
              }}
                        placeholder="Raw markdown — Ctrl+Shift+M to return" autoFocus />
            : <div spellCheck={true} lang="en-US" style={{ display: 'contents' }}><EditorContent editor={editor} /></div>
          }
        </div>
        {showMeta && activeTab && (
          <>
            <div
              className={`meta-handle${isMetaDragging ? ' meta-handle--dragging' : ''}`}
              onMouseDown={startMetaResize}
            />
            <MetaPanel
              meta={metaCache.current[activeTab.uuid] ?? null}
              versions={versionsCache.current[activeTab.uuid] ?? []}
              path={activeTab.path}
              width={metaWidth}
              isModified={activeTab.isModified ?? false}
              isEvaluating={activeTab.isEvaluating}
              isWaitingAI={activeTab.isWaitingAI}
              onRestoreRequested={(body) => {
                if (!activeTab) return
                const uuid = activeTab.uuid

                // 1. Cancel any pending autosave for this file
                if (saveTimer.current) {
                  clearTimeout(saveTimer.current)
                  saveTimer.current = null
                }

                // 2. Update body caches — Store handles version snapshot automatically on save
                savedBodyCache.current[uuid] = body
                if (isMarkdownMode) {
                  mdCache.current[uuid] = body
                  setRawMd(body)
                } else if (editor) {
                  editor.commands.setContent(body, false)
                }

                // 3. Save to disk (Store bumps version and saves snapshot automatically)
                saveBufferSafe(uuid)

                // 4. Clear "isModified" state immediately
                setTabs(prev => prev.map(t => t.uuid === uuid ? { ...t, isModified: false, isEmpty: body.trim().length === 0 } : t))
              }}
            />
          </>
        )}
        </div>

        {/* Status Bar */}
        <div className="status-bar">
          <div className="status-bar__left">
            {tabs.filter(t => t.isEvaluating || t.isWaitingAI).map(t => {
              const label = t.displayName || t.path.split('/').pop()?.replace(/\.md$/, '') || 'note'
              const task  = t.aiJobName || (t.isWaitingAI ? 'Thinking' : 'Evaluating')
              const secs  = evalStartTimes.current[t.uuid]
                ? Math.floor((Date.now() - evalStartTimes.current[t.uuid]) / 1000)
                : null
              void aiTick  // consumed so the component re-renders each tick
              return (
                <div key={t.uuid} className="status-bar__item">
                  <span className="status-bar__spinner" />
                  <span className="status-bar__task">{task}</span>
                  <span className="status-bar__sep">—</span>
                  <span className="status-bar__note">{label}</span>
                  {secs !== null && secs > 0 && (
                    <span className="status-bar__elapsed">{secs}s</span>
                  )}
                </div>
              )
            })}
          </div>
          <div className="status-bar__right">
            <EditorStats editor={editor} isMarkdownMode={isMarkdownMode} rawMd={rawMd} />
          </div>
        </div>
      </div>

      {showAskPopup && askContextRef.current && (
        <AskPopup
          contextLabel={askContextRef.current.contextLabel}
          onSend={handleAskSend}
          onClose={() => setShowAskPopup(false)}
        />
      )}

      {timeoutPopup && (
        <TimeoutPopup
          path={timeoutPopup.path}
          suggestedName={timeoutPopup.suggestedName}
          onAccept={async name => {
            const { path } = timeoutPopup
            setTimeoutPopup(null)
            await FileBufferWithName(path, name)
            finishCloseTab(path)
          }}
          onRetry={async () => {
            const { path, suggestedName } = timeoutPopup
            const rec = await EvaluateBuffer(path)  // throws on timeout
            setTimeoutPopup(null)
            
            // Get current content to check user_intent
            const tab = tabsRef.current.find(t => t.path === path)
            const userIntent = tab ? (metaCache.current[tab.uuid]?.userIntent ?? null) : null

            if (userIntent === 'keep' || (userIntent !== 'trash' && rec.keep)) {
              await FileBuffer(path)
            } else {
              await DiscardBuffer(path)
            }
            finishCloseTab(path)
          }}
          onDelete={() => {
            const { path } = timeoutPopup
            setTimeoutPopup(null)
            DiscardBuffer(path)
              .then(() => finishCloseTab(path))
              .catch(e => console.error('[stash] TimeoutPopup delete failed', e))
          }}
          onCancel={() => setTimeoutPopup(null)}
        />
      )}

      {/* Blocking quit dialog — shown while waiting for outstanding AI jobs to finish */}
      {pendingClose && (
        <div className="pending-close-backdrop">
          <div className="pending-close-dialog">
            <div className="ai-eval-spinner pending-close-spinner" />
            <div className="pending-close-title">Finishing AI evaluation…</div>
            <div className="pending-close-body">
              Stash is waiting for {evaluatingUuids.current.size + pendingAiCount.current} background AI job{evaluatingUuids.current.size + pendingAiCount.current !== 1 ? 's' : ''} to complete before closing.
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
