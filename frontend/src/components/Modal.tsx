import React, { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

interface BaseModalProps {
  onClose: () => void
  children: React.ReactNode
  className?: string
}

function BaseModal({ onClose, children, className }: BaseModalProps) {
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
    <div className="fixed inset-0 z-[1000] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm animate-in fade-in duration-200">
      <div 
        ref={ref}
        className={cn(
          "bg-tn-bg-alt border border-solid border-tn-border-2 rounded-lg shadow-2xl w-full max-w-md overflow-hidden animate-in zoom-in-95 duration-200",
          className
        )}
      >
        {children}
      </div>
    </div>
  )
}

interface ConfirmModalProps {
  title: string
  message: string
  confirmLabel?: string
  cancelLabel?: string
  isDestructive?: boolean
  onConfirm: () => void
  onClose: () => void
}

export function ConfirmModal({ title, message, confirmLabel = 'Confirm', cancelLabel = 'Cancel', isDestructive = false, onConfirm, onClose }: ConfirmModalProps) {
  return (
    <BaseModal onClose={onClose}>
      <div className="p-6">
        <h3 className="text-lg font-semibold text-tn-text mb-2">{title}</h3>
        <p className="text-tn-text-dim text-sm leading-relaxed">{message}</p>
      </div>
      <div className="bg-tn-bg-dark px-6 py-4 flex justify-end gap-3">
        <button 
          onClick={onClose}
          className="px-4 py-2 text-sm font-medium text-tn-text-dim hover:text-tn-text bg-transparent border-none cursor-pointer transition-colors"
        >
          {cancelLabel}
        </button>
        <button 
          onClick={onConfirm}
          className={cn(
            "px-4 py-2 text-sm font-medium text-white rounded cursor-pointer transition-all border-none font-semibold shadow-sm active:scale-95",
            isDestructive ? "bg-tn-red hover:brightness-110" : "bg-tn-blue hover:brightness-110"
          )}
        >
          {confirmLabel}
        </button>
      </div>
    </BaseModal>
  )
}

interface PromptModalProps {
  title: string
  message: string
  placeholder?: string
  initialValue?: string
  submitLabel?: string
  onSubmit: (val: string) => void
  onClose: () => void
}

export function PromptModal({ title, message, placeholder, initialValue = '', submitLabel = 'Submit', onSubmit, onClose }: PromptModalProps) {
  const [value, setValue] = React.useState(initialValue)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  return (
    <BaseModal onClose={onClose}>
      <div className="p-6">
        <h3 className="text-lg font-semibold text-tn-text mb-2">{title}</h3>
        <p className="text-tn-text-dim text-sm mb-4">{message}</p>
        <input 
          ref={inputRef}
          type="text"
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder={placeholder}
          onKeyDown={e => {
            if (e.key === 'Enter') onSubmit(value)
            if (e.key === 'Escape') onClose()
          }}
          className="w-full bg-tn-bg-dark border border-solid border-tn-border rounded px-3 py-2 text-tn-text placeholder:text-tn-muted focus:outline-none focus:ring-1 focus:ring-tn-blue transition-all"
        />
      </div>
      <div className="bg-tn-bg-dark px-6 py-4 flex justify-end gap-3">
        <button 
          onClick={onClose}
          className="px-4 py-2 text-sm font-medium text-tn-text-dim hover:text-tn-text bg-transparent border-none cursor-pointer transition-colors"
        >
          Cancel
        </button>
        <button 
          onClick={() => onSubmit(value)}
          className="px-4 py-2 text-sm font-medium text-white rounded cursor-pointer transition-all border-none bg-tn-blue hover:brightness-110 font-semibold shadow-sm active:scale-95"
        >
          {submitLabel}
        </button>
      </div>
    </BaseModal>
  )
}
