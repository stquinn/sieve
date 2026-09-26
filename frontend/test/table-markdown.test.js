// @ts-check
// table-markdown.test.js — the file form a table is written in, and the fidelity
// of the trip back (#162).
//
// THE DEFECT. A cell holding one fence is a cell with `childCount === 1`, which is
// all tiptap-markdown's built-in table serialiser checks before writing the cell
// through `renderInline` into a pipe row. The fence markers were dropped and the
// code's lines became table ROWS on the next load — corruption in the block-op on
// the wire, before any save, compounding every time the mangled form was rewritten.
//
// WHAT IS PINNED. For every case: the exact markdown written, the node shape after
// loading that markdown back, and that writing it a SECOND time gives identical
// bytes. The last of those is not ceremony — the block-sync diff churns on any
// table that never settles, and an asymmetric writer would resend the document on
// every keystroke.
//
// THE REAL STACK, AND THE SHIPPING NODES. A live Editor with tiptap-markdown, the
// table node minted by `TableMarkdown.node` and the `SieveNativeCodeBlock` the app
// registers — both read out of the modules that ship, so a change to either cannot
// pass here and fail in the app. `element: null` (as link-mark-roundtrip.test.js
// does) runs `onBeforeCreate` without a DOM mount.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Editor } from '@tiptap/core'
import { StarterKit } from '@tiptap/starter-kit'
import { Markdown } from 'tiptap-markdown'
// real-vendor FIRST: it seeds the vendor bag with the real Table and
// CodeBlockLowlight that the two modules below read.
import './helpers/real-vendor.js'
// Side-effect import: this is where `window.SieveNativeCodeBlock` is built.
import '../src/static/lens/document-editor/surfaces/sieve-block-extension.js'
import { TableMarkdown } from '../src/static/lens/document-editor/surfaces/table-markdown.js'
import { T } from '../src/static/lens/document-editor/surfaces/tiptap-vendor.js'

/** @type {any} */
let editor

beforeAll(() => {
  editor = new Editor({
    element: null,
    extensions: [
      StarterKit.configure({ codeBlock: false }),
      Markdown.configure({ html: true, transformPastedText: true }),
      TableMarkdown.node({ resizable: false }),
      T.TableRow,
      T.TableHeader,
      T.TableCell,
      /** @type {any} */ (globalThis).window.SieveNativeCodeBlock,
    ],
    content: '',
  })
})

afterAll(() => {
  if (editor && !editor.isDestroyed) editor.destroy()
})

/** Loads `markdown` and writes the document back out. @param {string} markdown @returns {string} */
function rewrite(markdown) {
  editor.commands.setContent(markdown)
  return editor.storage.markdown.getMarkdown()
}

/** The first `table` node in the current document. @returns {any} */
function loadedTable() {
  let found = null
  editor.state.doc.descendants((/** @type {any} */ node) => {
    if (found) return false
    if (node.type.name === 'table') found = node
    return !found
  })
  return found
}

/** A cell's children as `kind` strings, one per child: the node's type name, and
 *  for a code block its language after a colon.
 *  @param {any} cell @returns {string[]} */
function childKinds(cell) {
  /** @type {string[]} */ const kinds = []
  cell.forEach((/** @type {any} */ child) => {
    const language = child.attrs && child.attrs.language
    kinds.push(child.type.name + (language ? `:${language}` : ''))
  })
  return kinds
}

/** Row `r`, cell `c` of the loaded table. @param {number} r @param {number} c @returns {any} */
function cellAt(r, c) { return loadedTable().child(r).child(c) }

const SIMPLE = [
  '| Name | Role |',
  '| --- | --- |',
  '| Ada | *first* |',
  '',
].join('\n')

const FENCE_CELL = [
  '<table>',
  '<tr><th>',
  '',
  'Request',
  '',
  '</th></tr>',
  '<tr><td>',
  '',
  '```json',
  '{"id": 1}',
  '```',
  '',
  '</td></tr>',
  '</table>',
].join('\n')

