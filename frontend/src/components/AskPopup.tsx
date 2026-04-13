import { useEffect, useRef } from 'react'

interface AskPopupProps {
  contextLabel: string   // e.g. "selection" | "code block" | "document"
  onSend: (question: string) => void
  onClose: () => void
}

export function AskPopup({ contextLabel, onSend, onClose }: AskPopupProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    textareaRef.current?.focus()
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const val = textareaRef.current?.value.trim() ?? ''
      if (val) {
        onSend(val)
        onClose()
      }
    }
  }

  function handleSend() {
    const val = textareaRef.current?.value.trim() ?? ''
    if (val) {
      onSend(val)
      onClose()
    }
  }

  return (
    <div className="ask-popup">
      <div className="ask-popup__header">
        <span className="ask-popup__label">{contextLabel} Inquiry</span>
        <button className="ask-popup__close" onClick={onClose} title="Close (Esc)">✕</button>
      </div>
      <textarea
        ref={textareaRef}
        className="ask-popup__input"
        placeholder="Ask a question… (Enter to send, Shift+Enter for new line)"
        rows={3}
        onKeyDown={handleKeyDown}
        spellCheck={false}
      />
      <div className="ask-popup__footer">
        <span className="ask-popup__hint">Enter to send · Shift+Enter for new line</span>
        <button className="ask-popup__send" onClick={handleSend}>Send</button>
      </div>
    </div>
  )
}
