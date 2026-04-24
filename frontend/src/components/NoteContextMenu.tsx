import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { cn } from '@/lib/utils'
import { UserIntent } from '../types'
import { FolderOpen, Rocket, Sparkles, Trash2, CheckCircle2, XCircle, RotateCcw, Pencil, X } from 'lucide-react'

// ── Shared menu shell ──────────────────────────────────────────────────────

interface MenuShellProps {
  x: number
  y: number
  onClose: () => void
  children: React.ReactNode
}

function MenuShell({ x, y, onClose, children }: MenuShellProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState({ top: y, left: x })

  // Clamp to viewport after the first paint so we know the menu dimensions.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const { width, height } = el.getBoundingClientRect()
    const vw = window.innerWidth
    const vh = window.innerHeight
    setPos({
      top:  Math.min(y, vh - height - 8),
      left: Math.min(x, vw - width  - 8),
    })
  }, [x, y])

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [onClose])

  return (
    <div
      ref={ref}
      className="fixed z-[100] bg-tn-bg-alt border border-solid border-tn-border-2 rounded-md shadow-2xl py-1 min-w-[200px]"
      style={{ top: pos.top, left: pos.left }}
    >
      {children}
    </div>
  )
}

// ── Prompt context menu ────────────────────────────────────────────────────

interface PromptContextMenuProps {
  x: number
  y: number
  name: string
  isVirtual?: boolean
  onClose: () => void
  onRestore?: () => void
}

export function PromptContextMenu({ x, y, name, isVirtual, onClose, onRestore }: PromptContextMenuProps) {
  return (
    <MenuShell x={x} y={y} onClose={onClose}>
      <div className="px-3 py-1.5 text-[11px] text-white/70 font-mono bg-tn-bg-dark border-0 border-b border-solid border-white/20 uppercase tracking-wider truncate mb-1">
        {name}.md
      </div>
      {!isVirtual && onRestore && (
        <button
          className="w-full bg-transparent border-none text-left px-3 py-1.5 text-[14px] text-tn-orange hover:bg-tn-border hover:text-white transition-colors flex items-center gap-2"
          onClick={() => { onRestore(); onClose() }}
        >
          <RotateCcw className="w-4 h-4 opacity-70" />
          Restore to Default
        </button>
      )}
      <div className="px-3 py-1.5 text-[10px] text-white/50 uppercase tracking-[0.1em] font-bold italic border-t border-white/10 mt-1">
        AI Instruction Template
      </div>
    </MenuShell>
  )
}

// ── Note / folder context menu ─────────────────────────────────────────────

interface NoteContextMenuProps {
  x: number
  y: number
  id: string        // opaque: UUID for notes, folderID for dirs, prompt.id for prompts
  name: string      // display name — no parsing needed
  path?: string     // ExternalRef label — only for ShowInFiles
  isPrompt?: boolean
  intent: UserIntent
  onClose: () => void
  onSetIntent: (intent: UserIntent) => void
  onDelete: () => void
  onRename: () => void
  onShowInFiles: () => void
  onSmartFile: () => void
  onSmartMetadata: () => void
  isDir?: boolean
  childCount?: number
  isVirtual?: boolean
  onRestore?: () => void
  onCloseTab?: () => void
  onCloseAllTabs?: () => void
}

