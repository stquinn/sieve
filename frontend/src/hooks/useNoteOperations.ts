import React from 'react'
import type { Editor } from '@tiptap/core'
import {
  DeleteNote, MoveNote, EvaluateBuffer, LoadBuffer, SaveBuffer,
  FileBuffer, DiscardBuffer, GetStoreInfo, GetNotes,
  CreateFolder, DeleteFolder, RenameFolder, RestorePrompt, GetPrompts,
} from '../../wailsjs/go/main/App'
import type { NoteEntry, PromptEntry } from '../components/Sidebar'
import type { TabState } from '../types'
import type { UserIntent } from '../types'
import { splitFrontmatter } from '../lib/markdown'
import { applyFilingRec, bumpFm, setYamlField, getLocalISOString } from '../lib/fmUtils'

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
  fmCache: React.MutableRefObject<Record<string, string>>
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
  fmCache,
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
      await MoveNote(oldPath, newPath)
      setTabs(prev => prev.map(t => t.path === oldPath ? { ...t, path: newPath } : t))
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
          const fm = bumpFm(fmCache.current[tab.uuid] ?? '')
          fmCache.current[tab.uuid] = fm
          savedBodyCache.current[tab.uuid] = body
          await SaveBuffer(path, fm + body).catch(console.error)
        }
      }
      runBackgroundEval(tab.uuid, path, true)
      return
    }

    console.log('[stash:ai] Smart File (no tab): evaluating', { path })
    try {
      const rec = await EvaluateBuffer(path)
      const content = await LoadBuffer(path)
      let { frontmatter, body } = splitFrontmatter(content)
      const userIntentMatch = frontmatter.match(/^user_intent:\s*(keep|trash)/m)
      const userIntent = userIntentMatch ? userIntentMatch[1] : null

      if (userIntent === 'trash' || (rec && !rec.keep && userIntent !== 'keep')) {
        console.log('[stash:ai] handleSmartFile (no tab): discard recommended/intended', { path })
        await DiscardBuffer(path)
        await GetNotes().then(res => setNotes(res || [])).catch(console.error)
        return
      }
      const info = await GetStoreInfo()
      frontmatter = applyFilingRec(frontmatter, rec, info.cli)
      await SaveBuffer(path, frontmatter + body)
      await FileBuffer(path)
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
          const fm = bumpFm(fmCache.current[tab.uuid] ?? '')
          fmCache.current[tab.uuid] = fm
          savedBodyCache.current[tab.uuid] = body
          await SaveBuffer(path, fm + body).catch(console.error)
        }
      }
      runBackgroundEval(tab.uuid, path, false, false)
      return
    }

    console.log('[stash:ai] Smart Metadata (no tab): evaluating', { path })
    try {
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
      await RestorePrompt(name)
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
            try {
              const content = await LoadBuffer(newPath)
              let { frontmatter, body } = splitFrontmatter(content)
              const pureName = fileName.replace(/\.md$/, '')

              frontmatter = setYamlField(frontmatter, 'filename', pureName)
              frontmatter = setYamlField(frontmatter, 'user_suggested_name', pureName)

              await SaveBuffer(newPath, frontmatter + body)

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
