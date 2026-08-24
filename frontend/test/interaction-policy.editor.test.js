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
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import { registerBlockKind } from '../src/static/renderers/block-kinds.js'
import { buildInteractionPolicyExtension, policyEnterKeydown, CODE_TEXT_POLICY } from '../src/static/lens/document-editor/interaction-policy.js'

// These take the SAME preset the real code-node-view.js / diagram-node-view.js
// declarations do, so the fakes cannot drift from what ships. (diagram's real
// caretStop:'render' + expandable are omitted here on purpose — these cases
// exercise its edit-mode keys.)
registerBlockKind({
  kind: 'code',
  native: false,
  renderer: {
    interactionPolicy: { ...CODE_TEXT_POLICY },
  },
})

// Mode-toggling kind (diagram/log pattern): Mod+Enter routes to onModEnter.
let modEnterCalls = 0
registerBlockKind({
  kind: 'diagram',
  native: false,
  renderer: {
    interactionPolicy: { ...CODE_TEXT_POLICY, modEnterTogglesMode: true },
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

// Prose is a block like any other and DECLARES its policy — mirrors the real
// declaration in lens/surfaces/prose-block.js (surround only, no autoclose). A native
// def is its own behaviour holder, so the policy sits on the def itself.
registerBlockKind({
  kind: 'prose',
  native: true,
  interactionPolicy: { surroundSelection: true },
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
      buildInteractionPolicyExtension({ Extension, Plugin, Selection, TextSelection, NodeSelection, Decoration, DecorationSet }),
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

describe('Smart Home in raw-text blocks', () => {
  it('first press → first non-ws char; second press → column 0', () => {
    makeEditor({ type: 'doc', content: [
      { type: 'sieve-code', content: [{ type: 'text', text: '    code' }] },
      { type: 'paragraph' },
    ] })
    caretAt(9) // end of '    code' (block starts at 1)
    expect(press('Home').handled).toBe(true)
    expect(editor.state.selection.from).toBe(5) // first non-ws
    expect(press('Home').handled).toBe(true)
    expect(editor.state.selection.from).toBe(1) // column 0
  })
  it('Home in prose stays native', () => {
    makeEditor({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'ab' }] }] })
    caretAt(2)
    expect(press('Home').handled).toBe(false)
  })
})

describe('Read-only text typing (log) via policy', () => {
  it('typing a character is consumed', () => {
    makeEditor({ type: 'doc', content: [
      { type: 'sieve-log', content: [{ type: 'text', text: 'line' }] },
      { type: 'paragraph' },
    ] })
    caretAt(3)
    expect(press('x').handled).toBe(true)
    expect(docText()).toBe('line')
  })
  it('Backspace mid-text is consumed', () => {
    makeEditor({ type: 'doc', content: [
      { type: 'sieve-log', content: [{ type: 'text', text: 'line' }] },
      { type: 'paragraph' },
    ] })
    caretAt(3)
    expect(press('Backspace').handled).toBe(true)
    expect(docText()).toBe('line')
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

// ── Mod+K: the link chord (contract, #67) ───────────────────────────────────
// Owned by the policy extension like every other chord (per-renderer key
// handlers are FORBIDDEN). Two behaviours in one chord: a caret inside a link
// EDITS it; a non-empty selection CREATES one — the only link-creation path in
// WYSIWYG. Driven end-to-end through the shared dialog so the wiring, not a
// mocked seam, is what passes.
describe('Mod+K link chord', () => {
  // The dialog is a lazily-built SINGLETON: once opened it stays in the DOM,
  // so "not shown" is `open === false`, never absence.
  function linkDialog() { return document.querySelector('dialog.link-edit-popup') }
  function dialogShown() { return !!linkDialog()?.open }
  function dialogInputs() { return linkDialog().querySelectorAll('.block-edit-popup__input') }
  function save() { linkDialog().querySelector('.ask-popup__send').click() }

  afterEach(() => { linkDialog()?.close() })

  it('with the caret inside a link, opens the editor prefilled with that link', () => {
    makeEditor({ type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'go ' },
      { type: 'text', text: 'here', marks: [{ type: 'link', attrs: { href: 'https://old.example.com' } }] },
      { type: 'text', text: ' now' },
    ] }] })
    caretAt(6)
    expect(press('k', { ctrlKey: true }).handled).toBe(true)
    expect(dialogInputs()[0].value).toBe('https://old.example.com')
    expect(dialogInputs()[1].value).toBe('here')
  })

  it('saving rewrites the href in the document (an ordinary tracked prose edit)', () => {
    makeEditor({ type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'here', marks: [{ type: 'link', attrs: { href: 'https://old.example.com' } }] },
    ] }] })
    caretAt(3)
    press('k', { ctrlKey: true })
    dialogInputs()[0].value = 'https://new.example.com'
    save()
    let href = null
    editor.state.doc.descendants((n) => {
      const m = (n.marks || []).find((mk) => mk.type.name === 'link')
      if (m) href = m.attrs.href
    })
    expect(href).toBe('https://new.example.com')
  })

  it('with text SELECTED and no link, creates one over the selection', () => {
    makeEditor({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'read the docs' }] }] })
    editor.commands.setTextSelection({ from: 6, to: 14 })
    expect(press('k', { ctrlKey: true }).handled).toBe(true)
    expect(dialogInputs()[0].value).toBe('')        // no URL yet
    expect(dialogInputs()[1].value).toBe('the docs') // the selected text is the label
    dialogInputs()[0].value = 'https://example.com/docs'
    save()
    let mark = null
    editor.state.doc.descendants((n) => {
      const m = (n.marks || []).find((mk) => mk.type.name === 'link')
      if (m) mark = m
    })
    expect(mark?.attrs.href).toBe('https://example.com/docs')
    expect(docText()).toBe('read the docs')
  })

  it('a bare caret in unlinked prose is NATIVE — nothing to edit, nothing to create', () => {
    makeEditor({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'plain' }] }] })
    caretAt(3)
    expect(press('k', { ctrlKey: true }).handled).toBe(false)
    expect(dialogShown()).toBe(false)
  })

  it('is NATIVE inside a raw-text sieve block (no marks there — links are prose)', () => {
    makeEditor({ type: 'doc', content: [
      { type: 'sieve-code', content: [{ type: 'text', text: 'code' }] },
      { type: 'paragraph' },
    ] })
    caretAt(3)
    expect(press('k', { ctrlKey: true }).handled).toBe(false)
  })

  it('is NATIVE in a paragraph INSIDE a sieve container (Go authors that body)', () => {
    makeEditor({ type: 'doc', content: [
      { type: 'sieve-clip', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'clipped' }] }] },
      { type: 'paragraph' },
    ] })
    editor.commands.setTextSelection({ from: 3, to: 8 })
    expect(press('k', { ctrlKey: true }).handled).toBe(false)
  })

  it('Mod+Shift+K and Mod+Alt+K are left alone (the chord is bare Mod+K)', () => {
    makeEditor({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'read the docs' }] }] })
    editor.commands.setTextSelection({ from: 6, to: 14 })
    expect(press('k', { ctrlKey: true, shiftKey: true }).handled).toBe(false)
    expect(press('k', { ctrlKey: true, altKey: true }).handled).toBe(false)
    expect(dialogShown()).toBe(false)
  })
})

