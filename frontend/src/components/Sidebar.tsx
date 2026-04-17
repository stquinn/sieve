import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { NoteContextMenu } from './NoteContextMenu'
import { UserIntent } from '../types'
import { FolderPlus, Folder, FileText, ChevronRight, ChevronDown, X } from 'lucide-react'

// Mirrors vault.NoteEntry from Go
export interface NoteEntry {
  name: string
  displayName?: string
  path?: string      // vault-relative, present on files
  userIntent?: string // from frontmatter: "keep", "trash", or ""
  isDir: boolean
  children?: NoteEntry[]
}

export interface PromptEntry {
  name: string
  displayName: string
  path: string
  isVirtual: boolean
}

interface ContextMenuState {
  x: number
  y: number
  path: string
  intent: UserIntent
  isDir?: boolean
  childCount?: number 
  isVirtual?: boolean
}

export interface SidebarProps {
  entries: NoteEntry[]
  openPaths: Set<string>
  openFolders: Set<string>
  onToggleFolder: (path: string) => void
  activePath?: string
  onOpen: (path: string) => void
  onShowInFiles: (path: string) => void
  onSmartFile: (path: string) => void
  onSmartMetadata: (path: string) => void
  onDelete: (path: string) => void
  onMove: (oldPath: string, newPath: string) => void
  onSetIntent: (path: string, intent: UserIntent) => void
  onCreateFolder: (parentPath: string) => void
  onDeleteFolder: (path: string) => void
  onRename: (path: string, name: string, isDir: boolean) => void
  width: number
  showPrompts: boolean
  prompts: PromptEntry[]
  onEditPrompt: (name: string) => void
  onRestorePrompt: (name: string) => void
  promptsHeight: number
  onPromptsResize: (height: number) => void
}

