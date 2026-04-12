import { cn } from '@/lib/utils'
import { useEffect, useRef, useState } from 'react'
import { TabState, BufferStatus, UserIntent } from '../types'

interface TabBarProps {
  tabs: TabState[]
  activeIdx: number
  onSelect: (idx: number) => void
  onClose: (idx: number) => void
  onNew: () => void
  onHelp: () => void
  onSetIntent: (idx: number, intent: UserIntent) => void
}

export function TabBar({ tabs, activeIdx, onSelect, onClose, onNew, onHelp, onSetIntent }: TabBarProps) {
  return (
    <div className="flex items-center bg-tn-bg-dark border-b border-tn-border h-11 overflow-x-auto shrink-0"
         style={{ scrollbarWidth: 'none' }}>
      {tabs.map((tab, idx) => (
        <TabItem
          key={tab.path}
          tab={tab}
          active={idx === activeIdx}
          onSelect={() => onSelect(idx)}
          onClose={() => onClose(idx)}
          onSetIntent={intent => onSetIntent(idx, intent)}
        />
      ))}
      <button
        onClick={onNew}
        aria-label="New tab"
        className="px-3 h-full text-tn-muted hover:text-tn-text hover:bg-tn-bg-alt text-lg leading-none shrink-0 transition-colors"
      >
        +
      </button>
      <div className="flex-1" />
      <button
        onClick={onHelp}
        aria-label="Keyboard shortcuts & cheatsheet (Ctrl+/)"
        title="Shortcuts & cheatsheet (Ctrl+/)"
        className="px-3 h-full text-tn-muted hover:text-tn-text hover:bg-tn-bg-alt text-[13px] leading-none shrink-0 transition-colors"
      >
        ?
      </button>
    </div>
  )
}

interface TabItemProps {
  tab: TabState
  active: boolean
  onSelect: () => void
  onClose: () => void
  onSetIntent: (intent: UserIntent) => void
}

function TabItem({ tab, active, onSelect, onClose, onSetIntent }: TabItemProps) {
  const dot = tabDot(tab)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenu(null)
      }
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  const handleContextMenu = (e: React.MouseEvent) => {
    e.preventDefault()
    setMenu({ x: e.clientX, y: e.clientY })
  }

  const pick = (intent: UserIntent) => {
    setMenu(null)
    onSetIntent(intent)
  }

  return (
    <>
      <div
        onClick={onSelect}
        onContextMenu={handleContextMenu}
        className={cn(
          'group flex items-center gap-1.5 px-3 h-full cursor-pointer border-r border-tn-border',
          'text-base whitespace-nowrap select-none shrink-0 transition-colors',
          active
            ? 'bg-tn-bg text-white font-medium border-b-2 border-b-tn-blue'
            : 'text-tn-text-dim hover:bg-tn-bg-alt hover:text-tn-text',
        )}
      >
        {dot && (
          <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', dot)} />
        )}
        <span className="max-w-[160px] overflow-hidden text-ellipsis">
          {tabLabel(tab.path)}
        </span>
        {tab.mode === 'markdown' && (
          <span className="text-[10px] text-tn-muted font-mono bg-tn-bg-dark px-1 rounded shrink-0">
            M
          </span>
        )}
        <button
          onClick={e => { e.stopPropagation(); onClose() }}
          aria-label="Close tab"
          className="ml-0.5 text-[16px] leading-none opacity-40 hover:opacity-100 hover:text-tn-red shrink-0 transition-opacity flex items-center justify-center w-4 h-4"
        >
          {tab.isModified ? (
            <>
              <span className="group-hover:hidden text-[12px] -translate-y-0.5">●</span>
              <span className="hidden group-hover:inline">×</span>
            </>
          ) : (
            <span>×</span>
          )}
        </button>
      </div>

      {menu && (
        <div
          ref={menuRef}
          className="fixed z-50 bg-tn-bg-dark border border-tn-border rounded shadow-lg py-1 text-sm"
          style={{ left: menu.x, top: menu.y }}
        >
          <button
            className="w-full text-left px-4 py-1.5 hover:bg-tn-bg-alt text-tn-blue disabled:opacity-40 disabled:cursor-default"
            disabled={tab.userIntent === 'keep'}
            onClick={() => pick('keep')}
          >
            Mark as Keep
          </button>
          <button
            className="w-full text-left px-4 py-1.5 hover:bg-tn-bg-alt text-tn-red disabled:opacity-40 disabled:cursor-default"
            disabled={tab.userIntent === 'trash'}
            onClick={() => pick('trash')}
          >
            Mark as Trash
          </button>
          {tab.userIntent !== null && (
            <button
              className="w-full text-left px-4 py-1.5 hover:bg-tn-bg-alt text-tn-muted"
              onClick={() => pick(null)}
            >
              Clear Intent
            </button>
          )}
        </div>
      )}
    </>
  )
}

function tabDot(tab: TabState): string | null {
  if (tab.isEmpty) return null
  if (tab.userIntent === 'trash') return 'bg-tn-red'   // marked for discard
  if (tab.status === 'filed') return 'bg-tn-green'
  if (tab.userIntent === 'keep') return 'bg-tn-blue'
  return 'bg-yellow-500'  // unfiled, amber
}

function tabLabel(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1].replace(/\.md$/, '')
}
