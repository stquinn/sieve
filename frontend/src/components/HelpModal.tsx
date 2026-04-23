import { useEffect } from 'react'
import { getModKey } from '../utils/platform'

interface Props {
  onClose: () => void
}



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
  const mod = getModKey()
  const GLOBAL_SHORTCUTS = [
    { keys: [mod, 'N'],            desc: 'New tab' },
    { keys: [mod, 'W'],            desc: 'Close tab (Smart close)' },
    { keys: [mod, 'P'],            desc: 'Quick switcher (files & tabs)' },
    { keys: [mod, 'F'],            desc: 'Find in current document' },
    { keys: [mod, 'Shift', 'F'],   desc: 'Store-wide search' },
    { keys: [mod, '\\'],           desc: 'Toggle sidebar' },
    { keys: [mod, 'S'],            desc: 'Save document (local persistence)' },
    { keys: [mod, '/'],            desc: 'Toggle this cheat sheet' },
    { keys: [mod, 'Click'],        desc: 'Open link in browser' },
  ]
  
  const AI_SHORTCUTS = [
    { keys: [mod, 'Shift', 'E'],   desc: 'Smart Filing (Analyze & Auto-file)' },
    { keys: [mod, 'Shift', 'Enter'],desc: 'Promote (Force Keep & Auto-file)' },
    { keys: [mod, 'E'],            desc: 'Explain selection or current block' },
    { keys: [mod, 'Shift', 'A'],   desc: 'Ask AI about selection or block' },
    { keys: [mod, 'Shift', 'P'],   desc: 'Toggle prompt templates section' },
    { keys: [mod, 'Shift', 'I'],   desc: 'Toggle meta / info panel' },
    { keys: [mod, 'Shift', 'M'],   desc: 'Toggle Markdown / WYSIWYG mode' },
    { keys: [mod, 'J'],            desc: 'Toggle AI block visibility' },
  ]

  const FORMAT_SHORTCUTS = [
    { keys: [mod, 'B'],            desc: 'Bold' },
    { keys: [mod, 'I'],            desc: 'Italic' },
    { keys: [mod, 'Z'],            desc: 'Undo' },
    { keys: [mod, 'Shift', 'Z'],   desc: 'Redo' },
    { keys: [mod, 'Alt', '1-6'],   desc: 'Heading levels' },
    { keys: [mod, 'Shift', '8'],   desc: 'Bullet list' },
    { keys: [mod, 'Shift', '7'],   desc: 'Numbered list' },
    { keys: [mod, 'Shift', '9'],   desc: 'Task list' },
    { keys: [mod, 'Shift', 'B'],   desc: 'Block quote' },
    { keys: ['Shift', 'Enter'],    desc: 'Hard break (new line)' },
  ]

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
            <h3 className="help-modal__section-title">Global Shortcuts</h3>
            <table className="help-modal__table">
              <tbody>
                {GLOBAL_SHORTCUTS.map(({ keys, desc }) => (
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
            <h3 className="help-modal__section-title">AI & View Gestures</h3>
            <table className="help-modal__table">
              <tbody>
                {AI_SHORTCUTS.map(({ keys, desc }) => (
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
            <h3 className="help-modal__section-title">Formatting Shortcuts</h3>
            <table className="help-modal__table">
              <tbody>
                {FORMAT_SHORTCUTS.map(({ keys, desc }) => (
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
