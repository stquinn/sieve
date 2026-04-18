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
import { DescribeImage, DiscardBuffer, FileBuffer, FileBufferWithName, GetNotes, GetSession, GetStoreInfo, LoadBuffer, NewBuffer, RefineLanguage, SaveBuffer, SaveBufferAsset, SaveNoteAsset, SaveSession, SaveSidebarWidth, SaveMetaWidth, SavePromptsHeight, ShowInFiles, EvaluateBuffer, Quit as AppQuit, SaveVersionSnapshot, LoadPrompt, SavePrompt, GetPrompts, TogglePrompts, DownloadImageAsset } from '../wailsjs/go/main/App'
import { stash } from '../wailsjs/go/models'
import { BrowserOpenURL, EventsOn, EventsOff, Quit } from '../wailsjs/runtime/runtime'
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
import { splitFrontmatter } from './lib/markdown'
import { assetMarkdownPath, versionFromFm, bumpFm, bumpFocusCount, parseMeta, applyFilingRec, setYamlField, getAncestorPaths } from './lib/fmUtils'
import { EditorStats } from './components/EditorStats'
import { useNoteOperations } from './hooks/useNoteOperations'
import { useAiGestures } from './hooks/useAiGestures'
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
  const fmCache  = useRef<Record<string, string>>({})  // frontmatter per uuid
  const mdCache  = useRef<Record<string, string>>({})  // raw markdown per uuid (when in markdown mode)
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

  // Extract user_suggested_name from frontmatter string for timeout popup pre-fill.
  function extractSuggestedName(fm: string): string {
    const match = fm.match(/^user_suggested_name:\s*(.+)/m)
    const val = match?.[1]?.trim()
    if (val && val !== 'null') return val
    return ''
  }

  // Remove a tab by path using the latest tabsRef state (safe to call from async callbacks).
  function finishCloseTab(path: string) {
    const currentTabs = tabsRef.current
    const idx = currentTabs.findIndex(t => t.path === path)
    if (idx === -1) return

    const closingUuid = currentTabs[idx].uuid
    if (closingUuid) {
      delete fmCache.current[closingUuid]
      delete mdCache.current[closingUuid]
      delete savedBodyCache.current[closingUuid]
    }

    if (currentTabs.length === 1) {
      NewBuffer().then(({ path: newPath, uuid }) => {
        const newTab: TabState = { uuid, path: newPath, scroll: 0, active: true, mode: 'wysiwyg', status: 'unfiled', userIntent: null, isEmpty: true, isModified: false }
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
    H.current.loadTab(newTabs[newIdx])
  }

  // Smart-mode background evaluation for a closing tab.
  // Tab closes immediately; AI runs in background and files/discards when done.
  // forceKeep=true: always file regardless of AI vote.
  // On timeout without forceKeep: file left on disk in unfiled state (recoverable).
  function fireSmartClose(path: string, suggestedName: string, forceKeep = false) {
    console.log('[stash:ai] smartClose: closing tab immediately, eval in background', { path, forceKeep })
    // Capture UUID and content before finishCloseTab wipes the caches
    const tabUuid = tabsRef.current.find(t => t.path === path)?.uuid ?? ''
    const savedFm   = fmCache.current[tabUuid] ?? ''
    const savedBody = savedBodyCache.current[tabUuid] ?? ''

    // Close tab immediately — user doesn't wait
    finishCloseTab(path)

    // Background eval — no await
    ;(async () => {
      try {
        const rec = await EvaluateBuffer(path)
        const userIntentMatch = savedFm.match(/^user_intent:\s*(keep|trash)/m)
        const userIntent = userIntentMatch ? userIntentMatch[1] : null
        
        const shouldKeep = forceKeep || userIntent === 'keep' || (userIntent !== 'trash' && rec.keep)
        if (shouldKeep) {
          const info = await GetStoreInfo()
          const fm = applyFilingRec(savedFm, rec, info.cli)
          await SaveBuffer(path, fm + savedBody)
          const result = await FileBuffer(path)
          const { newPath, content: filedContent } = result
          const { frontmatter: filedFm, body: filedBody } = splitFrontmatter(filedContent)
          
          fmCache.current[tabUuid] = filedFm
          savedBodyCache.current[tabUuid] = filedBody
          uuidToPath.current.set(tabUuid, newPath)
          
          console.log('[stash:ai] smartClose: filed', { path, newPath })
        } else {
          await DiscardBuffer(path)
          console.log('[stash:ai] smartClose: discarded', { path })
        }
      } catch(err) {
        if (forceKeep) {
          // user said keep — file with suggestedName even without AI naming
          console.warn('[stash:ai] smartClose: eval timed out, filing with suggestedName', err)
          if (suggestedName) {
            FileBufferWithName(path, suggestedName).catch(console.error)
          } else {
            FileBuffer(path).catch(console.error)
          }
        } else {
          // Timeout without explicit keep: leave file on disk as unfiled and restore to session
          // so it re-opens on next launch rather than being silently orphaned.
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
              const isBuffer = tab.status !== 'filed'
              const storeRelPath = isBuffer
                ? await SaveBufferAsset(id, dataUrl)
                : await SaveNoteAsset(tab.path, id, dataUrl)

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
              
              DownloadImageAsset(imgSrc, capturedTab?.path ?? 'new', id)
                .then((storeRelPath: string) => {
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
      // Guard: if fmCache hasn't been populated yet, loadTab hasn't resolved — skip
      if (fmCache.current[uuid] === undefined) return

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
        const fm = bumpFm(fmCache.current[uuid] ?? '')
        fmCache.current[uuid] = fm
        savedBodyCache.current[uuid] = body
        saveBufferSafe(uuid, fm + body)
        const version = versionFromFm(fm)
        SaveVersionSnapshot(uuid, version, fm + body).catch(console.error)
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
        fmCache.current[uuid] = '' 
        setTabs(prev => prev.map(t => t.path === tab.path ? { ...t, status: 'filed', uuid: uuid, isVirtual: tab.isVirtual } : t))
        setRawMd(content)
        mdCache.current[uuid] = content
        savedBodyCache.current[uuid] = content
        setActiveIdx(tabsRef.current.findIndex(t => t.path === tab.path))
      }).catch(console.error)
      return
    }

    LoadBuffer(tab.path).then(content => {
      let { frontmatter, body } = splitFrontmatter(content)

      // Ensure the file has a persistent UUID in frontmatter.
      // This UUID is the document's permanent identity — used to route async
      // AI callbacks back to the correct tab or file, surviving renames/moves.
      let fileUuid = frontmatter.match(/^uuid:\s*(\S+)/m)?.[1]?.trim() ?? ''
      if (!fileUuid) {
        fileUuid = crypto.randomUUID()
        frontmatter = setYamlField(frontmatter, 'uuid', fileUuid)
        SaveBuffer(tab.path, frontmatter + body).catch(console.error)
      }

      fmCache.current[fileUuid] = frontmatter
      uuidToPath.current.set(fileUuid, tab.path)
      const meta = parseMeta(frontmatter, body)
      setTabs(prev => prev.map(t => t.path === tab.path ? { ...t, ...meta, uuid: fileUuid } : t))
      console.debug('[stash] loadTab', { path: tab.path, mode: tab.mode, scroll: tab.scroll })

      if (tab.mode === 'markdown') {
        const cached = mdCache.current[fileUuid] ?? content
        mdCache.current[fileUuid] = cached
        setRawMd(cached)
      } else {
        queueMicrotask(() => {
          editor.commands.setContent(body)
        })
      }
      savedBodyCache.current[fileUuid] = body

      const applyScroll = () => {
        const el = document.getElementById('app')
        const ta = document.querySelector('.markdown-raw') as HTMLTextAreaElement
        let fmPixelHeight = 0
        if (tab.mode === 'markdown') {
          const fmStr = fmCache.current[fileUuid] ?? ''
          fmPixelHeight = fmStr.split('\n').length * 24.5
          if (ta) ta.scrollTop = (meta.scroll ?? 0) + fmPixelHeight
        } else {
          if (el) el.scrollTop = (meta.scroll ?? 0)
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
    return () => { unlistenNotes(); unlistenPrompts(); }
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
  function saveBufferSafe(uuid: string, content: string) {
    const tab = tabsRef.current.find(t => t.uuid === uuid)
    if (!tab) {
      console.warn('[stash] saveBufferSafe: abort — UUID not in open tabs', uuid)
      return
    }
    if (tab.path.startsWith('prompt:')) {
      const name = tab.path.split(':').pop()!
      SavePrompt(name, content).then(async () => {
         const p = await GetPrompts()
         setPrompts(p || [])
         // Clear dirty flag for the prompt tab
         setTabs(prev => prev.map(t => t.uuid === uuid ? { ...t, isModified: false } : t))
      }).catch(console.error)
      return
    }
    SaveBuffer(tab.path, content).then(() => {
      // Single authoritative point to clear 'dirty' flag on successful save
      setTabs(prev => prev.map(t => t.uuid === uuid ? { ...t, isModified: false } : t))
    }).catch(console.error)
  }

  function savePromptSafe(name: string, content: string) {
    SavePrompt(name, content).then((path: string) => {
      // Update the tab path to the real file path so it's no longer virtual
      // Wait, SPEC says prompts in sidebar always show as virtual if not on disk.
      // Actually, if it's open, we keep the "prompt:name" path for simplicity
      // and just ensure SavePrompt handles it.
      const uuid = `prompt-${name}`
      fmCache.current[uuid] = ''
      savedBodyCache.current[uuid] = content
      setTabs(prev => prev.map(t => t.uuid === uuid ? { ...t, isModified: false } : t))
    }).catch(console.error)
  }

  // ── Flush active tab to disk immediately ───────────────────────────────────

  function flush() {
    if (!activeTab) return
    const uuid = activeTab.uuid  // permanent file identity
    const path = activeTab.path
    // Guard: fmCache not populated yet means loadTab hasn't resolved — skip.
    if (fmCache.current[uuid] === undefined) return
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }

    let fm = fmCache.current[uuid] ?? ''
    const currentScrollValue = currentScroll()
    const savedScrollStr = fm.match(/^scroll:\s*(\d+)/m)?.[1]
    const savedScroll = savedScrollStr ? parseInt(savedScrollStr, 10) : 0
    let fmHasChanged = false
    
    if (currentScrollValue !== savedScroll) {
      fm = setYamlField(fm, 'scroll', currentScrollValue)
      fmCache.current[uuid] = fm
      fmHasChanged = true
    }

    if (isMarkdownMode) {
      if (rawMd === mdCache.current[uuid] && !fmHasChanged) return
      // Raw mode shows full file — save as-is, but re-sync frontmatter cache
      let { frontmatter, body } = splitFrontmatter(rawMd)
      if (frontmatter && fmHasChanged) {
        frontmatter = setYamlField(frontmatter, 'scroll', currentScrollValue)
      }
      const fullContent = frontmatter ? frontmatter + body : rawMd
      if (frontmatter) fmCache.current[uuid] = frontmatter
      saveBufferSafe(uuid, fullContent)
      mdCache.current[uuid] = fullContent
    } else {
      const body = editor?.storage.markdown.getMarkdown() ?? ''
      const bodyChanged = body !== savedBodyCache.current[uuid]
      if (!bodyChanged && !fmHasChanged) return
      
      let fmToSave = fm
      if (bodyChanged) {
        fmToSave = bumpFm(fmToSave)
      }
      fmCache.current[uuid] = fmToSave
      savedBodyCache.current[uuid] = body
      saveBufferSafe(uuid, fmToSave + body)
      if (bodyChanged) {
        const version = versionFromFm(fmToSave)
        SaveVersionSnapshot(uuid, version, fmToSave + body).catch(console.error)
      }
    }
  }

  // ── Tab operations ─────────────────────────────────────────────────────────

  function currentScroll(): number {
    const activeTabObj = tabsRef.current[activeIdxRef.current]
    if (activeTabObj?.mode === 'markdown') {
      const ta = document.querySelector('.markdown-raw') as HTMLTextAreaElement
      const unadjusted = ta?.scrollTop ?? 0
      const fmStr = fmCache.current[activeTabObj.uuid ?? ''] ?? ''
      const fmLineCount = fmStr.split('\n').length
      return Math.max(0, unadjusted - (fmLineCount * 24.5))
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
    NewBuffer().then(({ path, uuid }) => {
      const tab: TabState = { uuid, path, scroll: 0, active: true, mode: 'wysiwyg', status: 'unfiled', userIntent: null, isEmpty: true, isModified: false }
      // tabsRef.current is always current (updated every render); use it to get
      // the correct new index before the setTabs updater has a chance to run.
      const newIdx = tabsRef.current.length
      setTabs(prev => [...prev, tab])
      setActiveIdx(newIdx)
      H.current.loadTab(tab)
    }).catch(console.error)
  }
  function handleSelectStore() {
    // @ts-ignore
    import('../wailsjs/go/main/App').then(m => m.SelectStore()).then(path => {
      if (path) window.location.reload()
    }).catch(err => alert(err))
  }

  function handleCreateStore() {
    // @ts-ignore
    import('../wailsjs/go/main/App').then(m => m.CreateStore()).then(path => {
      if (path) window.location.reload()
    }).catch(err => alert(err))
  }


  async function closeTab(idx: number) {
    const tab = tabs[idx]
    const path = tab.path
    // Capture volatile state synchronously before any awaits — these could be
    // stale by the time async branches complete if the user switches tabs.
    const capturedActivePath = activeTabRef.current?.path
    const capturedMarkdownMode = isMarkdownMode
    const capturedRawMd = rawMd

    if (tab.status !== 'filed') {
      if (tab.isEmpty) {
        // Silently discard empty scratch buffers
        await DiscardBuffer(path).catch(console.error)
      } else if (tab.userIntent === 'trash' || (tab.userIntent === null && tier === 'dumb')) {
        // Trash or dumb mode default
        await DiscardBuffer(path).catch(console.error)
      } else if (tab.userIntent === 'keep') {
        // Save latest content first, then fire AI in background (always files — AI vote skipped).
        const body = (capturedMarkdownMode && tab.path === capturedActivePath)
            ? splitFrontmatter(capturedRawMd).body
            : editor?.storage.markdown.getMarkdown() ?? ''

        if (body !== savedBodyCache.current[tab.uuid]) {
            const fm = bumpFm(fmCache.current[tab.uuid] ?? '')
            fmCache.current[tab.uuid] = fm
            savedBodyCache.current[tab.uuid] = body
            await SaveBuffer(path, fm + body).catch(console.error)
            SaveVersionSnapshot(tab.uuid, versionFromFm(fm), fm + body).catch(console.error)
        }
        const suggested = extractSuggestedName(fmCache.current[tab.uuid] ?? '')
        fireSmartClose(path, suggested, true)
        return  // finishCloseTab called by fireSmartClose
      } else if (tier === 'smart') {
        // Smart mode, user_intent: null, not empty — evaluate in background then file/discard.
        const suggested = extractSuggestedName(fmCache.current[tab.uuid] ?? '')
        fireSmartClose(path, suggested)
        return  // finishCloseTab called by fireSmartClose when done
      }
    }

    if (tab.uuid) {
      delete fmCache.current[tab.uuid]
      delete mdCache.current[tab.uuid]
      delete savedBodyCache.current[tab.uuid]
    }

    if (tabs.length === 1) {
      // Always keep at least one tab — open a fresh buffer
      const result = await NewBuffer().catch(() => null)
      if (!result) return
      const newTab: TabState = { uuid: result.uuid, path: result.path, scroll: 0, active: true, mode: 'wysiwyg', status: 'unfiled', userIntent: null, isEmpty: true, isModified: false }
      setTabs([newTab])
      setActiveIdx(0)
      H.current.loadTab(newTab)
      return
    }

    const scroll = currentScroll()
    if (capturedMarkdownMode && tab.path === capturedActivePath) mdCache.current[tab.uuid] = capturedRawMd
    const withScroll = tabs.map((t, i) => i === activeIdx ? { ...t, scroll } : t)
    const newTabs = withScroll.filter((_, i) => i !== idx)
    const newIdx = Math.min(idx, newTabs.length - 1)
    setTabs(newTabs)
    setActiveIdx(newIdx)
    H.current.loadTab(newTabs[newIdx])
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
    const fm = fmCache.current[tab.uuid] ?? ''
    const updatedFm = setYamlField(fm, 'user_intent', intent)
    fmCache.current[tab.uuid] = updatedFm
    setTabs(prev => prev.map((t, i) => i === idx ? { ...t, userIntent: intent } : t))
    // Persist to disk using latest saved body (don't bump version — not a content edit)
    const body = savedBodyCache.current[tab.uuid] ?? ''
    SaveBuffer(tab.path, updatedFm + body).catch(console.error)
    console.debug('[stash] user_intent set', { path: tab.path, intent })
  }

  async function closeTabsBulk(indices: number[]) {
    if (indices.length === 0) return

    const sorted = [...indices].sort((a, b) => b - a)
    let finalTabs = [...tabs]
    let currentActiveIdx = activeIdx
    // Capture volatile state before any awaits — async map callbacks would see stale closures.
    const capturedActivePath = activeTabRef.current?.path
    const capturedMarkdownMode = isMarkdownMode
    const capturedRawMd = rawMd

    const promises = sorted.map(async (idx) => {
        const tab = finalTabs[idx]
        const path = tab.path
        if (tab.status !== 'filed') {
            if (tab.path === capturedActivePath) flush()

            if (tab.isEmpty || tab.userIntent === 'trash' || (tab.userIntent === null && tier === 'dumb')) {
               await DiscardBuffer(path).catch(console.error)
            } else if (tab.userIntent === 'keep') {
               const body = (capturedMarkdownMode && tab.path === capturedActivePath)
                  ? splitFrontmatter(capturedRawMd).body
                  : (tab.path === capturedActivePath ? editor?.storage.markdown.getMarkdown() : savedBodyCache.current[tab.uuid]) ?? ''

               if (body !== savedBodyCache.current[tab.uuid]) {
                 const fm = bumpFm(fmCache.current[tab.uuid] ?? '')
                 fmCache.current[tab.uuid] = fm
                 savedBodyCache.current[tab.uuid] = body
                 await SaveBuffer(path, fm + body).catch(console.error)
                 SaveVersionSnapshot(tab.uuid, versionFromFm(fm), fm + body).catch(console.error)
               }
               FileBuffer(path).catch(console.error)
            }
            // If Smart mode and userIntent === null, defer (leave on disk)
        }
        if (tab.uuid) {
          delete fmCache.current[tab.uuid]
          delete mdCache.current[tab.uuid]
          delete savedBodyCache.current[tab.uuid]
        }
    })
    
    await Promise.all(promises)
    
    for (const idx of sorted) {
        finalTabs.splice(idx, 1)
        if (currentActiveIdx >= idx && currentActiveIdx > 0) currentActiveIdx--
    }
    
    if (finalTabs.length === 0) {
        const result = await NewBuffer().catch(() => null)
        if (result) {
           const newTab: TabState = { uuid: result.uuid, path: result.path, scroll: 0, active: true, mode: 'wysiwyg', status: 'unfiled', userIntent: null, isEmpty: true, isModified: false }
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
    const currentFmStart = fmCache.current[uuid] ?? ''
    let evalFm = setYamlField(currentFmStart, 'ai_eval', 'evaluating')
    fmCache.current[uuid] = evalFm
    const body0 = savedBodyCache.current[uuid] ?? ''
    const path0 = resolvePathByUuid(uuid) ?? initialPath
    await SaveBuffer(path0, evalFm + body0).catch(console.error)
    setTabs(prev => prev.map(t => t.uuid === uuid ? { ...t, ...parseMeta(evalFm, body0) } : t))

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

    // Apply results to the CURRENT fm (autosave may have bumped version during eval)
    let finalFm = fmCache.current[uuid] ?? evalFm
    if (rec) {
      const info = await GetStoreInfo()
      finalFm = applyFilingRec(finalFm, rec, info.cli)
    } else {
      finalFm = setYamlField(finalFm, 'ai_eval', 'timeout')
    }
    fmCache.current[uuid] = finalFm

    // Use the freshest body available (autosave may have written newer content)
    const currentBody = savedBodyCache.current[uuid] ?? body0
    const currentPath = resolvePathByUuid(uuid) ?? initialPath

    await SaveBuffer(currentPath, finalFm + currentBody).catch(console.error)
    SaveVersionSnapshot(uuid, versionFromFm(finalFm), finalFm + currentBody).catch(console.error)

    if (fileAfter) {
      const userIntentMatch = finalFm.match(/^user_intent:\s*(keep|trash)/m)
      const userIntent = userIntentMatch ? userIntentMatch[1] : null

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
        const result = await FileBuffer(currentPath)
        const { newPath, content: filedContent } = result
        const { frontmatter: filedFm, body: filedBody } = splitFrontmatter(filedContent)
        
        fmCache.current[uuid] = filedFm
        savedBodyCache.current[uuid] = filedBody
        uuidToPath.current.set(uuid, newPath)
        
        setTabs(prev => prev.map(t => t.uuid === uuid ? {
          ...t, path: newPath, ...parseMeta(filedFm, filedBody), status: 'filed' as TabState['status'], isEvaluating: false
        } : t))

        // If this is the active tab, we MUST update the editor content to match the promoted asset paths
        if (activeTab?.uuid === uuid) {
          if (isMarkdownMode) {
            setRawMd(filedContent)
          } else if (editor) {
            queueMicrotask(() => {
              editor.commands.setContent(filedBody)
            })
          }
        }
      } catch(e) {
        console.error('[stash:ai] runBackgroundEval: FileBuffer failed', e)
        setTabs(prev => prev.map(t => t.uuid === uuid ? { ...t, ...parseMeta(finalFm, currentBody), isEvaluating: false } : t))
      }
    } else {
      setTabs(prev => prev.map(t => t.uuid === uuid ? { ...t, ...parseMeta(finalFm, currentBody), isEvaluating: false } : t))
    }
  }

  // smartSave: Ctrl+S behaviour — evaluate without filing for unfiled buffers,
  // flush only for already-filed notes. forceFile (Ctrl+Shift+Enter) still files immediately.
  function smartSave() {
    if (!activeTab || activeTab.isEmpty) return
    if (activeTab.status === 'filed') {
      flush()
      return
    }
    forceFile(false, /* skipFile */ true)
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
    const uuid = activeTab.uuid  // permanent file identity — survives renames/moves
    let fm = fmCache.current[uuid] ?? ''
    const body = isMarkdownMode
      ? splitFrontmatter(mdCache.current[uuid] ?? rawMd).body
      : (editor?.storage.markdown.getMarkdown() ?? '')

    // If we already know a background eval is coming, show the spinner immediately
    // before any await — otherwise the I/O round-trip delays the visual feedback.
    const willEval = tier === 'smart' && (forceEval || activeTab.status === 'unfiled')
    if (willEval && !evaluatingUuids.current.has(uuid)) {
      setTabs(prev => prev.map(t => t.uuid === uuid ? { ...t, isEvaluating: true, aiJobName: 'Evaluating' } : t))
    }

    // Flush latest content to disk before evaluation reads it
    let saved = false
    if (isMarkdownMode) {
      if (rawMd !== mdCache.current[uuid]) {
        const { frontmatter } = splitFrontmatter(rawMd)
        if (frontmatter) fmCache.current[uuid] = frontmatter
        await SaveBuffer(path, rawMd).catch(console.error)
        mdCache.current[uuid] = rawMd
        saved = true
      }
    } else {
      if (body !== savedBodyCache.current[uuid]) {
        fm = bumpFm(fm)
        fmCache.current[uuid] = fm
        savedBodyCache.current[uuid] = body
        await SaveBuffer(path, fm + body).catch(console.error)
        saved = true
      }
    }

    if (saved) {
      // Handled by SaveBuffer .then in saveBufferSafe
    }

    if (willEval) {
      // Hand off to background — returns immediately, spinner already visible
      const fileAfter = activeTab.status === 'unfiled' && !skipFile
      // allowDiscard: true if filing/saving unfiled, false if ad-hoc re-eval (forceEval)
      runBackgroundEval(uuid, path, fileAfter, /* allowDiscard */ !forceEval)
      return
    }

    // Dumb mode or already-filed without forceEval: just file if needed, no AI
    if (activeTab.status === 'unfiled' && !skipFile) {
      try {
        const { newPath } = await FileBuffer(path)
        const filedFm = (fmCache.current[uuid] ?? fm).replace(/^status:\s*.+/m, 'status: filed')
        fmCache.current[uuid] = filedFm
        uuidToPath.current.set(uuid, newPath)
        setTabs(prev => prev.map(t =>
          t.path === path ? { ...t, path: newPath, ...parseMeta(filedFm, body), status: 'filed' as TabState['status'] } : t
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
    let cursorMdPos = 0
    if (!isMarkdownMode) {
      if (editor) {
        const ratio = editor.state.selection.from / Math.max(1, editor.state.doc.content.size)
        const bodyContent = editor.storage.markdown.getMarkdown() || ''
        const fmLen = (fmCache.current[uuid] ?? '').length
        cursorMdPos = fmLen + Math.floor(ratio * bodyContent.length)
      }
    } else {
      const ta = document.querySelector('.markdown-raw') as HTMLTextAreaElement
      if (ta) cursorMdPos = ta.selectionStart
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
      let fmPixelHeight = 0
      if (newMode === 'markdown') {
        const fmStr = fmCache.current[uuid] ?? ''
        fmPixelHeight = fmStr.split('\n').length * 24.5
      }
      
      if (newMode === 'markdown' && ta) {
         ta.scrollTop = oldBodyScroll + fmPixelHeight
      } else if (el) {
         el.scrollTop = oldBodyScroll
      }
    }

    if (newMode === 'markdown') {
      const body = editor?.storage.markdown.getMarkdown() ?? ''
      const fm = fmCache.current[uuid] ?? ''
      const full = fm + body
      mdCache.current[uuid] = full
      setRawMd(full)
      
      requestAnimationFrame(() => {
        const ta = document.querySelector('.markdown-raw') as HTMLTextAreaElement
        if (ta) {
          ta.setSelectionRange(cursorMdPos, cursorMdPos)
          ta.focus()
        }
        applyViewScroll()
        setTimeout(applyViewScroll, 30)
        setTimeout(applyViewScroll, 100)
        setTimeout(applyViewScroll, 250)
        setTimeout(applyViewScroll, 500)
      })
    } else {
      const full = mdCache.current[uuid] ?? rawMd
      const { frontmatter, body } = splitFrontmatter(full)
      if (frontmatter) fmCache.current[uuid] = frontmatter
      savedBodyCache.current[uuid] = body
      
      requestAnimationFrame(() => {
        editor?.commands.setContent(body)
        if (editor) {
          const fmLen = (frontmatter || '').length
          const bodyLen = body.length
          const bodyOffset = Math.max(0, cursorMdPos - fmLen)
          const ratio = bodyOffset / Math.max(1, bodyLen)
          // Use Math.min to avoid exceeding doc size padding limits
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
    tabsRef, fmCache, savedBodyCache, mdCache,
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
    activeTabRef, tabsRef, uuidToPath, fmCache, savedBodyCache,
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
  // WebKitGTK's native paste inserts images directly as blob:wails:// URLs,
  // bypassing the JS clipboardData API (which arrives empty). We watch the
  // editor DOM for newly added <img> elements with blob: src and retroactively
  // save them to disk via canvas → SaveBufferAsset / SaveNoteAsset.
  // The img src stored in Tiptap is the MARKDOWN-RELATIVE path — ImageNodeView
  // resolves it to a /store/... display URL at render time.

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
            // Use ref (not closure) to always read the current active tab
            const tab = activeTabRef.current
            if (!tab) { console.error('[stash] mutation: no active tab'); return }

            try {
              // Save to buffer assets or store assets depending on tab type
              const isBuffer = tab.status !== 'filed'
              const storeRelPath = isBuffer
                ? await SaveBufferAsset(id, dataUrl)
                : await SaveNoteAsset(tab.path, id, dataUrl)

              // Compute the markdown-relative path from the tab file to the asset
              const mdPath = assetMarkdownPath(tab.path, storeRelPath)
              console.debug('[stash] mutation: image saved', { id, storeRelPath, mdPath })

              // Update Tiptap node: src = markdown path (ImageNodeView resolves /store/ for display)
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
                DescribeImage(storeRelPath)
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


  // ── App close ──────────────────────────────────────────────────────────────

  useEffect(() => {
    const unlistenClosing = EventsOn('app:closing', async () => {
      console.log('[stash] shutdown: app:closing received, flushing state...')
      
      // 1. Flush active tab (from editor state)
      await flushRef.current()

      // 2. Flush all other background tabs (from cached states)
      const otherTabs = tabsRef.current.filter(t => t.uuid !== activeTabRef.current?.uuid && !t.isVirtual)
      if (otherTabs.length > 0) {
        console.log('[stash] shutdown: flushing', otherTabs.length, 'background tab(s)...')
        await Promise.all(otherTabs.map(async (t) => {
          const uuid = t.uuid
          const body = savedBodyCache.current[uuid] ?? ''
          const fm   = fmCache.current[uuid] ?? ''
          const raw  = mdCache.current[uuid]
          
          if (raw) {
            await SaveBuffer(t.path, raw).catch(console.error)
          } else if (body || fm) {
            await SaveBuffer(t.path, fm + body).catch(console.error)
          }
        }))
      }

      const doQuit = async () => {
        await persistSession()
          .then(() => console.log('[stash] shutdown: session saved'))
          .catch(err => console.error('[stash] shutdown: save failed', err))
          .finally(() => {
            console.log('[stash] shutdown: calling backend AppQuit')
            AppQuit().catch(err => {
              console.error('[stash] shutdown: AppQuit failed, forcing runtime Quit', err)
              Quit()
            })
          })
      }

      const totalJobs = evaluatingUuids.current.size + pendingAiCount.current
      if (totalJobs === 0) {
        // No outstanding AI jobs — quit immediately
        doQuit()
        return
      }

      // Outstanding AI jobs — show blocking dialog, then quit when all done (or timeout)
      console.log('[stash] shutdown: waiting for', totalJobs, 'AI job(s)...')
      setPendingClose(true)
      const deadline = Date.now() + cliTimeoutLongMs.current
      const poll = setInterval(() => {
        const remaining = evaluatingUuids.current.size + pendingAiCount.current
        if (remaining === 0 || Date.now() >= deadline) {
          clearInterval(poll)
          setPendingClose(false)
          if (remaining > 0) {
            console.warn('[stash] shutdown: timed out waiting for AI jobs, quitting anyway')
          }
          doQuit()
        }
      }, 200)
    })

    return () => {
      EventsOff('app:closing')
    }
  }, [])

  // ── Focus count tracking ──────────────────────────────────────────────────
  // Increments focus_count at two levels:
  // 1. Visit: After tab has held focus for 30s (visit signal).
  // 2. Duration: Every 5min during continuous active focus (dwell signal).

  useEffect(() => {
    if (focusTimer.current) clearTimeout(focusTimer.current)
    const tab = tabs[activeIdx]
    if (!tab) return
    const path = tab.path
    const uuid = tab.uuid

    // Level 1: Debounced "Visit" increment (30s)
    focusTimer.current = setTimeout(() => {
      const currentTab = tabsRef.current.find(t => t.path === path)
      if (!currentTab || !currentTab.uuid) return
      
      const fm = fmCache.current[currentTab.uuid]
      if (!fm) return
      
      const newFm = bumpFocusCount(fm)
      fmCache.current[currentTab.uuid] = newFm
      const body = savedBodyCache.current[currentTab.uuid] ?? ''
      saveBufferSafe(currentTab.uuid, newFm + body)
      console.debug('[stash] focus_count: visit incremented', { path })
    }, 30 * 1000)

    // Level 2: Periodic "Dwell" increment (5min)
    const dwellInterval = setInterval(() => {
      // Re-read current tab from and refs to ensure we only increment if THIS tab is still active
      if (activeIdxRef.current !== activeIdx) return

      const currentTab = tabsRef.current[activeIdx]
      if (!currentTab || !currentTab.uuid) return
      
      const fm = fmCache.current[currentTab.uuid]
      if (!fm) return
      
      const newFm = bumpFocusCount(fm)
      fmCache.current[currentTab.uuid] = newFm
      const body = savedBodyCache.current[currentTab.uuid] ?? ''
      saveBufferSafe(currentTab.uuid, newFm + body)
      console.debug('[stash] focus_count: dwell interval incremented', { path })
    }, 5 * 60 * 1000)

    return () => { 
      if (focusTimer.current) { clearTimeout(focusTimer.current); focusTimer.current = null }
      clearInterval(dwellInterval)
    }
  }, [activeIdx])

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
                import('../wailsjs/go/main/App').then(m => m.InitStore(el.value)).then(() => window.location.reload()).catch(err => alert(err))
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
                  const body = splitFrontmatter(val).body
                  const empty = body.trim().length === 0
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
              meta={fmCache.current[activeTab.uuid] ?? ''}
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

                // 2. Compute the new state
                const currentFm = fmCache.current[uuid] ?? ''
                const finalFm = bumpFm(currentFm)
                const fullContent = finalFm + body
                const version = versionFromFm(finalFm)

                // 3. Update all caches and refs synchronously
                fmCache.current[uuid] = finalFm
                savedBodyCache.current[uuid] = body
                if (isMarkdownMode) {
                  mdCache.current[uuid] = fullContent
                  setRawMd(fullContent)
                } else if (editor) {
                  // Set content in editor - false suppresses onUpdate because we are saving manually now
                  editor.commands.setContent(body, false)
                }

                // 4. Save to disk and cut history snapshot IMMEDIATELY
                saveBufferSafe(uuid, fullContent)
                SaveVersionSnapshot(uuid, version, fullContent).catch(console.error)

                // 5. Clear "isModified" state immediately as it's now flushed
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
            const result = await FileBufferWithName(path, name)
            const { newPath } = result
            finishCloseTab(path)
          }}
          onRetry={async () => {
            const { path, suggestedName } = timeoutPopup
            const rec = await EvaluateBuffer(path)  // throws on timeout
            setTimeoutPopup(null)
            
            // Get current content to check user_intent
            const tab = tabsRef.current.find(t => t.path === path)
            const fm = (tab && fmCache.current[tab.uuid]) || ''
            const userIntentMatch = fm.match(/^user_intent:\s*(keep|trash)/m)
            const userIntent = userIntentMatch ? userIntentMatch[1] : null

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
