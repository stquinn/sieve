import React, { useEffect, useState, useMemo, useRef } from 'react'
import { NoteEntry } from './Sidebar'
import { TabState } from '../types'
import { FileText, FileEdit } from 'lucide-react'

// Flattens a nested NoteEntry tree into an array of file paths / names
function flattenNotes(entries: NoteEntry[], currentPath = ''): { name: string; displayName?: string; path: string }[] {
  let list: { name: string; displayName?: string; path: string }[] = []
  for (const entry of entries) {
    if (entry.isDir && entry.children) {
      list = [...list, ...flattenNotes(entry.children, currentPath + entry.name + '/')]
    } else if (!entry.isDir && entry.path) {
      list.push({ name: entry.name, displayName: entry.displayName, path: entry.path })
    }
  }
  return list
}

export interface QuickSwitcherProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (path: string) => void
  tabs: TabState[]
  notesTree: NoteEntry[]
}

export function QuickSwitcher({ isOpen, onClose, onSelect, tabs, notesTree }: QuickSwitcherProps) {
  const [query, setQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  // Auto-focus input when opened
  useEffect(() => {
    if (isOpen) {
      setQuery('')
      setSelectedIndex(0)
      setTimeout(() => inputRef.current?.focus(), 50)
    }
  }, [isOpen])

  // Process and filter data
  const flatData = useMemo(() => {
    const activePaths = new Set(tabs.map(t => t.path))
    
    // 1. Open buffers (unfiled)
    const buffers = tabs
      .filter(t => t.status !== 'filed')
      .map(t => ({
        // Name is the basename without '.md' or '.tmp'
        name: t.path.split('/').pop()?.replace('.md', '') || 'buffer',
        path: t.path,
        icon: 'buffer' as const,
        isOpen: true,
      }))
    
    // 2. All Notes
    const allNotes = flattenNotes(notesTree).map(n => ({
      name: n.displayName || n.name,
      filename: n.name,
      path: n.path,
      icon: 'note' as const,
      isOpen: activePaths.has(n.path),
    }))

    // Merge and deduplicate by path
    const itemsMap = new Map()
    for (const buf of buffers) itemsMap.set(buf.path, buf)
    for (const note of allNotes) {
      if (!itemsMap.has(note.path)) {
        itemsMap.set(note.path, note)
      } else {
        itemsMap.get(note.path).isOpen = true
      }
    }
    const allItems = Array.from(itemsMap.values())

    // Fuzzy match
    const lowerQuery = query.toLowerCase()
    return allItems
      .filter(item => item.path.toLowerCase().includes(lowerQuery) || item.name.toLowerCase().includes(lowerQuery))
      .slice(0, 50) // Cap results for performance
  }, [tabs, notesTree, query])

  // Scroll active item into view
  useEffect(() => {
    if (listRef.current) {
      const el = listRef.current.children[selectedIndex] as HTMLElement
      if (el && el.scrollIntoView) {
        el.scrollIntoView({ block: 'nearest' })
      }
    }
  }, [selectedIndex])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex(idx => Math.min(idx + 1, flatData.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex(idx => Math.max(0, idx - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const item = flatData[selectedIndex]
      if (item) {
        onSelect(item.path)
        onClose()
      }
    }
  }

  if (!isOpen) return null

  return (
    <div className="help-modal-backdrop" onClick={onClose}>
      <div className="quick-switch" onClick={e => e.stopPropagation()}>
        <input
          ref={inputRef}
          className="quick-switch__input"
          placeholder="Search files by name..."
          value={query}
          onChange={e => {
            setQuery(e.target.value)
            setSelectedIndex(0)
          }}
          onKeyDown={handleKeyDown}
        />
        <div className="quick-switch__list" ref={listRef}>
          {flatData.length === 0 && <div className="quick-switch__empty">No files found matching "{query}"</div>}
          {flatData.map((item, idx) => (
            <div
              key={item.path}
              className={`quick-switch__item ${idx === selectedIndex ? 'quick-switch__item--active' : ''}`}
              onClick={() => {
                onSelect(item.path)
                onClose()
              }}
              onMouseEnter={() => setSelectedIndex(idx)}
            >
              <span className="quick-switch__icon">
                {item.icon === 'buffer' ? <FileEdit size={16} /> : <FileText size={16} />}
              </span>
              <div className="quick-switch__info">
                <div className="quick-switch__name">
                  {item.name}
                  {item.isOpen && <span className="quick-switch__badge">open</span>}
                </div>
                <div className="quick-switch__path">
                  {item.filename && item.name !== item.filename && (
                    <span className="opacity-60 mr-2">{item.filename}.md</span>
                  )}
                  {item.path}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