// ── Pair behaviours through the REAL PM chain ──────────────────────────────
// textInput goes through view.someProp('handleTextInput', …) — the same walk
// ProseMirror does for a typed character — so a `true` here means the shipped
// editor produced this text, not a unit-level restatement of the transform.
function type(ch) {
  const { from, to } = editor.state.selection
  const handled = editor.view.someProp('handleTextInput', (f) => f(editor.view, from, to, ch))
  return !!handled
}

describe('surround selection (contract: pair characters wrap a selection)', () => {
  it('wraps a code-block selection and leaves it selected', () => {
    makeEditor({ type: 'doc', content: [
      { type: 'sieve-code', content: [{ type: 'text', text: 'hello world' }] },
    ] })
    editor.commands.setTextSelection({ from: 1, to: 6 })
    expect(type('"')).toBe(true)
    expect(docText()).toBe('"hello" world')
    expect(editor.state.selection.from).toBe(2)
    expect(editor.state.selection.to).toBe(7) // still on `hello`, now inside the quotes
  })

  it('wraps a PROSE selection without flattening its marks', () => {
    makeEditor({ type: 'doc', content: [{ type: 'paragraph', content: [
      { type: 'text', text: 'plain ' },
      { type: 'text', text: 'bold', marks: [{ type: 'bold' }] },
    ] }] })
    editor.commands.setTextSelection({ from: 7, to: 11 })
    expect(type('(')).toBe(true)
    expect(docText()).toBe('plain (bold)')
    // The wrapped run must STILL be bold — surround inserts around content,
    // it never rewrites it (that is why the edit is two ops, not a replace).
    const marksOnBold = editor.state.doc.resolve(9).marks().map((m) => m.type.name)
    expect(marksOnBold).toContain('bold')
  })

  it('a plain paragraph does NOT autoclose (prose declares surround only)', () => {
    makeEditor({ type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hi' }] }] })
    caretAt(3)
    expect(type('(')).toBe(false) // native: a lone `(` is inserted by PM
  })
})

describe('autoclose + pair expansion in code (contract)', () => {
  it('typing an opener inserts the pair and puts the caret inside', () => {
    makeEditor({ type: 'doc', content: [
      { type: 'sieve-code', content: [{ type: 'text', text: 'x = ' }] },
    ] })
    caretAt(5)
    expect(type('[')).toBe(true)
    expect(docText()).toBe('x = []')
    expect(editor.state.selection.from).toBe(6)
  })

  it('typing the closer types OVER it rather than doubling', () => {
    makeEditor({ type: 'doc', content: [
      { type: 'sieve-code', content: [{ type: 'text', text: 'f()' }] },
    ] })
    caretAt(3)
    expect(type(')')).toBe(true)
    expect(docText()).toBe('f()')
    expect(editor.state.selection.from).toBe(4)
  })

  it('Backspace between an empty pair removes both halves', () => {
    makeEditor({ type: 'doc', content: [
      { type: 'sieve-code', content: [{ type: 'text', text: 'f()' }] },
    ] })
    caretAt(3)
    expect(press('Backspace').handled).toBe(true)
    expect(docText()).toBe('f')
  })

  it('Backspace elsewhere stays native', () => {
    makeEditor({ type: 'doc', content: [
      { type: 'sieve-code', content: [{ type: 'text', text: 'abc' }] },
    ] })
    caretAt(3)
    expect(press('Backspace').handled).toBe(false)
  })

  it('Enter between an empty pair expands to a block at the line indent', () => {
    makeEditor({ type: 'doc', content: [
      { type: 'sieve-code', content: [{ type: 'text', text: '  if x {}' }] },
    ] })
    caretAt(9) // between { and }
    expect(press('Enter').handled).toBe(true)
    expect(docText()).toBe('  if x {\n    \n  }')
  })

  it('Enter NOT between a pair keeps the plain auto-indent behaviour', () => {
    makeEditor({ type: 'doc', content: [
      { type: 'sieve-code', content: [{ type: 'text', text: '  if x {' }] },
    ] })
    caretAt(9)
    expect(press('Enter').handled).toBe(true)
    expect(docText()).toBe('  if x {\n  ')
  })

  it('a read-only kind takes none of it', () => {
    makeEditor({ type: 'doc', content: [
      { type: 'sieve-log', content: [{ type: 'text', text: 'log line' }] },
    ] })
    caretAt(3)
    expect(type('(')).toBe(false)
    expect(press('Backspace').handled).toBe(true) // consumed by readOnlyText, not by pair-delete
    expect(docText()).toBe('log line')
  })
})

describe('literalGlyphs decoration', () => {
  it('decorates code and diagram blocks but not prose', () => {
    makeEditor({ type: 'doc', content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'prose' }] },
      { type: 'sieve-code', content: [{ type: 'text', text: 'code' }] },
      { type: 'sieve-diagram', content: [{ type: 'text', text: 'uml' }] },
    ] })
    const decorated = []
    editor.view.someProp('decorations', (f) => {
      const set = f.call(
        editor.view.state.plugins.find((p) => p.props && p.props.decorations && p.getState),
        editor.state,
      )
      return set
    })
    // Walk every plugin's decorations and collect the literal-glyph ones.
    editor.state.plugins.forEach((p) => {
      if (!p.props || !p.props.decorations) return
      const set = p.props.decorations.call(p, editor.state)
      if (!set || !set.find) return
      set.find().forEach((d) => {
        if (d.type && d.type.attrs && d.type.attrs.class === 'sieve-literal-glyphs') {
          decorated.push(editor.state.doc.nodeAt(d.from).type.name)
        }
      })
    })
    expect(decorated).toContain('sieve-code')
    expect(decorated).toContain('sieve-diagram')
    expect(decorated).not.toContain('paragraph')
  })
})
