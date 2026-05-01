import React, { useEffect, useState, useMemo, useRef } from 'react'
import { NoteEntry } from '../types'
import { TabState } from '../types'
import { FileText, FileEdit } from 'lucide-react'

// Flattens a nested NoteEntry tree into items with id + displayPath for display.
function flattenNotes(entries: NoteEntry[], currentPath = ''): { name: string; displayName?: string; id: string; displayPath: string }[] {
  let list: { name: string; displayName?: string; id: string; displayPath: string }[] = []
  for (const entry of entries) {
    if (entry.isDir && entry.children) {
      list = [...list, ...flattenNotes(entry.children, currentPath + entry.name + '/')]
    } else if (!entry.isDir && entry.id) {
      list.push({ name: entry.name, displayName: entry.displayName, id: entry.id, displayPath: currentPath + entry.name + '.md' })
    }
  }
  return list
}

export interface QuickSwitcherProps {
  isOpen: boolean
  onClose: () => void
  onSelect: (id: string) => void
  tabs: { uuid: string; displayName?: string; status: string; mode: string }[]
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
    const openIDs = new Set(tabs.map(t => t.uuid))

    // 1. Open buffers (unfiled)
    const buffers = tabs
      .filter(t => t.status !== 'filed')
      .map(t => ({
        name: t.displayName || 'Buffer',
        id: t.uuid,
        displayPath: '',
        icon: 'buffer' as const,
        isOpen: true,
      }))

    // 2. All Notes
    const allNotes = flattenNotes(notesTree).map(n => ({
      name: n.displayName || n.name,
      filename: n.name,
      id: n.id,
      displayPath: n.displayPath,
      icon: 'note' as const,
      isOpen: openIDs.has(n.id),
    }))

    // Merge and deduplicate by id
    const itemsMap = new Map()
    for (const buf of buffers) itemsMap.set(buf.id, buf)
    for (const note of allNotes) {
      if (!itemsMap.has(note.id)) {
        itemsMap.set(note.id, note)
      } else {
        itemsMap.get(note.id).isOpen = true
      }
    }
    const allItems = Array.from(itemsMap.values())

    // Fuzzy match
    const lowerQuery = query.toLowerCase()
    return allItems
      .filter(item => item.displayPath.toLowerCase().includes(lowerQuery) || item.name.toLowerCase().includes(lowerQuery))
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
        onSelect(item.id)
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
              key={item.id}
              className={`quick-switch__item ${idx === selectedIndex ? 'quick-switch__item--active' : ''}`}
              onClick={() => {
                onSelect(item.id)
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
                  {(item as any).filename && item.name !== (item as any).filename && (
                    <span className="opacity-60 mr-2">{(item as any).filename}.md</span>
                  )}
                  {item.displayPath}
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
