import React, { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import { UserIntent } from '../types'
import { FolderOpen, Rocket, Sparkles, Trash2, CheckCircle2, XCircle, RotateCcw, Pencil } from 'lucide-react'

interface Props {
  x: number
  y: number
  path: string
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
}

export function NoteContextMenu({ x, y, path, intent, onClose, onSetIntent, onDelete, onRename, onShowInFiles, onSmartFile, onSmartMetadata, isDir, childCount }: Props) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose()
      }
    }
    window.addEventListener('mousedown', handler)
    return () => window.removeEventListener('mousedown', handler)
  }, [onClose])

  return (
    <div
      ref={ref}
      className="fixed z-[100] bg-tn-bg-alt border border-solid border-tn-border-2 rounded-md shadow-2xl py-1 min-w-[200px]"
      style={{ top: y, left: x }}
    >
      <div className="px-3 py-1.5 text-[11px] text-tn-muted font-mono bg-tn-bg-dark border-0 border-b border-solid border-white/20 uppercase tracking-wider truncate mb-1">
        {path.split('/').pop()}
      </div>

      <button
        className="w-full bg-transparent border-none text-left px-3 py-1.5 text-[14px] text-tn-text hover:bg-tn-border hover:text-white transition-colors flex items-center gap-2"
        onClick={() => { onShowInFiles(); onClose() }}
      >
        <FolderOpen className="w-4 h-4 opacity-70" />
        Show in Files
      </button>
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
        className={cn(
          "w-full bg-transparent border-none text-left px-3 py-1.5 text-[14px] text-tn-red transition-colors flex items-center gap-2",
          isDir && childCount! > 0 ? "opacity-30 cursor-not-allowed" : "hover:bg-tn-red/10 hover:text-tn-red"
        )}
        onClick={() => {
          if (isDir && childCount! > 0) return
          onDelete(); 
          onClose();
        }}
        disabled={isDir && childCount! > 0}
      >
        <Trash2 className="w-4 h-4 opacity-70" />
        {isDir ? 'Delete Folder' : 'Delete Note...'}
      </button>
    </div>
  )
}
