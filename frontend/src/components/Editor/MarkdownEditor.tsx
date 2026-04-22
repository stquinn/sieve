import React from 'react'

interface MarkdownEditorProps {
  uuid: string
  value: string
  isActive: boolean
  onChange: (value: string) => void
  onExplain?: () => void
  onAsk?: () => void
  textareaRef?: React.RefObject<HTMLTextAreaElement>
}

export const MarkdownEditor: React.FC<MarkdownEditorProps> = ({
  uuid,
  value,
  isActive,
  onChange,
  onExplain,
  onAsk,
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
          // Note: Filing and Promote are now handled globally in App.tsx
          if (e.ctrlKey && key === 'e' && !e.shiftKey) { 
            if (onExplain) {
              e.preventDefault()
              e.stopPropagation()
              onExplain()
            }
          }
          if (e.ctrlKey && e.shiftKey && key === 'a') { 
            if (onAsk) {
              e.preventDefault()
              e.stopPropagation()
              onAsk()
            }
          }
        }}
        spellCheck="true"
        placeholder="Raw markdown — Ctrl+Shift+M to return"
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
