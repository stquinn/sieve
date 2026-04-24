import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { NoteContextMenu } from './NoteContextMenu'
import { UserIntent, NoteEntry, PromptEntry } from '../types'
import { FolderPlus, Plus, Folder, FolderOpen, FileText, ChevronRight, ChevronDown, X, Settings } from 'lucide-react'
import { StorableDataService } from '../lib/StorableDataService'
import { AiService } from '../lib/AiService'
import { ShowInFiles } from '../../wailsjs/go/main/App'
import { useModal } from '../lib/ModalContext'

export type { NoteEntry, PromptEntry }

interface ContextMenuState {
  x: number
  y: number
  id: string           // opaque: UUID for notes, folderID for dirs, prompt.id for prompts
  name: string         // display name — no parsing needed
  path?: string        // ExternalRef — only for ShowInFiles
  intent: UserIntent
  isDir?: boolean
  childCount?: number
  isVirtual?: boolean
  isPrompt?: boolean
}

interface SidebarProps {
  dataService: StorableDataService
  aiService: AiService
  entries: NoteEntry[]
  openIDs: Set<string>
  openFolders: Set<string>
  onToggleFolder: (folderID: string) => void
  activeID?: string
  onOpen: (id: string) => void
  width: number
  showPrompts: boolean
  prompts: PromptEntry[]
  onEditPrompt: (promptID: string) => void
  promptsHeight: number
  onPromptsResize: (height: number) => void
  setNotes: (notes: NoteEntry[]) => void
  setPrompts: (prompts: PromptEntry[]) => void
  onRenameFolder?: (oldFolderID: string, newFolderID: string) => void
  onOpenSettings: () => void
  onNew: () => void
}

