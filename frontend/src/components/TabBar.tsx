import { cn } from '@/lib/utils'
import { forwardRef, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { TabState, UserIntent } from '../types'
import { NoteContextMenu } from './NoteContextMenu'
import { FileText } from 'lucide-react'

interface TabBarProps {
  tabs: TabState[]
  activeIdx: number
  ds: any
  onSelect: (idx: number) => void
  onClose: (idx: number) => void
  onNew: () => void
  onHelp: () => void
  onSetIntent: (uuid: string, intent: UserIntent) => void
  onReorder: (from: number, to: number) => void
  onShowInFiles: (path: string) => void
  onSmartFile: (path: string) => void
  onSmartMetadata: (path: string) => void
  onDelete: (path: string) => void
  onRename: (path: string, name: string, isDir: boolean) => void
  onRestorePrompt: (name: string) => void
  onCloseAll: () => void
}

export function TabBar({
  tabs,
  activeIdx,
  ds,
  onSelect,
  onClose,
  onNew,
  onHelp,
  onSetIntent,
  onReorder,
  onShowInFiles,
  onSmartFile,
  onSmartMetadata,
  onDelete,
  onRename,
  onRestorePrompt,
  onCloseAll
}: TabBarProps) {
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
    <div className="flex items-stretch bg-tn-bg-dark border-0 border-b-2 border-solid border-tn-border-2 h-[44px] shrink-0">

      {/* Tab scroll area — clips overflowing tabs */}
      <div
        ref={tabsAreaRef}
        className="flex items-stretch shrink overflow-hidden min-w-0"
      >
        {tabs.map((tab, idx) => (
          <div key={tab.uuid} className="flex items-stretch shrink min-w-[80px] w-[250px]">
            {showIndicatorAt(idx) && <DropIndicator />}
            <TabItem
              ref={el => { tabRefs.current[idx] = el }}
              tab={tab}
              ds={ds}
              active={idx === activeIdx}
              isDragging={dragIdx === idx}
              onSelect={() => onSelect(idx)}
              onClose={() => onClose(idx)}
              onSetIntent={intent => onSetIntent(tab.uuid, intent)}
              onShowInFiles={() => onShowInFiles(ds.get(tab.uuid)?.path || '')}
              onSmartFile={() => onSmartFile(ds.get(tab.uuid)?.path || '')}
              onSmartMetadata={() => onSmartMetadata(ds.get(tab.uuid)?.path || '')}
              onDelete={() => onDelete(ds.get(tab.uuid)?.path || '')}
              onRename={() => onRename(ds.get(tab.uuid)?.path || '', tabLabel(tab, ds), false)}
              onCloseAll={onCloseAll}
              isVirtual={tab.isVirtual}
              onRestore={onRestorePrompt ? () => onRestorePrompt((ds.get(tab.uuid)?.path || '').split(':').pop()!) : undefined}
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
            <div className="absolute right-0 top-full mt-px z-50 bg-tn-bg-alt border border-solid border-white/20 rounded-md shadow-2xl py-1 min-w-[200px]">
              {tabs.slice(hiddenStart).map((tab: TabState, i: number) => {
                const realIdx = hiddenStart + i
                const doc = ds.get(tab.uuid)
                const dot = tabDot(tab, ds)
                const isEvaluating = doc?.meta?.status === 'evaluating' // simplified
                return (
                  <button
                    key={tab.uuid}
                    onClick={() => { onSelect(realIdx); setShowOverflow(false) }}
                    className={cn(
                      'w-full bg-transparent border-none text-left px-3 py-1.5 text-[14px] flex items-center gap-2 transition-colors',
                      realIdx === activeIdx
                        ? 'text-tn-blue bg-tn-bg-alt'
                        : 'text-tn-text-dim hover:bg-tn-bg-alt hover:text-tn-text'
                    )}
                  >
                    {isEvaluating
                      ? <span className="w-2 h-2 rounded-full border-2 border-solid border-tn-orange border-t-transparent animate-spin shrink-0" />
                      : dot ? <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', dot)} /> : null
                    }
                    <span className="truncate">{tabLabel(tab, ds)}</span>
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
  onShowInFiles: () => void
  onSmartFile: () => void
  onSmartMetadata: () => void
  onDelete: () => void
  onRename: () => void
  isVirtual?: boolean
  onRestore?: () => void
  onDragStart: () => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
  onDragEnd: () => void
  onCloseAll: () => void
  ds: any
}

const TabItem = forwardRef<HTMLDivElement, TabItemProps>(function TabItem(
  { tab, active, isDragging, ds, onSelect, onClose, onSetIntent, onShowInFiles, onSmartFile, onSmartMetadata, onDelete, onRename, isVirtual, onRestore, onDragStart, onDragOver, onDrop, onDragEnd, onCloseAll },
  ref
) {
  const doc = ds.get(tab.uuid)
  const meta = doc?.meta
  const dot = tabDot(tab, ds)
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null)

  const tooltip = [
    meta?.displayName ?? null,
    doc?.path || tab.uuid,
    meta?.status === 'filed' ? 'Status: Filed' : '',
    doc?.isModified ? '* Unsaved changes' : '',
    meta?.userIntent === 'keep' ? 'Intent: Keep' : meta?.userIntent === 'trash' ? 'Intent: Trash' : ''
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
            e.dataTransfer.setData('text/plain', doc?.path || tab.uuid)
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
            : 'bg-tn-bg-dark text-tn-text-dim hover:bg-tn-bg hover:text-tn-text border-t-2 border-t-transparent border-b-2 border-b-transparent -mb-[2px]',
        )}
      >
        {(meta?.status === 'evaluating' || meta?.status === 'thinking' || ds.getTransient(tab.uuid).isWaitingAI)
          ? <span className="w-2 h-2 rounded-full border-2 border-solid border-tn-orange border-t-transparent animate-spin shrink-0" />
          : dot ? <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', dot)} /> 
          : <FileText className="w-3.5 h-3.5 opacity-40 shrink-0" />
        }
        <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap min-w-0 text-left">
          {tabLabel(tab, ds)}
        </span>
        {tab.mode === 'markdown' && (
          <span className="text-[12px] text-tn-blue font-bold font-mono bg-tn-bg-alt px-1.5 rounded shrink-0">M</span>
        )}
        <button
          onClick={e => { e.stopPropagation(); onClose() }}
          aria-label="Close tab"
          className="ml-0.5 opacity-0 group-hover:opacity-40 hover:!opacity-100 hover:text-tn-red shrink-0 transition-opacity flex items-center justify-center w-4 h-4 text-[15px] leading-none"
        >
          {doc?.isModified ? (
            <>
              <span className="group-hover:hidden text-[10px]">●</span>
              <span className="hidden group-hover:inline">×</span>
            </>
          ) : (
            <span>×</span>
          )}
        </button>
      </div>

      {/* Unified Right-click context menu */}
      {menu && (
        <NoteContextMenu
          x={menu.x}
          y={menu.y}
          path={doc?.path || ''}
          intent={meta?.userIntent || null}
          onClose={() => setMenu(null)}
          onSetIntent={onSetIntent}
          onShowInFiles={onShowInFiles}
          onSmartFile={onSmartFile}
          onSmartMetadata={onSmartMetadata}
          onDelete={onDelete}
          onRename={onRename}
          isVirtual={isVirtual}
          onRestore={onRestore}
          onCloseTab={onClose}
          onCloseAllTabs={onCloseAll}
        />
      )}
    </>
  )
})

// ── Helpers ────────────────────────────────────────────────────────────────

function tabDot(tab: TabState, ds: any): string | null {
  const doc = ds.get(tab.uuid)
  const meta = doc?.meta
  if (!doc || (doc.body.trim().length === 0)) return null
  if (meta?.userIntent === 'trash') return 'bg-tn-red'
  if (meta?.status === 'filed') return 'bg-tn-green'
  if (meta?.userIntent === 'keep') return 'bg-tn-blue'
  return doc.isModified ? 'bg-tn-orange' : null
}

function tabLabel(tab: TabState, ds: any): string {
  const doc = ds.get(tab.uuid)
  const meta = doc?.meta
  let label = meta?.displayName
  if (!label) {
    const path = doc?.path || tab.uuid
    const parts = path.replace(/\\/g, '/').split('/')
    label = parts[parts.length - 1].replace(/\.md$/, '')
  }
  return meta?.status === 'error' ? `⚠️ ${label}` : label
}