export function NoteContextMenu({
  x, y, id, name, path, isPrompt, intent, onClose, onSetIntent, onDelete, onRename,
  onShowInFiles, onSmartFile, onSmartMetadata,
  isDir, childCount, isVirtual, onRestore, onCloseTab, onCloseAllTabs,
}: NoteContextMenuProps) {
  // Delegate prompts to the dedicated component.
  if (isPrompt) {
    return (
      <PromptContextMenu
        x={x} y={y} name={name} isVirtual={isVirtual}
        onClose={onClose} onRestore={onRestore}
      />
    )
  }

  return (
    <MenuShell x={x} y={y} onClose={onClose}>
      {!isDir && (
        <>
          <button
            className="w-full bg-transparent border-none text-left px-3 py-1.5 text-[14px] text-tn-text hover:bg-tn-border hover:text-white transition-colors flex items-center gap-2"
            onClick={() => { onSmartFile(); onClose() }}
          >
            <Rocket className="w-4 h-4 opacity-70" />
            Smart File
          </button>
          <button
            className="w-full bg-transparent border-none text-left px-3 py-1.5 text-[14px] text-tn-text hover:bg-tn-border hover:text-white transition-colors flex items-center gap-2"
            onClick={() => { onSmartMetadata(); onClose() }}
          >
            <Sparkles className="w-4 h-4 opacity-70" />
            Smart Metadata
          </button>
        </>
      )}

      {!isDir && (
        <>
          <div className="my-1 border-0 border-t border-solid border-white/20" />
          <button
            className={cn(
              "w-full bg-transparent border-none text-left px-3 py-1.5 text-[14px] transition-colors flex items-center gap-2",
              "text-tn-blue hover:bg-tn-border hover:text-tn-text",
              intent === 'keep' && "bg-tn-border text-white"
            )}
            onClick={() => { onSetIntent('keep'); onClose() }}
          >
            <CheckCircle2 className="w-4 h-4 opacity-70 text-tn-blue" />
            Mark as Keep
          </button>
          <button
            className={cn(
              "w-full bg-transparent border-none text-left px-3 py-1.5 text-[14px] transition-colors flex items-center gap-2",
              "text-tn-red hover:bg-tn-border hover:text-tn-text",
              intent === 'trash' && "bg-tn-border text-white"
            )}
            onClick={() => { onSetIntent('trash'); onClose() }}
          >
            <XCircle className="w-4 h-4 opacity-70 text-tn-red" />
            Mark as Trash
          </button>

          {intent !== null && (
            <button
              className="w-full bg-transparent border-none text-left px-3 py-1.5 text-[14px] text-tn-muted hover:bg-tn-border hover:text-white transition-colors flex items-center gap-2"
              onClick={() => { onSetIntent(null); onClose() }}
            >
              <RotateCcw className="w-4 h-4 opacity-70" />
              Clear Intent
            </button>
          )}
        </>
      )}

      <div className="my-1 border-0 border-t border-solid border-white/20" />

      <button
        className="w-full bg-transparent border-none text-left px-3 py-1.5 text-[14px] text-tn-text hover:bg-tn-border hover:text-white transition-colors flex items-center gap-2"
        onClick={() => { onRename(); onClose() }}
      >
        <Pencil className="w-4 h-4 opacity-70" />
        Rename...
      </button>

      <div className="my-1 border-0 border-t border-solid border-white/20" />

      <button
        className="w-full bg-transparent border-none text-left px-3 py-1.5 text-[14px] text-tn-text hover:bg-tn-border hover:text-white transition-colors flex items-center gap-2"
        onClick={() => { onShowInFiles(); onClose() }}
      >
        <FolderOpen className="w-4 h-4 opacity-70" />
        Show in Files
      </button>

      <div className="my-1 border-0 border-t border-solid border-white/20" />

      <button
        className={cn(
          "w-full bg-transparent border-none text-left px-3 py-1.5 text-[14px] text-tn-red transition-colors flex items-center gap-2",
          isDir && childCount! > 0 ? "opacity-30 cursor-not-allowed" : "hover:bg-tn-red hover:text-white"
        )}
        onClick={() => {
          if (isDir && childCount! > 0) return
          onDelete()
          onClose()
        }}
        disabled={isDir && childCount! > 0}
      >
        <Trash2 className="w-4 h-4 opacity-70" />
        {isDir ? 'Delete Folder' : 'Delete Note...'}
      </button>

      {onCloseTab && (
        <>
          <div className="my-1 border-0 border-t border-solid border-white/20" />
          <button
            className="w-full bg-transparent border-none text-left px-3 py-1.5 text-[14px] text-tn-text hover:bg-tn-border hover:text-white transition-colors flex items-center gap-2"
            onClick={() => { onCloseTab(); onClose() }}
          >
            <X className="w-4 h-4 opacity-70" />
            Close This Tab
          </button>
        </>
      )}

      {onCloseAllTabs && (
        <button
          className="w-full bg-transparent border-none text-left px-3 py-1.5 text-[14px] text-tn-text hover:bg-tn-border hover:text-white transition-colors flex items-center gap-2"
          onClick={() => { onCloseAllTabs(); onClose() }}
        >
          <X className="w-4 h-4 opacity-70" />
          Close All Tabs
        </button>
      )}
    </MenuShell>
  )
}
