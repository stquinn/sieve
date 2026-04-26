import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import './lib/SmartStorables'
import { sieve as stash } from '../wailsjs/go/models'
// Backend service imports moved to line 19-25 block
import {
  GetSession, SaveSession, SaveSidebarWidth, SaveMetaWidth, SavePromptsHeight,
  TogglePrompts, SelectVault, InitVault, ShowInFilesByID
} from '../wailsjs/go/main/App'
import { BrowserOpenURL, EventsOn } from '../wailsjs/runtime/runtime'
import { NoteEntry, PromptEntry } from './types'
// MetaPanel replaced by HTMX — see #htmx-meta-panel and /api/meta handler
import { StoreSearch } from './components/StoreSearch'
import { QuickSwitcher } from './components/QuickSwitcher'
import { TimeoutPopup } from './components/TimeoutPopup'
import { TabMode, TabState, UserIntent } from './types'
import { X } from 'lucide-react'
import { EditorStats } from './components/EditorStats'
import { useAppLifecycle } from './hooks/useAppLifecycle'
import { useUiState } from './hooks/useUiState'
import { StorableDataService } from './lib/StorableDataService'
import { AiService } from './lib/AiService'
import { isMod } from './utils/platform'
export type SettingsTab = 'ai' | 'appearance' | 'editor'
import './App.css'

function getAncestorFolderIDs(noteID: string, entries: NoteEntry[]): string[] {
  function search(nodes: NoteEntry[], acc: string[]): string[] | null {
    for (const node of nodes) {
      if (node.isDir && node.children) {
        const found = search(node.children, [...acc, node.id!])
        if (found) return found
      } else if (node.id === noteID) {
        return acc
      }
    }
    return null
  }
  return search(entries, []) ?? []
}

