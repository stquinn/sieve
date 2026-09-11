// @ts-check
// ClipboardSlice — the clipboard VIEWS of one selection, as a unit. What the
// policy handler does with the answer (preventDefault, the cut's delete) is
// pinned in interaction-policy.editor.test.js against a real editor; these are
// the decisions that need a DOM and a selection PM cannot see.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection, NodeSelection } from '@tiptap/pm/state'

vi.mock('../src/static/ui/copy-image.js', () => ({ copyImageToClipboard: vi.fn() }))

import { ClipboardSlice } from '../src/static/lens/document-editor/clipboard-slice.js'
import { copyImageToClipboard } from '../src/static/ui/copy-image.js'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'text*', toDOM: () => ['p', 0] },
    text: { group: 'inline' },
    'sieve-log': {
      group: 'block', content: 'text*', code: true,
      attrs: { kind: { default: 'log' }, id: { default: 'l1' } },
      toDOM: (n) => ['pre', { 'data-id': n.attrs.id }, ['code', 0]],
    },
    'sieve-smart-image': {
      group: 'block', atom: true, selectable: true,
      attrs: { kind: { default: 'smart-image' }, id: { default: 'i1' }, src: { default: '' } },
      toDOM: (n) => ['img', { src: n.attrs.src }],
    },
  },
})

const LOG = 'line one\nline two\nline three'

/** A view over a doc, with one rendered element per top-level node. */
function viewOf(nodes, selection) {
  const doc = schema.nodes.doc.create(null, nodes)
  const state = EditorState.create({ schema, doc })
  /** @type {Record<number, HTMLElement>} */ const doms = {}
  let offset = 0
  doc.forEach((node) => {
    const el = document.createElement('div')
    el.className = 'sieve-block'
    const chrome = document.createElement('div')
    chrome.className = 'block-chrome-host'
    el.appendChild(chrome)
    const body = document.createElement('pre')
    body.textContent = node.textContent
    el.appendChild(body)
    document.body.appendChild(el)
    doms[offset] = el
    offset += node.nodeSize
  })
  const withSel = selection
    ? state.apply(state.tr.setSelection(selection(doc)))
    : state
  return { state: withSel, nodeDOM: (pos) => doms[pos] || null, doms }
}

/** A live DOM highlight over `el`'s body text. */
function highlight(el) {
  const range = document.createRange()
  range.selectNodeContents(el.querySelector('pre'))
  const sel = window.getSelection()
  sel.removeAllRanges()
  sel.addRange(range)
  return sel
}

function slice(view, overrides = {}) {
  return new ClipboardSlice({ view, ...overrides })
}

function clip() {
  const data = {}
  return { data, setData: (mime, value) => { data[mime] = value } }
}

beforeEach(() => {
  document.body.innerHTML = ''
  const sel = window.getSelection()
  if (sel && sel.removeAllRanges) sel.removeAllRanges()
  vi.clearAllMocks()
})

describe('what goes on the clipboard', () => {
  it('a partial range inside a block carries the characters as text, the whole block as sieve/slice, or both', () => {
    const view = viewOf(
      [schema.nodes['sieve-log'].create(null, schema.text(LOG))],
      (doc) => TextSelection.create(doc, 10, 18),
    )
    const data = clip()
    expect(slice(view).write(/** @type {any} */ (data))).toBe(true)
    expect(data.data['text/plain']).toBe('line two')
    expect(data.data['text/html']).toBe('line two')
    expect(JSON.parse(data.data['sieve/slice'])[0]).toEqual([
      { mimeType: 'sieve/log', content: JSON.stringify({ kind: 'log', id: 'l1' }) },
    ])
  })

  it('a whole-block selection falls back to the node text and its rendered DOM', () => {
    const view = viewOf(
      [schema.nodes['sieve-log'].create(null, schema.text(LOG))],
      (doc) => NodeSelection.create(doc, 0),
    )
    const data = clip()
    slice(view).write(/** @type {any} */ (data))
    expect(data.data['text/plain']).toBe(LOG)
    // The gutter chrome is host furniture, not the block's content.
    expect(data.data['text/html']).not.toContain('block-chrome-host')
    expect(data.data['text/html']).toContain('line one')
  })

  it('an injected range spanning two blocks yields one ContentEntry set per block', () => {
    const log = () => schema.nodes['sieve-log'].create(null, schema.text('x'))
    const first = log()
    const view = viewOf([first, log()])
    const data = clip()
    slice(view, { range: { from: 0, to: first.nodeSize * 2 } }).write(/** @type {any} */ (data))
    expect(JSON.parse(data.data['sieve/slice'])).toHaveLength(2)
    expect(data.data['text/plain']).toBe('x\n\nx')
  })

  it('pure prose is refused, so ProseMirror serves it', () => {
    const view = viewOf(
      [schema.nodes.paragraph.create(null, schema.text('hello'))],
      (doc) => TextSelection.create(doc, 1, 4),
    )
    expect(slice(view).write(/** @type {any} */ (clip()))).toBe(false)
  })
})

