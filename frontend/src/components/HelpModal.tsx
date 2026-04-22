import { useEffect } from 'react'

interface Props {
  onClose: () => void
}

const SHORTCUTS = [
  { keys: ['Ctrl', 'N'],            desc: 'New tab' },
  { keys: ['Ctrl', 'W'],            desc: 'Close tab (Smart close)' },
  { keys: ['Ctrl', 'P'],            desc: 'Quick switcher (files & tabs)' },
  { keys: ['Ctrl', '\\'],           desc: 'Toggle sidebar' },
  { keys: ['Ctrl', 'Shift', 'P'],   desc: 'Toggle prompt templates section' },
  { keys: ['Ctrl', 'Shift', 'I'],   desc: 'Toggle meta / info panel' },
  { keys: ['Ctrl', 'Shift', 'M'],   desc: 'Toggle Markdown / WYSIWYG mode' },
  { keys: ['Ctrl', 'F'],            desc: 'Find in current document' },
  { keys: ['Ctrl', 'Shift', 'F'],   desc: 'Store-wide search' },
  { keys: ['Ctrl', 'S'],            desc: 'Smart Save (AI summary & metadata, stays in Library)' },
  { keys: ['Mod', 'Shift', 'Enter'],desc: 'Promote (Save & File immediately to Library)' },
  { keys: ['Ctrl', 'Shift', 'E'],   desc: 'Smart Filing (Evaluate buffer & propose file path)' },
  { keys: ['Ctrl', 'E'],            desc: 'Explain selection or current block / buffer' },
  { keys: ['Ctrl', 'Shift', 'A'],   desc: 'Ask about selection or block / buffer' },
  { keys: ['Tab'],                  desc: 'Indent text (4 spaces)' },
  { keys: ['Ctrl', '/'],            desc: 'Toggle this cheat sheet' },
  { keys: ['Ctrl', 'Click'],        desc: 'Open link in browser' },
]

const MD_ROWS = [
  { syntax: '# Heading 1',            desc: 'H1' },
  { syntax: '## Heading 2',           desc: 'H2' },
  { syntax: '### Heading 3',          desc: 'H3' },
  { syntax: '**bold**',               desc: 'Bold' },
  { syntax: '*italic*',               desc: 'Italic' },
  { syntax: '~~strikethrough~~',      desc: 'Strikethrough' },
  { syntax: '`code`',                 desc: 'Inline code' },
  { syntax: '[text](url)',            desc: 'Link' },
  { syntax: '> quote',               desc: 'Blockquote' },
  { syntax: '- item',                desc: 'Unordered list' },
  { syntax: '1. item',               desc: 'Ordered list' },
  { syntax: '---',                   desc: 'Horizontal rule' },
  { syntax: '```lang\\ncode\\n```',  desc: 'Fenced code block' },
  { syntax: '```lang id="x"',        desc: 'Code block with block ID' },
  { syntax: '| a | b |\\n|---|---|', desc: 'Table' },
]

export function HelpModal({ onClose }: Props) {
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

  return (
    <div
      className="help-modal-backdrop"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="help-modal">
        <div className="help-modal__header">
          <span className="help-modal__title">Stash — Quick Reference</span>
          <button className="help-modal__close" onClick={onClose} title="Close (Esc)">✕</button>
        </div>

        <div className="help-modal__body">
          <section className="help-modal__section">
            <h3 className="help-modal__section-title">Keyboard Shortcuts</h3>
            <table className="help-modal__table">
              <tbody>
                {SHORTCUTS.map(({ keys, desc }) => (
                  <tr key={desc}>
                    <td className="help-modal__keys">
                      {keys.map((k, i) => (
                        <span key={k}>
                          <kbd className="help-modal__kbd">{k}</kbd>
                          {i < keys.length - 1 && <span className="help-modal__plus">+</span>}
                        </span>
                      ))}
                    </td>
                    <td className="help-modal__desc">{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="help-modal__section">
            <h3 className="help-modal__section-title">Markdown Reference</h3>
            <table className="help-modal__table">
              <tbody>
                {MD_ROWS.map(({ syntax, desc }) => (
                  <tr key={desc}>
                    <td className="help-modal__syntax"><code>{syntax}</code></td>
                    <td className="help-modal__desc">{desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </div>
      </div>
    </div>
  )
}
