import React, { createContext, useContext, useState } from 'react'
import { ConfirmModal, PromptModal } from '../components/Modal'

interface ConfirmOptions {
  title: string
  message: string
  isDestructive?: boolean
  onConfirm: () => void
}

interface PromptOptions {
  title: string
  message: string
  placeholder?: string
  initialValue?: string
  onSubmit: (val: string) => void
}

interface ModalContextValue {
  confirm: (opts: ConfirmOptions) => void
  prompt: (opts: PromptOptions) => void
}

const ModalContext = createContext<ModalContextValue | null>(null)

export function ModalProvider({ children }: { children: React.ReactNode }) {
  const [confirmState, setConfirmState] = useState<ConfirmOptions | null>(null)
  const [promptState, setPromptState] = useState<PromptOptions | null>(null)

  const value: ModalContextValue = {
    confirm: (opts) => setConfirmState(opts),
    prompt: (opts) => setPromptState(opts),
  }

  return (
    <ModalContext.Provider value={value}>
      {children}
      {confirmState && (
        <ConfirmModal
          {...confirmState}
          onClose={() => setConfirmState(null)}
        />
      )}
      {promptState && (
        <PromptModal
          {...promptState}
          onClose={() => setPromptState(null)}
        />
      )}
    </ModalContext.Provider>
  )
}

export function useModal(): ModalContextValue {
  const ctx = useContext(ModalContext)
  if (!ctx) throw new Error('useModal must be used inside ModalProvider')
  return ctx
}
