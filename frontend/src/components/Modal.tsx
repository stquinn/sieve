import React, { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'

interface BaseModalProps {
  onClose: () => void
  children: React.ReactNode
  className?: string
}

export function BaseModal({ onClose, children, className }: BaseModalProps) {
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
          "bg-tn-bg-dark border border-solid border-tn-border-2 rounded-xl shadow-2xl w-full max-w-xl overflow-hidden animate-in zoom-in-95 duration-200",
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
      <div className="px-8 pt-6 pb-8">
        <h3 className="text-xl font-bold text-tn-text mb-3">{title}</h3>
        <p className="text-tn-text-dim text-base leading-relaxed">{message}</p>
      </div>
      <div className="bg-tn-bg-alt px-8 py-5 flex justify-end gap-3 border-t border-solid border-tn-border-2">
        <button 
          onClick={onClose}
          className="px-6 py-2.5 text-base font-medium text-tn-text-dim hover:text-tn-text bg-transparent border-none cursor-pointer transition-colors"
        >
          {cancelLabel}
        </button>
        <button 
          onClick={async () => {
            await onConfirm()
            onClose()
          }}
          className={cn(
            "px-8 py-2.5 text-base font-bold text-white rounded-lg cursor-pointer transition-all border-none shadow-lg active:scale-95",
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
      <div className="px-8 pt-6 pb-8">
        <h3 className="text-xl font-bold text-tn-text mb-3">{title}</h3>
        <p className="text-tn-text-dim text-base mb-5">{message}</p>
        <input 
          ref={inputRef}
          type="text"
          value={value}
          onChange={e => setValue(e.target.value)}
          placeholder={placeholder}
          onKeyDown={e => {
            if (e.key === 'Enter') {
              (async () => {
                await onSubmit(value)
                onClose()
              })()
            }
            if (e.key === 'Escape') onClose()
          }}
          className="w-full bg-tn-bg-dark border-2 border-solid border-tn-border-2 rounded-xl px-5 py-3.5 text-xl text-tn-text placeholder:text-tn-muted focus:outline-none focus:border-tn-blue focus:ring-4 focus:ring-tn-blue/20 transition-all shadow-inner"
        />
      </div>
      <div className="bg-tn-bg-alt px-8 py-5 flex justify-end gap-3 border-t border-solid border-tn-border-2">
        <button 
          onClick={onClose}
          className="px-6 py-2.5 text-base font-medium text-tn-text-dim hover:text-tn-text bg-transparent border-none cursor-pointer transition-colors"
        >
          Cancel
        </button>
        <button 
          onClick={async () => {
            await onSubmit(value)
            onClose()
          }}
          className="px-8 py-2.5 text-base font-bold text-white rounded-lg cursor-pointer transition-all border-none bg-tn-blue hover:brightness-110 shadow-lg active:scale-95"
        >
          {submitLabel}
        </button>
      </div>
    </BaseModal>
  )
}