export function Sidebar({
  dataService, aiService, entries, openIDs, openFolders, onToggleFolder, activeID, onOpen,
  width, showPrompts, prompts, onEditPrompt,
  promptsHeight, onPromptsResize, setNotes, setPrompts, onRenameFolder, onOpenSettings, onNew
}: SidebarProps) {
  const { confirm, prompt } = useModal()
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [isResizingPrompts, setIsResizingPrompts] = useState(false)
  const sidebarRef = useRef<HTMLDivElement>(null)

  // ── Business Logic ──────────────────────────────────────────────────────────

  const refreshNotes = () => dataService.getNotes().then(res => setNotes(res || [])).catch(console.error)
  const refreshPrompts = () => dataService.getPrompts().then(res => setPrompts(res || [])).catch(console.error)

  const handleSmartFile = async (id: string) => {
    let uuid = dataService.get(id)?.id
    if (!uuid) {
      try {
        const doc = await dataService.loadByID(id)
        uuid = doc.id
      } catch (e) {
        console.error(`[Sidebar] Failed to load ${id} for filing:`, e)
        return
      }
    }
    aiService.smartFile(uuid)
  }

  const handleSmartMetadata = async (id: string) => {
    let uuid = dataService.get(id)?.id
    if (!uuid) {
      try {
        const doc = await dataService.loadByID(id)
        uuid = doc.id
      } catch (e) {
        console.error(`[Sidebar] Failed to load ${id} for metadata:`, e)
        return
      }
    }
    aiService.smartMetadata(uuid)
  }

  const handleDelete = (id: string, name: string, isDir: boolean = false) => {
    confirm({
      title: isDir ? 'Delete Folder' : 'Delete Note',
      message: `Are you sure you want to delete "${name}"?`,
      isDestructive: true,
      onConfirm: async () => {
        try {
          if (isDir) {
            await dataService.deleteFolder(id)
          } else {
            await dataService.discard(id)
          }
          refreshNotes()
        } catch (e) { console.error(e) }
      }
    })
  }

  const handleRename = (id: string, currentName: string, isDir: boolean) => {
    prompt({
      title: isDir ? 'Rename Folder' : 'Rename Note',
      message: `Enter new name for "${currentName}":`,
      initialValue: currentName,
      onSubmit: async (newName: string) => {
        if (!newName || newName === currentName) return
        try {
          const result = await dataService.renameDoc(id, newName, isDir)
          if (isDir && onRenameFolder && typeof result === 'string') {
            onRenameFolder(id, result)
          }
          refreshNotes()
        } catch (e) { console.error(e) }
      }
    })
  }

  const onSetIntent = async (id: string, intent: UserIntent) => {
    const uuid = dataService.get(id)?.id || id
    dataService.setIntent(uuid, intent)
    await dataService.save(uuid)
    refreshNotes()
  }

  const onCreateFolder = (parentFolderID: string) => {
    prompt({
      title: 'New Folder',
      message: `Create a new folder${parentFolderID ? ` in "${parentFolderID.split('/').pop()}"` : ''}:`,
      onSubmit: async (name: string) => {
        if (!name) return
        await dataService.createFolder(parentFolderID, name)
        refreshNotes()
      }
    })
  }

  const onRestorePrompt = async (name: string) => {
    await dataService.deletePrompt(name)
    refreshPrompts()
  }

  const onMove = async (noteID: string, targetFolderID: string) => {
    await dataService.move(noteID, targetFolderID)
    refreshNotes()
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  useEffect(() => {
    if (!isResizingPrompts) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!sidebarRef.current) return
      const sidebarRect = sidebarRef.current.getBoundingClientRect()
      const newHeight = sidebarRect.bottom - e.clientY
      onPromptsResize(Math.max(100, Math.min(newHeight, 500)))
    }

    const handleMouseUp = () => setIsResizingPrompts(false)

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isResizingPrompts, onPromptsResize])

  function openMenu(e: React.MouseEvent, state: Omit<ContextMenuState, 'x' | 'y'>) {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, ...state })
  }

  const [isRootDragOver, setIsRootDragOver] = useState(false)

  return (
    <div
      ref={sidebarRef}
      className="sidebar flex flex-col h-full bg-tn-bg border-t border-r border-solid border-tn-border-2 select-none transition-all duration-75 relative z-10 !overflow-hidden"
      style={{ width: `${width}px` }}
    >
      <div
        className={cn(
          "sidebar__section-title transition-colors flex items-center justify-between border-0 border-b border-solid border-tn-border-2 h-[44px] min-h-[44px] p-0 shrink-0",
          isRootDragOver && "bg-tn-bg-alt ring-1 ring-tn-blue text-white"
        )}
        onDragOver={e => { e.preventDefault(); setIsRootDragOver(true) }}
        onDragLeave={() => setIsRootDragOver(false)}
        onDrop={e => {
          e.preventDefault()
          setIsRootDragOver(false)
          const noteID = e.dataTransfer.getData('text/plain')
          if (noteID) {
            onMove(noteID, 'store')
          }
        }}
      >
        <span className="pl-4 text-[13px] font-black uppercase tracking-[0.05em] text-tn-muted">Library</span>
        <div className="flex items-center gap-1 pr-1">
          <button
            className="hover:text-tn-text hover:bg-tn-bg-alt/80 transition-all bg-transparent border-none p-1.5 cursor-pointer flex items-center justify-center leading-none text-tn-muted rounded-md"
            onClick={(e) => { e.stopPropagation(); onNew() }}
            title="New Note (Mod + N)"
          >
            <Plus className="w-[18px] h-[18px]" />
          </button>
          <button
            className="hover:text-tn-text hover:bg-tn-bg-alt/80 transition-all bg-transparent border-none p-1.5 cursor-pointer flex items-center justify-center leading-none text-tn-muted rounded-md"
            onClick={(e) => { e.stopPropagation(); onCreateFolder('') }}
            title="New Folder"
          >
            <FolderPlus className="w-[18px] h-[18px]" />
          </button>
          <button
            className="hover:text-tn-text hover:bg-tn-bg-alt/80 transition-all bg-transparent border-none p-0 pr-1.5 cursor-pointer flex items-center justify-center leading-none text-tn-muted rounded-md"
            onClick={(e) => { e.stopPropagation(); onOpenSettings() }}
            title="Settings (Mod + ,)"
          >
            <Settings className="w-[18px] h-[18px]" />
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto flex flex-col scrollbar-hide min-h-0">
        {entries.length === 0
          ? <div className="sidebar__empty">No filed documents yet</div>
          : <EntryList
            entries={entries}
            depth={0}
            openIDs={openIDs}
            openFolders={openFolders}
            onToggleFolder={onToggleFolder}
            activeID={activeID}
            onOpen={onOpen}
            onContextMenu={openMenu}
            onMove={onMove}
          />
        }
      </div>


      {showPrompts && prompts.length > 0 && (
        <div
          className="sidebar__prompts-container flex flex-col border-t border-tn-bg-alt relative shrink-0"
          style={{ height: `${promptsHeight}px`, minHeight: '40px', maxHeight: '70vh' }}
        >
          {/* Vertical Resize Handle */}
          <div
            className={cn(
              "absolute -top-[1.5px] left-0 right-0 h-[3px] cursor-ns-resize transition-all z-[100]",
              isResizingPrompts ? "bg-tn-orange shadow-[0_0_10px_rgba(255,158,100,0.5)]" : "bg-tn-border-2 hover:bg-tn-orange/40"
            )}
            onMouseDown={(e) => {
              e.preventDefault()
              setIsResizingPrompts(true)
            }}
          />

          <div className="sidebar__prompts flex-1 overflow-y-auto pt-3">
            <div className="sidebar__section-title px-3 mb-1 text-[13px] font-black uppercase tracking-[0.05em] text-tn-muted">
              <span>Prompts</span>
            </div>
            <div className="sidebar__prompts-list pb-2">
              {prompts.map(p => (
                <PromptItem
                  key={p.name}
                  prompt={p}
                  active={activeID === p.id}
                  onEdit={() => onEditPrompt(p.id)}
                  onRestore={() => onRestorePrompt(p.name)}
                  onContextMenu={(e) => openMenu(e, {
                    id: p.id,
                    name: p.displayName,
                    intent: null,
                    isDir: false,
                    childCount: 0,
                    isVirtual: p.isVirtual,
                    isPrompt: true
                  })}
                />
              ))}
            </div>
          </div>
        </div>
      )}

      {contextMenu && (
        <NoteContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          id={contextMenu.id}
          name={contextMenu.name}
          path={contextMenu.path}
          isPrompt={contextMenu.isPrompt}
          intent={contextMenu.intent}
          onClose={() => setContextMenu(null)}
          onShowInFiles={() => ShowInFiles(contextMenu.path || '')}
          onSmartFile={() => handleSmartFile(contextMenu.id)}
          onSmartMetadata={() => handleSmartMetadata(contextMenu.id)}
          onDelete={() => handleDelete(contextMenu.id, contextMenu.name, !!contextMenu.isDir)}
          onRename={() => handleRename(contextMenu.id, contextMenu.name, !!contextMenu.isDir)}
          onSetIntent={intent => onSetIntent(contextMenu.id, intent)}
          isDir={contextMenu.isDir}
          childCount={contextMenu.childCount}
          isVirtual={contextMenu.isVirtual}
          onRestore={contextMenu.isPrompt ? () => onRestorePrompt(contextMenu.name) : undefined}
        />
      )}
    </div>
  )
}

