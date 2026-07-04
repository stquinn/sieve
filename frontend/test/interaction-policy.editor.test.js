// Integration: a REAL TipTap editor (StarterKit lists + Table + a sieve-code
// node) with the interaction-policy extension, verifying the contract's Tab
// column AND the load-bearing ordering rule: native keymaps run first, the
// policy plugin is the backstop (docs/editor-interaction-contract.md).
//
// Key dispatch goes through view.someProp('handleKeyDown', …) — the exact
// chain ProseMirror's own keydown listener walks, in the same plugin order —
// so a `true` result here means the browser default (focus escape) is
// prevented in the real app.
import { describe, it, expect, afterEach } from 'vitest'
import { Editor, Node, Extension } from '@tiptap/core'
import { StarterKit } from '@tiptap/starter-kit'
import { Table, TableRow, TableCell, TableHeader } from '@tiptap/extension-table'
import { Plugin, Selection, TextSelection, NodeSelection } from '@tiptap/pm/state'
import { registerBlockKind } from '../src/static/block/block-kinds.js'
import { buildInteractionPolicyExtension, policyEnterKeydown } from '../src/static/editor/interaction-policy.js'

registerBlockKind({
  kind: 'code',
  native: false,
  renderer: {
    interactionPolicy: { rawText: true, indentWidth: 2, enterInsertsNewline: true, autoIndentOnEnter: true },
  },
})

// Mode-toggling kind (diagram/log pattern): Mod+Enter routes to onModEnter.
let modEnterCalls = 0
registerBlockKind({
  kind: 'diagram',
  native: false,
  renderer: {
    interactionPolicy: { rawText: true, indentWidth: 2, enterInsertsNewline: true, modEnterTogglesMode: true },
    onModEnter() { modEnterCalls++; return true },
  },
})

registerBlockKind({
  kind: 'log',
  native: false,
  renderer: {
    interactionPolicy: { readOnlyText: true },
  },
})

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

const SieveDiagram = Node.create({
  name: 'sieve-diagram',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,
  parseHTML() { return [{ tag: 'pre.sieve-diagram' }] },
  renderHTML() { return ['pre', { class: 'sieve-diagram' }, ['code', 0]] },
})

const SieveLog = Node.create({
  name: 'sieve-log',
  group: 'block',
  content: 'text*',
  marks: '',
  code: true,
  defining: true,
  parseHTML() { return [{ tag: 'pre.sieve-log' }] },
  renderHTML() { return ['pre', { class: 'sieve-log' }, ['code', 0]] },
})

// Read-only container (web-clip/ai-block shape): block+ content, caretStop.
registerBlockKind({
  kind: 'clip',
  native: false,
  renderer: { interactionPolicy: { caretStop: true } },
})

const SieveClip = Node.create({
  name: 'sieve-clip',
  group: 'block',
  content: 'block+',
  selectable: true,
  defining: true,
  parseHTML() { return [{ tag: 'div.sieve-clip' }] },
  renderHTML() { return ['div', { class: 'sieve-clip' }, 0] },
})

let editor = null
afterEach(() => { if (editor) { editor.destroy(); editor = null } })

function makeEditor(contentJSON) {
  editor = new Editor({
    element: document.createElement('div'),
    // Mirrors editor.js: Enter dispatches pre-core from editorProps (core
    // Keymap would otherwise claim it in code:true blocks); Tab is the
    // post-native backstop plugin inside the extension.
    editorProps: {
      handleKeyDown: (view, event) => policyEnterKeydown(view, event),
    },
    extensions: [
      StarterKit.configure({ trailingNode: true }), // mirrors editor.js (caret contract clause 1)
      Table.configure({ resizable: false }),
      TableRow, TableHeader, TableCell,
      SieveCode, SieveDiagram, SieveLog, SieveClip,
      buildInteractionPolicyExtension({ Extension, Plugin, Selection, TextSelection, NodeSelection }),
    ],
    content: contentJSON,
  })
  return editor
}

// Walk the real handleKeyDown chain (direct props, then plugins in order).
function press(key, opts = {}) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts })
  const handled = editor.view.someProp('handleKeyDown', (f) => f(editor.view, event))
  return { handled: !!handled, event }
}

function caretAt(pos) {
  const tr = editor.state.tr.setSelection(TextSelection.create(editor.state.doc, pos))
  editor.view.dispatch(tr)
}

function docText() { return editor.state.doc.textContent }

describe('Tab in plain paragraph (contract: consume ∅)', () => {
  it('consumes Tab, inserts nothing', () => {
    makeEditor({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }] })
    caretAt(3)
    const { handled } = press('Tab')
    expect(handled).toBe(true) // focus can never escape
    expect(docText()).toBe('hello')
  })
  it('consumes Shift+Tab, inserts nothing', () => {
    makeEditor({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }] })
    caretAt(3)
    const { handled } = press('Tab', { shiftKey: true })
    expect(handled).toBe(true)
    expect(docText()).toBe('hello')
  })
})

