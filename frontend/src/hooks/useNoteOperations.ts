import React from 'react'
import type { Editor } from '@tiptap/core'
// Direct backend imports removed to follow the centralized service pattern.
// All operations now flow through the dataService.
import type { NoteEntry, PromptEntry } from '../components/Sidebar'
import type { TabState } from '../types'
import type { UserIntent } from '../types'
import { applyFilingRecToMeta } from '../lib/fmUtils'
import type { StorableDataService } from '../lib/StorableDataService'

type ConfirmModalState = { title: string; message: string; onConfirm: () => void; isDestructive?: boolean }
type PromptModalState = { title: string; message: string; placeholder?: string; initialValue?: string; onSubmit: (val: string) => void }

interface UseNoteOperationsParams {
  prompts: PromptEntry[]
  tabsRef: React.MutableRefObject<TabState[]>
  activeIdxRef: React.MutableRefObject<number>
  tierRef: React.MutableRefObject<'dumb' | 'smart'>
  setTabs: React.Dispatch<React.SetStateAction<TabState[]>>
  setActiveIdx: React.Dispatch<React.SetStateAction<number>>
  setNotes: React.Dispatch<React.SetStateAction<NoteEntry[]>>
  setPrompts: React.Dispatch<React.SetStateAction<PromptEntry[]>>
  setConfirmModal: (val: ConfirmModalState | null) => void
  setPromptModal: (val: PromptModalState | null) => void
  selectTab: (idx: number) => void
  flush: () => void
  runBackgroundEval: (uuid: string, path: string, fileAfter: boolean, allowDiscard?: boolean, originalMode?: 'wysiwyg' | 'markdown', closeAfter?: boolean) => Promise<void>
  setTabIntent: (uuid: string, intent: UserIntent) => void
  dataService: StorableDataService
}

