import React from 'react'
import type { Editor } from '@tiptap/core'
import {
  DeleteNote, MoveNote, EvaluateBuffer, LoadBuffer, SaveBuffer,
  FileBuffer, RefileNote, DiscardBuffer, GetStoreInfo, GetNotes,
  CreateFolder, DeleteFolder, RenameFolder, DeletePrompt, GetPrompts,
} from '../../wailsjs/go/main/App'
import type { NoteEntry, PromptEntry } from '../components/Sidebar'
import type { TabState } from '../types'
import type { UserIntent } from '../types'
import type { main } from '../../wailsjs/go/models'
import { applyFilingRecToMeta } from '../lib/fmUtils'

type ConfirmModalState = { title: string; message: string; onConfirm: () => void; isDestructive?: boolean }
type PromptModalState = { title: string; message: string; placeholder?: string; initialValue?: string; onSubmit: (val: string) => void }

interface UseNoteOperationsParams {
  tabs: TabState[]
  activeIdx: number
  activeTab: TabState | undefined
  isMarkdownMode: boolean
  rawMd: string
  tier: 'dumb' | 'smart'
  prompts: PromptEntry[]
  editor: Editor | null
  tabsRef: React.MutableRefObject<TabState[]>
  metaCache: React.MutableRefObject<Record<string, main.DocumentMetaDTO | null>>
  savedBodyCache: React.MutableRefObject<Record<string, string>>
  mdCache: React.MutableRefObject<Record<string, string>>
  setTabs: React.Dispatch<React.SetStateAction<TabState[]>>
  setActiveIdx: React.Dispatch<React.SetStateAction<number>>
  setNotes: React.Dispatch<React.SetStateAction<NoteEntry[]>>
  setPrompts: React.Dispatch<React.SetStateAction<PromptEntry[]>>
  setConfirmModal: (val: ConfirmModalState | null) => void
  setPromptModal: (val: PromptModalState | null) => void
  selectTab: (idx: number) => void
  flush: () => void
  loadTab: (tab: TabState) => void
  runBackgroundEval: (uuid: string, path: string, fileAfter: boolean, allowDiscard?: boolean) => Promise<void>
  setTabIntent: (idx: number, intent: UserIntent) => void
}