describe('a selected image carries its bitmap', () => {
  it('copies the resolved src and writes no text view', () => {
    const view = viewOf(
      [schema.nodes['sieve-smart-image'].create({ src: 'shot.png' })],
      (doc) => NodeSelection.create(doc, 0),
    )
    const data = clip()
    expect(slice(view, { uuid: 'doc-7' }).write(/** @type {any} */ (data))).toBe(true)
    expect(copyImageToClipboard).toHaveBeenCalledTimes(1)
    expect(/** @type {any} */ (copyImageToClipboard).mock.calls[0][0]).toContain('shot.png')
    expect(data.data['text/plain']).toBeUndefined()
  })

  it('with no src yet, defers to ProseMirror rather than copying nothing', () => {
    const view = viewOf(
      [schema.nodes['sieve-smart-image'].create()],
      (doc) => NodeSelection.create(doc, 0),
    )
    expect(slice(view).write(/** @type {any} */ (clip()))).toBe(false)
    expect(copyImageToClipboard).not.toHaveBeenCalled()
  })
})

describe('a highlight in a region ProseMirror does not own', () => {
  it('retargets the text views onto the block the user highlighted', () => {
    const first = schema.nodes.paragraph.create(null, schema.text('prose'))
    const view = viewOf(
      [first, schema.nodes['sieve-log'].create(null, schema.text(LOG))],
      (doc) => TextSelection.create(doc, 1, 3), // PM's selection is in the PARAGRAPH
    )
    highlight(view.doms[first.nodeSize])
    const data = clip()
    const s = slice(view)
    expect(s.range).toEqual({ from: first.nodeSize, to: first.nodeSize + LOG.length + 2 })
    expect(s.write(/** @type {any} */ (data))).toBe(true)
    expect(data.data['text/plain']).toBe(LOG)
  })

  it('leaves a cut nothing to remove — the highlight is not PM\'s to delete', () => {
    const first = schema.nodes.paragraph.create(null, schema.text('prose'))
    const view = viewOf(
      [first, schema.nodes['sieve-log'].create(null, schema.text(LOG))],
      (doc) => TextSelection.create(doc, 1, 3),
    )
    highlight(view.doms[first.nodeSize])
    const s = slice(view)
    expect(s.cutRange).toBeNull()
    // The highlight is real selected content, so this is not an empty selection
    // even though there is no PM range for a cut to delete.
    expect(s.empty).toBe(false)
  })
})

describe('cutRange', () => {
  it('is the selection range when PM owns it', () => {
    const view = viewOf(
      [schema.nodes['sieve-log'].create(null, schema.text(LOG))],
      (doc) => TextSelection.create(doc, 10, 18),
    )
    expect(slice(view).cutRange).toEqual({ from: 10, to: 18 })
  })

  it('is null for a collapsed caret', () => {
    const view = viewOf(
      [schema.nodes['sieve-log'].create(null, schema.text(LOG))],
      (doc) => TextSelection.create(doc, 10),
    )
    expect(slice(view).cutRange).toBeNull()
  })
})

describe('empty', () => {
  it('is true for a collapsed caret with no highlight', () => {
    const view = viewOf(
      [schema.nodes['sieve-log'].create(null, schema.text(LOG))],
      (doc) => TextSelection.create(doc, 10),
    )
    expect(slice(view).empty).toBe(true)
  })

  it('is false when PM owns a real range', () => {
    const view = viewOf(
      [schema.nodes['sieve-log'].create(null, schema.text(LOG))],
      (doc) => TextSelection.create(doc, 10, 18),
    )
    expect(slice(view).empty).toBe(false)
  })
})