describe('Tab in table (contract: native cell nav wins over the backstop)', () => {
  function makeTable() {
    makeEditor({ type: 'doc', content: [{ type: 'paragraph' }] })
    editor.commands.insertTable({ rows: 2, cols: 2, withHeaderRow: false })
  }
  it('Tab moves to the next cell without inserting spaces', () => {
    makeTable()
    editor.commands.setContent // no-op guard: content set via insertTable
    // Put the caret in the FIRST cell.
    let firstCellPos = null
    editor.state.doc.descendants((node, pos) => {
      if (firstCellPos === null && node.type.name === 'tableCell') { firstCellPos = pos + 2 }
    })
    caretAt(firstCellPos)
    const before = editor.state.selection.from
    const { handled } = press('Tab')
    expect(handled).toBe(true)
    expect(editor.state.selection.from).toBeGreaterThan(before) // moved to next cell
    expect(docText()).toBe('') // no spaces injected anywhere
  })
  it('Shift+Tab in the FIRST cell is consumed (never a focus escape)', () => {
    makeTable()
    let firstCellPos = null
    editor.state.doc.descendants((node, pos) => {
      if (firstCellPos === null && node.type.name === 'tableCell') { firstCellPos = pos + 2 }
    })
    caretAt(firstCellPos)
    const { handled } = press('Tab', { shiftKey: true })
    expect(handled).toBe(true)
    expect(docText()).toBe('')
  })
})

describe('Tab in list (native indent wins; backstop otherwise)', () => {
  it('first item cannot sink — backstop consumes, doc unchanged', () => {
    makeEditor({ type: 'doc', content: [
      { type: 'bulletList', content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
      ] },
    ] })
    caretAt(4)
    const before = editor.getJSON()
    const { handled } = press('Tab')
    expect(handled).toBe(true)
    expect(editor.getJSON()).toEqual(before)
  })
  it('second item sinks into a nested list (native behaviour intact)', () => {
    makeEditor({ type: 'doc', content: [
      { type: 'bulletList', content: [
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'one' }] }] },
        { type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'two' }] }] },
      ] },
    ] })
    // caret inside "two"
    let pos = null
    editor.state.doc.descendants((node, p) => {
      if (node.isText && node.text === 'two') pos = p + 1
    })
    caretAt(pos)
    const { handled } = press('Tab')
    expect(handled).toBe(true)
    const json = JSON.stringify(editor.getJSON())
    expect((json.match(/bulletList/g) || []).length).toBe(2) // nested list created
  })
})

describe('Tab in sieve-code (contract: indent 2)', () => {
  function makeCode(text) {
    makeEditor({ type: 'doc', content: [
      { type: 'sieve-code', content: text ? [{ type: 'text', text }] : [] },
      { type: 'paragraph' },
    ] })
  }
  it('collapsed caret inserts 2 spaces at the caret', () => {
    makeCode('abc')
    caretAt(3) // between b and c (block starts at 1)
    const { handled } = press('Tab')
    expect(handled).toBe(true)
    expect(docText()).toBe('ab  c')
  })
  it('multi-line selection indents each line at line start', () => {
    makeCode('aa\nbb')
    // select from inside line 1 to inside line 2
    const tr = editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 2, 5))
    editor.view.dispatch(tr)
    const { handled } = press('Tab')
    expect(handled).toBe(true)
    expect(docText()).toBe('  aa\n  bb')
  })
  it('Shift+Tab de-indents up to 2 leading spaces per line', () => {
    makeCode('  aa\n bb')
    const tr = editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 2, 8))
    editor.view.dispatch(tr)
    const { handled } = press('Tab', { shiftKey: true })
    expect(handled).toBe(true)
    expect(docText()).toBe('aa\nbb')
  })
  it('Shift+Tab with nothing to de-indent is still consumed', () => {
    makeCode('aa')
    caretAt(2)
    const { handled } = press('Tab', { shiftKey: true })
    expect(handled).toBe(true)
    expect(docText()).toBe('aa')
  })
})

