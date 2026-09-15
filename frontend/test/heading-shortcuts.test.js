// Integration: a REAL TipTap editor (StarterKit + a sieve-code node) with the
// HeadingShortcuts extension, pinning the Confluence-style `h1. `/`h2. `/`h3. `
// autoformat recorded in docs/editor-interaction-contract.md § Autoformat.
//
// Input goes through view.someProp('handleTextInput', …) — the exact chain
// ProseMirror's own DOM input handler walks, in the same plugin order — so a
// `true` result here means the typed space is consumed in the real app.
import { describe, it, expect, afterEach } from 'vitest'
import { Editor, Node, Extension } from '@tiptap/core'
import { StarterKit } from '@tiptap/starter-kit'
import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { Highlight } from '@tiptap/extension-highlight'
import markdownItMark from 'markdown-it-mark'

// extensions.js reads its vendor members off the shared bag test/setup.js seeded
// (mutate, never reassign — tiptap-vendor.js already captured a reference), and
// evaluates VENDOR.Highlight.extend() at import time, so Highlight must be real.
Object.assign(globalThis.TipTap, {
  Node, Extension, Plugin, PluginKey, Decoration, DecorationSet, Highlight, markdownItMark,
})
const { HeadingShortcuts } = await import('../src/static/lens/extensions.js')

// A raw-text fence, as the real sieve-code node declares it: code:true is what
// suppresses autoformat inside it.
const SieveCode = Node.create({
  name: 'sieve-code',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,
  parseHTML() { return [{ tag: 'pre.sieve-code' }] },
  renderHTML() { return ['pre', { class: 'sieve-code' }, ['code', 0]] },
})

let editor = null
afterEach(() => { if (editor) { editor.destroy(); editor = null } })

function makeEditor(contentJSON) {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit.configure({ trailingNode: true }), SieveCode, HeadingShortcuts],
    content: contentJSON,
  })
  return editor
}

function paragraph(text) {
  return { type: 'doc', content: [{ type: 'paragraph', content: text ? [{ type: 'text', text }] : [] }] }
}

function caretAt(pos) {
  editor.view.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos)))
}

// The real typing path: ProseMirror offers the character to handleTextInput
// first, and inserts it itself only when every handler declines.
function type(char) {
  const { from, to } = editor.state.selection
  const handled = !!editor.view.someProp('handleTextInput', (f) => f(editor.view, from, to, char))
  if (!handled) editor.view.dispatch(editor.state.tr.insertText(char, from, to))
  return handled
}

function typeAll(text) {
  let handled = false
  for (const char of text) handled = type(char)
  return handled
}

function firstNode() { return editor.state.doc.firstChild }

describe('h1./h2./h3. converts a paragraph to a heading', () => {
  for (const [token, level] of [['h1. ', 1], ['h2. ', 2], ['h3. ', 3], ['H2. ', 2]]) {
    it(`"${token}" at a paragraph start → heading level ${level}, token and space consumed`, () => {
      makeEditor(paragraph(''))
      caretAt(1)
      expect(typeAll(token)).toBe(true)
      expect(firstNode().type.name).toBe('heading')
      expect(firstNode().attrs.level).toBe(level)
      expect(firstNode().textContent).toBe('')
    })
  }

  it('keeps the rest of the line and leaves the caret able to keep typing', () => {
    makeEditor(paragraph('Title'))
    caretAt(1)
    typeAll('h2. ')
    expect(firstNode().type.name).toBe('heading')
    expect(firstNode().attrs.level).toBe(2)
    expect(firstNode().textContent).toBe('Title')
  })

  it('is one tracked transaction — a single undo puts the paragraph back', () => {
    makeEditor(paragraph('Title'))
    caretAt(1)
    typeAll('h1. ')
    editor.commands.undo()
    // How much of the typed token that undo also takes back is history grouping,
    // not this rule; what is pinned is that ONE undo leaves no heading behind.
    expect(firstNode().type.name).toBe('paragraph')
  })

  it('re-levels a heading that is already one', () => {
    makeEditor({ type: 'doc', content: [{ type: 'heading', attrs: { level: 1 }, content: [{ type: 'text', text: 'x' }] }] })
    caretAt(1)
    typeAll('h3. ')
    expect(firstNode().attrs.level).toBe(3)
    expect(firstNode().textContent).toBe('x')
  })
})

describe('what does NOT convert', () => {
  it('h4. — only levels 1-3 are in scope', () => {
    makeEditor(paragraph(''))
    caretAt(1)
    expect(typeAll('h4. ')).toBe(false)
    expect(firstNode().type.name).toBe('paragraph')
    expect(firstNode().textContent).toBe('h4. ')
  })

  it('the token mid-line — the shortcut is start-of-block only', () => {
    makeEditor(paragraph('see'))
    caretAt(4)
    expect(typeAll(' h1. ')).toBe(false)
    expect(firstNode().type.name).toBe('paragraph')
    expect(firstNode().textContent).toBe('see h1. ')
  })

  it('space is the ONLY boundary character — Enter after the token splits the paragraph instead', () => {
    makeEditor(paragraph(''))
    caretAt(1)
    typeAll('h1.')
    editor.commands.splitBlock()
    expect(firstNode().type.name).toBe('paragraph')
    expect(firstNode().textContent).toBe('h1.')
  })

  it('inside a code fence — a code textblock never autoformats', () => {
    makeEditor({ type: 'doc', content: [{ type: 'sieve-code', content: [{ type: 'text', text: 'x' }] }] })
    caretAt(1)
    expect(typeAll('h1. ')).toBe(false)
    expect(firstNode().type.name).toBe('sieve-code')
    expect(firstNode().textContent).toBe('h1. x')
  })

  it('inside a native code block', () => {
    makeEditor({ type: 'doc', content: [{ type: 'codeBlock', content: [{ type: 'text', text: 'x' }] }] })
    caretAt(1)
    expect(typeAll('h1. ')).toBe(false)
    expect(firstNode().type.name).toBe('codeBlock')
    expect(firstNode().textContent).toBe('h1. x')
  })
})
