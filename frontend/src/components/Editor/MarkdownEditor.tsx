import React from 'react'
import { isMod } from '../../utils/platform'

interface MarkdownEditorProps {
  uuid: string
  value: string
  isActive: boolean
  onChange: (value: string) => void
  onExplain?: () => void
  onAsk?: (question?: string) => void
  onToggleAiBlocks?: () => void
  textareaRef?: React.RefObject<HTMLTextAreaElement>
}

export const MarkdownEditor: React.FC<MarkdownEditorProps> = ({
  uuid,
  value,
  isActive,
  onChange,
  onExplain,
  onAsk,
  onToggleAiBlocks,
  textareaRef
}) => {
  const lines = value.split('\n').length

  return (
    <div 
      id={`app-${uuid}`}
      className="markdown-wrapper"
      style={{ 
        display: 'flex',
        flexDirection: 'row', 
        height: '100%', 
        overflow: 'hidden',
        background: 'var(--theme-bg)',
        position: 'relative'
      }}
    >
      <div className="markdown-gutter" style={{
        width: '2.75rem',
        padding: '40px 0.6rem 0.85em',
        backgroundColor: 'var(--theme-bgDark)',
        borderRight: '1px solid var(--theme-border)',
        color: 'var(--theme-muted)',
        fontFamily: 'var(--theme-monoFont)',
        fontSize: '14px',
        lineHeight: '1.6',
        textAlign: 'right',
        userSelect: 'none',
        overflow: 'hidden'
      }}>
        {Array.from({ length: lines }).map((_, i) => (
          <div key={i}>{i + 1}</div>
        ))}
      </div>
      <textarea
        id={`ta-${uuid}`}
        ref={textareaRef}
        className="markdown-editor"
        value={value}
        onScroll={(e) => {
          const gutter = e.currentTarget.parentElement?.querySelector('.markdown-gutter')
          if (gutter) gutter.scrollTop = e.currentTarget.scrollTop
        }}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          const key = e.key.toLowerCase()
          const mod = isMod(e)
          // Note: Filing and Promote are now handled globally in App.tsx
          if (mod && key === 'e' && !e.shiftKey) { 
            if (onExplain) {
              e.preventDefault()
              e.stopPropagation()
              onExplain()
            }
          }
          if (mod && e.shiftKey && key === 'a') { 
            if (onAsk) {
              e.preventDefault()
              e.stopPropagation()
              onAsk()
            }
          }
          if (mod && key === 'j') {
            if (onToggleAiBlocks) {
              e.preventDefault()
              e.stopPropagation()
              onToggleAiBlocks()
            }
          }
        }}
        spellCheck="true"
        placeholder="Raw markdown — Mod+Shift+M to return"
        autoFocus={isActive}
        autoComplete="off"
        autoCorrect="off"
        style={{
          flex: 1,
          paddingTop: '40px',
          paddingLeft: '1rem',
          paddingRight: '1rem',
          paddingBottom: '1rem'
        }}
      />
    </div>
  )
}
