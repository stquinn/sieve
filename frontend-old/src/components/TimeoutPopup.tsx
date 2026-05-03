import { useRef, useState } from 'react'

interface TimeoutPopupProps {
  path: string
  suggestedName: string
  onAccept: (name: string) => void
  onRetry: () => Promise<void>    // resolves on success, rejects on second timeout
  onDelete: () => void
  onCancel: () => void
}

export function TimeoutPopup({ suggestedName, onAccept, onRetry, onDelete, onCancel }: TimeoutPopupProps) {
  const [name, setName] = useState(suggestedName)
  const [retrying, setRetrying] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  async function handleRetry() {
    setRetrying(true)
    try {
      await onRetry()
      // onRetry resolved = AI succeeded and called onAccept/onDelete itself
    } catch {
      // AI timed out again — return popup to idle state, name input intact
      setRetrying(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="bg-tn-bg-dark border border-tn-border-2 rounded-md shadow-2xl w-[420px] p-5 flex flex-col gap-4">
        <div className="text-tn-text text-[13px] font-medium">AI naming timed out</div>
        <div className="text-tn-muted text-[12px] leading-relaxed">
          Enter a name for this buffer, or choose what to do with it.
        </div>
        <input
          ref={inputRef}
          className="bg-tn-bg border border-tn-border-2 rounded px-3 py-1.5 text-[13px] text-tn-text outline-none focus:border-tn-blue w-full font-mono"
          value={name}
          onChange={e => setName(e.target.value)}
          placeholder="kebab-case-name"
          disabled={retrying}
          autoFocus
        />
        {retrying && (
          <div className="text-tn-muted text-[12px] italic">Retrying AI evaluation…</div>
        )}
        <div className="flex gap-2 justify-end">
          <button
            className="px-3 py-1.5 text-[12px] text-tn-muted hover:text-tn-text border border-tn-border-2 rounded hover:bg-tn-bg-alt transition-colors"
            onClick={onCancel}
            disabled={retrying}
          >
            Cancel
          </button>
          <button
            className="px-3 py-1.5 text-[12px] text-tn-red hover:text-white border border-tn-border-2 rounded hover:bg-tn-bg-alt transition-colors"
            onClick={onDelete}
            disabled={retrying}
          >
            Delete
          </button>
          <button
            className="px-3 py-1.5 text-[12px] text-tn-blue hover:text-white border border-tn-border-2 rounded hover:bg-tn-bg-alt transition-colors"
            onClick={handleRetry}
            disabled={retrying}
          >
            Retry
          </button>
          <button
            className="px-3 py-1.5 text-[12px] bg-tn-blue text-white rounded hover:brightness-110 transition-colors disabled:opacity-50"
            onClick={() => onAccept(name.trim() || 'untitled')}
            disabled={retrying}
          >
            Accept
          </button>
        </div>
      </div>
    </div>
  )
}
