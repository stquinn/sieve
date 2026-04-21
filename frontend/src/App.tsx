import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import './lib/SmartStorables'
import { EditorPanel, EditorPanelHandle } from './components/EditorPanel'
import { main, stash } from '../wailsjs/go/models'
import { StorableDataService } from './lib/StorableDataService'
import { 
  DiscardBuffer, FileBuffer, FileBufferWithName, GetNotes, GetSession, 
  GetStoreInfo, LoadBuffer, NewBuffer, RefileNote, SaveBuffer, 
  SaveSession, SaveSidebarWidth, SaveMetaWidth, SavePromptsHeight, 
  ShowInFiles, EvaluateBuffer, GetPrompts, TogglePrompts, DeletePrompt
} from '../wailsjs/go/main/App'
import { BrowserOpenURL, EventsOn } from '../wailsjs/runtime/runtime'
import { TabBar } from './components/TabBar'
import { HelpModal } from './components/HelpModal'
import { Sidebar, NoteEntry, PromptEntry } from './components/Sidebar'
import { MetaPanel } from './components/MetaPanel'
import { StoreSearch } from './components/StoreSearch'
import { QuickSwitcher } from './components/QuickSwitcher'
import { TimeoutPopup } from './components/TimeoutPopup'
import { AskPopup } from './components/AskPopup'
import { TabState, UserIntent } from './types'
import { ConfirmModal, PromptModal } from './components/Modal'
import { X } from 'lucide-react'
import { EditorStats } from './components/EditorStats'
import { useNoteOperations } from './hooks/useNoteOperations'
import { useAiGestures } from './hooks/useAiGestures'
import { useAppLifecycle } from './hooks/useAppLifecycle'
import { getAncestorPaths, getLocalISOString, applyFilingRecToMeta } from './lib/fmUtils'
import './App.css'