export default function App() {
  const [tabs, setTabs]           = useState<TabState[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const [ready, setReady]         = useState(false)
  const {
    showHelp, setShowHelp, toggleHelp,
    showSidebar, setShowSidebar, toggleSidebar,
    showMeta, setShowMeta, toggleMeta,
    showPrompts, setShowPrompts, togglePrompts,
    showSearch, setShowSearch, toggleSearch,
    showQuickSwitch, setShowQuickSwitch, toggleQuickSwitch,
    sidebarMode, setSidebarMode,
    tier, setTier,
    sidebarWidth, setSidebarWidth,
    metaWidth, setMetaWidth,
    promptsHeight, setPromptsHeight,
    isDragging, setIsDragging,
    isMetaDragging, setIsMetaDragging,
    pendingClose, setPendingClose,
  } = useUiState()
  const [searchTerm, setSearchTerm]         = useState('')
  const [notes, setNotes]         = useState<NoteEntry[]>([])
  const [prompts, setPrompts]     = useState<PromptEntry[]>([])
  const [tick, setTick]                 = useState(0)
  const [storeInfo, setStoreInfo] = useState<{ root: string; themeName: string; } | null>(null)
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set())
  const [lastSettingsPanel, setLastSettingsPanel] = useState<SettingsTab>('ai')
  
  const [editorStats, setEditorStats] = useState({ chars: 0, lines: 0 })
  const dataService = useRef(new StorableDataService(() => setTick(t => t + 1)))
  const aiService   = useRef(new AiService(dataService.current, () => setTick(t => t + 1)))
  const activeTab = tabs[activeIdx]

  const focusTimer   = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Stable refs for globals exposed to HTMX sidebar and tab bar
  const openDocRef        = useRef<((id: string) => Promise<void>) | undefined>(undefined)
  const newTabRef         = useRef<(() => Promise<void>) | undefined>(undefined)
  const selectTabByIdRef  = useRef<((id: string) => void) | undefined>(undefined)
  const closeTabByIdRef   = useRef<((id: string) => void) | undefined>(undefined)
  const reorderTabsRef    = useRef<((from: number, to: number) => void) | undefined>(undefined)
  const closeAllTabsRef   = useRef<(() => void) | undefined>(undefined)
  const deleteNoteByIdRef = useRef<((id: string) => void) | undefined>(undefined)

  const autosaveMs                = useRef(30_000)
  const cliTimeoutLongMs          = useRef(60_000)
  const sidebarWidthRef           = useRef(240)
  const metaWidthRef              = useRef(260)
  const promptsHeightRef          = useRef(180)
  const tabsRef                  = useRef<TabState[]>([])
  const activeIdxRef             = useRef(0)
  const tierRef                  = useRef<'dumb' | 'smart'>('dumb')
  const readyRef                 = useRef(false)
  const lastLoadedUuid           = useRef<string>('')
  const lastLoadedMode           = useRef<string>('')
  const showSidebarRef           = useRef(true)
  const showMetaRef              = useRef(false)
  const showPromptsRef           = useRef(true)
  const openFoldersRef           = useRef<Set<string>>(new Set())
  const lastSettingsPanelRef     = useRef('ai')

  useEffect(() => { tabsRef.current = tabs }, [tabs])
  useEffect(() => { activeIdxRef.current = activeIdx }, [activeIdx])
  useEffect(() => { tierRef.current = tier }, [tier])
  useEffect(() => { readyRef.current = ready }, [ready])
  useEffect(() => { showSidebarRef.current = showSidebar }, [showSidebar])
  useEffect(() => { showMetaRef.current = showMeta }, [showMeta])
  useEffect(() => { showPromptsRef.current = showPrompts }, [showPrompts])
  useEffect(() => { openFoldersRef.current = openFolders }, [openFolders])
  useEffect(() => { lastSettingsPanelRef.current = lastSettingsPanel }, [lastSettingsPanel])

  useEffect(() => {
    if (ready) persistSession()
  }, [showSidebar, showMeta, showPrompts])

  useEffect(() => {
    if (showMeta) refreshMetaPanel(getActiveUUID())
  }, [showMeta, activeIdx])

  useEffect(() => {
    if (!showMeta) return
    const uuid = getActiveUUID()
    const isDirty = !!dataService.current.get(uuid)?.isModified
    ;(window as any).sieveSetMetaDirty?.(isDirty)
  }, [tick, showMeta])

  // Wire editor event listeners and expose AI service for editor.js
  useEffect(() => {
    const onStats = (e: Event) => setEditorStats((e as CustomEvent).detail)
    const onSaved = (e: Event) => {
      const { uuid } = (e as CustomEvent).detail ?? {}
      if (uuid) refreshMetaPanel(uuid)
    }
    document.addEventListener('editor:stats', onStats)
    document.addEventListener('editor:saved', onSaved)
    ;(window as any).__sieveAiService = aiService.current
    ;(window as any).__sieveAutosaveMs = () => autosaveMs.current
    return () => {
      document.removeEventListener('editor:stats', onStats)
      document.removeEventListener('editor:saved', onSaved)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // Load the active tab into the HTMX editor whenever it changes
  useEffect(() => {
    const tab = tabs[activeIdx]
    console.log('[App] useEffect triggered by activeIdx:', activeIdx, 'tab:', tab?.uuid)
    if (ready) {
      if (tab) {
        console.log('[App] useEffect calling loadEditor for tab:', tab.uuid)
        loadEditor(tab.uuid, tab.mode || 'wysiwyg')
      } else if (tabs.length === 0) {
        console.log('[App] useEffect: no active tab, clearing editor.')
        loadEditor('', '')
      }
    }
  }, [activeIdx, tabs.length, ready])

  // Expose stable globals so the HTMX sidebar and tab bar can call into React state
  useEffect(() => {
    ;(window as any).sieveOpenNote      = (id: string) => openDocRef.current?.(id)
    ;(window as any).sieveNewNote       = () => newTabRef.current?.()
    ;(window as any).sieveOpenSettings  = () => {
      const dlg = document.getElementById('settings-dialog') as any
      if (dlg) {
        const computed = getComputedStyle(document.documentElement);
        ['--theme-bg', '--theme-bgDark', '--theme-bgAlt', '--theme-border', '--theme-border2', '--theme-muted', '--theme-text', '--theme-textDim', '--theme-accentPrimary', '--theme-accentCyan', '--theme-accentGreen', '--theme-accentYellow', '--theme-accentOrange', '--theme-accentRed', '--theme-accentPurple'].forEach(v => {
          dlg.style.setProperty(v, computed.getPropertyValue(v));
        });
        dlg.showModal()
        const htmx = (window as any).htmx
        const target = document.getElementById('settings-dialog-content')
        if (htmx && target) {
          htmx.ajax('GET', '/api/settings', { target: target, swap: 'innerHTML' })
        }
      }
    }
    ;(window as any).sieveRenameNote = (id: string, currentName: string) => {
      const dlg = document.getElementById('rename-dialog') as any
      if (dlg) {
        const computed = getComputedStyle(document.documentElement);
        ['--theme-bg', '--theme-bgDark', '--theme-bgAlt', '--theme-border', '--theme-border2', '--theme-muted', '--theme-text', '--theme-textDim', '--theme-accentPrimary', '--theme-accentCyan', '--theme-accentGreen', '--theme-accentYellow', '--theme-accentOrange', '--theme-accentRed', '--theme-accentPurple'].forEach(v => {
          dlg.style.setProperty(v, computed.getPropertyValue(v));
        });
        dlg.showModal()
        const htmx = (window as any).htmx
        const target = document.getElementById('rename-dialog-content')
        if (htmx && target) {
          htmx.ajax('GET', '/api/sidebar/rename-prompt?id=' + encodeURIComponent(id) + '&name=' + encodeURIComponent(currentName) + '&type=note', { target: target, swap: 'innerHTML' })
        }
      }
    }
    ;(window as any).sieveRenameFolder = (id: string, currentName: string) => {
      const dlg = document.getElementById('rename-dialog') as any
      if (dlg) {
        const computed = getComputedStyle(document.documentElement);
        ['--theme-bg', '--theme-bgDark', '--theme-bgAlt', '--theme-border', '--theme-border2', '--theme-muted', '--theme-text', '--theme-textDim', '--theme-accentPrimary', '--theme-accentCyan', '--theme-accentGreen', '--theme-accentYellow', '--theme-accentOrange', '--theme-accentRed', '--theme-accentPurple'].forEach(v => {
          dlg.style.setProperty(v, computed.getPropertyValue(v));
        });
        dlg.showModal()
        const htmx = (window as any).htmx
        const target = document.getElementById('rename-dialog-content')
        if (htmx && target) {
          htmx.ajax('GET', '/api/sidebar/rename-prompt?id=' + encodeURIComponent(id) + '&name=' + encodeURIComponent(currentName) + '&type=folder', { target: target, swap: 'innerHTML' })
        }
      }
    }
    ;(window as any).sieveOpenDelete = (id: string, name: string, type: string) => {
      const dlg = document.getElementById('delete-dialog') as any
      if (dlg) {
        const computed = getComputedStyle(document.documentElement);
        ['--theme-bg', '--theme-bgDark', '--theme-bgAlt', '--theme-border', '--theme-border2', '--theme-muted', '--theme-text', '--theme-textDim', '--theme-accentPrimary', '--theme-accentCyan', '--theme-accentGreen', '--theme-accentYellow', '--theme-accentOrange', '--theme-accentRed', '--theme-accentPurple'].forEach(v => {
          dlg.style.setProperty(v, computed.getPropertyValue(v));
        });
        dlg.showModal()
        const htmx = (window as any).htmx
        const target = document.getElementById('delete-dialog-content')
        if (htmx && target) {
          htmx.ajax('GET', '/api/sidebar/delete-prompt?id=' + encodeURIComponent(id) + '&name=' + encodeURIComponent(name) + '&type=' + encodeURIComponent(type), { target: target, swap: 'innerHTML' })
        }
      }
    }
    ;(window as any).sieveShowInFiles   = (id: string) => ShowInFilesByID(id)
    ;(window as any).sieveSmartFile     = (id: string) => aiService.current?.smartFile(id)
    ;(window as any).sieveSmartMetadata = (id: string) => aiService.current?.smartMetadata(id)
    ;(window as any).sieveSelectTab     = (id: string) => selectTabByIdRef.current?.(id)
    ;(window as any).sieveCloseTab      = (id: string) => closeTabByIdRef.current?.(id)
    ;(window as any).sieveReorderTabs   = (from: number, to: number) => reorderTabsRef.current?.(from, to)
    ;(window as any).sieveHelp          = () => {
      const dlg = document.getElementById('help-dialog') as any
      if (dlg) {
        const computed = getComputedStyle(document.documentElement);
        ['--theme-bg', '--theme-bgDark', '--theme-bgAlt', '--theme-border', '--theme-border2', '--theme-muted', '--theme-text', '--theme-textDim', '--theme-accentPrimary', '--theme-accentCyan', '--theme-accentGreen', '--theme-accentYellow', '--theme-accentOrange', '--theme-accentRed', '--theme-accentPurple'].forEach(v => {
          dlg.style.setProperty(v, computed.getPropertyValue(v));
        });
        dlg.showModal()
        const htmx = (window as any).htmx
        const target = document.getElementById('help-dialog-content')
        if (htmx && target) {
          htmx.ajax('GET', '/api/help', { target: target, swap: 'innerHTML' })
        }
      }
    }
    ;(window as any).sieveOnSettingsChanged = () => {
      dataService.current.getStoreInfo().then(info => {
        setStoreInfo(info)
        setTier(info.tier === 2 ? 'smart' : 'dumb')
        cliTimeoutLongMs.current = info.cliTimeoutLong * 1000 || 20000
        autosaveMs.current = info.autosaveDebounce * 1000 || 30000
        if (info.themeVars) {
          const root = document.documentElement;
          Object.entries(info.themeVars).forEach(([key, value]) => {
            root.style.setProperty(`--theme-${key}`, value as string);
          });
        }
      })
    }
    ;(window as any).sieveCloseAllTabs  = () => closeAllTabsRef.current?.()
    ;(window as any).sieveDeleteNote    = (id: string) => deleteNoteByIdRef.current?.(id)
    ;(window as any).sieveSetMetaDirty  = (dirty: boolean) => {
      const indicator = document.getElementById('meta-dirty-indicator')
      if (!indicator) return
      const label = indicator.querySelector('.meta-dirty-label') as HTMLElement | null
      const dot   = indicator.querySelector('.meta-dirty-dot')   as HTMLElement | null
      if (dirty) {
        indicator.className = indicator.className.replace('border-tn-border', 'border-tn-yellow')
        if (!indicator.className.includes('border-tn-yellow')) indicator.className += ' border-tn-yellow'
        indicator.style.background = 'color-mix(in srgb, var(--theme-accentYellow) 10%, transparent)'
        if (label) { label.className = label.className.replace('text-tn-text-dim', 'text-tn-yellow'); label.textContent = 'Unsaved Changes' }
        if (dot)   { dot.className   = dot.className.replace('bg-tn-green', 'bg-tn-yellow'); dot.style.boxShadow = '0 0 8px var(--theme-accentYellow)' }
      } else {
        indicator.className = indicator.className.replace('border-tn-yellow', 'border-tn-border')
        indicator.style.background = ''
        if (label) { label.className = label.className.replace('text-tn-yellow', 'text-tn-text-dim'); label.textContent = 'All Changes Saved' }
        if (dot)   { dot.className   = dot.className.replace('bg-tn-yellow', 'bg-tn-green'); dot.style.boxShadow = '' }
      }
    }
    return () => {
      delete (window as any).sieveOpenNote
      delete (window as any).sieveNewNote
      delete (window as any).sieveOpenSettings
      delete (window as any).sieveShowInFiles
      delete (window as any).sieveSmartFile
      delete (window as any).sieveSmartMetadata
      delete (window as any).sieveSelectTab
      delete (window as any).sieveCloseTab
      delete (window as any).sieveReorderTabs
      delete (window as any).sieveHelp
      delete (window as any).sieveCloseAllTabs
      delete (window as any).sieveDeleteNote
      delete (window as any).sieveSetMetaDirty
    }
  }, [])

  const htmxSidebarRef = useCallback((el: HTMLDivElement | null) => {
    if (!el || !(window as any).htmx) return
    ;(window as any).htmx.ajax('GET', '/api/sidebar', { target: el, swap: 'innerHTML' })
    if (!(window as any).sieveCloseMenu) {
      const script = document.createElement('script')
      script.src = '/static/sidebar.js'
      document.body.appendChild(script)
    }
  }, [])

  const htmxTabbarRef = useCallback((el: HTMLDivElement | null) => {
    if (!el || !(window as any).htmx) return
    ;(window as any).htmx.ajax('GET', '/api/tabs', { target: el, swap: 'innerHTML' })
    if (!(window as any).sieveTabBarInit) {
      const script = document.createElement('script')
      script.src = '/static/tabbar.js'
      document.body.appendChild(script)
    }
  }, [])

  const refreshTabBar = () => {
    const htmx = (window as any).htmx
    const el = document.getElementById('htmx-tabbar')
    if (!htmx || !el) return
    htmx.ajax('GET', '/api/tabs', { target: el, swap: 'innerHTML' })
  }

  const refreshMetaPanel = (uuid: string) => {
    const htmx = (window as any).htmx
    const el = document.getElementById('htmx-meta-panel')
    if (!htmx || !el || !uuid) return
    htmx.ajax('GET', `/api/meta?uuid=${encodeURIComponent(uuid)}`, { target: el, swap: 'innerHTML' })
  }

  const loadEditor = (uuid: string, mode: string) => {
    console.log('[App] loadEditor called with uuid:', uuid, 'mode:', mode)
    if (!uuid) {
      console.log('[App] loadEditor: clearing editor.')
      const el = document.getElementById('htmx-editor')
      if (el) el.innerHTML = ''
      lastLoadedUuid.current = ''
      lastLoadedMode.current = ''
      ;(window as any).sieveInitEditor?.(null, '', '')
      return
    }
    if (lastLoadedUuid.current === uuid && lastLoadedMode.current === mode) {
      console.log('[App] loadEditor skipping duplicate load for uuid:', uuid, 'mode:', mode)
      return
    }
    lastLoadedUuid.current = uuid
    lastLoadedMode.current = mode
    const el = document.getElementById('htmx-editor')
    if (el && uuid) {
      console.log('[App] loadEditor creating mount element directly')
      el.innerHTML = `<div id="tiptap-mount" data-uuid="${uuid}" data-mode="${mode}" style="flex:1;min-height:0;height:100%;display:flex;flex-direction:column"></div>`
      const mount = el.querySelector('#tiptap-mount') as HTMLElement
      if (mount) {
        console.log('[App] loadEditor calling sieveInitEditor directly')
        ;(window as any).sieveInitEditor?.(mount, uuid, mode)
      }
    } else {
      console.warn('[App] loadEditor missing prerequisites:', { hasEl: !!el, hasUuid: !!uuid })
    }
  }

  const getActiveUUID = (): string => tabsRef.current[activeIdxRef.current]?.uuid ?? ''

  const selectTab = (idx: number) => {
    console.log('[App] selectTab called with idx:', idx, 'current activeIdx:', activeIdx)
    if (idx === activeIdx) return
    setActiveIdx(idx)
    
    const tab = tabs[idx]
    if (tab) loadEditor(tab.uuid, tab.mode || 'wysiwyg')

    persistSession({ activeIdx: idx, tabs: tabsToSession(tabs, idx) as any }).then(() => {
      refreshTabBar()
      refreshMetaPanel(tabs[idx]?.uuid ?? '')
    })
  }

  const newTab = async () => {
    try {
      const doc = await dataService.current.create()
      const tab: TabState = {
        uuid: doc.id,
        mode: 'wysiwyg',
      }
      setTabs(prev => {
        const next = [...prev, tab]
        const nextIdx = next.length - 1
        setActiveIdx(nextIdx)
        persistSession({ tabs: tabsToSession(next, nextIdx) as any, activeIdx: nextIdx }).then(refreshTabBar)
        return next
      })
    } catch (e) {
      console.error('[App] newTab failed', e)
    }
  }

  // smartFileClose is handled via AiService now, see evaluateDocument calls in EditorPanel
  const smartFileClose = async (idx: number) => {
    const currentTabs = tabsRef.current
    const tab = currentTabs[idx]
    if (!tab) return

    const doc = dataService.current.get(tab.uuid)
    const isBuffer = doc?.kind === 'buffer'
    
    // 1. Calculate new state immediately
    const nextTabs = currentTabs.filter((_, i) => i !== idx)
    const nextIdx = Math.max(0, Math.min(idx, nextTabs.length - 1))
    
    // 2. Commit UI state
    setTabs(nextTabs)
    setActiveIdx(nextIdx)
    persistSession({ activeIdx: nextIdx, tabs: tabsToSession(nextTabs, nextIdx) as any }).then(refreshTabBar)

    // 3. Trigger Smart Logic if needed (Background)
    if (doc?.isModified || isBuffer) {
      console.log('[stash:ai] Closing active buffer/modified doc, triggering evaluation.')
      aiService.current.evaluateDocument(tab.uuid, true, true, {
        onComplete: (jobId) => console.log('[stash:ai] Close-evaluation complete', jobId),
        onError: (jobId, err) => console.error('[stash:ai] Close-evaluation error', jobId, err)
      })
    }
  }

  const toggleFolder = (path: string) => {
    const next = new Set(openFolders)
    if (next.has(path)) next.delete(path)
    else next.add(path)
    setOpenFolders(next)
    persistSession({ openFolders: Array.from(next) })
  }

  const renameOpenFolder = (oldPath: string, newPath: string) => {
    const next = new Set(openFolders)
    if (next.has(oldPath)) {
      next.delete(oldPath)
      next.add(newPath)
      setOpenFolders(next)
      persistSession({ openFolders: Array.from(next) })
    }
  }

  const tabsToSession = (tabList: TabState[], activeIndex: number) =>
    tabList.map((t, i) => ({
      id: t.uuid,
      active: i === activeIndex,
      mode: t.mode,
      displayName: dataService.current.get(t.uuid)?.meta?.displayName ?? '',
      status: dataService.current.get(t.uuid)?.meta?.status ?? '',
      userIntent: dataService.current.get(t.uuid)?.meta?.userIntent ?? '',
    }))

  // Persistence guard: prevents overwriting saved session with empty initial state on launch
  const persistSession = async (overrides?: Partial<stash.Session>) => {
    if (!readyRef.current) return

    const session: stash.Session = {
      activeIdx: activeIdxRef.current,
      tabs: tabsToSession(tabsRef.current, activeIdxRef.current) as any,
      sidebarWidth: sidebarWidthRef.current,
      metaWidth: metaWidthRef.current,
      promptsHeight: promptsHeightRef.current,
      showSidebar: showSidebarRef.current,
      showMeta: showMetaRef.current,
      showPrompts: showPromptsRef.current,
      openFolders: Array.from(openFoldersRef.current),
      lastSettingsPanel: lastSettingsPanelRef.current,
      ...overrides
    } as stash.Session
    await SaveSession(session).catch(console.error)
  }

  const openDoc = async (id: string) => {
    const existingIdx = tabs.findIndex(t => t.uuid === id)
    if (existingIdx !== -1) {
      selectTab(existingIdx)
      return
    }

    try {
      const doc = await dataService.current.loadByID(id)
      const tab: TabState = { uuid: doc.id, mode: 'wysiwyg' }
      const nextTabs = [...tabs, tab]
      setTabs(nextTabs)
      setActiveIdx(nextTabs.length - 1)
      persistSession({ tabs: tabsToSession(nextTabs, nextTabs.length - 1) as any, activeIdx: nextTabs.length - 1 }).then(refreshTabBar)
    } catch (e) {
      console.error('[App] openDoc failed', e)
    }
  }

  // Keep HTMX bridge refs current so the sidebar and tab bar can call into React state
  useEffect(() => { openDocRef.current = openDoc }, [openDoc])
  useEffect(() => { newTabRef.current = newTab }, [newTab])
  useEffect(() => {
    selectTabByIdRef.current = (id: string) => {
      console.log('[App] selectTabByIdRef called with id:', id)
      const idx = tabsRef.current.findIndex(t => t.uuid === id)
      console.log('[App] selectTabByIdRef mapped id to idx:', idx, 'current activeIdxRef:', activeIdxRef.current)
      if (idx === -1 || idx === activeIdxRef.current) return
      setActiveIdx(idx)
      
      const tab = tabsRef.current[idx]
      if (tab) loadEditor(tab.uuid, tab.mode || 'wysiwyg')

      persistSession({ activeIdx: idx, tabs: tabsToSession(tabsRef.current, idx) as any }).then(refreshTabBar)
    }
  }, [])
  useEffect(() => {
    closeTabByIdRef.current = (id: string) => {
      const idx = tabsRef.current.findIndex(t => t.uuid === id)
      if (idx === -1) return
      smartFileClose(idx)
    }
  }, [smartFileClose])
  useEffect(() => {
    reorderTabsRef.current = (oldIdx: number, newIdx: number) => {
      const current = tabsRef.current
      const next = [...current]
      const [moved] = next.splice(oldIdx, 1)
      next.splice(newIdx, 0, moved)
      setTabs(next)
      let finalIdx = activeIdxRef.current
      if (finalIdx === oldIdx) finalIdx = newIdx
      else if (finalIdx > oldIdx && finalIdx <= newIdx) finalIdx = finalIdx - 1
      else if (finalIdx < oldIdx && finalIdx >= newIdx) finalIdx = finalIdx + 1
      setActiveIdx(finalIdx)
      persistSession({ activeIdx: finalIdx, tabs: tabsToSession(next, finalIdx) as any }).then(refreshTabBar)
    }
  }, [])
  useEffect(() => {
    closeAllTabsRef.current = async () => {
      for (const t of tabsRef.current) {
        await dataService.current.save(t.uuid).catch(console.error)
      }
      const doc = await dataService.current.create()
      const tab: TabState = { uuid: doc.id, mode: 'wysiwyg' }
      setTabs([tab])
      setActiveIdx(0)
      persistSession({ activeIdx: 0, tabs: tabsToSession([tab], 0) as any }).then(refreshTabBar)
    }
  }, [])
  useEffect(() => {
    deleteNoteByIdRef.current = async (id: string) => {
      await dataService.current.discard(id).catch(console.error)
      const idx = tabsRef.current.findIndex(t => t.uuid === id)
      if (idx !== -1) smartFileClose(idx)
    }
  }, [smartFileClose])

  const openByPath = async (path: string) => {
    try {
      const doc = await dataService.current.load(path)
      await openDoc(doc.id)
    } catch (e) {
      console.error('[App] openByPath failed', e)
    }
  }

  const handlers = useRef<{
    newTab: () => Promise<void>
    closeTab: () => Promise<void>
    save: () => Promise<void>
    toggleMode: () => void
    smartFile: () => void
    smartMetadata: () => void
    keepAndSmartFile: () => Promise<void>
  }>(null as any)

  useLayoutEffect(() => {
    handlers.current = {
      newTab,
      closeTab: () => smartFileClose(activeIdxRef.current),
      save: async () => {
        ;(window as any).sieveEditor?.save()
      },
      toggleMode: () => {
        const idx = activeIdxRef.current
        const tab = tabsRef.current[idx]
        if (!tab) return
        const newMode = (tab.mode === 'wysiwyg' ? 'markdown' : 'wysiwyg') as TabMode
        setTabs(prev => {
          const next = prev.map((t, i) => i === idx ? { ...t, mode: newMode } : t) as TabState[]
          loadEditor(tab.uuid, newMode)
          persistSession({ activeIdx: idx, tabs: tabsToSession(next, idx) as any }).then(refreshTabBar)
          return next
        })
      },
      smartFile: () => {
        const uuid = tabsRef.current[activeIdxRef.current]?.uuid
        if (uuid) aiService.current.smartFile(uuid)
      },
      smartMetadata: () => {
        const uuid = tabsRef.current[activeIdxRef.current]?.uuid
        if (uuid) aiService.current.smartMetadata(uuid)
      },
      keepAndSmartFile: async () => {
        const uuid = tabsRef.current[activeIdxRef.current]?.uuid
        if (uuid) aiService.current.keepAndFile(uuid)
      }
    }
  })



  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      const mod = isMod(e)
      console.log(`[stash:key] ${mod?'Mod+':''}${e.shiftKey?'Shift+':''}${key} (code: ${e.code}, kc: ${e.keyCode})`)

      if (mod && key === 'n') { e.preventDefault(); handlers.current.newTab() }
      if (mod && (key === 'w' || e.code === 'KeyW')) { 
        e.preventDefault(); 
        e.stopImmediatePropagation();
        handlers.current.closeTab(); 
      }
      if (mod && key === 's') { e.preventDefault(); handlers.current.save() }
      if (mod && key === ',') { e.preventDefault(); (window as any).sieveOpenSettings?.() }
      if (mod && e.shiftKey && key === 'm') { e.preventDefault(); handlers.current.toggleMode() }
      if (mod && (key === 'p' || e.code === 'KeyP') && !e.shiftKey) { e.preventDefault(); setShowQuickSwitch(v => !v) }
      if (mod && e.shiftKey && (key === 'p' || e.code === 'KeyP')) { 
        e.preventDefault(); 
        setShowPrompts(prev => !prev)
      }
      if (mod && (key === '\\' || e.code === 'Backslash')) { 
        e.preventDefault(); 
        setShowSidebar(prev => !prev)
      }
      if (mod && e.shiftKey && (key === 'i' || e.code === 'KeyI')) { 
        e.preventDefault(); 
        setShowMeta(prev => !prev)
      }
      if (mod && (key === '/' || key === '?' || e.code === 'Slash' || e.keyCode === 191)) { 
        e.preventDefault(); 
        e.stopImmediatePropagation();
        console.log('[stash:ui] Toggling Help Modal...');
        (window as any).sieveHelp?.()
      }
      if (mod && key === 'f' && !e.shiftKey) { e.preventDefault(); toggleSearch() }
      if (mod && e.shiftKey && key === 'f') { 
        e.preventDefault(); 
        setSidebarMode('search'); 
        setShowSidebar(true); 
      }

      // AI Gestures (Globalized for focus-independence)
      if (mod && e.shiftKey && key === 'e') { 
        e.preventDefault(); 
        handlers.current.smartFile(); 
      }
      if (mod && e.shiftKey && key === 'enter') { 
        e.preventDefault(); 
        handlers.current.keepAndSmartFile(); 
      }
    }
    window.addEventListener('keydown', onKeyDown, { capture: true })
    return () => window.removeEventListener('keydown', onKeyDown, { capture: true })
  }, [])

  useEffect(() => {
    dataService.current.getStoreInfo().then(info => {
      console.log('[App] Store Info loaded:', info)
      setStoreInfo(info)
      tierRef.current = (info.tier === 2 ? 'smart' : 'dumb') as any
      setTier((info.tier === 2 ? 'smart' : 'dumb') as any)
      //settings are in seconds convert to milliseconds
      cliTimeoutLongMs.current = info.cliTimeoutLong * 1000 || 20000
      autosaveMs.current = info.autosaveDebounce * 1000 || 30000

      // Live apply theme variables
      if (info.themeVars) {
        const root = document.documentElement;
        Object.entries(info.themeVars).forEach(([key, value]) => {
          root.style.setProperty(`--theme-${key}`, value as string);
        });
      }
      
      console.log('[App] Initializing session...')
      GetSession().then(async session => {
        try {
          setPromptsHeight(session.promptsHeight || 180)
          promptsHeightRef.current = session.promptsHeight || 180
          if (session.tabs?.length) {
            console.log('[App] Restoring tabs:', session.tabs.length)
            const st = (session.tabs as any[])
              .map(t => ({ uuid: t.id || t.uuid, mode: t.mode || 'wysiwyg' } as TabState))
            
            if (st.length > 0) {
              setTabs(st)
              const restoredIdx = session.activeIdx !== undefined ? session.activeIdx : (session.tabs as any[]).findIndex((t: any) => t.active)
              setActiveIdx(Math.max(0, Math.min(restoredIdx, st.length - 1)))
              
              await Promise.all((session.tabs as any[]).map(async t => {
                const uuid = t.id || t.uuid
                if (!uuid) return
                if (dataService.current.get(uuid)) return
                try {
                  await dataService.current.loadByID(uuid)
                } catch {
                  // fallback for old sessions that only stored path
                  if (t.path) {
                    try { await dataService.current.load(t.path) } catch (e2) {
                      console.error('[App] restore: failed to load tab', uuid, e2)
                    }
                  }
                }
              }))
            }
          }
          if (session.openFolders) setOpenFolders(new Set(session.openFolders))
          if (session.showSidebar !== undefined) setShowSidebar(session.showSidebar)
          if (session.showMeta !== undefined) setShowMeta(session.showMeta)
          if (session.showPrompts !== undefined) setShowPrompts(session.showPrompts)
          if (session.sidebarWidth) { setSidebarWidth(session.sidebarWidth); sidebarWidthRef.current = session.sidebarWidth }
          if (session.metaWidth) { setMetaWidth(session.metaWidth); metaWidthRef.current = session.metaWidth }
          if (session.promptsHeight) { setPromptsHeight(session.promptsHeight); promptsHeightRef.current = session.promptsHeight }
          if (session.lastSettingsPanel) setLastSettingsPanel(session.lastSettingsPanel as SettingsTab)
        } catch (e) {
          console.error('[App] Critical failure during session restoration:', e)
        } finally {
          console.log('[App] Startup complete, setting ready.')
          setReady(true)
        }
      })
    })
    const fNotes = () => dataService.current.getNotes().then(res => setNotes(res || []))
    const fPrompts = () => dataService.current.getPrompts().then(res => setPrompts(res || []))
    fNotes(); fPrompts()
    const u1 = EventsOn('notes:changed', fNotes)
    const u2 = EventsOn('prompts:changed', fPrompts)

    // SSE connection for HTMX sidebar + tab bar refresh on notes:changed.
    const es = new EventSource('/sse')
    es.addEventListener('notes:changed', () => {
      const htmx = (window as any).htmx
      const sidebar = document.getElementById('htmx-sidebar')
      if (htmx && sidebar) htmx.ajax('GET', '/api/sidebar', { target: sidebar, swap: 'innerHTML' })
      refreshTabBar()
    })

    // When any sidebar HTMX action settles (intent change, rename, delete),
    // also refresh the tab bar so labels/dots stay in sync.
    // When the tab bar itself settles, re-init drag/overflow handlers.
    const onAfterSettle = (e: Event) => {
      const target = (e as CustomEvent).detail?.target as HTMLElement | undefined
      console.log('[App] onAfterSettle fired for target:', target?.id, 'classes:', target?.className)
      if (!target) return
      if (target.id === 'htmx-tabbar') {
        ;(window as any).sieveTabBarInit?.()
      } else if (target.id === 'htmx-sidebar' || target.closest?.('#htmx-sidebar')) {
        refreshTabBar()
      } else if (target.id === 'htmx-meta-panel') {
        const uuid = tabsRef.current[activeIdxRef.current]?.uuid ?? ''
        const isDirty = !!dataService.current.get(uuid)?.isModified
        ;(window as any).sieveSetMetaDirty?.(isDirty)
      } else if (target.id === 'htmx-editor') {
        const mount = target.querySelector('#tiptap-mount') as HTMLElement | null
        console.log('[App] onAfterSettle found mount in htmx-editor:', !!mount)
        if (mount) {
          const uuid = mount.getAttribute('data-uuid') ?? ''
          const mode = mount.getAttribute('data-mode') ?? 'wysiwyg'
          console.log('[App] onAfterSettle calling sieveInitEditor for uuid:', uuid)
          ;(window as any).sieveInitEditor?.(mount, uuid, mode)
        }
      }
    }
    document.addEventListener('htmx:afterSettle', onAfterSettle)

    const onEditorRestore = (e: Event) => {
      const { body } = (e as CustomEvent).detail ?? {}
      if (typeof body !== 'string') return
      ;(window as any).sieveEditor?.setContent(body)
    }
    document.body.addEventListener('editor:restore', onEditorRestore)

    return () => {
      u1(); u2(); es.close()
      document.removeEventListener('htmx:afterSettle', onAfterSettle)
      document.body.removeEventListener('editor:restore', onEditorRestore)
    }
  }, [])

  const onRestorePrompt = async (name: string) => {
    await dataService.current.deletePrompt(name)
    await dataService.current.getPrompts().then(setPrompts)
    const promptID = `prompt:${name}`
    const entry = tabs.find(t => t.uuid === promptID)
    if (entry) {
      dataService.current.evict(entry.uuid)
      await dataService.current.loadByID(promptID)
      setTick(t => t + 1)
    }
  }

  useAppLifecycle({
    activeIdx,
    tabs,
    tabsRef,
    activeIdxRef,
    tierRef,
    cliTimeoutLongMs,
    focusTimer,
    persistSession,
    setPendingClose,
    dataService: dataService.current,
    aiService: aiService.current
  })


  if (!ready) return <div className="loading-screen" />

  if (!storeInfo?.root) {
     return (
       <div className="bootstrap-screen">
         <h1>Welcome to Stash</h1>
         <p>Select a folder to use as your Store.</p>
         <button onClick={async () => {
           const path = await SelectVault()
           if (path) {
             await InitVault(path)
             window.location.reload()
           }
         }}>Initialize Store</button>
       </div>
     )
  }

  console.log('[App] Rendering main UI. Tabs:', tabs.length, 'ActiveIdx:', activeIdx)

  return (
    <div
      id="app-root"
      className={`theme-${storeInfo?.themeName || 'default'} tier-${tier}`}
      style={{ 
        '--sidebar-w': `${showSidebar ? sidebarWidth : 0}px`,
        '--meta-w': `${showMeta ? metaWidth : 0}px`
      } as any}
    >
      {showSidebar && (
        <>
          {sidebarMode === 'files' ? (
            <div
              id="htmx-sidebar"
              className="sidebar"
              style={{ width: `${sidebarWidth}px` }}
              ref={htmxSidebarRef}
            />
          ) : (
            <StoreSearch
              width={sidebarWidth}
              onOpen={async p => { await openByPath(p); setSidebarMode('files') }}
              onClose={() => setSidebarMode('files')}
              dataService={dataService.current}
            />
          )}
          <div className={`sidebar-handle ${isDragging ? 'dragging' : ''}`} onMouseDown={e => {
            const startX = e.clientX
            const startW = sidebarWidth
            const mm = (me: MouseEvent) => {
              const w = Math.max(160, Math.min(500, startW + (me.clientX - startX)))
              setSidebarWidth(w)
              sidebarWidthRef.current = w
            }
            const mu = () => { 
              window.removeEventListener('mousemove', mm); 
              window.removeEventListener('mouseup', mu); 
              SaveSidebarWidth(sidebarWidthRef.current);
              persistSession({ sidebarWidth: sidebarWidthRef.current });
            }
            window.addEventListener('mousemove', mm); window.addEventListener('mouseup', mu)
          }} />
        </>
      )}

      <div id="right-panel">
        <div
          id="htmx-tabbar"
          ref={htmxTabbarRef}
          className="flex items-stretch bg-tn-bg-dark border-0 border-t border-b border-solid border-tn-border-2 h-[44px] shrink-0"
        />

        <QuickSwitcher
          isOpen={showQuickSwitch}
          onClose={() => setShowQuickSwitch(false)}
          onSelect={openDoc}
          tabs={tabs.map(t => {
            const doc = dataService.current.get(t.uuid)
            return {
              uuid: t.uuid,
              mode: t.mode,
              displayName: doc?.meta?.displayName,
              status: doc?.meta?.status as any,
            }
          })}
          notesTree={notes}
        />

        <dialog id="settings-dialog" style={{ background: 'transparent', border: 'none', padding: 0, outline: 'none' }}>
          <div id="settings-dialog-content" style={{ background: 'var(--theme-bgDark)', width: '600px', borderRadius: '8px', overflow: 'hidden', boxShadow: '0 8px 40px rgba(0,0,0,0.6)' }} />
        </dialog>

        <dialog id="help-dialog" style={{ background: 'transparent', border: 'none', padding: 0, outline: 'none' }}>
          <div id="help-dialog-content" style={{ background: 'var(--theme-bgDark)', width: '90vw', borderRadius: '8px', overflow: 'hidden', boxShadow: '0 8px 40px rgba(0,0,0,0.6)' }} />
        </dialog>

        <dialog id="rename-dialog" style={{ background: 'transparent', border: 'none', padding: 0, outline: 'none' }}>
          <div id="rename-dialog-content" style={{ background: 'var(--theme-bgDark)', width: '450px', borderRadius: '8px', overflow: 'hidden', boxShadow: '0 8px 40px rgba(0,0,0,0.6)' }} />
        </dialog>

        <dialog id="delete-dialog" style={{ background: 'transparent', border: 'none', padding: 0, outline: 'none' }}>
          <div id="delete-dialog-content" style={{ background: 'var(--theme-bgDark)', width: '450px', borderRadius: '8px', overflow: 'hidden', boxShadow: '0 8px 40px rgba(0,0,0,0.6)' }} />
        </dialog>

        <div className="editor-area">
           {showSearch && activeTab && (
            <div className="search-bar">
              <input 
                autoFocus 
                className="search-bar__input" 
                placeholder="Find in note..." 
                value={searchTerm}
                onChange={e => {
                  const val = e.target.value
                  setSearchTerm(val)
                  ;(window as any).sieveEditor?.setSearchTerm(val)
                }}
                onKeyDown={e => {
                  if (e.key === 'Escape') {
                    setShowSearch(false)
                    setSearchTerm('')
                    ;(window as any).sieveEditor?.clearSearch()
                  }
                }} />
              <button onClick={() => {
                setShowSearch(false)
                setSearchTerm('')
                ;(window as any).sieveEditor?.clearSearch()
              }}><X size={16} /></button>
            </div>
          )}

          <div
            id="htmx-editor"
            className="editor-wrapper"
            style={{ flex: 1, minHeight: 0, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}
          />

          {showMeta && activeTab && (
            <>
              <div className="meta-handle" onMouseDown={e => {
                const startX = e.clientX
                const startW = metaWidth
                const mm = (me: MouseEvent) => {
                  const w = Math.max(200, Math.min(600, startW - (me.clientX - startX)))
                  setMetaWidth(w)
                  metaWidthRef.current = w
                }
                const mu = () => { 
                  window.removeEventListener('mousemove', mm); 
                  window.removeEventListener('mouseup', mu); 
                  SaveMetaWidth(metaWidthRef.current);
                  persistSession({ metaWidth: metaWidthRef.current });
                }
                window.addEventListener('mousemove', mm); window.addEventListener('mouseup', mu)
              }} />
              <div
                id="htmx-meta-panel"
                style={{ width: metaWidth }}
                className="flex flex-col flex-shrink-0 overflow-hidden bg-tn-bg-dark border-l border-tn-border text-base"
              />
            </>
          )}
        </div>
        <div className="status-bar">
          <div className="status-bar__left">
            {/* Context-specific tab spinners */}
            {tabs.filter(t => dataService.current.get(t.uuid)?.meta?.status === 'evaluating' || dataService.current.getTransient(t.uuid).isWaitingAI).map(t => (
              <div key={t.uuid} className="status-bar__item">
                <span className="status-bar__spinner" />
                {dataService.current.getTransient(t.uuid).aiJobName || 'AI'}...
              </div>
            ))}
            
            {/* Global Background Job Count (for tasks whose tabs might be closed) */}
            {aiService.current.getPendingCount() > 0 && (
               <div className="status-bar__item status-bar__global-ai">
                 <span className="status-bar__spinner" />
                 {aiService.current.getPendingCount()} background task{aiService.current.getPendingCount() > 1 ? 's' : ''}...
               </div>
            )}
          </div>
          <div className="status-bar__right">
            {activeTab && (
              <EditorStats chars={editorStats.chars} lines={editorStats.lines} />
            )}
          </div>
        </div>
      </div>

      {pendingClose && (
        <div className="pending-close-backdrop">
          <div className="pending-close-dialog">
            <div className="pending-close-title">Finishing AI evaluation…</div>
            <div className="pending-close-body">
              Stash is waiting for AI jobs to complete before closing.
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