describe('a simple table is still a GFM pipe table', () => {
  it('writes the pipe form, marks in cells intact, and is idempotent', () => {
    expect(rewrite(SIMPLE)).toBe(SIMPLE)
    expect(rewrite(SIMPLE)).toBe(SIMPLE)
  })

  it('loads as one paragraph per cell under a header row', () => {
    rewrite(SIMPLE)
    expect(loadedTable().child(0).child(0).type.name).toBe('tableHeader')
    expect(childKinds(cellAt(1, 0))).toEqual(['paragraph'])
    expect(cellAt(1, 1).textContent).toBe('first')
  })
})

describe('the reported defect: a fence in a cell (#162)', () => {
  it('keeps the fence and its language in the file', () => {
    const written = rewrite(FENCE_CELL)
    expect(written).toBe(FENCE_CELL)
    expect(written).toContain('```json')
    expect(written).not.toMatch(/^\| /m)
  })

  it('loads back as ONE table whose cell holds a codeBlock, not extra rows', () => {
    rewrite(FENCE_CELL)
    const table = loadedTable()
    expect(table.childCount).toBe(2)
    expect(childKinds(cellAt(1, 0))).toEqual(['codeBlock:json'])
    expect(cellAt(1, 0).textContent).toBe('{"id": 1}')
  })

  it('writes a table BUILT in the editor with a fence in a cell in the new form', () => {
    // The defect's own path: the editor holds the table, nothing has been loaded
    // from a file yet, and the first write is what goes on the wire.
    editor.commands.setContent({
      type: 'doc',
      content: [{
        type: 'table',
        content: [
          { type: 'tableRow', content: [{ type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Request' }] }] }] },
          { type: 'tableRow', content: [{ type: 'tableCell', content: [{ type: 'codeBlock', attrs: { language: 'json' }, content: [{ type: 'text', text: '{"id": 1}' }] }] }] },
        ],
      }],
    })
    expect(editor.storage.markdown.getMarkdown()).toBe(FENCE_CELL)
  })
})

// One row per case in the issue's acceptance criteria. `markdown` is BOTH the
// source loaded and the bytes expected back, so each row pins the written form,
// and `shape` pins what that form loads as.
const CASES = [
  {
    name: 'a fence with an internal blank line',
    markdown: [
      '<table>', '<tr><th>', '', 'Req', '', '</th></tr>',
      '<tr><td>', '', '```', 'one', '', 'two', '```', '', '</td></tr>',
      '</table>',
    ].join('\n'),
    shape: () => {
      expect(childKinds(cellAt(1, 0))).toEqual(['codeBlock'])
      expect(cellAt(1, 0).textContent).toBe('one\n\ntwo')
    },
  },
  {
    name: 'a fence whose code contains a ``` run (SieveNativeCodeBlock lengthens the fence)',
    markdown: [
      '<table>', '<tr><th>', '', 'Req', '', '</th></tr>',
      '<tr><td>', '', '````md', '```', 'x', '```', '````', '', '</td></tr>',
      '</table>',
    ].join('\n'),
    shape: () => {
      expect(childKinds(cellAt(1, 0))).toEqual(['codeBlock:md'])
      expect(cellAt(1, 0).textContent).toBe('```\nx\n```')
    },
  },
  {
    name: 'a list as a cell\'s only child',
    markdown: [
      '<table>', '<tr><th>', '', 'Steps', '', '</th></tr>',
      '<tr><td>', '', '- one', '- two', '', '</td></tr>',
      '</table>',
    ].join('\n'),
    shape: () => {
      expect(childKinds(cellAt(1, 0))).toEqual(['bulletList'])
      expect(cellAt(1, 0).textContent).toBe('onetwo')
    },
  },
  {
    name: 'a heading and a blockquote in one cell',
    markdown: [
      '<table>', '<tr><th>', '', 'Notes', '', '</th></tr>',
      '<tr><td>', '', '## Title', '', '> quoted', '', '</td></tr>',
      '</table>',
    ].join('\n'),
    shape: () => expect(childKinds(cellAt(1, 0))).toEqual(['heading', 'blockquote']),
  },
  {
    name: 'two paragraphs in one cell, and an empty cell beside it',
    markdown: [
      '<table>', '<tr><th>', '', 'A', '', '</th><th>', '', 'B', '', '</th></tr>',
      '<tr><td>', '', 'first', '', 'second', '', '</td><td>', '', '</td></tr>',
      '</table>',
    ].join('\n'),
    shape: () => {
      expect(childKinds(cellAt(1, 0))).toEqual(['paragraph', 'paragraph'])
      expect(cellAt(1, 1).textContent).toBe('')
    },
  },
  {
    name: 'colspan and rowspan, written only where they say something',
    markdown: [
      '<table>', '<tr><th colspan="2">', '', 'Both', '', '</th></tr>',
      '<tr><td rowspan="2">', '', '```', 'x', '```', '', '</td><td>', '', 'b', '', '</td></tr>',
      '<tr><td>', '', 'c', '', '</td></tr>',
      '</table>',
    ].join('\n'),
    shape: () => {
      expect(cellAt(0, 0).attrs.colspan).toBe(2)
      expect(cellAt(1, 0).attrs.rowspan).toBe(2)
      expect(childKinds(cellAt(1, 0))).toEqual(['codeBlock'])
    },
  },
  {
    name: 'no header row',
    markdown: [
      '<table>',
      '<tr><td>', '', 'a', '', '</td><td>', '', 'b', '', '</td></tr>',
      '</table>',
    ].join('\n'),
    shape: () => {
      expect(loadedTable().childCount).toBe(1)
      expect(cellAt(0, 0).type.name).toBe('tableCell')
    },
  },
  {
    name: 'a nested table holding a fence',
    markdown: [
      '<table>', '<tr><th>', '', 'Outer', '', '</th></tr>',
      '<tr><td>', '',
      '<table>', '<tr><th>', '', 'Inner', '', '</th></tr>',
      '<tr><td>', '', '```', 'y', '```', '', '</td></tr>',
      '</table>', '',
      '</td></tr>',
      '</table>',
    ].join('\n'),
    shape: () => {
      const inner = cellAt(1, 0).firstChild
      expect(inner.type.name).toBe('table')
      expect(inner.child(1).child(0).firstChild.type.name).toBe('codeBlock')
    },
  },
  {
    name: '`|` and `<td>` as literal cell text',
    markdown: [
      '<table>', '<tr><th>', '', 'Chars', '', '</th></tr>',
      '<tr><td>', '', 'a | b and &lt;td&gt;', '', '</td><td>', '', '```', 'z', '```', '', '</td></tr>',
      '</table>',
    ].join('\n'),
    shape: () => expect(cellAt(1, 0).textContent).toBe('a | b and <td>'),
  },
]

describe('every complex table round-trips, shape preserved, second write identical', () => {
  for (const { name, markdown, shape } of CASES) {
    it(name, () => {
      expect(rewrite(markdown)).toBe(markdown)
      expect(rewrite(markdown)).toBe(markdown)
      shape()
    })
  }
})

describe('the complex form is clean, and legacy HTML still loads', () => {
  it('carries no <body>, <colgroup>, style= or a span of 1', () => {
    const written = rewrite(FENCE_CELL)
    for (const noise of ['<body>', '<colgroup>', 'style=', 'colspan="1"', 'rowspan="1"']) {
      expect(written).not.toContain(noise)
    }
  })

  it('rewrites the legacy single-line <table> HTML in the new form', () => {
    const legacy = '<table style="minWidth: 50px"><colgroup><col><col></colgroup><tbody>'
      + '<tr><th colspan="1" rowspan="1"><p>A</p></th><th colspan="1" rowspan="1"><p>B</p></th></tr>'
      + '<tr><td colspan="1" rowspan="1"><pre><code class="language-json">{"id": 1}</code></pre></td>'
      + '<td colspan="1" rowspan="1"><p>b</p></td></tr></tbody></table>\n'
    const written = rewrite(legacy)
    expect(written).toBe([
      '<table>', '<tr><th>', '', 'A', '', '</th><th>', '', 'B', '', '</th></tr>',
      '<tr><td>', '', '```json', '{"id": 1}', '```', '', '</td><td>', '', 'b', '', '</td></tr>',
      '</table>',
    ].join('\n'))
    expect(rewrite(written)).toBe(written)
  })
})