interface EntryListProps {
  entries: NoteEntry[]
  depth: number
  openIDs: Set<string>
  openFolders: Set<string>
  onToggleFolder: (folderID: string) => void
  activeID?: string
  onOpen: (id: string) => void
  onContextMenu: (e: React.MouseEvent, state: Omit<ContextMenuState, 'x' | 'y'>) => void
  onMove: (noteID: string, targetFolderID: string) => void
}

function EntryList({ entries, depth, openIDs, openFolders, onToggleFolder, activeID, onOpen, onContextMenu, onMove }: EntryListProps) {
  return (
    <>
      {entries.map(entry =>
        entry.isDir
          ? <DirEntry
            key={entry.id || entry.name}
            entry={entry}
            depth={depth}
            openIDs={openIDs}
            openFolders={openFolders}
            onToggleFolder={onToggleFolder}
            activeID={activeID}
            onOpen={onOpen}
            onContextMenu={onContextMenu}
            onMove={onMove}
          />
          : <FileEntry
            key={entry.id || entry.path}
            entry={entry}
            depth={depth}
            open={openIDs.has(entry.id!)}
            active={activeID === entry.id}
            onOpen={onOpen}
            onContextMenu={onContextMenu}
          />
      )}
    </>
  )
}

interface DirEntryProps {
  entry: NoteEntry
  depth: number
  openIDs: Set<string>
  openFolders: Set<string>
  onToggleFolder: (folderID: string) => void
  activeID?: string
  onOpen: (id: string) => void
  onContextMenu: (e: React.MouseEvent, state: Omit<ContextMenuState, 'x' | 'y'>) => void
  onMove: (noteID: string, targetFolderID: string) => void
}

