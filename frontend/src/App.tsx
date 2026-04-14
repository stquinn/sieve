import { DOMParser as ProseMirrorDOMParser, Fragment } from '@tiptap/pm/model'
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
import { Ask, DiscardBuffer, Explain, FileBuffer, FileBufferWithName, GetNotes, GetSession, GetVaultInfo, LoadBuffer, NewBuffer, RefineLanguage, SaveBuffer, SaveBufferAsset, SaveNoteAsset, SaveSession, SaveSidebarWidth, SaveMetaWidth, ShowInFiles, EvaluateBuffer, Quit as AppQuit, SaveVersionSnapshot, DeleteNote, MoveNote, CreateFolder, DeleteFolder, RenameFolder } from '../wailsjs/go/main/App'
import { vault } from '../wailsjs/go/models'
import { UserIntent } from './types'
import { BrowserOpenURL, EventsOn, EventsOff, Quit } from '../wailsjs/runtime/runtime'
import { CodeBlockWithAttrs } from './extensions/CodeBlockWithAttrs'
import { BlockIdMark } from './extensions/BlockIdMark'
import { ImageWithAttrs } from './extensions/ImageWithAttrs'
import { AiBlockDecoration } from './extensions/AiBlockDecoration'
import { AiBlock } from './extensions/AiBlock'
import { detectLanguage } from './utils/pasteHeuristics'
import { TabBar } from './components/TabBar'
import { HelpModal } from './components/HelpModal'
import { Sidebar, NoteEntry } from './components/Sidebar'
import { MetaPanel } from './components/MetaPanel'
import { VaultSearch } from './components/VaultSearch'
import { QuickSwitcher } from './components/QuickSwitcher'
import { TimeoutPopup } from './components/TimeoutPopup'
import { AskPopup } from './components/AskPopup'
import { TabState } from './types'
import { ConfirmModal, PromptModal } from './components/Modal'
import { ChevronUp, ChevronDown, X } from 'lucide-react'
import { Search } from './extensions/Search'
import './App.css'

const lowlight = createLowlight(common)

// Compute markdown-relative path from a tab's vault-relative path to an asset's vault-relative path.
// e.g. tabPath="dash/buffers/buf.md", assetPath="dash/buffers/assets/blk.png" → "assets/blk.png"
// e.g. tabPath="notes/note.md", assetPath="assets/blk.png" → "../assets/blk.png"
function assetMarkdownPath(tabPath: string, assetVaultPath: string): string {
  const fromDir = tabPath.split('/').slice(0, -1)
  const toParts = assetVaultPath.split('/')
  let common = 0
  while (common < fromDir.length && common < toParts.length && fromDir[common] === toParts[common]) common++
  const ups = Array(fromDir.length - common).fill('..')
  const downs = toParts.slice(common)
  return [...ups, ...downs].join('/')
}

function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const match = content.match(/^(---\n[\s\S]*?\n---\n?)/)
  if (match) return { frontmatter: match[1], body: content.slice(match[1].length) }
  return { frontmatter: '', body: content }
}

// getCleanMarkdown strips all AI blocks from the markdown string to provide
// a "pure" document context for follow-up questions.
function getCleanMarkdown(fullMd: string): string {
  const regex = /\n*\[!ai\] id="[^"]+" ref="[^"]+"[\s\S]*?\[!ai-end\]\n*/g
  return fullMd.replace(regex, '\n\n').trim()
}