export function useNoteOperations({
  prompts,
  tabsRef,
  activeIdxRef,
  tierRef,
  setTabs,
  setActiveIdx,
  setNotes,
  setPrompts,
  setConfirmModal,
  setPromptModal,
  selectTab,
  flush,
  runBackgroundEval,
  setTabIntent,
  dataService,
}: UseNoteOperationsParams) {
  async function openNote(path: string) {
    const existingIdx = tabsRef.current.findIndex(t => dataService.get(t.uuid)?.path === path)
    if (existingIdx !== -1) {
      selectTab(existingIdx)
      // Force focus on re-selection to resolve "second click" issues
      const uuid = tabsRef.current[existingIdx].uuid
      setTimeout(() => {
        const handle = (window as any).editorRefs?.get(uuid)
        if (handle) handle.focus()
      }, 0)
      return
    }

    try {
      flush()
      // UUID-First: Get the identity before adding to UI
      const doc = await dataService.load(path)
      
      setTabs(prev => {
        const idx = prev.findIndex(t => t.uuid === doc.id)
        if (idx !== -1) return prev
        
        const newTab: TabState = { 
          uuid: doc.id, 
          mode: 'wysiwyg', 
        }
        return [...prev, newTab]
      })
      
      // No more manual flush/load — EditorPanel handles its own life when mounted.
      setTimeout(() => {
        const currentTabs = tabsRef.current
        const newIdx = currentTabs.findIndex(t => t.uuid === doc.id)
        if (newIdx !== -1) {
          setActiveIdx(newIdx)
        }
      }, 0)
    } catch (err) {
      console.error('[stash] openNote failed', err)
    }
  }


  async function handleDeleteNote(path: string) {
    setConfirmModal({
      title: 'Delete Note',
      message: `Are you sure you want to delete "${path.split('/').pop()}"? This will also remove its version history.`,
      isDestructive: true,
      onConfirm: async () => {
        setConfirmModal(null)
        try {
          const currentTabs = tabsRef.current
          const idx = currentTabs.findIndex(t => dataService.get(t.uuid)?.path === path)
          if (idx !== -1) {
            const uuid = currentTabs[idx].uuid
            await dataService.discard(uuid)
            setTabs(prev => prev.filter((_, i) => i !== idx))
            if (activeIdxRef.current >= idx) {
              setActiveIdx(Math.max(0, activeIdxRef.current - 1))
            }
          }
          await dataService.getNotes().then(res => setNotes(res || [])).catch(console.error)
        } catch (err) {
          console.error('Failed to delete note', err)
          alert(`Failed to delete note: ${err}`)
        }
      }
    })
  }

  async function handleMoveNote(oldPath: string, newPath: string) {
    try {
      await dataService.move(oldPath, newPath)
      // When a note moves, the service is notified. Apps list only changes path labels if path was stored in tab.
      // But we don't store path in tab, so we don't need to update tabs! 
      // The Sidebar and TabItems will resolve the new path on the next render.
      await dataService.getNotes().then(res => setNotes(res || [])).catch(console.error)
    } catch (err) {
      console.error('Failed to move note', err)
      alert(`Failed to move note: ${err}`)
    }
  }

  async function handleSmartFile(path: string, originalMode?: 'wysiwyg' | 'markdown', closeAfter: boolean = false) {
    if (tierRef.current !== 'smart') return
    const tabs = tabsRef.current
    const activeIdx = activeIdxRef.current
    const activeTab = tabs[activeIdx]
    const tab = tabs.find(t => dataService.get(t.uuid)?.path === path)
    
    if (tab) {
      if (tab.uuid === activeTab?.uuid) {
        await dataService.save(tab.uuid).catch(console.error)
      }
      runBackgroundEval(tab.uuid, path, true, true, originalMode || tab.mode, closeAfter)
      return
    }

    console.log('[stash:ai] Smart File (no tab): evaluating', { path })
    try {
      const doc = await dataService.load(path)
      const rec = await dataService.evaluate(path)
      const userIntent = doc.meta?.userIntent
      if (userIntent === 'trash' || (rec && !rec.keep && userIntent !== 'keep')) {
        await dataService.discard(doc.id)
        await dataService.getNotes().then(res => setNotes(res || [])).catch(console.error)
        return
      }
      const info = await dataService.getStoreInfo()
      const updatedMeta = applyFilingRecToMeta(doc.meta!, rec, info.cli)
      dataService.setMeta(doc.id, { ...updatedMeta, aiEval: 'complete' })

      if (doc.meta?.status === 'filed') {
        await dataService.refile(doc.id)
      } else {
        await dataService.save(doc.id)
        await dataService.file(doc.id)
      }
      await dataService.getNotes().then(res => setNotes(res || [])).catch(console.error)
    } catch (e) {
      console.error('[stash:ai] Smart File (no tab) failed', e)
    }
  }

  async function handleSmartMetadata(path: string) {
    if (tierRef.current !== 'smart') return
    const tabs = tabsRef.current
    const activeIdx = activeIdxRef.current
    const activeTab = tabs[activeIdx]
    const tab = tabs.find(t => dataService.get(t.uuid)?.path === path)
    if (tab) {
      if (tab.uuid === activeTab?.uuid) {
        await dataService.save(tab.uuid).catch(console.error)
      }
      runBackgroundEval(tab.uuid, path, false, false)
      return
    }

    console.log('[stash:ai] Smart Metadata (no tab): evaluating', { path })
    try {
      const rec = await dataService.evaluate(path)
      const doc = await dataService.load(path)
      const info = await dataService.getStoreInfo()
      const updatedMeta = applyFilingRecToMeta(doc.meta!, rec, info.cli)
      dataService.setMeta(doc.id, { ...updatedMeta, aiEval: 'complete' })
      await dataService.save(doc.id)
      await dataService.getNotes().then(res => setNotes(res || [])).catch(console.error)
    } catch (err) {
      console.error('[stash:ai] Smart Metadata (no tab) failed', err)
    }
  }

  async function onEditPrompt(name: string) {
    const uuid = `prompt:${name}`
    const existing = tabsRef.current.find(t => t.uuid === uuid)
    if (existing) {
      const idx = tabsRef.current.indexOf(existing)
      setActiveIdx(idx)
      return
    }

    // Load the prompt content into the data service before mounting the tab
    await dataService.load(`prompt:${name}`).catch(console.error)

    const newTab: TabState = {
      uuid,
      mode: 'markdown',
    }

    const newTabs = [...tabsRef.current, newTab]
    setTabs(newTabs)
    setActiveIdx(newTabs.length - 1)
  }

  async function onRestorePrompt(name: string) {
    try {
      await dataService.deletePrompt(name)
      const p = await dataService.getPrompts()
      setPrompts(p || [])
    } catch (err) {
      console.error('Failed to restore prompt', err)
    }
  }

  async function handleSetIntentByPath(path: string, intent: UserIntent) {
    const tab = tabsRef.current.find(t => dataService.get(t.uuid)?.path === path)
    if (tab) {
      setTabIntent(tab.uuid, intent)
    } else {
      try {
        const doc = await dataService.load(path)
        dataService.setMeta(doc.id, { ...doc.meta!, userIntent: intent ?? undefined })
        await dataService.save(doc.id)
        await dataService.getNotes().then(res => setNotes(res || [])).catch(console.error)
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
        const cleanParent = parentPath || 'store'
        const path = `${cleanParent}/${name}`.replace(/\/+/g, '/')
        try {
          await dataService.createFolder(path)
          await dataService.getNotes().then(res => setNotes(res || [])).catch(console.error)
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
          await dataService.deleteFolder(path)
          await dataService.getNotes().then(res => setNotes(res || [])).catch(console.error)
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
            await dataService.rename(path, newPath, true)
          } else {
            await dataService.rename(path, newPath, false)
            // Update metadata in the service if indexed ... (logic preserved)
          }
          await dataService.getNotes().then(res => setNotes(res || [])).catch(console.error)
          // No need to update tabs! UUID didn't change, service will return new path.
        } catch (err) {
          console.error('Rename failed', err)
          alert(`Rename failed: ${err}`)
        }
      }
    })
  }

  return {
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
  }
}
