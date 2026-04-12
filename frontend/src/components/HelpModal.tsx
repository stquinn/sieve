import { useEffect } from 'react'

interface Props {
  onClose: () => void
}

const SHORTCUTS = [
  { keys: ['Ctrl', 'N'],            desc: 'New tab' },
  { keys: ['Ctrl', 'W'],            desc: 'Close tab' },
  { keys: ['Ctrl', 'P'],            desc: 'Quick switcher (files & tabs)' },
  { keys: ['Ctrl', 'F'],            desc: 'Find in document' },
  { keys: ['Ctrl', 'Shift', 'F'],   desc: 'Vault-wide search' },
  { keys: ['Ctrl', 'S'],            desc: 'Save / file buffer' },
  { keys: ['Ctrl', 'Shift', '↵'],  desc: 'Force file buffer to notes' },
  { keys: ['Ctrl', 'E'],             desc: 'Explain selection or current buffer (smart mode)' },
  { keys: ['Ctrl', 'Shift', 'A'],   desc: 'Ask about selection or buffer (smart mode)' },
  { keys: ['Ctrl', 'Shift', 'E'],   desc: 'Re-evaluate AI (summary, tags, folder)' },
  { keys: ['Tab'],                  desc: 'Indent 4 spaces' },
  { keys: ['Ctrl', 'Shift', 'M'],   desc: 'Toggle markdown / WYSIWYG mode' },
  { keys: ['Ctrl', '\\'],           desc: 'Toggle sidebar' },
  { keys: ['Ctrl', 'Shift', 'I'],   desc: 'Toggle meta panel' },
  { keys: ['Ctrl', '/'],            desc: 'Toggle this cheatsheet' },
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
      if (e.key === 'Escape' || (e.ctrlKey && e.key === '/')) {
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
