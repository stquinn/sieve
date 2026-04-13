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
import { Ask, DiscardBuffer, Explain, FileBuffer, FileBufferWithName, GetNotes, GetSession, GetVaultInfo, LoadBuffer, NewBuffer, RefineLanguage, SaveBuffer, SaveBufferAsset, SaveNoteAsset, SaveSession, SaveSidebarWidth, SaveMetaWidth, ShowInFiles, EvaluateBuffer, Quit as AppQuit } from '../wailsjs/go/main/App'
import { vault } from '../wailsjs/go/models'
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

function newTabUuid(): string {
  return crypto.randomUUID()
}

function splitFrontmatter(content: string): { frontmatter: string; body: string } {
  const match = content.match(/^(---\n[\s\S]*?\n---\n?)/)
  if (match) return { frontmatter: match[1], body: content.slice(match[1].length) }
  return { frontmatter: '', body: content }
}

function getLocalISOString(d = new Date()): string {
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
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
  const [isMetaDragging, setIsMetaDragging] = useState(false)
  const [showSearch, setShowSearch]         = useState(false)
  const [showQuickSwitch, setShowQuickSwitch] = useState(false)
  const [sidebarMode, setSidebarMode]       = useState<'files'|'search'>('files')
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
  const sidebarWidthRef           = useRef(240)
  const metaWidthRef              = useRef(260)
  const showSidebarRef           = useRef(true)
  const showMetaRef              = useRef(false)
  const focusTimer                = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Caches keyed by path — survive tab switches without triggering re-renders
  const fmCache  = useRef<Record<string, string>>({})  // frontmatter per path
  const mdCache  = useRef<Record<string, string>>({})  // raw markdown per path (when in markdown mode)
  const savedBodyCache = useRef<Record<string, string>>({}) // clean WYSIWYG body per path
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

    delete fmCache.current[path]
    delete mdCache.current[path]

    if (currentTabs.length === 1) {
      NewBuffer().then(newPath => {
        const newTab: TabState = { uuid: newTabUuid(), path: newPath, scroll: 0, active: true, mode: 'wysiwyg', status: 'unfiled', userIntent: null, isEmpty: true, isModified: false }
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
  // Marks tab isClosing, awaits AI, then files/discards/shows popup.
  // forceKeep=true: user_intent=keep — always file regardless of AI vote, no discard popup on timeout.
  function fireSmartClose(path: string, suggestedName: string, forceKeep = false) {
    console.log('[stash:ai] smartClose: starting evaluation', { path, forceKeep })
    setTabs(prev => prev.map(t => t.path === path ? { ...t, isClosing: true } : t))

    EvaluateBuffer(path)
      .then(rec => {
        console.log('[stash:ai] smartClose: eval complete', { path, keep: rec.keep, filename: rec.filename, title: rec.title, forceKeep })
        const shouldKeep = forceKeep || rec.keep
        if (shouldKeep) {
          let fm = fmCache.current[path] || ''
          fm = setYamlField(fm, 'ai_eval', 'complete')
          fm = setYamlField(fm, 'ai_last_evaluated', getLocalISOString())
          if (rec.title)    fm = setYamlField(fm, 'display_name', rec.title)
          if (rec.filename) fm = setYamlField(fm, 'filename', rec.filename)
          if (rec.folder)   fm = setYamlField(fm, 'ai_folder_suggestion', rec.folder)
          if (rec.summary)  fm = setYamlField(fm, 'summary', rec.summary)
          if (rec.tags && rec.tags.length > 0) fm = setYamlField(fm, 'tags', rec.tags)
          
          const filename = rec.filename || suggestedName
          if (filename) fm = setYamlField(fm, 'user_suggested_name', filename)

          const body = savedBodyCache.current[path] ?? ''
          
          return SaveBuffer(path, fm + body).then(() => {
            return FileBuffer(path)
          }).then(newPath => {
            if (newPath) {
              fmCache.current[newPath] = fm.replace(/^status:\s*.+/m, 'status: filed')
            }
          })
        } else {
          return DiscardBuffer(path)
        }
      })
      .then(() => finishCloseTab(path))
      .catch(err => {
        if (forceKeep) {
          // user said keep — file silently even if AI timed out
          console.warn('[stash:ai] smartClose forceKeep: eval failed, filing without AI naming', err)
          const filename = suggestedName
          const fileFn = filename ? FileBufferWithName(path, filename) : FileBuffer(path)
          fileFn.then(() => finishCloseTab(path)).catch(console.error)
        } else {
          console.warn('[stash] smart close eval failed, showing timeout popup', err)
          setTabs(prev => prev.map(t => t.path === path ? { ...t, isClosing: false } : t))
          setTimeoutPopup({ path, suggestedName })
        }
      })
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
      StarterKit.configure({ codeBlock: false }),
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
      // Guard: if fmCache hasn't been populated yet, loadTab hasn't resolved — skip
      if (fmCache.current[activeTab.path] === undefined) return

      const path = activeTab.path
      const body = editor.storage.markdown.getMarkdown()
      const isMod = (body !== savedBodyCache.current[path])
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
        const path = activeTab.path
        const body = editor.storage.markdown.getMarkdown()
        if (body === savedBodyCache.current[path]) return
        const fm = bumpFm(fmCache.current[path] ?? '')
        fmCache.current[path] = fm
        savedBodyCache.current[path] = body
        SaveBuffer(path, fm + body).catch(console.error)
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

      fmCache.current[tab.path] = frontmatter
      uuidToPath.current.set(fileUuid, tab.path)
      const meta = parseMeta(frontmatter, body)
      setTabs(prev => prev.map(t => t.path === tab.path ? { ...t, ...meta, uuid: fileUuid } : t))
      console.debug('[stash] loadTab', { path: tab.path, mode: tab.mode, scroll: tab.scroll })

      if (tab.mode === 'markdown') {
        const cached = mdCache.current[tab.path] ?? content
        mdCache.current[tab.path] = cached
        setRawMd(cached)
      } else {
        editor.commands.setContent(body)
      }
      savedBodyCache.current[tab.path] = body

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
      if (info.autosaveDebounce > 0) autosaveMs.current = info.autosaveDebounce

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
        // UUIDs are runtime-only — assign fresh ones when restoring from session.
        const st = (session.tabs as TabState[]).map(t => ({ ...t, uuid: newTabUuid() }))
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
    SaveSession(vault.Session.createFrom({ 
      tabs: toSave,
      sidebarWidth,
      metaWidth,
      showSidebar,
      showMeta
    })).catch(console.error)
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

  // ── Flush active tab to disk immediately ───────────────────────────────────

  function flush() {
    if (!activeTab) return
    // Guard: fmCache not populated yet means loadTab hasn't resolved — skip.
    if (fmCache.current[activeTab.path] === undefined) return
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    if (isMarkdownMode) {
      if (rawMd === mdCache.current[activeTab.path]) return
      // Raw mode shows full file — save as-is, but re-sync frontmatter cache
      const { frontmatter } = splitFrontmatter(rawMd)
      if (frontmatter) fmCache.current[activeTab.path] = frontmatter
      SaveBuffer(activeTab.path, rawMd).catch(console.error)
      mdCache.current[activeTab.path] = rawMd
      setTabs(prev => prev.map(t => t.path === activeTab.path ? { ...t, isModified: false } : t))
    } else {
      const path = activeTab.path
      const body = editor?.storage.markdown.getMarkdown() ?? ''
      if (body === savedBodyCache.current[path]) return
      const fm = bumpFm(fmCache.current[path] ?? '')
      fmCache.current[path] = fm
      savedBodyCache.current[path] = body
      SaveBuffer(path, fm + body).catch(console.error)
      setTabs(prev => prev.map(t => t.path === path ? { ...t, isModified: false } : t))
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
    if (isMarkdownMode && activeTab) mdCache.current[activeTab.path] = rawMd
    flush()
    // Persist scroll into tabs state so session save captures it
    const updatedTabs = tabs.map((t, i) => i === activeIdx ? { ...t, scroll } : t)
    setTabs(updatedTabs)
    setActiveIdx(idx)
    H.current.loadTab(updatedTabs[idx])
  }

  function newTab() {
    if (!vaultInfo?.root) return
    if (isMarkdownMode && activeTab) mdCache.current[activeTab.path] = rawMd
    flush()
    NewBuffer().then(path => {
      const tab: TabState = { uuid: newTabUuid(), path, scroll: 0, active: true, mode: 'wysiwyg', status: 'unfiled', userIntent: null, isEmpty: true, isModified: false }
      // Use functional update so we append to the latest tabs, not the stale closure.
      let newIdx = 0
      setTabs(prev => { newIdx = prev.length; return [...prev, tab] })
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
    if (tab.isClosing) return  // AI eval already in flight for this tab
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

        if (body !== savedBodyCache.current[path]) {
            const fm = bumpFm(fmCache.current[path] ?? '')
            fmCache.current[path] = fm
            savedBodyCache.current[path] = body
            await SaveBuffer(path, fm + body).catch(console.error)
        }
        const suggested = extractSuggestedName(fmCache.current[path] ?? '')
        fireSmartClose(path, suggested, true)
        return  // finishCloseTab called by fireSmartClose
      } else if (tier === 'smart') {
        // Smart mode, user_intent: null, not empty — evaluate in background.
        // Tab stays open (isClosing=true) until AI responds or popup fires.
        const suggested = extractSuggestedName(fmCache.current[path] ?? '')
        fireSmartClose(path, suggested)
        return  // finishCloseTab called by fireSmartClose when done
      }
    }

    delete fmCache.current[path]
    delete mdCache.current[path]

    if (tabs.length === 1) {
      // Always keep at least one tab — open a fresh buffer
      const newPath = await NewBuffer().catch(() => null)
      if (!newPath) return
      const newTab: TabState = { uuid: newTabUuid(), path: newPath, scroll: 0, active: true, mode: 'wysiwyg', status: 'unfiled', userIntent: null, isEmpty: true, isModified: false }
      setTabs([newTab])
      setActiveIdx(0)
      H.current.loadTab(newTab)
      return
    }

    const scroll = currentScroll()
    if (capturedMarkdownMode && tab.path === capturedActivePath) mdCache.current[path] = capturedRawMd
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
    const fm = fmCache.current[tab.path] ?? ''
    const updatedFm = setYamlField(fm, 'user_intent', intent)
    fmCache.current[tab.path] = updatedFm
    setTabs(prev => prev.map((t, i) => i === idx ? { ...t, userIntent: intent } : t))
    // Persist to disk using latest saved body (don't bump version — not a content edit)
    const body = savedBodyCache.current[tab.path] ?? ''
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
                  : (tab.path === capturedActivePath ? editor?.storage.markdown.getMarkdown() : savedBodyCache.current[path]) ?? ''
               
               if (body !== savedBodyCache.current[path]) {
                 const fm = bumpFm(fmCache.current[path] ?? '')
                 fmCache.current[path] = fm
                 savedBodyCache.current[path] = body
                 await SaveBuffer(path, fm + body).catch(console.error)
               }
               await FileBuffer(path).catch(console.error)
            }
            // If Smart mode and userIntent === null, defer (leave on disk)
        }
        delete fmCache.current[path]
        delete mdCache.current[path]
    })
    
    await Promise.all(promises)
    
    for (const idx of sorted) {
        finalTabs.splice(idx, 1)
        if (currentActiveIdx >= idx && currentActiveIdx > 0) currentActiveIdx--
    }
    
    if (finalTabs.length === 0) {
        const newPath = await NewBuffer().catch(() => null)
        if (newPath) {
           const newTab: TabState = { uuid: newTabUuid(), path: newPath, scroll: 0, active: true, mode: 'wysiwyg', status: 'unfiled', userIntent: null, isEmpty: true, isModified: false }
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

  async function forceFile(forceEval: boolean = false) {
    console.log('[stash:ai] forceFile called', { path: activeTab?.path, status: activeTab?.status, isEmpty: activeTab?.isEmpty, tier, forceEval })
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
    let fm = fmCache.current[path] ?? ''
    const body = isMarkdownMode
      ? splitFrontmatter(mdCache.current[path] ?? rawMd).body
      : (editor?.storage.markdown.getMarkdown() ?? '')

    if (isMarkdownMode) {
      if (rawMd !== mdCache.current[path]) {
        const { frontmatter } = splitFrontmatter(rawMd)
        if (frontmatter) fmCache.current[path] = frontmatter
        await SaveBuffer(path, rawMd).catch(console.error)
        mdCache.current[path] = rawMd
      }
    } else {
      if (body !== savedBodyCache.current[path]) {
        fm = bumpFm(fm)
        fmCache.current[path] = fm
        savedBodyCache.current[path] = body
        await SaveBuffer(path, fm + body).catch(console.error)
      }
    }

    try {
      let finalFm = fm
      
      const setYamlLocal = setYamlField

      if (tier === 'smart' && (forceEval || activeTab.status === 'unfiled')) {
         console.log('[stash:ai] forceFile: starting AI evaluation', { path, forceEval })

         // Mark as evaluating locally
         finalFm = setYamlLocal(finalFm, 'ai_eval', 'evaluating')
         fmCache.current[path] = finalFm
         const meta = parseMeta(finalFm, body)
         setTabs(prev => prev.map(t => t.path === path ? { ...t, ...meta } : t))
         await SaveBuffer(path, finalFm + body).catch(err => console.error('[stash:ai] SaveBuffer (pre-eval) failed', err))

         try {
             const rec = await EvaluateBuffer(path)
             console.log('[stash:ai] EvaluateBuffer result', { path, keep: rec.keep, filename: rec.filename, title: rec.title, folder: rec.folder, tags: rec.tags?.length })
             if (rec) {
                finalFm = setYamlLocal(finalFm, 'ai_eval', 'complete')
                finalFm = setYamlLocal(finalFm, 'ai_last_evaluated', getLocalISOString())

                const info = await GetVaultInfo()
                finalFm = setYamlLocal(finalFm, 'cli', info.cli)

                if (rec.title)    finalFm = setYamlLocal(finalFm, 'display_name', rec.title)
                if (rec.filename) finalFm = setYamlLocal(finalFm, 'filename', rec.filename)
                if (rec.folder)   finalFm = setYamlLocal(finalFm, 'ai_folder_suggestion', rec.folder)
                if (rec.summary)  finalFm = setYamlLocal(finalFm, 'summary', rec.summary)
                if (rec.tags && rec.tags.length > 0) finalFm = setYamlLocal(finalFm, 'tags', rec.tags)
             }
         } catch(e) {
             console.error('[stash:ai] EvaluateBuffer failed (timeout or parse error)', e)
             finalFm = setYamlLocal(finalFm, 'ai_eval', 'timeout')
         }

         // Save the evaluated frontmatter back to the buffer path
         fmCache.current[path] = finalFm
         const updatedMeta = parseMeta(finalFm, body)
         setTabs(prev => prev.map(t => t.path === path ? { ...t, ...updatedMeta } : t))
         await SaveBuffer(path, finalFm + body).catch(err => console.error('[stash:ai] SaveBuffer (post-eval) failed', err))
      } else {
         console.debug('[stash:ai] forceFile: skipping AI eval', { tier, forceEval, status: activeTab.status })
      }

      if (activeTab.status === 'unfiled') {
         // Now physically move it out of the buffer tray using the exact filename / folder the AI suggested
         const newPath = await FileBuffer(path)
         
         const filedFm = finalFm.replace(/^status:\s*.+/m, 'status: filed')
         fmCache.current[newPath] = filedFm
         delete fmCache.current[path]
         if (mdCache.current[path]) {
           mdCache.current[newPath] = mdCache.current[path]
           delete mdCache.current[path]
         }
         
         setTabs(prev => {
            const newTabs = prev.map(t => 
              t.path === path ? { ...t, path: newPath, ...parseMeta(filedFm, body), status: 'filed' as TabState['status'] } : t
            )
            return newTabs
         })
      } else {
         // It was already filed, we just re-evaluated in place
         setTabs(prev => {
            const newTabs = prev.map(t => 
              t.path === path ? { ...t, ...parseMeta(finalFm, body) } : t
            )
            return newTabs
         })
         // Session doesn't strictly need saving if the path didn't change, but it's cheap
      }

    } catch (err) {
      console.error('[stash] forceFile failed', err)
    }
  }

  function toggleMode() {
    if (!activeTab) return
    if (isMarkdownMode && activeTab) mdCache.current[activeTab.path] = rawMd
    flush()

    const newMode = isMarkdownMode ? 'wysiwyg' : 'markdown'
    const newTabs = tabs.map((t, i) => i === activeIdx ? { ...t, mode: newMode as TabState['mode'] } : t)
    setTabs(newTabs)

    if (newMode === 'markdown') {
      // Show full file: frontmatter + body
      const body = editor?.storage.markdown.getMarkdown() ?? ''
      const fm = fmCache.current[activeTab.path] ?? ''
      const full = fm + body
      mdCache.current[activeTab.path] = full
      setRawMd(full)
    } else {
      // Strip frontmatter before feeding back to editor.
      // Fall back to rawMd (current textarea) if mdCache somehow wasn't populated.
      const full = mdCache.current[activeTab.path] ?? rawMd
      const { frontmatter, body } = splitFrontmatter(full)
      if (frontmatter) fmCache.current[activeTab.path] = frontmatter
      savedBodyCache.current[activeTab.path] = body
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
    if (isMarkdownMode && activeTab) mdCache.current[activeTab.path] = rawMd
    flush()
    const tab: TabState = { uuid: newTabUuid(), path, scroll: 0, active: true, mode: 'wysiwyg', status: 'filed', userIntent: null, isEmpty: false, isModified: false }
    const newTabs = [...tabs, tab]
    const newIdx = newTabs.length - 1
    setTabs(newTabs)
    setActiveIdx(newIdx)
    H.current.loadTab(tab)
  }

  async function handleRefileWithAI(path: string) {
    if (tier !== 'smart') return
    try {
      const content = await LoadBuffer(path)
      let { frontmatter, body } = splitFrontmatter(content)
      
      const hasAiResult = /^ai_eval:\s*complete\b/m.test(frontmatter) || /^ai_folder_suggestion:/m.test(frontmatter)

      if (!hasAiResult) {
        console.log('[stash:ai] handleRefileWithAI: evaluating', { path })
        const rec = await EvaluateBuffer(path)
        frontmatter = setYamlField(frontmatter, 'ai_eval', 'complete')
        frontmatter = setYamlField(frontmatter, 'ai_last_evaluated', getLocalISOString())
        if (rec.title)    frontmatter = setYamlField(frontmatter, 'display_name', rec.title)
        if (rec.filename) frontmatter = setYamlField(frontmatter, 'filename', rec.filename)
        if (rec.folder)   frontmatter = setYamlField(frontmatter, 'ai_folder_suggestion', rec.folder)
        if (rec.summary)  frontmatter = setYamlField(frontmatter, 'summary', rec.summary)
        if (rec.tags && rec.tags.length > 0) frontmatter = setYamlField(frontmatter, 'tags', rec.tags)
        
        await SaveBuffer(path, frontmatter + body)
      } else {
        console.log('[stash:ai] handleRefileWithAI: using existing AI result', { path })
      }
      
      const newPath = await FileBuffer(path)

      if (fmCache.current[path]) {
        fmCache.current[newPath] = fmCache.current[path]
        delete fmCache.current[path]
      }
      if (mdCache.current[path]) {
        mdCache.current[newPath] = mdCache.current[path]
        delete mdCache.current[path]
      }
      if (savedBodyCache.current[path] !== undefined) {
        savedBodyCache.current[newPath] = savedBodyCache.current[path]
        delete savedBodyCache.current[path]
      }

      setTabs(prev => {
        const newTabs = prev.map(t => 
           t.path === path ? { ...t, path: newPath, ...parseMeta(frontmatter, body) } : t
        )
        return newTabs
      })
    } catch (e) {
      console.error('[stash:ai] refile failed', e)
    }
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
      // Threading: find source content via first ref in the chain.
      const sourceRef = aiBlockRef.split(',')[0]
      let sourceContent = ''
      if (sourceRef && sourceRef !== 'doc') {
        doc.descendants((node) => {
          if (node.attrs?.id === sourceRef) { sourceContent = node.textContent; return false }
        })
      }
      const newRef = aiBlockRef ? `${aiBlockRef},${aiBlockId}` : aiBlockId
      return {
        content: sourceContent || editor.storage.markdown.getMarkdown(),
        blockRef: newRef,
        history: doc.textBetween(from, to, '\n'),
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
      return { content: editor.storage.markdown.getMarkdown(), blockRef: 'doc', history: '', contextLabel: 'Document' }
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
      const pattern = new RegExp(`(\\[!ai\\] id="${idEscaped}"[^\\n]*)\\n\\n[\\s\\S]*?\\n\\n\\[!ai-end\\]`)
      const updatedBody = body.replace(pattern, `$1\n\n${responseText}\n\n[!ai-end]`)

      if (updatedBody === body) {
        console.warn('[stash:ai] background update: placeholder not found in file', { uuid, path, aiId })
        return
      }

      const newFm = frontmatter ? setYamlField(frontmatter, 'ai_last_evaluated', getLocalISOString()) : frontmatter
      await SaveBuffer(path, newFm + updatedBody)

      // Keep caches consistent so the next loadTab for this path is correct.
      savedBodyCache.current[path] = updatedBody
      if (newFm) fmCache.current[path] = newFm

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
    const fm = fmCache.current[path]
    if (!fm) return
    const newFm = setYamlField(fm, 'ai_last_evaluated', getLocalISOString())
    fmCache.current[path] = newFm
    const body = editor?.storage.markdown.getMarkdown() ?? savedBodyCache.current[path] ?? ''
    SaveBuffer(path, newFm + body).catch(console.error)
  }

  function explainGesture() {
    if (!editor || tier !== 'smart') return
    const ctx = buildAiContext()
    if (!ctx.content) return

    const capturedUuid = activeTabRef.current?.uuid!
    const aiId = 'ai-' + Math.random().toString(16).substring(2, 6)
    insertAiPlaceholder(aiId, ctx.blockRef)

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
        if (activeTabRef.current?.uuid !== capturedUuid) return
        console.warn('[stash:ai] explain: failed', err)
        replaceAiPlaceholder(aiId, '_(explain timed out — Ctrl+E to retry)_')
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
        if (activeTabRef.current?.uuid !== capturedUuid) return
        console.warn('[stash:ai] ask: failed', err)
        replaceAiPlaceholder(aiId, '_(ask timed out — Ctrl+Shift+A to retry)_')
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
      if (e.ctrlKey && !e.shiftKey && !e.altKey && key === 's') { e.preventDefault(); H.current.forceFile() }
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
      if (isMarkdownMode && activeTabRef.current) mdCache.current[activeTabRef.current.path] = rawMd
      
      // Attempt to save session
      flushRef.current()
      saveSessionFromRefs()
        .then(() => console.log('[stash] shutdown: session saved'))
        .catch(err => console.error('[stash] shutdown: save failed', err))
        .finally(() => {
          console.log('[stash] shutdown: calling backend AppQuit')
          AppQuit().catch(err => {
            console.error('[stash] shutdown: AppQuit failed, forcing runtime Quit', err)
            Quit() // last resort fallback
          })
        })
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
      const fm = fmCache.current[path]
      if (!fm) return
      const newFm = bumpFocusCount(fm)
      fmCache.current[path] = newFm
      const body = editor?.storage.markdown.getMarkdown() ?? ''
      SaveBuffer(path, newFm + body).catch(console.error)
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
              onRefileAI={handleRefileWithAI}
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
          onReorder={reorderTab}
        />
        {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
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
          {activeTab?.isClosing && (
            <div className="ai-eval-overlay">
               <div className="ai-eval-spinner" />
               <div className="ai-eval-text">Evaluating before close…</div>
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
                  const isMod = (val !== mdCache.current[activeTab.path])
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
              meta={fmCache.current[activeTab.path] ?? ''}
              path={activeTab.path}
              width={metaWidth}
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
    </div>
  )
}