export default function App() {
  const [tabs, setTabs]           = useState<TabState[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const [ready, setReady]         = useState(false)
  const [showHelp, setShowHelp]   = useState(false)
  const [showSidebar, setShowSidebar] = useState(true)
  const [tier, setTier]           = useState<'dumb' | 'smart'>('dumb')
  const [sidebarWidth, setSidebarWidth]     = useState(240)
  const [isDragging, setIsDragging]         = useState(false)
  const [showMeta, setShowMeta]             = useState(false)
  const [showPrompts, setShowPrompts]       = useState(true)
  const [metaWidth, setMetaWidth]           = useState(260)
  const [promptsHeight, setPromptsHeight]   = useState(180)
  const [isMetaDragging, setIsMetaDragging] = useState(false)
  const [showSearch, setShowSearch]         = useState(false)
  const [pendingClose, setPendingClose]     = useState(false)
  const [showQuickSwitch, setShowQuickSwitch] = useState(false)
  const [sidebarMode, setSidebarMode]       = useState<'files'|'search'>('files')
  const [confirmModal, setConfirmModal] = useState<{ title: string, message: string, onConfirm: () => void, isDestructive?: boolean } | null>(null)
  const [promptModal, setPromptModal] = useState<{ title: string, message: string, placeholder?: string, initialValue?: string, onSubmit: (val: string) => void } | null>(null)
  const [searchTerm, setSearchTerm]         = useState('')
  const [notes, setNotes]         = useState<NoteEntry[]>([])
  const [prompts, setPrompts]     = useState<PromptEntry[]>([])
  const [timeoutPopup, setTimeoutPopup] = useState<{ path: string; suggestedName: string } | null>(null)
  const [showAskPopup, setShowAskPopup] = useState(false)
  const [tick, setTick]                 = useState(0)
  const [storeInfo, setStoreInfo] = useState<{ root: string; themeName: string; } | null>(null)
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set())
  
  const ds = useRef(new StorableDataService(() => setTick(t => t + 1)))
  const editorRefs = useRef<Map<string, EditorPanelHandle>>(new Map())
  const activeTab = tabs[activeIdx]
  const isMarkdownMode = activeTab?.mode === 'markdown'

  const uuidToPath = useRef<Map<string, string>>(new Map())
  const focusTimer   = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const next = new Map<string, string>()
    tabs.forEach(t => {
      const path = ds.current.get(t.uuid)?.path
      if (path) next.set(t.uuid, path)
    })
    uuidToPath.current = next
  }, [tabs, tick])

  const askContextRef = useRef<{ content: string; blockRef: string; history: string; contextLabel: string; imagePaths: string[] } | null>(null)
  const autosaveMs                = useRef(30_000)
  const cliTimeoutLongMs          = useRef(60_000)
  const sidebarWidthRef           = useRef(240)
  const metaWidthRef              = useRef(260)
  const promptsHeightRef          = useRef(180)
  const tabsRef                  = useRef<TabState[]>([])
  const activeIdxRef             = useRef(0)
  const tierRef                  = useRef<'dumb' | 'smart'>('dumb')
  const evaluatingUuids          = useRef<Set<string>>(new Set())
  const pendingAiCount           = useRef(0)
  const evalStartTimes           = useRef<Record<string, number>>({})
  const saveTimer                = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => { tabsRef.current = tabs }, [tabs])
  useEffect(() => { activeIdxRef.current = activeIdx }, [activeIdx])
  useEffect(() => { tierRef.current = tier }, [tier])

  const flush = useCallback(async () => {
    if (!activeTab) return
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null }
    await ds.current.save(activeTab.uuid).catch(console.error)
  }, [activeTab])

  const flushRef = useRef(flush)
  useEffect(() => { flushRef.current = flush }, [flush])

  const selectTab = (idx: number) => {
    if (idx === activeIdx) return
    setActiveIdx(idx)
  }

  const newTab = async () => {
    try {
      const dto = await NewBuffer()
      ds.current.set(dto.uuid, dto)
      const tab: TabState = {
        uuid: dto.uuid,
        mode: 'wysiwyg',
      }
      setTabs(prev => [...prev, tab])
      setActiveIdx(tabs.length)
    } catch (e) {
      console.error('[App] newTab failed', e)
    }
  }

  const closeTab = async (idx: number) => {
    const tab = tabs[idx]
    if (!tab) return
    
    const doc = ds.current.get(tab.uuid)
    const isDirty = doc?.isModified
    const path = doc?.path

    if (isDirty && path && !tab.isVirtual) {
      // Capture mode for potential restore before eviction
      const originalMode = tab.mode
      // Immediate UI close, followed by background filing
      const newTabs = tabs.filter((_, i) => i !== idx)
      setTabs(newTabs)
      if (newTabs.length === 0) {
        await newTab()
      } else {
        const newIdx = Math.min(idx, newTabs.length - 1)
        setActiveIdx(newIdx)
      }
      noteOps.handleSmartFile(path, originalMode)
    } else {
      // Immediate close for clean or virtual tabs
      const newTabs = tabs.filter((_, i) => i !== idx)
      if (newTabs.length === 0) {
        await newTab()
      } else {
        const newIdx = Math.min(idx, newTabs.length - 1)
        setTabs(newTabs)
        setActiveIdx(newIdx)
      }
    }
  }

  const closeAllTabs = async () => {
    for (const t of tabs) {
      await ds.current.save(t.uuid).catch(console.error)
    }
    const dto = await NewBuffer()
    ds.current.set(dto.uuid, dto)
    const tab: TabState = {
      uuid: dto.uuid,
      mode: 'wysiwyg',
    }
    setTabs([tab])
    setActiveIdx(0)
  }

  const reorderTab = (oldIdx: number, newIdx: number) => {
    const next = [...tabs]
    const [moved] = next.splice(oldIdx, 1)
    next.splice(newIdx, 0, moved)
    setTabs(next)
    if (activeIdx === oldIdx) setActiveIdx(newIdx)
    else if (activeIdx > oldIdx && activeIdx <= newIdx) setActiveIdx(activeIdx - 1)
    else if (activeIdx < oldIdx && activeIdx >= newIdx) setActiveIdx(activeIdx + 1)
  }

  const toggleMode = () => {
    if (!activeTab) return
    const newMode = isMarkdownMode ? 'wysiwyg' : 'markdown'
    setTabs(prev => prev.map((t, i) => i === activeIdx ? { ...t, mode: newMode } : t))
  }

  const setTabIntent = (uuid: string, intent: UserIntent) => {
    ds.current.setIntent(uuid, intent)
  }

  const isContentEmpty = (html: string) => {
    if (!html) return true
    const stripped = html.replace(/<[^>]*>/g, '').trim()
    return stripped === ''
  }

  const runBackgroundEval = async (uuid: string, path: string, fileAfter: boolean, allowDiscard: boolean = true, originalMode?: 'wysiwyg' | 'markdown') => {
    if (ds.current.getTransient(uuid).isWaitingAI) return
    
    ds.current.setTransient(uuid, { isWaitingAI: true, aiJobName: fileAfter ? 'Filing' : 'Metadata' })
    evaluatingUuids.current.add(uuid)
    pendingAiCount.current++
    setTick(t => t + 1)

    try {
      // Save buffer first so AI reads the latest content from disk
      await ds.current.save(uuid).catch(console.error)

      const dto = await ds.current.load(path)
      const body = dto.body || ''
      const userIntent = dto.meta?.userIntent

      // Silent Drop: If empty and no explicit keep intent, discard immediately
      if (fileAfter && isContentEmpty(body) && userIntent !== 'keep') {
        console.log('[stash:ai] Silent drop: empty buffer', { path })
        await DiscardBuffer(path)
        setTabs(prev => prev.filter(t => t.uuid !== uuid))
        await GetNotes().then(res => setNotes(res || []))
        return
      }

      const rec = await EvaluateBuffer(path)

      if (fileAfter && (userIntent === 'trash' || (rec && !rec.keep && userIntent !== 'keep' && allowDiscard))) {
        await DiscardBuffer(path)
        // Ensure tab is gone (usually already handled by closeTab)
        setTabs(prev => prev.filter(t => t.uuid !== uuid))
        await GetNotes().then(res => setNotes(res || []))
        return
      }

      const info = await GetStoreInfo()
      const updatedMeta = applyFilingRecToMeta(dto.meta!, rec, info.cli)
      ds.current.setMeta(uuid, { ...updatedMeta, aiEval: 'complete', aiLastEvaluated: getLocalISOString() })

      if (fileAfter) {
        if (dto.meta?.status === 'filed') {
          await RefileNote(ds.current.get(uuid) as any)
        } else {
          await ds.current.save(uuid)
          await FileBuffer(path)
        }
        await GetNotes().then(res => setNotes(res || []))
        // Success: ensure tab is gone (usually done, but defensive)
        setTabs(prev => prev.filter(t => t.uuid !== uuid))
      } else {
        await ds.current.save(uuid)
      }
    } catch (err) {
      console.error('[stash:ai] background eval failed', err)
      if (fileAfter && originalMode) {
        console.warn('[stash:ai] Restoring tab due to eval failure', { uuid, path })
        setTabs(prev => {
          if (prev.find(t => t.uuid === uuid)) return prev
          return [...prev, { uuid, mode: originalMode }]
        })
      }
    } finally {
      ds.current.setTransient(uuid, { isWaitingAI: false })
      evaluatingUuids.current.delete(uuid)
      pendingAiCount.current--
      setTick(t => t + 1)
    }
  }

  const persistSession = async (overrides?: Partial<stash.Session>) => {
    const session = {
      activeIdx: overrides?.activeIdx ?? activeIdx,
      tabs: tabs.map((t, i) => ({
        id: t.uuid,
        path: ds.current.get(t.uuid)?.path || '',
        active: i === activeIdx,
        mode: t.mode,
        scroll: ds.current.get(t.uuid)?.meta?.scroll || 0
      })) as any,
      showSidebar: overrides?.showSidebar ?? showSidebar,
      showMeta: overrides?.showMeta ?? showMeta,
      showPrompts: overrides?.showPrompts ?? showPrompts,
      sidebarWidth: overrides?.sidebarWidth ?? sidebarWidth,
      metaWidth: overrides?.metaWidth ?? metaWidth,
      promptsHeight: overrides?.promptsHeight ?? promptsHeight,
      openFolders: Array.from(openFolders)
    }
    await SaveSession(session as any).catch(console.error)
  }

  const persistSessionRef = useRef(persistSession)
  useLayoutEffect(() => { persistSessionRef.current = persistSession }, [persistSession])

  const H = useRef<{
    newTab: () => Promise<void>
    closeTab: () => Promise<void>
    closeAllTabs: () => Promise<void>
    closeAllBuffers: () => Promise<void>
    flush: () => Promise<void>
    forceFile: () => void
    smartSave: () => Promise<void>
    reEval: () => void
    toggleMode: () => void
    explain: () => void
    ask: () => void
    editPrompt: (name: string) => void
    smartFile: () => void
    keepAndSmartFile: () => Promise<void>
  }>({
    newTab,
    closeTab: () => closeTab(activeIdx),
    closeAllTabs,
    closeAllBuffers: closeAllTabs,
    flush,
    forceFile: () => {},
    smartSave: async () => { await ds.current.save(activeTab?.uuid ?? '').catch(console.error) },
    reEval: () => {},
    toggleMode,
    explain: () => {},
    ask: () => {},
    editPrompt: (name: string) => {},
    smartFile: () => {},
    keepAndSmartFile: async () => {}
  })

  // Hook initializations moved AFTER isMarkdownMode/activeTab are defined
  const noteOps = useNoteOperations({
    tabs, activeIdx, activeTab, 
    tier, prompts,
    tabsRef,
    setTabs, setActiveIdx, setNotes, setPrompts,
    setConfirmModal, setPromptModal,
    selectTab, flush,
    runBackgroundEval: (uuid, path, fileAfter, allowDiscard) => runBackgroundEval(uuid, path, fileAfter, allowDiscard),
    setTabIntent,
    ds: ds.current,
  })

  const aiGestures = useAiGestures({
    tier,
    activeTab, tabsRef, 
    uuidToPath,
    pendingAiCount, evalStartTimes, askContextRef,
    setTabs, setShowAskPopup,
    ds: ds.current,
    getEditor: (uuid) => editorRefs.current.get(uuid)
  })

  // Final wrap-up of H ref handlers
  useLayoutEffect(() => {
    H.current = {
      newTab,
      closeTab: () => closeTab(activeIdx),
      closeAllTabs,
      closeAllBuffers: closeAllTabs,
      flush,
      forceFile: () => {},
      smartSave: async () => { await ds.current.save(activeTab?.uuid ?? '').catch(console.error) },
      reEval: () => {
        const path = ds.current.get(activeTab?.uuid!)?.path
        if (path) noteOps.handleSmartMetadata(path)
      },
      toggleMode,
      explain: aiGestures.explainGesture,
      ask: aiGestures.askGesture,
      editPrompt: noteOps.onEditPrompt,
      smartFile: () => {
        const path = ds.current.get(activeTab?.uuid!)?.path
        if (path) noteOps.handleSmartFile(path)
      },
      keepAndSmartFile: async () => {
        if (!activeTab) return
        ds.current.setIntent(activeTab.uuid, 'keep')
        const path = ds.current.get(activeTab.uuid)?.path
        if (path) noteOps.handleSmartFile(path)
      }
    }
  }, [activeTab, activeIdx, tabs, aiGestures, noteOps])

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase()
      if (e.ctrlKey && key === 'n') { e.preventDefault(); H.current.newTab() }
      if (e.ctrlKey && key === 'w') { e.preventDefault(); H.current.closeTab() }
      if (e.ctrlKey && key === 's') { e.preventDefault(); H.current.smartSave() }
      if (e.ctrlKey && e.shiftKey && key === 'm') { e.preventDefault(); H.current.toggleMode() }
      // AI Shortcuts refined by user feedback
      if (e.ctrlKey && !e.shiftKey && key === 'e') { 
        e.preventDefault(); H.current.explain() 
      }
      if (e.ctrlKey && e.shiftKey && key === 'e') { 
        e.preventDefault(); H.current.smartFile() 
      }
      if (e.ctrlKey && e.shiftKey && key === 'a') { 
        e.preventDefault(); H.current.ask() 
      }
      if (e.ctrlKey && e.shiftKey && key === 'enter') { 
        e.preventDefault(); H.current.keepAndSmartFile() 
      }
      if (e.ctrlKey && key === 'p' && !e.shiftKey) { e.preventDefault(); setShowQuickSwitch(v => !v) }
      if (e.ctrlKey && e.shiftKey && key === 'p') { 
        e.preventDefault(); 
        setShowPrompts(prev => { const next = !prev; persistSessionRef.current({ showPrompts: next }); return next; })
      }
      if (e.ctrlKey && key === '\\') { 
        e.preventDefault(); 
        setShowSidebar(prev => { const next = !prev; persistSessionRef.current({ showSidebar: next }); return next; })
      }
      if (e.ctrlKey && e.shiftKey && key === 'i') { 
        e.preventDefault(); 
        setShowMeta(prev => { const next = !prev; persistSessionRef.current({ showMeta: next }); return next; })
      }
      if (e.ctrlKey && key === '/') { e.preventDefault(); setShowHelp(v => !v) }
      if (e.ctrlKey && !e.shiftKey && key === 'f') { e.preventDefault(); setShowSearch(v => !v) }
      if (e.ctrlKey && e.shiftKey && key === 'f') { 
        e.preventDefault(); 
        setSidebarMode('search'); 
        setShowSidebar(true); 
        persistSessionRef.current({ showSidebar: true }) 
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  useEffect(() => {
    GetStoreInfo().then(info => {
      setStoreInfo(info)
      setTier(info.tier === 1 ? 'dumb' : 'smart')
      GetSession().then(async session => {
        if (session.tabs?.length) {
          const st = (session.tabs as any[])
            .map(t => ({ uuid: t.uuid, mode: t.mode || 'wysiwyg' } as TabState))
            .filter(t => typeof t.uuid === 'string' && t.uuid.length > 0)
          
          if (st.length > 0) {
            setTabs(st)
            setActiveIdx(Math.max(0, (session.tabs as any[]).findIndex(t => t.active)))
            
            for (const t of session.tabs as any[]) {
              if (!t.uuid || !t.path) continue
              try {
                if (t.path.startsWith('prompt:')) {
                  // Prompt tabs are loaded via the frontend LoadPrompt path, not LoadBuffer
                  await ds.current.load(t.path)
                } else {
                  const dto = await LoadBuffer(t.path)
                  ds.current.set(t.uuid, dto)
                }
              } catch (e) {
                console.warn('[App] session restore: failed to load tab', t.path, e)
              }
            }
          } else {
            await newTab()
          }
        } else {
          await newTab()
        }
        if (session.openFolders) setOpenFolders(new Set(session.openFolders))
        if (session.showSidebar !== undefined) setShowSidebar(session.showSidebar)
        if (session.showMeta !== undefined) setShowMeta(session.showMeta)
        if (session.showPrompts !== undefined) setShowPrompts(session.showPrompts)
        if (session.sidebarWidth) { setSidebarWidth(session.sidebarWidth); sidebarWidthRef.current = session.sidebarWidth }
        if (session.metaWidth) { setMetaWidth(session.metaWidth); metaWidthRef.current = session.metaWidth }
        if (session.promptsHeight) { setPromptsHeight(session.promptsHeight); promptsHeightRef.current = session.promptsHeight }
        setReady(true)
      })
    })
    const fNotes = () => GetNotes().then(res => setNotes(res || []))
    const fPrompts = () => GetPrompts().then(res => setPrompts(res || []))
    fNotes(); fPrompts()
    const u1 = EventsOn('notes:changed', fNotes)
    const u2 = EventsOn('prompts:changed', fPrompts)
    return () => { u1(); u2() }
  }, [])

  const onRestorePrompt = async (name: string) => {
    await DeletePrompt(name)
    await GetPrompts().then(setPrompts)
    // Hot-reload open tab if it exists
    const path = `prompt:${name}`
    const entry = tabs.find(t => uuidToPath.current.get(t.uuid) === path)
    if (entry) {
      await ds.current.evict(entry.uuid)
      await ds.current.load(path)
      setTick(t => t + 1)
    }
  }

  useAppLifecycle({
    activeIdx, tabs, tabsRef, activeIdxRef,
    tierRef, evaluatingUuids, pendingAiCount, cliTimeoutLongMs,
    flushRef, focusTimer,
    persistSession, persistSessionRef, setPendingClose,
    ds: ds.current,
  })

  useEffect(() => {
    const path = ds.current.get(activeTab?.uuid!)?.path
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
        <p>Specify where your notes should live.</p>
        <input type="text" placeholder="Enter absolute path" id="manual-path-input" />
        <button onClick={() => {
          const el = document.getElementById('manual-path-input') as HTMLInputElement
          if (el?.value) {
            import('../wailsjs/go/main/App').then(m => m.InitVault(el.value)).then(() => window.location.reload())
          }
        }}>Get Started</button>
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
              openPaths={new Set(tabs.map(t => ds.current.get(t.uuid)?.path).filter(Boolean) as string[])}
              openFolders={openFolders}
              onToggleFolder={path => setOpenFolders(prev => {
                const next = new Set(prev)
                if (next.has(path)) { next.delete(path) } else { next.add(path) }
                return next
              })}
              activePath={ds.current.get(activeTab?.uuid!)?.path}
              onOpen={noteOps.openNote}
              onShowInFiles={p => ShowInFiles(p)}
              onSmartFile={noteOps.handleSmartFile}
              onSmartMetadata={noteOps.handleSmartMetadata}
              onDelete={noteOps.handleDeleteNote}
              onMove={noteOps.handleMoveNote}
              onSetIntent={noteOps.handleSetIntentByPath}
              onCreateFolder={noteOps.handleCreateFolder}
              onDeleteFolder={noteOps.handleDeleteFolder}
              onRename={noteOps.handleRename}
              width={sidebarWidth}
              showPrompts={showPrompts && tier === 'smart'}
              prompts={prompts}
              onEditPrompt={noteOps.onEditPrompt}
              onRestorePrompt={onRestorePrompt}
              promptsHeight={promptsHeight}
              onPromptsResize={h => { 
                setPromptsHeight(h); 
                promptsHeightRef.current = h;
                SavePromptsHeight(h);
                persistSession({ promptsHeight: h }); 
              }}
            />
          ) : (
            <StoreSearch
              width={sidebarWidth}
              onOpen={p => { noteOps.openNote(p); setSidebarMode('files') }}
              onClose={() => setSidebarMode('files')}
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
          ds={ds.current}
          onSelect={selectTab}
          onClose={closeTab}
          onNew={newTab}
          onHelp={() => setShowHelp(v => !v)}
          onSetIntent={setTabIntent}
          onRename={noteOps.handleRename}
          onReorder={reorderTab}
          onShowInFiles={p => ShowInFiles(p)}
          onSmartFile={noteOps.handleSmartFile}
          onSmartMetadata={noteOps.handleSmartMetadata}
          onDelete={noteOps.handleDeleteNote}
          onRestorePrompt={noteOps.onRestorePrompt}
          onCloseAll={closeAllTabs}
        />

        {showHelp && <HelpModal onClose={() => setShowHelp(false)} />}
        {confirmModal && <ConfirmModal {...confirmModal} onClose={() => setConfirmModal(null)} />}
        {promptModal && <PromptModal {...promptModal} onClose={() => setPromptModal(null)} />}
        
        <QuickSwitcher
          isOpen={showQuickSwitch}
          onClose={() => setShowQuickSwitch(false)}
          onSelect={noteOps.openNote}
          tabs={tabs.map(t => {
            const doc = ds.current.get(t.uuid)
            return {
              uuid: t.uuid,
              mode: t.mode,
              path: doc?.path || t.uuid,
              status: doc?.meta?.status as any,
              isEvaluating: doc?.meta?.status === 'evaluating',
              isWaitingAI: ds.current.getTransient(t.uuid).isWaitingAI
            }
          })}
          notesTree={notes}
        />

        <div id="editor-area">
          {showSearch && activeTab && (
            <div className="search-bar">
              <input autoFocus className="search-bar__input" placeholder="Find in note..." value={searchTerm}
                onChange={e => setSearchTerm(e.target.value)}
                onKeyDown={e => {
                  if (e.key === 'Escape') setShowSearch(false)
                  if (e.key === 'Enter') {
                    const ed = editorRefs.current.get(activeTab.uuid)?.getEditor()
                    if (e.shiftKey) ed?.commands.prevSearchResult()
                    else ed?.commands.nextSearchResult()
                  }
                }} />
              <button onClick={() => setShowSearch(false)}><X size={16} /></button>
            </div>
          )}

          <div id="editor-wrapper">
            {tabs.filter(t => typeof t.uuid === 'string' && t.uuid.length > 0).map((t, i) => (
              <div 
                key={t.uuid} 
                style={{ display: i === activeIdx ? 'contents' : 'none' }}
              >
                <EditorPanel
                  ref={ref => { if (ref) editorRefs.current.set(t.uuid, ref); else editorRefs.current.delete(t.uuid) }}
                  uuid={t.uuid}
                  mode={t.mode}
                  ds={ds.current}
                  isActive={i === activeIdx}
                  tick={tick}
                  tier={tier}
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
                meta={ds.current.get(activeTab.uuid)?.meta ?? null}
                versions={ds.current.get(activeTab.uuid)?.versions ?? []}
                path={ds.current.get(activeTab.uuid)?.path ?? ''}
                width={metaWidth}
                isModified={ds.current.get(activeTab.uuid)?.isModified ?? false}
                isEvaluating={ds.current.get(activeTab.uuid)?.meta?.status === 'evaluating'}
                isWaitingAI={ds.current.getTransient(activeTab.uuid).isWaitingAI}
                onRestoreRequested={async body => {
                  if (activeTab.mode === 'wysiwyg') {
                    editorRefs.current.get(activeTab.uuid)?.setContent(body)
                  }
                  ds.current.setBody(activeTab.uuid, body)
                  await ds.current.save(activeTab.uuid)
                }}
              />
            </>
          )}
        </div>

        <div className="status-bar">
          <div className="status-bar__left">
            {tabs.filter(t => ds.current.get(t.uuid)?.meta?.status === 'evaluating' || ds.current.getTransient(t.uuid).isWaitingAI).map(t => (
              <div key={t.uuid} className="status-bar__item">
                <span className="status-bar__spinner" />
                <span className="status-bar__task">AI Processing</span>
                <span className="status-bar__note">{ds.current.get(t.uuid)?.meta?.displayName || 'note'}</span>
              </div>
            ))}
          </div>
          <div className="status-bar__right">
             <EditorStats 
               editor={activeTab ? (editorRefs.current.get(activeTab.uuid)?.getEditor() || null) : null} 
               isMarkdownMode={activeTab?.mode === 'markdown'} 
               rawMd={activeTab ? (ds.current.get(activeTab.uuid)?.body || '') : ''} 
             />
          </div>
        </div>
      </div>

      {showAskPopup && askContextRef.current && (
        <AskPopup
          contextLabel={askContextRef.current.contextLabel}
          onSend={aiGestures.handleAskSend}
          onClose={() => setShowAskPopup(false)}
        />
      )}

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