function getLocalISOString(d = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

// Extract the current version number from frontmatter.
function versionFromFm(fm: string): number {
  const m = fm.match(/^version:\s*(\d+)/m)
  return m ? parseInt(m[1]) : 0
}

// Increment version and update modified timestamp in frontmatter.
// Only applied in wysiwyg mode (in markdown mode the user edits fm directly).
function bumpFm(fm: string): string {
  const now = getLocalISOString()
  const vMatch = fm.match(/^version:\s*(\d+)/m)
  const v = vMatch ? parseInt(vMatch[1]) + 1 : 1
  return fm
    .replace(/^version:\s*\d+/m, `version: ${v}`)
    .replace(/^modified:\s*.+/m, `modified: ${now}`)
}

function bumpFocusCount(fm: string): string {
  const fcMatch = fm.match(/^focus_count:\s*(\d+)/m)
  const fc = fcMatch ? parseInt(fcMatch[1]) + 1 : 1
  return fm.replace(/^focus_count:\s*\d+/m, `focus_count: ${fc}`)
}

function parseMeta(fm: string, body: string) {
  const status = (fm.match(/^status:\s*(\w+)/m)?.[1] ?? 'unfiled') as TabState['status']
  const userIntent = fm.match(/^user_intent:\s*(keep|trash)/m)?.[1] as any || null
  const isEvaluating = /^ai_eval:\s*evaluating\b/m.test(fm)
  const displayName = fm.match(/^display_name:\s*(.+)/m)?.[1]?.trim()?.replace(/^['"]|['"]$/g, '')
  if (displayName === 'null' || displayName === '') return { status, userIntent, displayName: undefined, isEmpty: body.trim().length === 0, isEvaluating }
  return { status, userIntent, displayName: displayName || undefined, isEmpty: body.trim().length === 0, isEvaluating }
}

// Update a single YAML frontmatter field in-place. Handles null, arrays, and strings.
function setYamlField(yaml: string, key: string, val: any): string {
  let strVal: string
  if (Array.isArray(val)) {
    strVal = `[${val.join(', ')}]`
  } else if (val !== null && val !== undefined && val !== '') {
    const s = String(val)
    strVal = s.includes(':') || s.includes("'") || s.includes('"') ? `"${s.replace(/"/g, '\\"')}"` : s
  } else {
    strVal = 'null'
  }
  const escapedKey = key.replace(/([.*+?^=!:${}()|\[\]\/\\])/g, '\\$1')
  const regex = new RegExp(`^${escapedKey}:\\s*.*$`, 'm')
  if (regex.test(yaml)) {
    return yaml.replace(regex, `${key}: ${strVal}`)
  } else {
    // Append before the closing marker, ensuring a leading newline
    return yaml.replace(/\n---\n?$/, `\n${key}: ${strVal}\n---\n`)
  }
}

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
  const [metaWidth, setMetaWidth]           = useState(260)
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
  const [timeoutPopup, setTimeoutPopup] = useState<{ path: string; suggestedName: string } | null>(null)
  const [showAskPopup, setShowAskPopup] = useState(false)
  // Captures the context for the pending ask — set when popup opens, read on send.
  const askContextRef = useRef<{ content: string; blockRef: string; history: string; contextLabel: string } | null>(null)
  const [vaultInfo, setVaultInfo] = useState<{ root: string; themeName: string; } | null>(null)
  const autosaveMs                = useRef(30_000)  // updated from settings on mount
  const cliTimeoutLongMs          = useRef(60_000)  // updated from settings on mount (default 60s)
  const sidebarWidthRef           = useRef(240)
  const metaWidthRef              = useRef(260)
  const showSidebarRef           = useRef(true)
  const showMetaRef              = useRef(false)
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

  useEffect(() => { showSidebarRef.current = showSidebar }, [showSidebar])
  useEffect(() => { showMetaRef.current = showMeta }, [showMeta])

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
        console.log('[stash:ai] smartClose: eval complete', { path, keep: rec.keep, forceKeep })
        const shouldKeep = forceKeep || rec.keep
        if (shouldKeep) {
          let fm = savedFm
          fm = setYamlField(fm, 'ai_eval', 'complete')
          fm = setYamlField(fm, 'ai_last_evaluated', getLocalISOString())
          if (rec.title)    fm = setYamlField(fm, 'display_name', rec.title)
          if (rec.filename) fm = setYamlField(fm, 'filename', rec.filename)
          if (rec.folder)   fm = setYamlField(fm, 'ai_folder_suggestion', rec.folder)
          if (rec.summary)  fm = setYamlField(fm, 'summary', rec.summary)
          if (rec.tags?.length) fm = setYamlField(fm, 'tags', rec.tags)
          const filename = rec.filename || suggestedName
          if (filename) fm = setYamlField(fm, 'user_suggested_name', filename)
          await SaveBuffer(path, fm + savedBody)
          await FileBuffer(path)
          console.log('[stash:ai] smartClose: filed', { path })
        } else {
          await DiscardBuffer(path)
          console.log('[stash:ai] smartClose: discarded', { path })
        }
      } catch(err) {
        if (forceKeep) {
          // user said keep — file with suggestedName even without AI naming
          console.warn('[stash:ai] smartClose: eval timed out, filing with suggestedName', err)
          const fileFn = suggestedName ? FileBufferWithName(path, suggestedName) : FileBuffer(path)
          fileFn.catch(console.error)
        } else {
          // Timeout without explicit keep: leave file on disk as unfiled and restore to session
          // so it re-opens on next launch rather than being silently orphaned.
          console.warn('[stash:ai] smartClose: eval timed out, restoring to session', { path })
          GetSession().then(session => {
            const orphanTab = { path, scroll: 0, active: false, mode: 'wysiwyg', status: 'unfiled' }
            session.tabs = [...(session.tabs ?? []), orphanTab as any]
            return SaveSession(session)
          }).catch(console.error)
        }
      }
    })()
  }

  // Keep refs in sync so resize mouseup handlers read latest widths
  useEffect(() => { sidebarWidthRef.current = sidebarWidth }, [sidebarWidth])
  useEffect(() => { metaWidthRef.current = metaWidth }, [metaWidth])

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
      BlockIdMark,
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
              const vaultRelPath = isBuffer
                ? await SaveBufferAsset(id, dataUrl)
                : await SaveNoteAsset(tab.path, id, dataUrl)

              const mdPath = assetMarkdownPath(tab.path, vaultRelPath)
              console.debug('[stash] paste: image saved', { id, vaultRelPath, mdPath })
              
              editor.commands.insertContent({
                type: 'image',
                attrs: { src: mdPath, id, detect: 'pending' }
              })
            } catch (err) {
              console.error('[stash] paste: save asset failed', err)
              // Fallback: insert with original src so content isn't lost
              if (fallbackSrc) {
                editor.commands.insertContent({ type: 'image', attrs: { src: fallbackSrc } })
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
              // First try fetch() — works for regular blob: and data: URLs
              // For blob:wails:// URLs in WebKitGTK, fetch() is blocked, so we fall back
              // to drawing the image into a canvas and extracting pixel data via toDataURL().
              const extractViaCanvas = () => new Promise<Blob>((resolve, reject) => {
                const img = new Image()
                img.onload = () => {
                  try {
                    const canvas = document.createElement('canvas')
                    canvas.width = img.naturalWidth
                    canvas.height = img.naturalHeight
                    const ctx = canvas.getContext('2d')
                    if (!ctx) { reject(new Error('no canvas context')); return }
                    ctx.drawImage(img, 0, 0)
                    canvas.toBlob(blob => {
                      if (blob) { console.debug('[stash] paste: canvas extracted blob', blob.size); resolve(blob) }
                      else reject(new Error('canvas toBlob returned null'))
                    }, 'image/png')
                  } catch (e) {
                    reject(e)
                  }
                }
                img.onerror = (e) => reject(e)
                img.src = imgSrc!
              })

              fetch(imgSrc)
                .then(r => r.blob())
                .then(blob => {
                  console.debug('[stash] paste: fetched blob from imgSrc', blob.size, blob.type)
                  return processBlob(blob, imgSrc ?? undefined)
                })
                .catch(() => {
                  console.debug('[stash] paste: fetch failed (CORS?), trying canvas extraction for', imgSrc)
                  return extractViaCanvas().then(blob => processBlob(blob, imgSrc ?? undefined))
                })
                .catch(err => {
                  console.error('[stash] paste: all image extraction methods failed', imgSrc, err)
                  // Fallback: Just insert the remote URL directly if we can't download it
                  editor.commands.insertContent({ type: 'image', attrs: { src: imgSrc } })
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
                          tr.setNodeMarkup(pos, null, { ...node.attrs, language: lang, detect: 'cli' })
                        } else {
                          console.debug('[stash:ai] RefineLanguage: detect=user, skipping', { id: capturedId })
                        }
                        return false
                      }
                    })
                    return found
                  })
                  if (!found) console.warn('[stash:ai] RefineLanguage: block not found in doc', { id: capturedId })
                })
                .catch(e => console.error('[stash:ai] RefineLanguage: call failed', e))
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
          event.stopPropagation()
          const { state } = view
          const { from, to, empty } = state.selection

          if (empty) {
            if (!event.shiftKey) {
              view.dispatch(state.tr.insertText('    '))
              return true
            }
            // Shift+Tab with no selection: dedent current line
            const blockStart = state.selection.$from.start()
            const lineText = state.doc.textBetween(blockStart, blockStart + 4)
            const spaces = lineText.match(/^ {1,4}/)?.[0].length ?? 0
            if (spaces > 0) view.dispatch(state.tr.delete(blockStart, blockStart + spaces))
            return true
          }

          // Multi-line: indent or dedent each block in the selection
          const tr = state.tr
          const positions: number[] = []
          state.doc.nodesBetween(from, to, (node, pos) => {
            if (node.isTextblock) positions.push(pos + 1)
          })

          if (event.shiftKey) {
            // Dedent: remove up to 4 leading spaces from each block
            let offset = 0
            for (const pos of positions) {
              const adjustedPos = pos + offset
              const nodeText = state.doc.textBetween(adjustedPos, adjustedPos + 4)
              const spaces = nodeText.match(/^ {1,4}/)?.[0].length ?? 0
              if (spaces > 0) {
                tr.delete(adjustedPos, adjustedPos + spaces)
                offset -= spaces
              }
            }
          } else {
            // Indent: prepend 4 spaces to each block
            let offset = 0
            for (const pos of positions) {
              tr.insertText('    ', pos + offset)
              offset += 4
            }
          }

          view.dispatch(tr)
          return true
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
      setTabs(prev => {
        return prev.map(x => {
          if (x.path === path && (x.isModified !== isMod || x.isEmpty !== empty)) {
             return { ...x, isModified: isMod, isEmpty: empty }
          }
          return x
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
        editor.commands.setContent(body)
      }
      savedBodyCache.current[fileUuid] = body

      requestAnimationFrame(() => {
        const el = document.getElementById('app')
        if (el) el.scrollTop = tab.scroll ?? 0
      })
    }).catch(() => {
      editor.commands.setContent('')
    })
  }, [editor])

  // ── Bootstrap: Vault info + Session restore ──────────────────────────────

  useEffect(() => {
    if (!editor) return

    GetVaultInfo().then(info => {
      setVaultInfo(info)
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
        if (session.hasOwnProperty('showSidebar')) setShowSidebar(session.showSidebar)
        if (session.hasOwnProperty('showMeta')) setShowMeta(session.showMeta)
        // Keep stored UUIDs — they come from frontmatter and are the document's permanent identity.
        const st = (session.tabs as TabState[])
        if (st?.length) {
          setTabs(st)
          const idx = Math.max(0, st.findIndex(t => t.active))
          setActiveIdx(idx)
          loadTab(st[idx])
        }
        setReady(true)
      })
    }).catch(console.error)

    const fetchNotes = () => GetNotes().then(res => setNotes(res || [])).catch(console.error)
    fetchNotes()

    const unlisten = EventsOn('notes:changed', () => {
      console.debug('[stash] notes:changed — refreshing sidebar')
      fetchNotes()
    })
    return unlisten
  }, [editor, loadTab])



  // ── Session save ───────────────────────────────────────────────────────────
  // Reactive: any time tabs or activeIdx changes, persist to disk automatically.

  useEffect(() => {
    if (!ready || tabs.length === 0) return
    const toSave = tabs.map((t, i) => ({
      path: t.path, scroll: t.scroll, active: i === activeIdx, mode: t.mode,
      displayName: t.displayName, status: t.status, userIntent: t.userIntent,
    }))
    
    // De-dupe: only save if structural session data has changed.
    // This avoids saving on every keystroke (which only flips the 'isModified' flag).
    const sessionStr = JSON.stringify({ toSave, showSidebar, showMeta, sidebarWidth, metaWidth })
    if (sessionStr === lastSavedSessionRef.current) return

    // Debounce: only save if structural session data stays stable for 1s.
    // Prevents disk pounding during rapid scrolling or UI toggles.
    const timer = setTimeout(() => {
      lastSavedSessionRef.current = sessionStr
      SaveSession(vault.Session.createFrom({ 
        tabs: toSave,
        sidebarWidth,
        metaWidth,
        showSidebar,
        showMeta
      })).catch(console.error)
    }, 1000)

    return () => clearTimeout(timer)
  }, [tabs, activeIdx, showSidebar, showMeta, sidebarWidth, metaWidth])

  // Called from close handler where we need to save synchronously from refs
  // (React state may not have flushed yet at that point).
  const saveSessionFromRefs = async () => {
    const toSave = tabsRef.current.map((t, i) => ({
      path: t.path, scroll: t.scroll, active: i === activeIdxRef.current, mode: t.mode,
      displayName: t.displayName, status: t.status, userIntent: t.userIntent,
    }))
    return await SaveSession(vault.Session.createFrom({ 
      tabs: toSave,
      sidebarWidth: sidebarWidthRef.current,
      metaWidth: metaWidthRef.current,
      showSidebar: showSidebarRef.current,
      showMeta: showMetaRef.current
    }))
  }

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
    SaveBuffer(tab.path, content).catch(console.error)
  }

  // ── Flush active tab to disk immediately ───────────────────────────────────

  function flush() {
    if (!activeTab) return
    const uuid = activeTab.uuid  // permanent file identity
    const path = activeTab.path
    // Guard: fmCache not populated yet means loadTab hasn't resolved — skip.
    if (fmCache.current[uuid] === undefined) return
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    if (isMarkdownMode) {
      if (rawMd === mdCache.current[uuid]) return
      // Raw mode shows full file — save as-is, but re-sync frontmatter cache
      const { frontmatter } = splitFrontmatter(rawMd)
      if (frontmatter) fmCache.current[uuid] = frontmatter
      saveBufferSafe(uuid, rawMd)
      mdCache.current[uuid] = rawMd
      setTabs(prev => prev.map(t => t.path === path ? { ...t, isModified: false } : t))
    } else {
      const body = editor?.storage.markdown.getMarkdown() ?? ''
      if (body === savedBodyCache.current[uuid]) return
      const fm = bumpFm(fmCache.current[uuid] ?? '')
      fmCache.current[uuid] = fm
      savedBodyCache.current[uuid] = body
      saveBufferSafe(uuid, fm + body)
      setTabs(prev => prev.map(t => t.path === path ? { ...t, isModified: false } : t))
      const version = versionFromFm(fm)
      SaveVersionSnapshot(uuid, version, fm + body).catch(console.error)
    }
  }

  // ── Tab operations ─────────────────────────────────────────────────────────

  function currentScroll(): number {
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
    if (!vaultInfo?.root) return
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
  function handleSelectVault() {
    // @ts-ignore
    import('../wailsjs/go/main/App').then(m => m.SelectVault()).then(path => {
      if (path) window.location.reload()
    }).catch(err => alert(err))
  }

  function handleCreateVault() {
    // @ts-ignore
    import('../wailsjs/go/main/App').then(m => m.CreateVault()).then(path => {
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
               await FileBuffer(path).catch(console.error)
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
  // fileAfter=true means move the buffer to notes/ when evaluation completes.
  // Guard: at most one job per UUID — additional calls are silently dropped.

  async function runBackgroundEval(uuid: string, initialPath: string, fileAfter: boolean) {
    if (evaluatingUuids.current.has(uuid)) {
      console.debug('[stash:ai] runBackgroundEval: already running for UUID, dropping', uuid)
      return
    }
    evaluatingUuids.current.add(uuid)
    setTabs(prev => prev.map(t => t.uuid === uuid ? { ...t, isEvaluating: true } : t))

    // Write ai_eval:evaluating to disk so the state survives a reload
    const currentFmStart = fmCache.current[uuid] ?? ''
    let evalFm = setYamlField(currentFmStart, 'ai_eval', 'evaluating')
    fmCache.current[uuid] = evalFm
    const body0 = savedBodyCache.current[uuid] ?? ''
    const path0 = resolvePathByUuid(uuid) ?? initialPath
    await SaveBuffer(path0, evalFm + body0).catch(console.error)
    setTabs(prev => prev.map(t => t.uuid === uuid ? { ...t, ...parseMeta(evalFm, body0) } : t))

    // ── Long-running AI call ──────────────────────────────────────────────────
    let rec: { keep: boolean; title: string; filename: string; folder: string; summary: string; tags: string[] } | null = null
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
      finalFm = setYamlField(finalFm, 'ai_eval', 'complete')
      finalFm = setYamlField(finalFm, 'ai_last_evaluated', getLocalISOString())
      const info = await GetVaultInfo()
      finalFm = setYamlField(finalFm, 'cli', info.cli)
      if (rec.title)    finalFm = setYamlField(finalFm, 'display_name', rec.title)
      if (rec.filename) finalFm = setYamlField(finalFm, 'filename', rec.filename)
      if (rec.folder)   finalFm = setYamlField(finalFm, 'ai_folder_suggestion', rec.folder)
      if (rec.summary)  finalFm = setYamlField(finalFm, 'summary', rec.summary)
      if (rec.tags && rec.tags.length > 0) finalFm = setYamlField(finalFm, 'tags', rec.tags)
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
      try {
        const newPath = await FileBuffer(currentPath)
        const filedFm = finalFm.replace(/^status:\s*.+/m, 'status: filed')
        fmCache.current[uuid] = filedFm
        uuidToPath.current.set(uuid, newPath)
        setTabs(prev => prev.map(t => t.uuid === uuid ? {
          ...t, path: newPath, ...parseMeta(filedFm, currentBody), status: 'filed' as TabState['status'], isEvaluating: false
        } : t))
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

    // Flush latest content to disk before evaluation reads it
    if (isMarkdownMode) {
      if (rawMd !== mdCache.current[uuid]) {
        const { frontmatter } = splitFrontmatter(rawMd)
        if (frontmatter) fmCache.current[uuid] = frontmatter
        await SaveBuffer(path, rawMd).catch(console.error)
        mdCache.current[uuid] = rawMd
      }
    } else {
      if (body !== savedBodyCache.current[uuid]) {
        fm = bumpFm(fm)
        fmCache.current[uuid] = fm
        savedBodyCache.current[uuid] = body
        await SaveBuffer(path, fm + body).catch(console.error)
      }
    }

    if (tier === 'smart' && (forceEval || activeTab.status === 'unfiled')) {
      // Hand off to background — returns immediately, tab shows spinner
      const fileAfter = activeTab.status === 'unfiled' && !skipFile
      runBackgroundEval(uuid, path, fileAfter)
      return
    }

    // Dumb mode or already-filed without forceEval: just file if needed, no AI
    if (activeTab.status === 'unfiled' && !skipFile) {
      try {
        const newPath = await FileBuffer(path)
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
    if (isMarkdownMode) mdCache.current[uuid] = rawMd
    flush()

    const newMode = isMarkdownMode ? 'wysiwyg' : 'markdown'
    const newTabs = tabs.map((t, i) => i === activeIdx ? { ...t, mode: newMode as TabState['mode'] } : t)
    setTabs(newTabs)

    if (newMode === 'markdown') {
      // Show full file: frontmatter + body
      const body = editor?.storage.markdown.getMarkdown() ?? ''
      const fm = fmCache.current[uuid] ?? ''
      const full = fm + body
      mdCache.current[uuid] = full
      setRawMd(full)
    } else {
      // Strip frontmatter before feeding back to editor.
      // Fall back to rawMd (current textarea) if mdCache somehow wasn't populated.
      const full = mdCache.current[uuid] ?? rawMd
      const { frontmatter, body } = splitFrontmatter(full)
      if (frontmatter) fmCache.current[uuid] = frontmatter
      savedBodyCache.current[uuid] = body
      // EditorContent is not in the DOM yet — it only mounts after setTabs triggers
      // a re-render. Defer setContent until the next frame so the view exists.
      requestAnimationFrame(() => {
        editor?.commands.setContent(body)
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

  // ── Open a note from the sidebar ──────────────────────────────────────────

  function openNote(path: string) {
    // If already open, focus that tab
    const existingIdx = tabs.findIndex(t => t.path === path)
    if (existingIdx !== -1) {
      selectTab(existingIdx)
      return
    }
    // Otherwise open a new tab
    if (isMarkdownMode && activeTab) mdCache.current[activeTab.uuid] = rawMd
    flush()
    const tab: TabState = { uuid: '', path, scroll: 0, active: true, mode: 'wysiwyg', status: 'filed', userIntent: null, isEmpty: false, isModified: false }
    const newTabs = [...tabs, tab]
    const newIdx = newTabs.length - 1
    setTabs(newTabs)
    setActiveIdx(newIdx)
    H.current.loadTab(tab)
  }

  async function handleDeleteNote(path: string) {
    setConfirmModal({
      title: 'Delete Note',
      message: `Are you sure you want to delete "${path.split('/').pop()}"? This will also remove its version history.`,
      isDestructive: true,
      onConfirm: async () => {
        setConfirmModal(null)
        try {
          await DeleteNote(path)
          // Close tab if open
          const idx = tabs.findIndex(t => t.path === path)
          if (idx !== -1) {
            setTabs(prev => prev.filter((_, i) => i !== idx))
            if (activeIdx >= idx) {
              setActiveIdx(Math.max(0, activeIdx - 1))
            }
          }
          await GetNotes().then(res => setNotes(res || [])).catch(console.error)
        } catch (err) {
          console.error('Failed to delete note', err)
          alert(`Failed to delete note: ${err}`)
        }
      }
    })
  }

  async function handleMoveNote(oldPath: string, newPath: string) {
    try {
      await MoveNote(oldPath, newPath)
      // Update tabs if open
      setTabs(prev => prev.map(t => t.path === oldPath ? { ...t, path: newPath } : t))
      // Refetch notes
      await GetNotes().then(res => setNotes(res || [])).catch(console.error)
    } catch (err) {
      console.error('Failed to move note', err)
      alert(`Failed to move note: ${err}`)
    }
  }

  async function handleSmartFile(path: string) {
    if (tier !== 'smart') return
    console.log('[stash:ai] Smart File: start', { path })
    const tabIdx = tabs.findIndex(t => t.path === path)
    if (tabIdx !== -1) {
      setTabs(prev => prev.map((t, i) => i === tabIdx ? { ...t, isEvaluating: true } : t))
    }

    try {
      console.log('[stash:ai] Smart File: evaluating...')
      const rec = await EvaluateBuffer(path)
      const content = await LoadBuffer(path)
      let { frontmatter, body } = splitFrontmatter(content)
      const tabUuid = tabsRef.current.find(t => t.path === path)?.uuid ?? ''

      frontmatter = setYamlField(frontmatter, 'ai_eval', 'complete')
      frontmatter = setYamlField(frontmatter, 'ai_last_evaluated', getLocalISOString())
      if (rec.title)    frontmatter = setYamlField(frontmatter, 'display_name', rec.title)
      if (rec.filename) frontmatter = setYamlField(frontmatter, 'filename', rec.filename)
      if (rec.folder)   frontmatter = setYamlField(frontmatter, 'ai_folder_suggestion', rec.folder)
      if (rec.summary)  frontmatter = setYamlField(frontmatter, 'summary', rec.summary)
      if (rec.tags && rec.tags.length > 0) frontmatter = setYamlField(frontmatter, 'tags', rec.tags)

      console.log('[stash:ai] Smart File: saving updated meta', { folder: rec.folder })
      await SaveBuffer(path, frontmatter + body)
      if (tabUuid) fmCache.current[tabUuid] = frontmatter

      console.log('[stash:ai] Smart File: calling backend FileBuffer')
      const newPath = await FileBuffer(path)
      console.log('[stash:ai] Smart File: result', { newPath })

      if (tabUuid) {
        uuidToPath.current.set(tabUuid, newPath)
      }

      setTabs(prev => prev.map(t =>
        t.path === path ? { 
          ...t, 
          path: newPath, 
          ...parseMeta(frontmatter, body),
          isEvaluating: false 
        } : t
      ))
      await GetNotes().then(res => setNotes(res || [])).catch(console.error)
    } catch (e) {
      console.error('[stash:ai] Smart File failed', e)
      alert(`Smart File failed: ${e}`)
      if (tabIdx !== -1) {
        setTabs(prev => prev.map((t, i) => i === tabIdx ? { ...t, isEvaluating: false } : t))
      }
    }
  }

  async function handleSmartMetadata(path: string) {
    if (tier !== 'smart') return
    const tabIdx = tabs.findIndex(t => t.path === path)
    if (tabIdx !== -1) {
      setTabs(prev => prev.map((t, i) => i === tabIdx ? { ...t, isEvaluating: true } : t))
    }

    try {
      console.log('[stash:ai] Smart Metadata: evaluating', { path })
      const rec = await EvaluateBuffer(path)
      const content = await LoadBuffer(path)
      let { frontmatter, body } = splitFrontmatter(content)
      
      frontmatter = setYamlField(frontmatter, 'ai_eval', 'complete')
      frontmatter = setYamlField(frontmatter, 'ai_last_evaluated', getLocalISOString())
      if (rec.title)    frontmatter = setYamlField(frontmatter, 'display_name', rec.title)
      if (rec.filename) frontmatter = setYamlField(frontmatter, 'filename', rec.filename)
      if (rec.folder)   frontmatter = setYamlField(frontmatter, 'ai_folder_suggestion', rec.folder)
      if (rec.summary)  frontmatter = setYamlField(frontmatter, 'summary', rec.summary)
      if (rec.tags && rec.tags.length > 0) frontmatter = setYamlField(frontmatter, 'tags', rec.tags)

      await SaveBuffer(path, frontmatter + body)
      await GetNotes().then(res => setNotes(res || [])).catch(console.error)

      if (tabIdx !== -1) {
        const tabUuid = tabs[tabIdx].uuid
        fmCache.current[tabUuid] = frontmatter
        const meta = parseMeta(frontmatter, body)
        setTabs(prev => prev.map((t, i) => i === tabIdx ? { 
          ...t, 
          ...meta,
          isEvaluating: false
        } : t))
      }
    } catch (err) {
      console.error('Smart Metadata failed', err)
      if (tabIdx !== -1) {
        setTabs(prev => prev.map((t, i) => i === tabIdx ? { ...t, isEvaluating: false } : t))
      }
    }
  }

  async function handleSetIntentByPath(path: string, intent: UserIntent) {
    const tabIdx = tabs.findIndex(t => t.path === path)
    if (tabIdx !== -1) {
      setTabIntent(tabIdx, intent)
    } else {
      try {
        const content = await LoadBuffer(path)
        const { frontmatter, body } = splitFrontmatter(content)
        const updatedFm = setYamlField(frontmatter, 'user_intent', intent)
        await SaveBuffer(path, updatedFm + body)
        await GetNotes().then(res => setNotes(res || [])).catch(console.error)
      } catch (err) {
        console.error('Failed to set intent by path', err)
      }
    }
  }

  async function handleCreateFolder(parentPath: string) {
    setPromptModal({
      title: 'New Folder',
      message: `Create a new folder in ${parentPath}:`,
      placeholder: 'folder-name',
      onSubmit: async (name: string) => {
        setPromptModal(null)
        if (!name) return
        const path = `${parentPath}/${name}`
        try {
          await CreateFolder(path)
          await GetNotes().then(res => setNotes(res || [])).catch(console.error)
        } catch (err) {
          console.error('Failed to create folder', err)
          alert(`Failed to create folder: ${err}`)
        }
      }
    })
  }

  async function handleDeleteFolder(path: string) {
    setConfirmModal({
      title: 'Delete Folder',
      message: `Are you sure you want to delete the folder "${path.split('/').pop()}"?`,
      isDestructive: true,
      onConfirm: async () => {
        setConfirmModal(null)
        try {
          await DeleteFolder(path)
          await GetNotes().then(res => setNotes(res || [])).catch(console.error)
        } catch (err) {
          console.error('Failed to delete folder', err)
          alert(`Failed to delete folder: ${err}`)
        }
      }
    })
  }

  async function handleRename(path: string, currentName: string, isDir: boolean) {
    setPromptModal({
      title: isDir ? 'Rename Folder' : 'Rename Note',
      message: `Enter new name for "${currentName}":`,
      initialValue: isDir ? currentName : currentName.replace(/\.md$/, ''),
      placeholder: isDir ? currentName : currentName.replace(/\.md$/, ''),
      onSubmit: async (newName: string) => {
        setPromptModal(null)
        if (!newName || newName === currentName) return
        const parentDir = path.substring(0, path.lastIndexOf('/'))
        const fileName = isDir ? newName : (newName.endsWith('.md') ? newName : newName + '.md')
        const newPath = parentDir ? `${parentDir}/${fileName}` : fileName
        try {
          if (isDir) {
            await RenameFolder(path, newPath)
          } else {
            await MoveNote(path, newPath)
            
            // Sync metadata
            try {
              const content = await LoadBuffer(newPath)
              let { frontmatter, body } = splitFrontmatter(content)
              const pureName = fileName.replace(/\.md$/, '')
              const oldPureName = path.split('/').pop()?.replace(/\.md$/, '') || ''
              
              frontmatter = setYamlField(frontmatter, 'filename', pureName)
              frontmatter = setYamlField(frontmatter, 'user_suggested_name', pureName)
              
              await SaveBuffer(newPath, frontmatter + body)
              
              // Update frontmatter cache to avoid it being overwritten by an autosave
              const tab = tabsRef.current.find(t => t.path === path)
              if (tab && tab.uuid) {
                fmCache.current[tab.uuid] = frontmatter
              }
            } catch (metaErr) {
              console.warn('Metdata sync failed after rename', metaErr)
            }
          }
          await GetNotes().then(res => setNotes(res || [])).catch(console.error)
          setTabs(prev => prev.map(t => t.path === path ? { ...t, path: newPath } : t))
        } catch (err) {
          console.error('Rename failed', err)
          alert(`Rename failed: ${err}`)
        }
      }
    })
  }

  // ── AI Explain / Ask gestures ─────────────────────────────────────────────

  // Insert a placeholder aiBlock node after the active block/selection.
  function insertAiPlaceholder(aiId: string, blockRef: string, question?: string) {
    if (!editor) return
    queueMicrotask(() => {
      editor.commands.command(({ tr, state }) => {
        const { schema, selection } = state
        const { to } = selection

        // Find the end of the top-level block containing the cursor.
        let insertPos = state.doc.content.size
        let offset = 0
        for (let i = 0; i < state.doc.childCount; i++) {
          const child = state.doc.child(i)
          const end = offset + child.nodeSize
          if (offset <= to && to <= end) { insertPos = end; break }
          offset = end
        }

        const members: any[] = []
        if (question) {
          members.push(schema.nodes.paragraph.create(null, [
            schema.text('Ask:', [schema.marks.bold.create()]),
            schema.text(` ${question}`),
          ]))
        }
        members.push(
          schema.nodes.paragraph.create(
            null, schema.text('(thinking…)', [schema.marks.italic.create()])
          )
        )

        const aiNode = schema.nodes.aiBlock.create(
          { id: aiId, ref: blockRef },
          Fragment.from(members)
        )
        tr.insert(insertPos, aiNode)
        return true
      })
    })
  }

  // Replace the placeholder aiBlock (identified by aiId) with the AI response.
  // Parses response markdown via markdown-it → HTML → ProseMirror DOMParser so
  // bold, italic, lists, and code blocks all become proper marks/nodes and
  // round-trip cleanly through the vault without any blockquote serializer issues.
  function replaceAiPlaceholder(aiId: string, responseText: string) {
    if (!editor) return

    let targetPos = -1
    let targetEnd = -1
    let askText = ''
    let existingRef = 'doc'

    editor.state.doc.descendants((node: any, pos: number) => {
      if (targetPos !== -1) return false
      if (node.type.name === 'aiBlock' && node.attrs.id === aiId) {
        targetPos = pos
        targetEnd = pos + node.nodeSize
        existingRef = node.attrs.ref ?? 'doc'
        node.forEach((child: any) => {
          if (child.type.name === 'paragraph' && child.textContent.startsWith('Ask: ')) {
            askText = child.textContent
          }
        })
        return false
      }
    })

    if (targetPos === -1) return

    // Parse response markdown → HTML → ProseMirror nodes.
    const { schema } = editor.state
    const responseHtml = editor.storage.markdown.parser.md.render(responseText.trim())
    const tempDiv = document.createElement('div')
    tempDiv.innerHTML = responseHtml
    const parsedDoc = ProseMirrorDOMParser.fromSchema(schema).parse(tempDiv)

    const responseNodes: any[] = []
    parsedDoc.forEach((child: any) => {
      // Skip empty paragraphs the DOMParser appends as document padding.
      if (child.type.name === 'paragraph' && child.childCount === 0) return
      responseNodes.push(child)
    })

    const members: any[] = []
    if (askText) {
      const question = askText.replace(/^Ask:\s*/, '')
      members.push(schema.nodes.paragraph.create(null, [
        schema.text('Ask:', [schema.marks.bold.create()]),
        schema.text(` ${question}`),
      ]))
    }
    members.push(...responseNodes)
    // Guard: aiBlock requires block+ content — ensure at least one node.
    if (members.length === 0) members.push(schema.nodes.paragraph.create())

    const newAiNode = schema.nodes.aiBlock.create(
      { id: aiId, ref: existingRef },
      Fragment.from(members)
    )

    editor.commands.command(({ tr }) => {
      tr.replaceWith(targetPos, targetEnd, newAiNode)
      return true
    })
  }

  // Build explain/ask context from current editor selection or cursor position.
  // Returns content string, a blockRef id, conversation history (for threading),
  // and a human-readable label for the ask popup.
  function buildAiContext(): { content: string; blockRef: string; history: string; contextLabel: string } {
    if (!editor) return { content: '', blockRef: 'doc', history: '', contextLabel: 'document' }

    const { selection, doc } = editor.state
    const { from, to, empty } = selection

    // Threading: detect if cursor is inside an aiBlock node.
    let aiBlockRef = ''
    let aiBlockId = ''
    doc.nodesBetween(from, to, (node: any) => {
      if (node.type.name === 'aiBlock') {
        aiBlockId = node.attrs.id ?? ''
        aiBlockRef = node.attrs.ref ?? ''
        return false
      }
    })

    if (aiBlockId) {
      // Threading: gather the full conversation history from the ref chain.
      const refs = aiBlockRef.split(',')
      const sourceRef = refs[0]
      let sourceContent = ''
      if (sourceRef && sourceRef !== 'doc') {
        doc.descendants((node) => {
          if (node.attrs?.id === sourceRef) { sourceContent = node.textContent; return false }
        })
      } else {
        sourceContent = getCleanMarkdown(editor.storage.markdown.getMarkdown())
      }

      // Collect all intermediate AI responses in the chain
      const intermediateHistory: string[] = []
      const serializer = editor.storage.markdown.serializer
      const seenIds = new Set<string>()
      let turnCount = 1

      for (let i = 1; i < refs.length; i++) {
        const refId = (refs[i] || '').trim()
        if (!refId || seenIds.has(refId)) continue
        seenIds.add(refId)

        doc.descendants((node) => {
          if (node.attrs?.id === refId) {
            const md = serializer.serialize(node)
            intermediateHistory.push(`[Turn ${turnCount++}]\n${md}`)
            return false
          }
        })
      }

      let currentBlockText = ''
      doc.nodesBetween(from, to, (node) => {
        if (node.type.name === 'aiBlock' && node.attrs?.id === aiBlockId) {
          if (!seenIds.has(node.attrs.id)) {
            currentBlockText = serializer.serialize(node)
            seenIds.add(node.attrs.id)
          }
          return false
        }
      })

      // If selection was non-empty and NOT an aiBlock, or if we couldn't find the parent aiBlock
      if (!currentBlockText && !empty) {
        currentBlockText = doc.textBetween(from, to, '\n')
      }

      const fullHistory = [
        ...intermediateHistory,
        currentBlockText ? `[Turn ${turnCount}]\n${currentBlockText}` : ''
      ].filter(Boolean).join('\n\n---\n\n')

      const newRef = aiBlockRef ? `${aiBlockRef},${aiBlockId}` : aiBlockId
      return {
        content: sourceContent,
        blockRef: newRef,
        history: fullHistory,
        contextLabel: 'Follow-up',
      }
    }

    if (empty) {
      // No selection — check if cursor is inside a code block.
      let codeContent = ''
      let codeId = ''
      doc.descendants((node, pos) => {
        if (node.type.name === 'codeBlock' && pos <= from && from <= pos + node.nodeSize) {
          codeContent = node.textContent
          codeId = node.attrs.id ?? ''
          return false
        }
      })
      if (codeContent) {
        return { content: codeContent, blockRef: codeId || 'doc', history: '', contextLabel: 'Code Block' }
      }
      return { content: getCleanMarkdown(editor.storage.markdown.getMarkdown()), blockRef: 'doc', history: '', contextLabel: 'Document' }
    }

    // Text selection — use selected text as content.
    const selectedText = doc.textBetween(from, to, '\n')
    let selectedCodeBlockId = ''
    doc.nodesBetween(from, to, (node) => {
      if (node.type.name === 'codeBlock' && node.attrs.id) selectedCodeBlockId = node.attrs.id
    })
    const blockRef = selectedCodeBlockId || 'blk-' + Math.random().toString(16).substring(2, 6)
    return { content: selectedText, blockRef, history: '', contextLabel: 'Selection' }
  }

  // Resolve a document's current file path from its UUID.
  // Checks open tabs first (most up-to-date after renames), then falls back to
  // the uuidToPath index populated on each loadTab.
  //
  // TODO: add a Go-side FindBufferByUuid(uuid) vault scan as a third fallback.
  // The current two sources cover all realistic in-app scenarios but would miss
  // an external rename of a file whose tab was closed before the AI job completed.
  // See: vault/buffer.go — scan all .md files for `uuid: <value>` in frontmatter.
  function resolvePathByUuid(uuid: string): string | undefined {
    return tabsRef.current.find(t => t.uuid === uuid)?.path ?? uuidToPath.current.get(uuid)
  }

  // Apply an AI response directly to a file on disk without touching the editor.
  // Used when the user switches tabs while an AI call is in-flight — the response
  // still lands in the correct file rather than being lost or corrupting the new tab.
  // Takes the document UUID (permanent identity) — path is resolved internally.
  async function applyAiResponseInBackground(uuid: string, aiId: string, responseText: string) {
    const path = resolvePathByUuid(uuid)
    if (!path) {
      console.warn('[stash:ai] background update: no path found for UUID', { uuid, aiId })
      return
    }
    try {
      // Load fresh from disk — don't use any in-memory state captured at dispatch time.
      const content = await LoadBuffer(path)
      const { frontmatter, body } = splitFrontmatter(content)

      // Find the [!ai] block by id and replace only its content, preserving the
      // original header line (which carries the ref= already written to disk).
      const idEscaped = aiId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const pattern = new RegExp(`(\\[!ai\\] id="${idEscaped}"[^\\n]*)\\s*[\\s\\S]*?\\s*\\[!ai-end\\]`)
      const updatedBody = body.replace(pattern, `$1\n\n${responseText}\n\n[!ai-end]`)

      if (updatedBody === body) {
        console.warn('[stash:ai] background update: placeholder not found in file', { uuid, path, aiId })
        return
      }

      const newFm = frontmatter ? setYamlField(frontmatter, 'ai_last_evaluated', getLocalISOString()) : frontmatter
      await SaveBuffer(path, newFm + updatedBody)

      // Keep caches consistent so the next loadTab for this UUID is correct.
      savedBodyCache.current[uuid] = updatedBody
      if (newFm) fmCache.current[uuid] = newFm

      console.log('[stash:ai] background update: response saved', { uuid, path, aiId })
    } catch (err) {
      console.error('[stash:ai] background update: failed', { uuid, path, aiId, err })
    }
  }

  // Update ai_last_evaluated in frontmatter and persist the active tab.
  // Only called when the user is still on the originating tab, so the editor
  // is guaranteed to hold that tab's content (including the just-applied AI response).
  // Takes the document UUID — path is resolved internally.
  function touchAiLastEvaluated(uuid: string) {
    const path = resolvePathByUuid(uuid)
    if (!path) return
    const fm = fmCache.current[uuid]
    if (!fm) return
    const newFm = setYamlField(fm, 'ai_last_evaluated', getLocalISOString())
    fmCache.current[uuid] = newFm
    const body = editor?.storage.markdown.getMarkdown() ?? savedBodyCache.current[uuid] ?? ''
    SaveBuffer(path, newFm + body).catch(console.error)
  }

  function explainGesture() {
    if (!editor || tier !== 'smart') return
    const ctx = buildAiContext()
    if (!ctx.content) return

    const capturedUuid = activeTabRef.current?.uuid!
    const aiId = 'ai-' + Math.random().toString(16).substring(2, 6)
    insertAiPlaceholder(aiId, ctx.blockRef)

    pendingAiCount.current++
    setTabs(prev => prev.map(t => t.uuid === capturedUuid ? { ...t, isWaitingAI: true } : t))

    console.log('[stash:ai] explain: firing', { aiId, uuid: capturedUuid, blockRef: ctx.blockRef, contentLen: ctx.content.length })
    Explain(ctx.content)
      .then(resp => {
        const trimmed = resp.trim()
        const isActive = activeTabRef.current?.uuid === capturedUuid
        if (!isActive) {
          console.log('[stash:ai] explain: tab not active — applying response to file', { uuid: capturedUuid, aiId })
          applyAiResponseInBackground(capturedUuid, aiId, trimmed)
          return
        }
        console.log('[stash:ai] explain: response received', { aiId, len: trimmed.length })
        replaceAiPlaceholder(aiId, trimmed)
        touchAiLastEvaluated(capturedUuid)
      })
      .catch(err => {
        console.warn('[stash:ai] explain: failed', err)
        const errorMsg = '_(explain timed out — Ctrl+E to retry)_'
        const isActive = activeTabRef.current?.uuid === capturedUuid
        if (!isActive) {
          applyAiResponseInBackground(capturedUuid, aiId, errorMsg)
          return
        }
        replaceAiPlaceholder(aiId, errorMsg)
      })
      .finally(() => {
        pendingAiCount.current--
        setTabs(prev => prev.map(t => t.uuid === capturedUuid ? { ...t, isWaitingAI: false } : t))
      })
  }

  function askGesture() {
    if (!editor || tier !== 'smart') return
    const ctx = buildAiContext()
    askContextRef.current = ctx
    setShowAskPopup(true)
  }

  function handleAskSend(question: string) {
    const ctx = askContextRef.current
    if (!ctx || !editor) return

    const capturedUuid = activeTabRef.current?.uuid!
    const aiId = 'ai-' + Math.random().toString(16).substring(2, 6)
    insertAiPlaceholder(aiId, ctx.blockRef, question)

    pendingAiCount.current++
    setTabs(prev => prev.map(t => t.uuid === capturedUuid ? { ...t, isWaitingAI: true } : t))

    console.log('[stash:ai] ask: firing', { aiId, uuid: capturedUuid, blockRef: ctx.blockRef, question: question.slice(0, 60) })
    Ask(ctx.content, ctx.history, question)
      .then(resp => {
        const trimmed = resp.trim()
        const isActive = activeTabRef.current?.uuid === capturedUuid
        if (!isActive) {
          console.log('[stash:ai] ask: tab not active — applying response to file', { uuid: capturedUuid, aiId })
          applyAiResponseInBackground(capturedUuid, aiId, trimmed)
          return
        }
        console.log('[stash:ai] ask: response received', { aiId, len: trimmed.length })
        replaceAiPlaceholder(aiId, trimmed)
        touchAiLastEvaluated(capturedUuid)
      })
      .catch(err => {
        console.warn('[stash:ai] ask: failed', err)
        const errorMsg = '_(ask timed out — Ctrl+Shift+A to retry)_'
        const isActive = activeTabRef.current?.uuid === capturedUuid
        if (!isActive) {
          applyAiResponseInBackground(capturedUuid, aiId, errorMsg)
          return
        }
        replaceAiPlaceholder(aiId, errorMsg)
      })
      .finally(() => {
        pendingAiCount.current--
        setTabs(prev => prev.map(t => t.uuid === capturedUuid ? { ...t, isWaitingAI: false } : t))
      })
  }

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
      loadTab:    loadTab,
      explain:    explainGesture,
      ask:        askGesture,
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
  // resolves it to a /vault/... display URL at render time.

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
              // Save to buffer assets or vault assets depending on tab type
              const isBuffer = tab.status !== 'filed'
              const vaultRelPath = isBuffer
                ? await SaveBufferAsset(id, dataUrl)
                : await SaveNoteAsset(tab.path, id, dataUrl)

              // Compute the markdown-relative path from the tab file to the asset
              const mdPath = assetMarkdownPath(tab.path, vaultRelPath)
              console.debug('[stash] mutation: image saved', { id, vaultRelPath, mdPath })

              // Update Tiptap node: src = markdown path (ImageNodeView resolves /vault/ for display)
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
    const unlistenClosing = EventsOn('app:closing', () => {
      console.log('[stash] shutdown: app:closing received, flushing state...')
      flushRef.current()

      const doQuit = () => {
        saveSessionFromRefs()
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

  // ── Focus count timer ─────────────────────────────────────────────────────
  // Increments focus_count in frontmatter after the tab has held focus for 2 min.

  useEffect(() => {
    if (focusTimer.current) clearTimeout(focusTimer.current)
    const tab = tabs[activeIdx]
    if (!tab || tab.status === 'filed') return
    const path = tab.path
    focusTimer.current = setTimeout(() => {
      // At 2-min fire time loadTab has long resolved, so tab.uuid IS the file UUID.
      // Look up the tab by path (captured at setup) to get current UUID.
      const currentTab = tabsRef.current.find(t => t.path === path)
      if (!currentTab) return  // tab was closed before timer fired
      const fm = fmCache.current[currentTab.uuid]
      if (!fm) return
      const newFm = bumpFocusCount(fm)
      fmCache.current[currentTab.uuid] = newFm
      // Use savedBodyCache — editor.getMarkdown() reads the currently visible
      // tab which may be different after 2 minutes of focus dwell time.
      const body = savedBodyCache.current[currentTab.uuid] ?? ''
      saveBufferSafe(currentTab.uuid, newFm + body)
      console.debug('[stash] focus_count bumped', { path })
    }, 2 * 60 * 1000)
    return () => { if (focusTimer.current) { clearTimeout(focusTimer.current); focusTimer.current = null } }
  }, [activeIdx])

  // ── Scroll position tracking ───────────────────────────────────────────────

  const scrollTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const el = document.getElementById('app')
    if (!el) return
    const onScroll = () => {
      if (scrollTimer.current) clearTimeout(scrollTimer.current)
      scrollTimer.current = setTimeout(() => {
        const scroll = el.scrollTop
        setTabs(prev => prev.map((t, i) => i === activeIdx ? { ...t, scroll } : t))
      }, 250)
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => { el.removeEventListener('scroll', onScroll); if (scrollTimer.current) clearTimeout(scrollTimer.current) }
  }, [activeIdx])

  // ── Cleanup ────────────────────────────────────────────────────────────────

  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current) }, [])

  const openPaths = new Set(tabs.map(t => t.path))

  if (!ready) return <div className="loading-screen" />

  if (!vaultInfo?.root) {
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
    <div id="app-root" className={`theme-${vaultInfo?.themeName || 'default'}`} style={{ '--sidebar-w': showSidebar ? `${sidebarWidth + 4}px` : '0px' } as React.CSSProperties}>
      {showSidebar && (
        <>
          {sidebarMode === 'files' ? (
            <Sidebar
              entries={notes}
              openPaths={openPaths}
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
            />
          ) : (
            <VaultSearch
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
          {activeTab?.isEvaluating && (
            <div className="ai-eval-overlay">
               <div className="ai-eval-spinner" />
               <div className="ai-eval-text">AI is evaluating...</div>
            </div>
          )}
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
            ? <textarea className="markdown-raw" value={rawMd} onChange={e => {
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
                        placeholder="Raw markdown — Ctrl+Shift+M to return" spellCheck={false} autoFocus />
            : <EditorContent editor={editor} />
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
            />
          </>
        )}
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
          onAccept={name => {
            const { path } = timeoutPopup
            setTimeoutPopup(null)
            FileBufferWithName(path, name)
              .then(() => finishCloseTab(path))
              .catch(e => console.error('[stash] TimeoutPopup accept failed', e))
          }}
          onRetry={async () => {
            const { path, suggestedName } = timeoutPopup
            const rec = await EvaluateBuffer(path)  // throws on timeout
            setTimeoutPopup(null)
            if (rec.keep) {
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
