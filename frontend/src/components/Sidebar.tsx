import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { NoteContextMenu } from './NoteContextMenu'
import { UserIntent } from '../types'
import { FolderPlus, Folder, FileText, ChevronRight, ChevronDown } from 'lucide-react'

// Mirrors vault.NoteEntry from Go
export interface NoteEntry {
  name: string
  displayName?: string
  path?: string      // vault-relative, present on files
  userIntent?: string // from frontmatter: "keep", "trash", or ""
  isDir: boolean
  children?: NoteEntry[]
}

interface ContextMenuState {
  x: number
  y: number
  path: string
  intent: UserIntent
  isDir?: boolean
  childCount?: number 
}

export interface SidebarProps {
  entries: NoteEntry[]
  openPaths: Set<string>
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
}

export function Sidebar({ 
  entries, openPaths, activePath, onOpen, onShowInFiles, onSmartFile, onSmartMetadata, onDelete, onMove, onSetIntent, onCreateFolder, onDeleteFolder, onRename, width 
}: SidebarProps) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)

  function openMenu(e: React.MouseEvent, path: string, intent: UserIntent, isDir?: boolean, childCount?: number) {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, path, intent, isDir, childCount })
  }

  const [isRootDragOver, setIsRootDragOver] = useState(false)

  return (
    <div className="sidebar" style={{ width }}>
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
          onClick={(e) => { e.stopPropagation(); onCreateFolder('notes') }}
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
            activePath={activePath}
            onOpen={onOpen}
            onContextMenu={openMenu}
            onMove={onMove}
            basePath="notes"
          />
      }

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
        />
      )}
    </div>
  )
}

interface EntryListProps {
  entries: NoteEntry[]
  depth: number
  openPaths: Set<string>
  activePath?: string
  onOpen: (path: string) => void
  onContextMenu: (e: React.MouseEvent, path: string, intent: UserIntent) => void
  onMove: (oldPath: string, newPath: string) => void
  basePath: string    // vault-relative path prefix for computing dir paths
}

function EntryList({ entries, depth, openPaths, activePath, onOpen, onContextMenu, onMove, basePath }: EntryListProps) {
  return (
    <>
      {entries.map(entry =>
        entry.isDir
          ? <DirEntry
              key={entry.name}
              entry={entry}
              depth={depth}
              openPaths={openPaths}
              activePath={activePath}
              onOpen={onOpen}
              onContextMenu={onContextMenu}
              onMove={onMove}
              basePath={`${basePath}/${entry.name}`}
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
  activePath?: string
  onOpen: (path: string) => void
  onContextMenu: (e: React.MouseEvent, path: string, intent: UserIntent, isDir?: boolean, childCount?: number) => void
  onMove: (oldPath: string, newPath: string) => void
  basePath: string
}

function DirEntry({ entry, depth, openPaths, activePath, onOpen, onContextMenu, onMove, basePath }: DirEntryProps) {
  const [expanded, setExpanded] = useState(true)
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
        onClick={() => setExpanded(v => !v)}
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