export function useNoteOperations({
  tabs,
  activeIdx,
  activeTab,
  isMarkdownMode,
  rawMd,
  tier,
  prompts,
  editor,
  tabsRef,
  metaCache,
  savedBodyCache,
  mdCache,
  setTabs,
  setActiveIdx,
  setNotes,
  setPrompts,
  setConfirmModal,
  setPromptModal,
  selectTab,
  flush,
  loadTab,
  runBackgroundEval,
  setTabIntent,
}: UseNoteOperationsParams) {
  function openNote(path: string) {
    const existingIdx = tabs.findIndex(t => t.path === path)
    if (existingIdx !== -1) {
      selectTab(existingIdx)
      return
    }
    if (isMarkdownMode && activeTab) mdCache.current[activeTab.uuid] = rawMd
    flush()
    const tab: TabState = { uuid: '', path, scroll: 0, active: true, mode: 'wysiwyg', status: 'filed', userIntent: null, isEmpty: false, isModified: false }
    const newTabs = [...tabs, tab]
    const newIdx = newTabs.length - 1
    setTabs(newTabs)
    setActiveIdx(newIdx)
    loadTab(tab)
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
      const note = await MoveNote(oldPath, newPath)
      setTabs(prev => prev.map(t => {
        if (t.path !== oldPath) return t
        // Update path and slug in tab state
        return { ...t, path: note.path }
      }))
      await GetNotes().then(res => setNotes(res || [])).catch(console.error)
    } catch (err) {
      console.error('Failed to move note', err)
      alert(`Failed to move note: ${err}`)
    }
  }

  async function handleSmartFile(path: string) {
    if (tier !== 'smart') return
    const tab = tabsRef.current.find(t => t.path === path)
    if (tab) {
      if (tab === activeTab) {
        const body = editor?.storage.markdown.getMarkdown() ?? ''
        if (body !== savedBodyCache.current[tab.uuid]) {
          const meta = metaCache.current[tab.uuid]
          if (meta) {
            savedBodyCache.current[tab.uuid] = body
            const dto = { uuid: tab.uuid, path, slug: tab.path.split('/').pop()?.replace('.md','') ?? '', body, meta, versions: [] }
            await SaveBuffer(dto as any).catch(console.error)
          }
        }
      }
      runBackgroundEval(tab.uuid, path, true)
      return
    }

    console.log('[stash:ai] Smart File (no tab): evaluating', { path })
    try {
      const rec = await EvaluateBuffer(path)
      const dto = await LoadBuffer(path)
      const userIntent = dto.meta.userIntent

      if (userIntent === 'trash' || (rec && !rec.keep && userIntent !== 'keep')) {
        console.log('[stash:ai] handleSmartFile (no tab): discard recommended/intended', { path })
        await DiscardBuffer(path)
        await GetNotes().then(res => setNotes(res || [])).catch(console.error)
        return
      }
      const info = await GetStoreInfo()
      const updatedMeta = applyFilingRecToMeta(dto.meta, rec, info.cli)
      const updatedDto = { ...dto, meta: updatedMeta }
      // Route by status: filed notes use RefileNote (rename within Library);
      // unfiled buffers use SaveBuffer + FileBuffer (promote to Library).
      if (dto.meta.status === 'filed') {
        await RefileNote(updatedDto as any)
      } else {
        await SaveBuffer(updatedDto as any)
        await FileBuffer(path)
      }
      await GetNotes().then(res => setNotes(res || [])).catch(console.error)
    } catch (e) {
      console.error('[stash:ai] Smart File (no tab) failed', e)
    }
  }

  async function handleSmartMetadata(path: string) {
    if (tier !== 'smart') return
    const tab = tabsRef.current.find(t => t.path === path)
    if (tab) {
      if (tab === activeTab) {
        const body = editor?.storage.markdown.getMarkdown() ?? ''
        if (body !== savedBodyCache.current[tab.uuid]) {
          const meta = metaCache.current[tab.uuid]
          if (meta) {
            savedBodyCache.current[tab.uuid] = body
            const dto = { uuid: tab.uuid, path, slug: tab.path.split('/').pop()?.replace('.md','') ?? '', body, meta, versions: [] }
            await SaveBuffer(dto as any).catch(console.error)
          }
        }
      }
      runBackgroundEval(tab.uuid, path, false, false)
      return
    }

    console.log('[stash:ai] Smart Metadata (no tab): evaluating', { path })
    try {
      const rec = await EvaluateBuffer(path)
      const dto = await LoadBuffer(path)
      const info = await GetStoreInfo()
      const updatedMeta = applyFilingRecToMeta(dto.meta, rec, info.cli)
      const updatedDto = { ...dto, meta: { ...updatedMeta, aiEval: 'complete' } }
      await SaveBuffer(updatedDto as any)
      await GetNotes().then(res => setNotes(res || [])).catch(console.error)
    } catch (err) {
      console.error('[stash:ai] Smart Metadata (no tab) failed', err)
    }
  }

  function onEditPrompt(name: string) {
    const existing = tabsRef.current.find(t => t.path === `prompt:${name}`)
    if (existing) {
      const idx = tabsRef.current.indexOf(existing)
      setActiveIdx(idx)
      loadTab(existing)
      return
    }

    const promptMeta = prompts.find(p => p.name === name)
    const uuid = `prompt-${name}`
    const newTab: TabState = {
      uuid,
      path: `prompt:${name}`,
      scroll: 0,
      active: true,
      mode: 'markdown',
      status: 'filed',
      isEmpty: false,
      isModified: false,
      displayName: promptMeta?.displayName || `${name}.md`
    }

    const newTabs = [...tabsRef.current.map(t => ({ ...t, active: false })), newTab]
    setTabs(newTabs)
    setActiveIdx(newTabs.length - 1)
    loadTab(newTab)
  }

  async function onRestorePrompt(name: string) {
    try {
      await DeletePrompt(name)
      const tab = tabsRef.current.find(t => t.path === `prompt:${name}`)
      if (tab) {
        loadTab(tab)
      }
      const p = await GetPrompts()
      setPrompts(p || [])
    } catch (err) {
      console.error('Failed to restore prompt', err)
    }
  }

  async function handleSetIntentByPath(path: string, intent: UserIntent) {
    const tabIdx = tabs.findIndex(t => t.path === path)
    if (tabIdx !== -1) {
      setTabIntent(tabIdx, intent)
    } else {
      try {
        const dto = await LoadBuffer(path)
        const updatedDto = { ...dto, meta: { ...dto.meta, userIntent: intent ?? undefined } }
        await SaveBuffer(updatedDto as any)
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
            const noteDto = await MoveNote(path, newPath)
            // Update filename/userSuggestedName in meta after rename
            const pureName = fileName.replace(/\.md$/, '')
            const tab = tabsRef.current.find(t => t.path === path)
            if (tab?.uuid) {
              const meta = metaCache.current[tab.uuid]
              if (meta) {
                const updatedMeta = { ...meta, filename: pureName, userSuggestedName: pureName }
                metaCache.current[tab.uuid] = updatedMeta
                const updatedDto = { ...noteDto, meta: updatedMeta }
                await SaveBuffer(updatedDto as any).catch(console.warn)
              }
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