export function Sidebar({ 
  entries, openPaths, openFolders, onToggleFolder, activePath, onOpen, onShowInFiles, onSmartFile, onSmartMetadata, onDelete, onMove, onSetIntent, onCreateFolder, onDeleteFolder, onRename, width,
  showPrompts, prompts, onEditPrompt, onRestorePrompt, promptsHeight, onPromptsResize
}: SidebarProps) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const [isResizingPrompts, setIsResizingPrompts] = useState(false)
  const sidebarRef = useRef<HTMLDivElement>(null)

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

  function openMenu(e: React.MouseEvent, path: string, intent: UserIntent, isDir?: boolean, childCount?: number, isVirtual?: boolean) {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, path, intent, isDir, childCount, isVirtual })
  }

  const [isRootDragOver, setIsRootDragOver] = useState(false)

  return (
    <div 
      ref={sidebarRef}
      className="sidebar flex flex-col h-full bg-tn-bg border-r border-tn-bg-alt select-none transition-all duration-75 relative z-10 !overflow-hidden" 
      style={{ width: `${width}px` }}
    >
      <div className="flex-1 overflow-y-auto flex flex-col scrollbar-hide">
      <div 
        className={cn(
          "sidebar__section-title transition-colors rounded group flex items-center justify-between",
          isRootDragOver && "bg-tn-bg-alt ring-1 ring-tn-blue text-white"
        )}
        onDragOver={e => { e.preventDefault(); setIsRootDragOver(true) }}
        onDragLeave={() => setIsRootDragOver(false)}
        onDrop={e => {
          e.preventDefault()
          setIsRootDragOver(false)
          const oldPath = e.dataTransfer.getData('text/plain')
          if (oldPath) {
            const fileName = oldPath.split('/').pop()
            const newPath = `notes/${fileName}`
            if (oldPath !== newPath) {
              onMove(oldPath, newPath)
            }
          }
        }}
      >
        <span>Notes</span>
        <button 
          className="opacity-0 group-hover:opacity-100 hover:text-tn-blue transition-all bg-transparent border-none p-0 cursor-pointer flex items-center justify-center leading-none"
          onClick={(e) => { e.stopPropagation(); onCreateFolder('') }}
          title="New Folder"
        >
          <FolderPlus className="w-4 h-4" />
        </button>
      </div>
      {entries.length === 0
        ? <div className="sidebar__empty">No filed notes yet</div>
        : <EntryList
            entries={entries}
            depth={0}
            openPaths={openPaths}
            openFolders={openFolders}
            onToggleFolder={onToggleFolder}
            activePath={activePath}
            onOpen={onOpen}
            onContextMenu={openMenu}
            onMove={onMove}
            basePath=""
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
          
          <div className="sidebar__prompts flex-1 overflow-y-auto">
            <div className="sidebar__section-title px-3 mb-1">
              <span>Prompts</span>
            </div>
            <div className="sidebar__prompts-list pb-2">
              {prompts.map(p => (
                <PromptItem 
                  key={p.name} 
                  prompt={p} 
                  active={activePath === `prompt:${p.name}`}
                  onEdit={() => onEditPrompt(p.name)} 
                  onRestore={() => onRestorePrompt(p.name)} 
                  onContextMenu={(e) => openMenu(e, `prompt:${p.name}`, null, false, 0, p.isVirtual)}
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
          path={contextMenu.path}
          intent={contextMenu.intent}
          onClose={() => setContextMenu(null)}
          onShowInFiles={() => onShowInFiles(contextMenu.path)}
          onSmartFile={() => onSmartFile(contextMenu.path)}
          onSmartMetadata={() => onSmartMetadata(contextMenu.path)}
          onDelete={() => contextMenu.isDir ? onDeleteFolder(contextMenu.path) : onDelete(contextMenu.path)}
          onRename={() => onRename(contextMenu.path, contextMenu.path.split('/').pop() || '', !!contextMenu.isDir)}
          onSetIntent={intent => onSetIntent(contextMenu.path, intent)}
          isDir={contextMenu.isDir}
          childCount={contextMenu.childCount}
          isVirtual={contextMenu.isVirtual}
          onRestore={contextMenu.path.startsWith('prompt:') ? () => onRestorePrompt(contextMenu.path.split(':').pop()!) : undefined}
        />
      )}
    </div>
  )
}

interface EntryListProps {
  entries: NoteEntry[]
  depth: number
  openPaths: Set<string>
  openFolders: Set<string>
  onToggleFolder: (path: string) => void
  activePath?: string
  onOpen: (path: string) => void
  onContextMenu: (e: React.MouseEvent, path: string, intent: UserIntent, isDir?: boolean, childCount?: number) => void
  onMove: (oldPath: string, newPath: string) => void
  basePath: string    // vault-relative path prefix for computing dir paths
}

function EntryList({ entries, depth, openPaths, openFolders, onToggleFolder, activePath, onOpen, onContextMenu, onMove, basePath }: EntryListProps) {
  return (
    <>
      {entries.map(entry =>
        entry.isDir
            ? <DirEntry
              key={entry.name}
              entry={entry}
              depth={depth}
              openPaths={openPaths}
              openFolders={openFolders}
              onToggleFolder={onToggleFolder}
              activePath={activePath}
              onOpen={onOpen}
              onContextMenu={onContextMenu}
              onMove={onMove}
              basePath={basePath ? `${basePath}/${entry.name}` : entry.name}
            />
          : <FileEntry
              key={entry.path}
              entry={entry}
              depth={depth}
              open={openPaths.has(entry.path!)}
              active={activePath === entry.path}
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
  openPaths: Set<string>
  openFolders: Set<string>
  onToggleFolder: (path: string) => void
  activePath?: string
  onOpen: (path: string) => void
  onContextMenu: (e: React.MouseEvent, path: string, intent: UserIntent, isDir?: boolean, childCount?: number) => void
  onMove: (oldPath: string, newPath: string) => void
  basePath: string
}

function DirEntry({ entry, depth, openPaths, openFolders, onToggleFolder, activePath, onOpen, onContextMenu, onMove, basePath }: DirEntryProps) {
  const expanded = openFolders.has(basePath)
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
    const oldPath = e.dataTransfer.getData('text/plain')
    if (oldPath && !oldPath.startsWith(basePath)) {
      // Move to this folder
      const fileName = oldPath.split('/').pop()
      const newPath = `${basePath}/${fileName}`
      if (oldPath !== newPath) {
        onMove(oldPath, newPath)
      }
    }
  }

  return (
    <div>
      <button
        className={cn(
          'sidebar__dir w-full text-left flex items-center gap-1 transition-colors',
          depth > 0 && 'sidebar__dir--nested',
          isDragOver && 'bg-tn-bg-alt ring-1 ring-tn-blue rounded'
        )}
        style={{ paddingLeft: `${0.75 + depth * 1}rem` }}
        onClick={() => onToggleFolder(basePath)}
        onContextMenu={e => onContextMenu(e, basePath, null, true, entry.children?.length || 0)}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <span className="sidebar__chevron opacity-70">
          {expanded ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
        </span>
        <Folder className="w-4 h-4 opacity-70 text-tn-blue shrink-0" />
        <span className="sidebar__dir-name truncate flex-1">{entry.name}</span>
      </button>
      {expanded && entry.children && (
        <EntryList
          entries={entry.children}
          depth={depth + 1}
          openPaths={openPaths}
          openFolders={openFolders}
          onToggleFolder={onToggleFolder}
          activePath={activePath}
          onOpen={onOpen}
          onContextMenu={onContextMenu}
          onMove={onMove}
          basePath={basePath}
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
  onOpen: (path: string) => void
  onContextMenu: (e: React.MouseEvent, path: string, intent: UserIntent, isDir?: boolean, childCount?: number) => void
}

function FileEntry({ entry, depth, open, active, onOpen, onContextMenu }: FileEntryProps) {
  const hasDisplay = entry.displayName && entry.displayName !== entry.name
  return (
    <button
      className={cn(
        'sidebar__file relative w-full text-left flex items-center gap-2 group',
        open && 'sidebar__file--open',
        active && 'bg-tn-bg-alt !text-white font-semibold shadow-[inset_2px_0_0_var(--theme-accentPrimary)]'
      )}
      style={{ paddingLeft: `${1.5 + depth * 1}rem` }}
      draggable
      onDragStart={e => {
        e.dataTransfer.setData('text/plain', entry.path!)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onClick={() => onOpen(entry.path!)}
      onContextMenu={e => onContextMenu(e, entry.path!, (entry.userIntent || null) as UserIntent, false, 0)}
      title={entry.path}
    >
      <div className="flex flex-col items-start leading-tight py-0.5 flex-1 min-w-0">
        <div className="flex items-center gap-2 w-full">
          <FileText className="w-3.5 h-3.5 opacity-40 shrink-0" />
          <div className="flex items-center gap-1.5 flex-1 min-w-0">
            {entry.userIntent && (
              <span className={cn(
                'w-1.5 h-1.5 rounded-full shrink-0',
                entry.userIntent === 'keep' ? 'bg-tn-blue' : 'bg-tn-red'
              )} />
            )}
            <span className="truncate flex-1">{entry.displayName || entry.name}</span>
          </div>
        </div>
        {hasDisplay && (
          <span className="text-[10px] opacity-60 truncate w-full font-mono mt-0.5 text-left pl-5.5">{entry.name}</span>
        )}
      </div>
    </button>
  )
}

function PromptItem({ prompt, active, onEdit, onRestore, onContextMenu }: { prompt: PromptEntry, active: boolean, onEdit: () => void, onRestore: () => void, onContextMenu: (e: React.MouseEvent) => void }) {
  return (
    <div className={cn(
      "sidebar__file flex items-center justify-between group py-1 pr-2",
      active && "bg-tn-bg-alt !text-white font-semibold shadow-[inset_2px_0_0_var(--theme-accentPrimary)]"
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
