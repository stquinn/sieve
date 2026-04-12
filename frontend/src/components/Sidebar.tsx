import { useEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'

// Mirrors vault.NoteEntry from Go
export interface NoteEntry {
  name: string
  path?: string   // vault-relative, present on files
  isDir: boolean
  children?: NoteEntry[]
}

interface ContextMenuState {
  x: number
  y: number
  vaultPath: string   // vault-relative path for ShowInFiles
}

interface SidebarProps {
  entries: NoteEntry[]
  openPaths: Set<string>
  onOpen: (path: string) => void
  onShowInFiles: (path: string) => void
  width: number
}

export function Sidebar({ entries, openPaths, onOpen, onShowInFiles, width }: SidebarProps) {
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  // Close menu on any outside click
  useEffect(() => {
    if (!contextMenu) return
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setContextMenu(null)
      }
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [contextMenu])

  function openMenu(e: React.MouseEvent, vaultPath: string) {
    e.preventDefault()
    e.stopPropagation()
    setContextMenu({ x: e.clientX, y: e.clientY, vaultPath })
  }

  return (
    <div className="sidebar" style={{ width }}>
      <div className="sidebar__section-title">Notes</div>
      {entries.length === 0
        ? <div className="sidebar__empty">No filed notes yet</div>
        : <EntryList
            entries={entries}
            depth={0}
            openPaths={openPaths}
            onOpen={onOpen}
            onContextMenu={openMenu}
            basePath="notes"
          />
      }

      {contextMenu && (
        <div
          ref={menuRef}
          className="fixed z-50 bg-tn-bg-dark border border-tn-border rounded shadow-lg py-1 min-w-[160px]"
          style={{ top: contextMenu.y, left: contextMenu.x }}
        >
          <button
            className="w-full text-left px-3 py-1.5 text-[12px] text-tn-text hover:bg-tn-bg-alt transition-colors"
            onClick={() => { onShowInFiles(contextMenu.vaultPath); setContextMenu(null) }}
          >
            Show in Files
          </button>
        </div>
      )}
    </div>
  )
}

interface EntryListProps {
  entries: NoteEntry[]
  depth: number
  openPaths: Set<string>
  onOpen: (path: string) => void
  onContextMenu: (e: React.MouseEvent, vaultPath: string) => void
  basePath: string    // vault-relative path prefix for computing dir paths
}

function EntryList({ entries, depth, openPaths, onOpen, onContextMenu, basePath }: EntryListProps) {
  return (
    <>
      {entries.map(entry =>
        entry.isDir
          ? <DirEntry
              key={entry.name}
              entry={entry}
              depth={depth}
              openPaths={openPaths}
              onOpen={onOpen}
              onContextMenu={onContextMenu}
              basePath={`${basePath}/${entry.name}`}
            />
          : <FileEntry
              key={entry.path}
              entry={entry}
              depth={depth}
              open={openPaths.has(entry.path!)}
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
  onOpen: (path: string) => void
  onContextMenu: (e: React.MouseEvent, vaultPath: string) => void
  basePath: string
}

function DirEntry({ entry, depth, openPaths, onOpen, onContextMenu, basePath }: DirEntryProps) {
  const [expanded, setExpanded] = useState(true)

  return (
    <div>
      <button
        className={cn('sidebar__dir', depth > 0 && 'sidebar__dir--nested')}
        style={{ paddingLeft: `${0.75 + depth * 1}rem` }}
        onClick={() => setExpanded(v => !v)}
        onContextMenu={e => onContextMenu(e, basePath)}
      >
        <span className="sidebar__chevron">{expanded ? '▾' : '▸'}</span>
        <span className="sidebar__dir-name">{entry.name}</span>
      </button>
      {expanded && entry.children && entry.children.length > 0 && (
        <EntryList
          entries={entry.children}
          depth={depth + 1}
          openPaths={openPaths}
          onOpen={onOpen}
          onContextMenu={onContextMenu}
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
  onOpen: (path: string) => void
  onContextMenu: (e: React.MouseEvent, vaultPath: string) => void
}

function FileEntry({ entry, depth, open, onOpen, onContextMenu }: FileEntryProps) {
  return (
    <button
      className={cn('sidebar__file', open && 'sidebar__file--open')}
      style={{ paddingLeft: `${1.5 + depth * 1}rem` }}
      onClick={() => onOpen(entry.path!)}
      onContextMenu={e => onContextMenu(e, entry.path!)}
      title={entry.path}
    >
      {entry.name}
    </button>
  )
}