describe('Enter (contract: raw-text newline + auto-indent; native prose untouched)', () => {
  it('Enter in sieve-code inserts newline copying leading whitespace', () => {
    makeEditor({ type: 'doc', content: [
      { type: 'sieve-code', content: [{ type: 'text', text: '  ab' }] },
      { type: 'paragraph' },
    ] })
    caretAt(5) // end of "  ab" (block starts at 1)
    const { handled } = press('Enter')
    expect(handled).toBe(true)
    expect(docText()).toBe('  ab\n  ')
  })
  it('Enter in a paragraph stays native (splits into two paragraphs)', () => {
    makeEditor({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ab' }] }] })
    caretAt(2)
    const { handled } = press('Enter')
    expect(handled).toBe(true) // handled by StarterKit's keymap, not swallowed
    expect(editor.getJSON().content.length).toBe(2)
  })
  it('Mod+Enter in a mode-toggling kind routes to onModEnter', () => {
    makeEditor({ type: 'doc', content: [
      { type: 'sieve-diagram', content: [{ type: 'text', text: 'graph' }] },
      { type: 'paragraph' },
    ] })
    caretAt(3)
    const before = modEnterCalls
    const { handled } = press('Enter', { ctrlKey: true })
    expect(handled).toBe(true)
    expect(modEnterCalls).toBe(before + 1)
    expect(docText()).toBe('graph') // toggle, not newline, not escape
  })
  it('Enter in read-only text (log) is consumed', () => {
    makeEditor({ type: 'doc', content: [
      { type: 'sieve-log', content: [{ type: 'text', text: 'line1' }] },
      { type: 'paragraph' },
    ] })
    caretAt(3)
    const { handled } = press('Enter')
    expect(handled).toBe(true)
    expect(docText()).toBe('line1')
  })
})

describe('Shift+Enter universal escape (contract: insert ¶ after block)', () => {
  it('escapes a code block to a new paragraph below', () => {
    makeEditor({ type: 'doc', content: [
      { type: 'sieve-code', content: [{ type: 'text', text: 'code' }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'tail' }] },
    ] })
    caretAt(3) // inside the code text
    const { handled } = press('Enter', { shiftKey: true })
    expect(handled).toBe(true)
    // New paragraph inserted between code block and 'tail'; caret inside it.
    const json = editor.getJSON()
    expect(json.content[0].type).toBe('sieve-code')
    expect(json.content[0].content[0].text).toBe('code') // content untouched
    expect(json.content[1].type).toBe('paragraph')
    expect(json.content[1].content).toBeUndefined() // the new empty paragraph
    expect(editor.state.selection.$from.parent.type.name).toBe('paragraph')
  })
  it('escapes read-only log text', () => {
    makeEditor({ type: 'doc', content: [
      { type: 'sieve-log', content: [{ type: 'text', text: 'line' }] },
      { type: 'paragraph' },
    ] })
    caretAt(3)
    const { handled } = press('Enter', { shiftKey: true })
    expect(handled).toBe(true)
    expect(editor.getJSON().content[1].type).toBe('paragraph')
  })
  it('leaves prose Shift+Enter native (soft break)', () => {
    makeEditor({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ab' }] }] })
    caretAt(2)
    press('Enter', { shiftKey: true })
    // HardBreak keymap (native) handles it — our handler returned false.
    expect(JSON.stringify(editor.getJSON())).toContain('hardBreak')
  })
})

describe('Read-only caret stops (contract clause 4)', () => {
  function makeClipDoc() {
    makeEditor({ type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'above' }] },
      { type: 'sieve-clip', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'inner' }] }] },
      { type: 'paragraph', content: [{ type: 'text', text: 'below' }] },
    ] })
  }
  it('ArrowDown from the paragraph above selects the clip whole (no dive)', () => {
    makeClipDoc()
    caretAt(6) // end of 'above'
    const { handled } = press('ArrowDown')
    expect(handled).toBe(true)
    expect(editor.state.selection.node?.type.name).toBe('sieve-clip')
  })
  it('ArrowDown while the clip is selected lands below it', () => {
    makeClipDoc()
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 7)))
    const { handled } = press('ArrowDown')
    expect(handled).toBe(true)
    expect(editor.state.selection.node).toBeUndefined()
    expect(editor.state.selection.$from.parent.textContent).toBe('below')
  })
  it('ArrowUp from below selects the clip; ArrowUp again lands above', () => {
    makeClipDoc()
    let belowPos = null
    editor.state.doc.descendants((node, p) => { if (node.isText && node.text === 'below') belowPos = p + 1 })
    caretAt(belowPos)
    expect(press('ArrowUp').handled).toBe(true)
    expect(editor.state.selection.node?.type.name).toBe('sieve-clip')
    expect(press('ArrowUp').handled).toBe(true)
    expect(editor.state.selection.$from.parent.textContent).toBe('above')
  })
  it('plain Enter on the selected clip inserts a paragraph after it', () => {
    makeClipDoc()
    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 7)))
    const { handled } = press('Enter')
    expect(handled).toBe(true)
    const json = editor.getJSON()
    expect(json.content[1].type).toBe('sieve-clip')
    expect(json.content[2].type).toBe('paragraph')
    expect(json.content[2].content).toBeUndefined() // new empty paragraph
  })
})

describe('Trailing node (contract clause 1: no dead-ends)', () => {
  it('a doc ending in a structured block gets a trailing paragraph on first edit', () => {
    makeEditor({ type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'x' }] },
      { type: 'sieve-code', content: [{ type: 'text', text: 'end' }] },
    ] })
    // TrailingNode applies via appendTransaction — i.e. from the first
    // transaction onward (app docs render through transactions).
    editor.view.dispatch(editor.state.tr.insertText('!', 2))
    const json = editor.getJSON()
    expect(json.content[json.content.length - 1].type).toBe('paragraph')
  })
})
