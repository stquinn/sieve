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
import { Plugin, TextSelection } from '@tiptap/pm/state'
import { registerBlockKind } from '../src/static/block/block-kinds.js'
import { buildInteractionPolicyExtension } from '../src/static/editor/interaction-policy.js'

registerBlockKind({
  kind: 'code',
  native: false,
  renderer: {
    interactionPolicy: { rawText: true, indentWidth: 2, enterInsertsNewline: true, autoIndentOnEnter: true },
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

let editor = null
afterEach(() => { if (editor) { editor.destroy(); editor = null } })

function makeEditor(contentJSON) {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [
      StarterKit.configure({ trailingNode: false }),
      Table.configure({ resizable: false }),
      TableRow, TableHeader, TableCell,
      SieveCode,
      buildInteractionPolicyExtension({ Extension, Plugin }),
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
