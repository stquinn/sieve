import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import './lib/SmartStorables'
import { EditorPanel, EditorPanelHandle } from './components/EditorPanel'
import { stash } from '../wailsjs/go/models'
// Backend service imports moved to line 19-25 block
import { 
  GetSession, SaveSession, SaveSidebarWidth, SaveMetaWidth, SavePromptsHeight, 
  ShowInFiles, TogglePrompts, SelectVault, InitVault
} from '../wailsjs/go/main/App'
import { BrowserOpenURL, EventsOn } from '../wailsjs/runtime/runtime'
import { TabBar } from './components/TabBar'
import { HelpModal } from './components/HelpModal'
import { Sidebar, NoteEntry, PromptEntry } from './components/Sidebar'
import { MetaPanel } from './components/MetaPanel'
import { StoreSearch } from './components/StoreSearch'
import { QuickSwitcher } from './components/QuickSwitcher'
import { TimeoutPopup } from './components/TimeoutPopup'
import { TabState, UserIntent } from './types'
import { ModalProvider } from './lib/ModalContext'
import { X } from 'lucide-react'
import { EditorStats } from './components/EditorStats'
import { useAppLifecycle } from './hooks/useAppLifecycle'
import { useUiState } from './hooks/useUiState'
import { StorableDataService } from './lib/StorableDataService'
import { AiService } from './lib/AiService'
import { isMod } from './utils/platform'
import { getAncestorPaths } from './lib/fmUtils'
import { SettingsModal, SettingsTab } from './components/SettingsModal'
import './App.css'

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
  const [showSettings, setShowSettings] = useState(false)
  const [searchTerm, setSearchTerm]         = useState('')
  const [notes, setNotes]         = useState<NoteEntry[]>([])
  const [prompts, setPrompts]     = useState<PromptEntry[]>([])
  const [tick, setTick]                 = useState(0)
  const [storeInfo, setStoreInfo] = useState<{ root: string; themeName: string; } | null>(null)
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set())
  const [lastSettingsPanel, setLastSettingsPanel] = useState<SettingsTab>('ai')
  
  const dataService = useRef(new StorableDataService(() => setTick(t => t + 1)))
  const aiService   = useRef(new AiService(dataService.current, () => setTick(t => t + 1)))
  const editorRefs = useRef<Map<string, EditorPanelHandle>>(new Map())
  const activeTab = tabs[activeIdx]
  const isMarkdownMode = activeTab?.mode === 'markdown'

  const uuidToPath = useRef<Map<string, string>>(new Map())
  const focusTimer   = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const next = new Map<string, string>()
    tabs.forEach(t => {
      const path = dataService.current.get(t.uuid)?.path
      if (path) next.set(t.uuid, path)
    })
    uuidToPath.current = next
  }, [tabs, tick])

  const autosaveMs                = useRef(30_000)
  const cliTimeoutLongMs          = useRef(60_000)
  const sidebarWidthRef           = useRef(240)
  const metaWidthRef              = useRef(260)
  const promptsHeightRef          = useRef(180)
  const tabsRef                  = useRef<TabState[]>([])
  const activeIdxRef             = useRef(0)
  const tierRef                  = useRef<'dumb' | 'smart'>('dumb')
  const readyRef                 = useRef(false)
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

  const selectTab = (idx: number) => {
    if (idx === activeIdx) return
    setActiveIdx(idx)
    persistSession({ activeIdx: idx })
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
        setActiveIdx(next.length - 1)
        persistSession({ tabs: next.map((t, i) => ({ 
          id: t.uuid, 
          path: dataService.current.get(t.uuid)?.path || '',
          active: i === next.length - 1,
          mode: t.mode
        })) as any, activeIdx: next.length - 1 })
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
    persistSession({ 
      activeIdx: nextIdx, 
      tabs: nextTabs.map((t, i) => ({
        id: t.uuid,
        path: dataService.current.get(t.uuid)?.path || '',
        active: i === nextIdx,
        mode: t.mode
      })) as any 
    })

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

  // Persistence guard: prevents overwriting saved session with empty initial state on launch
  const persistSession = async (overrides?: Partial<stash.Session>) => {
    if (!readyRef.current) return

    const session: stash.Session = {
      activeIdx: activeIdxRef.current,
      tabs: tabsRef.current.map((t, i) => ({ 
        id: t.uuid, 
        path: dataService.current.get(t.uuid)?.path || '',
        active: i === activeIdxRef.current,
        mode: t.mode
      })) as any,
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

  const openNote = async (path: string) => {
    const existingIdx = tabs.findIndex(t => dataService.current.get(t.uuid)?.path === path)
    if (existingIdx !== -1) {
      selectTab(existingIdx)
      return
    }

    try {
      const doc = await dataService.current.load(path)
      const tab: TabState = { uuid: doc.id, mode: 'wysiwyg' }
      const nextTabs = [...tabs, tab]
      setTabs(nextTabs)
      setActiveIdx(nextTabs.length - 1)
      persistSession({ tabs: nextTabs.map((t, i) => ({ 
        id: t.uuid, 
        path: dataService.current.get(t.uuid)?.path || '',
        active: i === nextTabs.length - 1,
        mode: t.mode
      })) as any, activeIdx: nextTabs.length - 1 })
    } catch (e) {
      console.error('[App] openNote failed', e)
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
        const uuid = tabsRef.current[activeIdxRef.current]?.uuid
        if (uuid) await dataService.current.save(uuid).catch(console.error)
      },
      toggleMode: () => {
        const idx = activeIdxRef.current
        const tab = tabsRef.current[idx]
        if (!tab) return
        const newMode = tab.mode === 'wysiwyg' ? 'markdown' : 'wysiwyg'
        setTabs(prev => prev.map((t, i) => i === idx ? { ...t, mode: newMode } : t))
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
      if (mod && key === ',') { e.preventDefault(); setShowSettings(true) }
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
        toggleHelp() 
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
                try {
                  if (!uuid) return
                  if (!dataService.current.get(uuid)) {
                    await dataService.current.load(t.path)
                  }
                } catch (e) {
                  console.error('[App] restore: failed to load tab', t.path, e)
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
    return () => { u1(); u2() }
  }, [])

  const onRestorePrompt = async (name: string) => {
    await dataService.current.deletePrompt(name)
    await dataService.current.getPrompts().then(setPrompts)
    const path = `prompt:${name}`
    const entry = tabs.find(t => uuidToPath.current.get(t.uuid) === path)
    if (entry) {
      await dataService.current.evict(entry.uuid)
      await dataService.current.load(path)
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

  useEffect(() => {
    if (!activeTab?.uuid) return
    const doc = dataService.current.get(activeTab.uuid)
    const path = doc?.path
    if (!path) return
    const ancestors = getAncestorPaths(path)
    if (ancestors.length > 0) {
      setOpenFolders(prev => {
        const next = new Set(prev)
        let changed = false
        for (const p of ancestors) {
          if (!next.has(p)) { next.add(p); changed = true }
        }
        return changed ? next : prev
      })
    }
  }, [activeTab?.uuid, tick])

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
    <ModalProvider>
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
            <Sidebar
              dataService={dataService.current}
              aiService={aiService.current}
              entries={notes}
              activePath={activeTab ? dataService.current.get(activeTab.uuid)?.path : undefined}
              openPaths={new Set(tabs.map(t => dataService.current.get(t.uuid)?.path).filter(Boolean) as string[])}
              openFolders={openFolders}
              onToggleFolder={toggleFolder}
              onRenameFolder={renameOpenFolder}
              onOpen={openNote}
              width={sidebarWidth}
              showPrompts={showPrompts && tier === 'smart'}
              prompts={prompts}
              onEditPrompt={async (name) => {
                const uuid = `prompt:${name}`
                const existingIdx = tabs.findIndex(t => t.uuid === uuid)
                if (existingIdx !== -1) {
                  selectTab(existingIdx)
                  return
                }
                const doc = await dataService.current.load(`prompt:${name}`)
                const tab: TabState = { uuid: doc.id, mode: 'markdown' }
                const nextTabs = [...tabs, tab]
                setTabs(nextTabs)
                setActiveIdx(nextTabs.length - 1)
              }}
              promptsHeight={promptsHeight}
              onPromptsResize={h => { 
                setPromptsHeight(h); 
                promptsHeightRef.current = h;
                SavePromptsHeight(h);
                persistSession({ promptsHeight: h }); 
              }}
              setNotes={setNotes}
              setPrompts={setPrompts}
              onOpenSettings={() => setShowSettings(true)}
              onNew={newTab}
            />
          ) : (
            <StoreSearch
              width={sidebarWidth}
              onOpen={p => { openNote(p); setSidebarMode('files') }}
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
        <TabBar
          tabs={tabs}
          activeIdx={activeIdx}
          dataService={dataService.current}
          aiService={aiService.current}
          onSelect={selectTab}
          onClose={smartFileClose}
          onNew={newTab}
          onHelp={() => setShowHelp(v => !v)}
          onSetIntent={(uuid, intent) => dataService.current.setIntent(uuid, intent)}
          onReorder={(oldIdx, newIdx) => {
            const next = [...tabs]
            const [moved] = next.splice(oldIdx, 1)
            next.splice(newIdx, 0, moved)
            setTabs(next)
            let finalIdx = activeIdx
            if (activeIdx === oldIdx) finalIdx = newIdx
            else if (activeIdx > oldIdx && activeIdx <= newIdx) finalIdx = activeIdx - 1
            else if (activeIdx < oldIdx && activeIdx >= newIdx) finalIdx = activeIdx + 1
            setActiveIdx(finalIdx)
            persistSession({ activeIdx: finalIdx, tabs: next.map((t, i) => ({
              id: t.uuid,
              path: dataService.current.get(t.uuid)?.path || '',
              active: i === finalIdx,
              mode: t.mode
            })) as any })
          }}
          onCloseAll={async () => {
             for (const t of tabs) {
               await dataService.current.save(t.uuid).catch(console.error)
             }
             const doc = await dataService.current.create()
             const tab: TabState = { uuid: doc.id, mode: 'wysiwyg' }
             setTabs([tab])
             setActiveIdx(0)
             persistSession({ activeIdx: 0, tabs: [{ id: doc.id, path: doc.path, active: true, mode: 'wysiwyg' }] as any })
          }}
        />

        {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
        {showSettings && (
          <SettingsModal 
            onClose={() => setShowSettings(false)} 
            dataService={dataService.current} 
            activeTab={lastSettingsPanel}
            onTabChange={tab => { setLastSettingsPanel(tab); persistSession({ lastSettingsPanel: tab }); }}
            onSettingsChanged={() => {
              dataService.current.getStoreInfo().then(info => {
                setStoreInfo(info)
                setTier(info.tier === 2 ? 'smart' : 'dumb')
                cliTimeoutLongMs.current = info.cliTimeoutLong * 1000 || 20000
                autosaveMs.current = info.autosaveDebounce * 1000 || 30000
                
                // Live apply theme variables
                if (info.themeVars) {
                  const root = document.documentElement;
                  Object.entries(info.themeVars).forEach(([key, value]) => {
                    root.style.setProperty(`--theme-${key}`, value as string);
                  });
                }
              })
            }}
          />
        )}
        
        <QuickSwitcher
          isOpen={showQuickSwitch}
          onClose={() => setShowQuickSwitch(false)}
          onSelect={openNote}
          tabs={tabs.map(t => {
            const doc = dataService.current.get(t.uuid)
            return {
              uuid: t.uuid,
              mode: t.mode,
              path: doc?.path || t.uuid,
              status: doc?.meta?.status as any,
              isEvaluating: doc?.meta?.status === 'evaluating',
              isWaitingAI: dataService.current.getTransient(t.uuid).isWaitingAI
            }
          })}
          notesTree={notes}
        />

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
                  const uuid = tabsRef.current[activeIdxRef.current]?.uuid
                  const editor = uuid ? editorRefs.current.get(uuid) : null
                  if (editor) editor.setSearchTerm(val)
                }}
                onKeyDown={e => {
                  if (e.key === 'Escape') {
                    setShowSearch(false)
                    setSearchTerm('')
                    const uuid = tabsRef.current[activeIdxRef.current]?.uuid
                    const editor = uuid ? editorRefs.current.get(uuid) : null
                    if (editor) editor.clearSearch()
                  }
                }} />
              <button onClick={() => {
                setShowSearch(false)
                setSearchTerm('')
                const uuid = tabsRef.current[activeIdxRef.current]?.uuid
                const editor = uuid ? editorRefs.current.get(uuid) : null
                if (editor) editor.clearSearch()
              }}><X size={16} /></button>
            </div>
          )}

          <div id="app" className="editor-wrapper">
            {tabs.filter(t => typeof t.uuid === 'string' && t.uuid.length > 0).map((t, i) => (
              <div 
                key={t.uuid} 
                style={{ display: i === activeIdx ? 'contents' : 'none' }}
              >
                <EditorPanel
                  ref={ref => { if (ref) editorRefs.current.set(t.uuid, ref); else editorRefs.current.delete(t.uuid) }}
                  uuid={t.uuid}
                  mode={t.mode}
                  dataService={dataService.current}
                  isActive={i === activeIdx}
                  tick={tick}
                  tier={tier}
                  aiService={aiService.current}
                  autosaveMs={autosaveMs.current}
                />
              </div>
            ))}
          </div>

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
              <MetaPanel
                key={activeTab.uuid}
                meta={dataService.current.get(activeTab.uuid)?.meta ?? null}
                versions={dataService.current.get(activeTab.uuid)?.versions ?? []}
                path={dataService.current.get(activeTab.uuid)?.path ?? ''}
                width={metaWidth}
                isModified={dataService.current.get(activeTab.uuid)?.isModified ?? false}
                isEvaluating={dataService.current.get(activeTab.uuid)?.meta?.status === 'evaluating'}
                isWaitingAI={dataService.current.getTransient(activeTab.uuid).isWaitingAI}
                dataService={dataService.current}
                onRestoreRequested={async body => {
                  dataService.current.setBody(activeTab.uuid, body)
                }}
                onSetIntent={(i: UserIntent) => dataService.current.setIntent(activeTab.uuid, i)}
                onSave={async () => {
                  await dataService.current.save(activeTab.uuid)
                }}
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
              <EditorStats 
                editor={editorRefs.current.get(activeTab.uuid)?.getEditor() || null} 
                isMarkdownMode={activeTab.mode === 'markdown'} 
                rawMd={dataService.current.get(activeTab.uuid)?.body || ''} 
              />
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
    </ModalProvider>
  )
}
