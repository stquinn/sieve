import { cn } from '@/lib/utils'
import { forwardRef, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TabState, UserIntent } from '../types'

interface TabBarProps {
  tabs: TabState[]
  activeIdx: number
  onSelect: (idx: number) => void
  onClose: (idx: number) => void
  onNew: () => void
  onHelp: () => void
  onSetIntent: (idx: number, intent: UserIntent) => void
  onReorder: (fromIdx: number, toPos: number) => void
}

export function TabBar({ tabs, activeIdx, onSelect, onClose, onNew, onHelp, onSetIntent, onReorder }: TabBarProps) {
  const tabsAreaRef = useRef<HTMLDivElement>(null)
  const tabRefs = useRef<(HTMLDivElement | null)[]>([])
  const [hiddenStart, setHiddenStart] = useState(tabs.length)
  const [showOverflow, setShowOverflow] = useState(false)
  const overflowBtnRef = useRef<HTMLDivElement>(null)

  // Drag state — use refs for drop handler reliability, state for rendering
  const dragIdxRef = useRef<number | null>(null)
  const dropPosRef = useRef<number | null>(null)
  const [dragIdx, setDragIdx] = useState<number | null>(null)
  const [dropPos, setDropPos] = useState<number | null>(null)

  // Keep tabRefs array in sync with tab count
  tabRefs.current = tabRefs.current.slice(0, tabs.length)

  // Find the first tab clipped by overflow:hidden on the tabs area
  useLayoutEffect(() => {
    const area = tabsAreaRef.current
    if (!area) return

    const measure = () => {
      const areaRight = area.getBoundingClientRect().right
      let firstHidden = tabs.length
      for (let i = 0; i < tabRefs.current.length; i++) {
        const el = tabRefs.current[i]
        if (!el) continue
        if (el.getBoundingClientRect().right > areaRight + 1) {
          firstHidden = i
          break
        }
      }
      setHiddenStart(firstHidden)
    }

    const ro = new ResizeObserver(measure)
    ro.observe(area)
    measure()
    return () => ro.disconnect()
  }, [tabs.length])

  // Close overflow dropdown on outside click
  useEffect(() => {
    if (!showOverflow) return
    const handler = (e: MouseEvent) => {
      if (overflowBtnRef.current && !overflowBtnRef.current.contains(e.target as Node)) {
        setShowOverflow(false)
      }
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [showOverflow])

  const hiddenCount = tabs.length - hiddenStart

  const updateDrop = (pos: number) => {
    dropPosRef.current = pos
    setDropPos(pos)
  }

  const commitDrop = () => {
    const from = dragIdxRef.current
    const to = dropPosRef.current
    if (from !== null && to !== null && to !== from && to !== from + 1) {
      onReorder(from, to)
    }
    dragIdxRef.current = null
    dropPosRef.current = null
    setDragIdx(null)
    setDropPos(null)
  }

  const cancelDrag = () => {
    dragIdxRef.current = null
    dropPosRef.current = null
    setDragIdx(null)
    setDropPos(null)
  }

  // Show drop indicator at position `pos` only when it's a meaningful move
  const showIndicatorAt = (pos: number) =>
    dragIdx !== null &&
    dropPos === pos &&
    pos !== dragIdx &&
    pos !== dragIdx + 1

  return (
    <div className="flex items-stretch bg-[#13131a] border-0 border-b-2 border-solid border-[#3b4261] h-[44px] shrink-0">

      {/* Tab scroll area — clips overflowing tabs */}
      <div
        ref={tabsAreaRef}
        className="flex items-stretch shrink overflow-hidden min-w-0"
      >
        {tabs.map((tab, idx) => (
          <div key={tab.path} className="flex items-stretch shrink min-w-[80px] w-[250px]">
            {showIndicatorAt(idx) && <DropIndicator />}
            <TabItem
              ref={el => { tabRefs.current[idx] = el }}
              tab={tab}
              active={idx === activeIdx}
              isDragging={dragIdx === idx}
              onSelect={() => onSelect(idx)}
              onClose={() => onClose(idx)}
              onSetIntent={intent => onSetIntent(idx, intent)}
              onDragStart={() => {
                dragIdxRef.current = idx
                setDragIdx(idx)
                setDropPos(null)
              }}
              onDragOver={e => {
                e.preventDefault()
                const rect = (e.currentTarget as HTMLElement).getBoundingClientRect()
                updateDrop(e.clientX < rect.left + rect.width / 2 ? idx : idx + 1)
              }}
              onDrop={e => { e.preventDefault(); commitDrop() }}
              onDragEnd={cancelDrag}
            />
          </div>
        ))}
        {/* Indicator after the last tab */}
        {showIndicatorAt(tabs.length) && <DropIndicator />}
      </div>

      {/* Overflow dropdown — shows tabs that don't fit */}
      {hiddenCount > 0 && (
        <div ref={overflowBtnRef} className="relative shrink-0 flex items-stretch border-0 border-l border-solid border-white/10">
          <button
            onClick={() => setShowOverflow(v => !v)}
            className={cn(
              'px-2.5 bg-transparent border-none h-full text-[14px] font-mono leading-none transition-colors',
              showOverflow
                ? 'text-tn-text bg-tn-bg-alt'
                : 'text-tn-muted hover:text-tn-text hover:bg-tn-bg-alt'
            )}
            title={`${hiddenCount} more tab${hiddenCount > 1 ? 's' : ''}`}
          >
            ▾ {hiddenCount}
          </button>
          {showOverflow && (
            <div className="absolute right-0 top-full mt-px z-50 bg-[#1c1d2a] border border-solid border-white/20 rounded-md shadow-2xl py-1 min-w-[200px]">
              {tabs.slice(hiddenStart).map((tab, i) => {
                const realIdx = hiddenStart + i
                const dot = tabDot(tab)
                return (
                  <button
                    key={tab.path}
                    onClick={() => { onSelect(realIdx); setShowOverflow(false) }}
                    className={cn(
                      'w-full bg-transparent border-none text-left px-3 py-1.5 text-[14px] flex items-center gap-2 transition-colors',
                      realIdx === activeIdx
                        ? 'text-tn-blue bg-[#1e2030]'
                        : 'text-tn-text-dim hover:bg-[#1e2030] hover:text-tn-text'
                    )}
                  >
                    {dot && <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', dot)} />}
                    <span className="truncate">{tabLabel(tab)}</span>
                  </button>
                )
              })}
            </div>
          )}
        </div>
      )}

      {/* New tab */}
      <button
        onClick={onNew}
        aria-label="New tab"
        className="px-3 md:px-4 bg-transparent border-none h-full text-tn-muted hover:text-tn-text hover:bg-tn-bg-alt text-[20px] leading-none shrink-0 transition-colors border-0 border-l border-solid border-white/10"
      >
        +
      </button>

      {/* Spacer */}
      <div 
        className="flex-1 min-w-0" 
        onDragOver={e => {
          e.preventDefault()
          if (dragIdx !== null) {
            updateDrop(tabs.length)
          }
        }}
        onDrop={e => {
          e.preventDefault()
          commitDrop()
        }}
      />

      {/* Help */}
      <button
        onClick={onHelp}
        aria-label="Keyboard shortcuts (Ctrl+/)"
        title="Shortcuts (Ctrl+/)"
        className="px-3 md:px-4 bg-transparent border-none h-full text-tn-muted hover:text-tn-text hover:bg-tn-bg-alt text-[14px] leading-none shrink-0 transition-colors"
      >
        ?
      </button>
    </div>
  )
}

function DropIndicator() {
  return <div className="w-0.5 bg-tn-blue self-stretch my-0.5 rounded-full shrink-0 mx-px" />
}

// ── TabItem ────────────────────────────────────────────────────────────────

interface TabItemProps {
  tab: TabState
  active: boolean
  isDragging: boolean
  onSelect: () => void
  onClose: () => void
  onSetIntent: (intent: UserIntent) => void
  onDragStart: () => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onDragEnd: () => void
}

const TabItem = forwardRef<HTMLDivElement, TabItemProps>(function TabItem(
  { tab, active, isDragging, onSelect, onClose, onSetIntent, onDragStart, onDragOver, onDrop, onDragEnd },
  ref
) {
  const dot = tabDot(tab)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    const close = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenu(null)
    }
    window.addEventListener('mousedown', close)
    return () => window.removeEventListener('mousedown', close)
  }, [menu])

  const tooltip = [
    tab.displayName ?? null,
    tab.path,
    tab.status === 'filed' ? 'Status: Filed' : '',
    tab.isModified ? '* Unsaved changes' : '',
    tab.userIntent === 'keep' ? 'Intent: Keep' : tab.userIntent === 'trash' ? 'Intent: Trash' : ''
  ].filter(Boolean).join('\n')

  return (
    <>
      <div
        ref={ref}
        title={tooltip}
        draggable
        onDragStart={(e) => {
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move'
            e.dataTransfer.setData('text/plain', tab.path)
          }
          onDragStart()
        }}
        onDragOver={onDragOver}
        onDrop={onDrop}
        onDragEnd={onDragEnd}
        onClick={onSelect}
        onContextMenu={e => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY }) }}
        className={cn(
          'group flex items-center gap-1.5 px-3 md:px-4 h-full cursor-pointer w-full',
          'text-[14px] whitespace-nowrap select-none shrink transition-colors',
          'border-solid border-0 border-r-[1px] border-r-white/10',
          isDragging && 'opacity-40',
          active
            ? 'bg-tn-bg text-tn-text border-t-2 border-t-tn-blue border-b-2 border-b-tn-bg -mb-[2px]'
            : 'bg-[#13131a] text-tn-text-dim hover:bg-[#1a1b2e] hover:text-tn-text border-t-2 border-t-transparent border-b-2 border-b-transparent -mb-[2px]',
        )}
      >
        {dot && <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', dot)} />}
        <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap min-w-0 text-left">
          {tabLabel(tab)}
        </span>
        {tab.mode === 'markdown' && (
          <span className="text-[12px] text-tn-blue font-bold font-mono bg-[#1e2030] px-1.5 rounded shrink-0">M</span>
        )}
        <button
          onClick={e => { e.stopPropagation(); onClose() }}
          aria-label="Close tab"
          className="ml-0.5 opacity-0 group-hover:opacity-40 hover:!opacity-100 hover:text-tn-red shrink-0 transition-opacity flex items-center justify-center w-4 h-4 text-[15px] leading-none"
        >
          {tab.isModified ? (
            <>
              <span className="group-hover:hidden text-[10px]">●</span>
              <span className="hidden group-hover:inline">×</span>
            </>
          ) : (
            <span>×</span>
          )}
        </button>
      </div>

      {/* Right-click context menu */}
      {menu && (
        <div
          ref={menuRef}
          className="fixed z-50 py-1 min-w-[160px]"
          style={{
            left: menu.x,
            top: menu.y,
            background: '#1c1d2a',
            border: '1px solid rgba(255,255,255,0.2)',
            borderRadius: '6px',
            boxShadow: '0 8px 32px rgba(0,0,0,0.5)',
          }}
        >
          <button
            className={cn(
              "w-full bg-transparent border-none text-left px-3 py-1.5 text-[14px] transition-colors flex items-center gap-2",
              "text-[#7aa2f7] hover:bg-[#2a2b3d] hover:text-[#c0caf5]",
              "disabled:text-[#565f89] disabled:opacity-35 disabled:cursor-default disabled:hover:bg-transparent"
            )}
            disabled={tab.userIntent === 'keep'}
            onClick={() => { setMenu(null); onSetIntent('keep') }}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-tn-blue shrink-0" />
            Mark as Keep
          </button>
          <button
            className={cn(
              "w-full bg-transparent border-none text-left px-3 py-1.5 text-[14px] transition-colors flex items-center gap-2",
              "text-[#f7768e] hover:bg-[#2a2b3d] hover:text-[#c0caf5]",
              "disabled:text-[#565f89] disabled:opacity-35 disabled:cursor-default disabled:hover:bg-transparent"
            )}
            disabled={tab.userIntent === 'trash'}
            onClick={() => { setMenu(null); onSetIntent('trash') }}
          >
            <span className="w-1.5 h-1.5 rounded-full bg-tn-red shrink-0" />
            Mark as Trash
          </button>
          {tab.userIntent !== null && (
            <>
              <div className="my-1 border-0 border-t border-solid border-white/10" />
              <button
                className="w-full bg-transparent border-none text-left px-3 py-1.5 text-[14px] text-[#565f89] hover:bg-[#2a2b3d] hover:text-white transition-colors"
                onClick={() => { setMenu(null); onSetIntent(null) }}
              >
                Clear Intent
              </button>
            </>
          )}
        </div>
      )}
    </>
  )
})

// ── Helpers ────────────────────────────────────────────────────────────────

function tabDot(tab: TabState): string | null {
  if (tab.isEmpty) return null
  if (tab.userIntent === 'trash') return 'bg-tn-red'
  if (tab.status === 'filed') return 'bg-tn-green'
  if (tab.userIntent === 'keep') return 'bg-tn-blue'
  return 'bg-yellow-500'
}

function tabLabel(tab: TabState): string {
  if (tab.displayName) return tab.displayName
  const parts = tab.path.replace(/\\/g, '/').split('/')
  return parts[parts.length - 1].replace(/\.md$/, '')
}