function DirEntry({ entry, depth, openIDs, openFolders, onToggleFolder, activeID, onOpen, onContextMenu, onMove }: DirEntryProps) {
  const folderID = entry.id!
  const expanded = openFolders.has(folderID)
  const [isDragOver, setIsDragOver] = useState(false)

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(true)
  }

  const handleDragLeave = () => {
    setIsDragOver(false)
  }

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragOver(false)
    const noteID = e.dataTransfer.getData('text/plain')
    if (noteID && noteID !== folderID) {
      onMove(noteID, folderID)
    }
  }

  return (
    <div>
      <button
        className={cn(
          'sidebar__dir w-full text-left flex items-center gap-1 transition-colors group',
          depth > 0 && 'sidebar__dir--nested',
          isDragOver && 'bg-tn-bg-alt ring-1 ring-tn-blue rounded'
        )}
        style={{ paddingLeft: `${0.75 + depth * 1}rem` }}
        onClick={() => onToggleFolder(folderID)}
        onContextMenu={e => onContextMenu(e, {
          id: folderID,
          name: entry.name,
          path: entry.path,
          intent: null,
          isDir: true,
          childCount: entry.children?.length || 0
        })}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <span className="sidebar__chevron opacity-70">
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </span>
        {expanded ? (
          <FolderOpen className="w-3.5 h-3.5 opacity-70 text-tn-blue shrink-0" />
        ) : (
          <Folder className="w-3.5 h-3.5 opacity-70 text-tn-blue shrink-0" />
        )}
        <span className="sidebar__dir-name truncate flex-1 text-[15px] font-bold text-tn-textDim">{entry.name}</span>
      </button>
      {expanded && entry.children && (
        <EntryList
          entries={entry.children}
          depth={depth + 1}
          openIDs={openIDs}
          openFolders={openFolders}
          onToggleFolder={onToggleFolder}
          activeID={activeID}
          onOpen={onOpen}
          onContextMenu={onContextMenu}
          onMove={onMove}
        />
      )}
    </div>
  )
}

interface FileEntryProps {
  entry: NoteEntry
  depth: number
  open: boolean
  active: boolean
  onOpen: (id: string) => void
  onContextMenu: (e: React.MouseEvent, state: Omit<ContextMenuState, 'x' | 'y'>) => void
}

function FileEntry({ entry, depth, open, active, onOpen, onContextMenu }: FileEntryProps) {
  const hasDisplay = entry.displayName && entry.displayName !== entry.name
  return (
    <button
      className={cn(
        'sidebar__file relative w-full text-left flex items-center gap-2 group',
        open && 'sidebar__file--open',
        active && 'bg-tn-bg-alt !text-white font-bold shadow-[inset_2px_0_0_var(--theme-accentPrimary)]'
      )}
      style={{ paddingLeft: `${1.5 + depth * 1}rem` }}
      draggable
      onDragStart={e => {
        e.dataTransfer.setData('text/plain', entry.id!)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onMouseDown={() => onOpen(entry.id!)}
      onContextMenu={e => onContextMenu(e, {
        id: entry.id!,
        name: entry.displayName || entry.name,
        path: entry.path,
        intent: (entry.userIntent || null) as UserIntent,
        isDir: false,
        childCount: 0
      })}
      title={entry.path}
    >
      <div className="flex flex-col items-start leading-tight flex-1 min-w-0">
        <div className="flex items-center gap-2 w-full">
          <FileText className="w-3.5 h-3.5 opacity-40 shrink-0" />
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            {entry.status === 'error' && <span title="Malformed YAML: check file on disk">⚠️</span>}
            {entry.userIntent && (
              <span className={cn(
                'w-1.5 h-1.5 rounded-full shrink-0',
                entry.userIntent === 'keep' ? 'bg-tn-blue' : (entry.userIntent === 'trash' ? 'bg-tn-red' : 'bg-tn-yellow')
              )} />
            )}
            <span className="truncate flex-1 text-[15px] font-medium text-tn-textDim">{entry.displayName || entry.name}</span>
          </div>
        </div>
      </div>
    </button>
  )
}

function PromptItem({ prompt, active, onEdit, onRestore, onContextMenu }: { prompt: PromptEntry, active: boolean, onEdit: () => void, onRestore: () => void, onContextMenu: (e: React.MouseEvent) => void }) {
  return (
    <div className={cn(
      "sidebar__file flex items-center justify-between group pr-2",
      active && "bg-tn-bg-alt !text-white font-bold shadow-[inset_2px_0_0_var(--theme-accentPrimary)]"
    )} style={{ paddingLeft: '1.5rem' }} onContextMenu={onContextMenu}>
      <button
        className="flex items-center gap-2 flex-1 min-w-0 bg-transparent border-none p-0 text-inherit cursor-pointer text-left"
        onClick={onEdit}
      >
        <FileText className={cn("w-3.5 h-3.5 shrink-0", prompt.isVirtual ? "opacity-40" : "text-tn-orange")} />
        <span className="truncate flex-1 font-medium">{prompt.displayName}</span>
        {!prompt.isVirtual && (
          <span className="text-[9px] bg-tn-orange/20 text-tn-orange px-1.5 py-0.5 rounded-full uppercase tracking-widest font-bold ml-1">
            Custom
          </span>
        )}
      </button>
      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
        {!prompt.isVirtual && (
          <button
            className="hover:text-tn-red transition-colors bg-transparent border-none p-0 cursor-pointer flex items-center justify-center p-1"
            onClick={(e) => { e.stopPropagation(); onRestore() }}
            title="Restore to Default"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    </div>
  )
}
