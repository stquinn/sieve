// @ts-check
// ClipboardSlice — the clipboard VIEWS of one selection, as a unit. What the
// policy handler does with the answer (preventDefault, the cut's delete) is
// pinned in interaction-policy.editor.test.js against a real editor; these are
// the decisions that need a DOM and a selection PM cannot see.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection, NodeSelection } from '@tiptap/pm/state'

vi.mock('../src/static/ui/copy-image.js', () => ({ copyImageToClipboard: vi.fn() }))

// A structured kind's own views come from its NodeView adapter, and every one of
// them leads with a WHOLE-BLOCK text/plain (code, log, diagram, reference,
// ai-block). Registering a real adapter needs the TipTap runtime, so the lookup is
// stood in for: without it the framework's sieve/<kind> is the only entry there is,
// and what a single-block copy does with a kind's own text view goes untested.
vi.mock('../src/static/lens/document-editor/surfaces/sieve-block-extension.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    rendererFor: (/** @type {string} */ kind) => (kind === 'code' ? {
      asContentEntry: (/** @type {any} */ node) => {
        const src = node.textContent || node.attrs.source
        return src ? [{ mimeType: 'text/plain', content: src }] : null
      },
    } : actual.rendererFor(kind)),
  }
})

import { ClipboardSlice } from '../src/static/lens/document-editor/clipboard-slice.js'
import { copyImageToClipboard } from '../src/static/ui/copy-image.js'
import { registerBlockKind } from '../src/static/renderers/block-kinds.js'

// Sieve nodes form the 'sieveBlock' group, and only a CONTAINER's content admits
// that group — which is how the clipboard tells a container it must descend into
// (ai-block) from one it must not (web-clip, whose 'block+' admits prose only).
const schema = new Schema({
  nodes: {
    doc: { content: '(block | sieveBlock)+' },
    paragraph: { group: 'block', content: 'text*', toDOM: () => ['p', 0] },
    text: { group: 'inline' },
    'sieve-log': {
      group: 'sieveBlock', content: 'text*', code: true,
      attrs: { kind: { default: 'log' }, id: { default: 'l1' } },
      toDOM: (n) => ['pre', { 'data-id': n.attrs.id }, ['code', 0]],
    },
    'sieve-code': {
      group: 'sieveBlock', content: 'text*', code: true,
      attrs: { kind: { default: 'code' }, id: { default: 'c1' }, language: { default: 'go' } },
      toDOM: (n) => ['pre', { 'data-id': n.attrs.id }, ['code', 0]],
    },
    'sieve-diagram': {
      group: 'sieveBlock', content: 'text*', code: true,
      attrs: { kind: { default: 'diagram' }, id: { default: 'd1' }, diagramType: { default: 'mermaid' } },
      toDOM: (n) => ['pre', { 'data-id': n.attrs.id }, ['code', 0]],
    },
    // The answer is a list of blocks, so the body admits sieve blocks alongside
    // native prose exactly as the document top level does (ai-block-node-view.js).
    'sieve-ai-block': {
      group: 'sieveBlock', content: '(block | sieveBlock)+',
      attrs: { kind: { default: 'ai-block' }, id: { default: 'a1' }, question: { default: 'why?' } },
      toDOM: () => ['div', 0],
    },
    // A container whose content admits prose only: it hosts no blocks, so a range
    // inside it stays one item.
    'sieve-web-clip': {
      group: 'sieveBlock', content: 'block+',
      attrs: { kind: { default: 'web-clip' }, id: { default: 'w1' } },
      toDOM: () => ['div', 0],
    },
    'sieve-smart-image': {
      group: 'sieveBlock', atom: true, selectable: true,
      attrs: { kind: { default: 'smart-image' }, id: { default: 'i1' }, src: { default: '' } },
      toDOM: (n) => ['img', { src: n.attrs.src }],
    },
  },
})

const LOG = 'line one\nline two\nline three'

// The clipboard reads a paragraph through the shared block-kind registry. The real
// definition is prose-block.js, which needs the whole TipTap vendor bootstrap; this
// is the half of its contract that matters here — sieve/prose plus text/plain, both
// the node's markdown, from the editor's serializer.
registerBlockKind({
  kind: 'prose',
  native: true,
  asContentEntry: (node, editor) => {
    const md = editor ? editor.serialize(node) : ''
    return md ? [
      { mimeType: 'sieve/prose', content: JSON.stringify({ content: md }) },
      { mimeType: 'text/plain', content: md },
    ] : null
  },
})

const editor = { serialize: (node) => node.textContent }

/**
 * A view over a doc, with one rendered element per node — top level AND, for a
 * container, its children, since the clipboard descends into one.
 *
 * Each block's read-only regions carry contenteditable="false", as the real ones
 * do: that attribute is how the clipboard knows a highlight there is the only
 * reading of the selection there is.
 */
function viewOf(nodes, selection) {
  const doc = schema.nodes.doc.create(null, nodes)
  const state = EditorState.create({ schema, doc })
  /** @type {Record<number, HTMLElement>} */ const doms = {}

  const render = (node, pos) => {
    const el = document.createElement('div')
    el.className = 'sieve-block'
    const chrome = document.createElement('div')
    chrome.className = 'block-chrome-host'
    chrome.setAttribute('contenteditable', 'false')
    el.appendChild(chrome)
    doms[pos] = el

    if (node.type.name === 'sieve-ai-block') {
      // The question TITLE is DOM ProseMirror does not own; the BODY is its
      // contentDOM, holding one rendered element per child.
      const title = document.createElement('div')
      title.className = 'ai-block__question'
      title.setAttribute('contenteditable', 'false')
      title.textContent = node.attrs.question
      el.appendChild(title)
      const body = document.createElement('div')
      body.className = 'sieve-block__content'
      el.appendChild(body)
      node.forEach((child, childOffset) => { body.appendChild(render(child, pos + 1 + childOffset)) })
      return el
    }

    const body = document.createElement('pre')
    // A log block is a record: read, never typed into.
    if (node.type.name === 'sieve-log') body.setAttribute('contenteditable', 'false')
    body.textContent = node.textContent
    el.appendChild(body)
    return el
  }

  doc.forEach((node, offset) => { document.body.appendChild(render(node, offset)) })
  const withSel = selection
    ? state.apply(state.tr.setSelection(selection(doc)))
    : state
  return { state: withSel, nodeDOM: (pos) => doms[pos] || null, doms }
}

/** A live DOM highlight over `el`'s body text. */
function highlight(el) {
  return highlightOver(el.querySelector('pre'))
}

/** A live DOM highlight over the contents of one element. */
function highlightOver(el) {
  const range = document.createRange()
  range.selectNodeContents(el)
  const sel = window.getSelection()
  sel.removeAllRanges()
  sel.addRange(range)
  return sel
}

/** A live DOM highlight that STARTS in one element and ends in another. */
function highlightAcross(startEl, endEl) {
  const range = document.createRange()
  range.setStart(startEl.firstChild, 0)
  range.setEnd(endEl.firstChild, endEl.firstChild.length)
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
    // A single block also exposes its own kind's mime, so the backend rebuilds it
    // from its own view rather than by detecting what its text looks like.
    expect(data.data['sieve/log']).toBe(JSON.stringify({ kind: 'log', id: 'l1' }))
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
    // Two blocks: no single-block view, or the backend would rebuild one of them twice.
    expect(data.data['sieve/log']).toBeUndefined()
  })

  it('a partial range keeps the selected characters as text while the block goes whole', () => {
    const code = schema.nodes['sieve-code'].create(null, schema.text('fmt.Println(1)\nfmt.Println(2)'))
    const view = viewOf([code], (doc) => TextSelection.create(doc, 1, 15))
    const data = clip()
    slice(view).write(/** @type {any} */ (data))
    // The kind's own entry describes the block whole; it must not overwrite the
    // text views, which follow the range.
    expect(data.data['text/plain']).toBe('fmt.Println(1)')
    expect(data.data['text/html']).toBe('fmt.Println(1)')
    expect(data.data['sieve/code']).toBe(JSON.stringify({ kind: 'code', id: 'c1', language: 'go' }))
  })

  // Every kind's single-block copy rebuilds from that kind's own view, so this
  // holds for a kind whose text reads as code, one whose text reads as a diagram,
  // and one whose content is not text at all.
  it.each([
    ['code', { kind: 'code', id: 'c1', language: 'go' }, (s) => s.nodes['sieve-code'].create(null, s.text('fmt.Println(1)'))],
    ['diagram', { kind: 'diagram', id: 'd1', diagramType: 'mermaid' }, (s) => s.nodes['sieve-diagram'].create(null, s.text('graph TD;'))],
    ['ai-block', { kind: 'ai-block', id: 'a1', question: 'why?' }, (s) => s.nodes['sieve-ai-block'].create(null, s.nodes.paragraph.create(null, s.text('because')))],
  ])('a single %s block carries its own kind mime', (kind, attrs, make) => {
    const node = make(schema)
    const view = viewOf([node], (doc) => NodeSelection.create(doc, 0))
    const data = clip()
    expect(slice(view, { editor }).write(/** @type {any} */ (data))).toBe(true)
    expect(JSON.parse(data.data['sieve/slice'])).toHaveLength(1)
    expect(data.data['sieve/' + kind]).toBe(JSON.stringify(attrs))
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

// An AI block's body holds a LIST OF BLOCKS, so a range inside it names some of
// them and each must reach the clipboard as the block it is — the answer's prose as
// prose, its code as code (#160). A range covering the whole node still names the
// one block it is.
describe('a range inside a block-hosting container', () => {
  /** An AI block whose answer is a paragraph then a code element. */
  function answered() {
    const para = schema.nodes.paragraph.create(null, schema.text('the prose'))
    const code = schema.nodes['sieve-code'].create(null, schema.text('fmt.Println(1)'))
    const ai = schema.nodes['sieve-ai-block'].create(null, [para, code])
    return { ai, para, code, paraFrom: 1, codeFrom: 1 + para.nodeSize }
  }

  it('is composed per element — the answer pastes as the blocks it showed', () => {
    const { ai, paraFrom, codeFrom } = answered()
    const view = viewOf([ai], (doc) => TextSelection.create(doc, paraFrom + 2, codeFrom + 4))
    const data = clip()
    expect(slice(view, { editor }).write(/** @type {any} */ (data))).toBe(true)

    const items = JSON.parse(data.data['sieve/slice'])
    expect(items).toHaveLength(2)
    expect(items[0].map((e) => e.mimeType)).toContain('sieve/prose')
    expect(items[1].map((e) => e.mimeType)).toContain('sieve/code')
    // The container itself is not one of the items, and so cannot be rebuilt whole.
    expect(JSON.stringify(items)).not.toContain('sieve/ai-block')
    expect(data.data['sieve/ai-block']).toBeUndefined()
    // Each element's own covered characters, once.
    expect(data.data['text/plain']).toBe('he prose\n\nfmt')
  })

  it('carries an element covered whole as that element\'s own kind', () => {
    const { ai, code, codeFrom } = answered()
    const view = viewOf([ai])
    const data = clip()
    slice(view, { editor, range: { from: codeFrom, to: codeFrom + code.nodeSize } })
      .write(/** @type {any} */ (data))
    expect(JSON.parse(data.data['sieve/slice'])).toHaveLength(1)
    expect(data.data['sieve/code']).toBe(JSON.stringify({ kind: 'code', id: 'c1', language: 'go' }))
    expect(data.data['text/plain']).toBe('fmt.Println(1)')
  })

  it('composes the container as ONE item when the range covers it whole', () => {
    const { ai } = answered()
    const view = viewOf([ai], (doc) => NodeSelection.create(doc, 0))
    const data = clip()
    slice(view, { editor }).write(/** @type {any} */ (data))
    const items = JSON.parse(data.data['sieve/slice'])
    expect(items).toHaveLength(1)
    expect(items[0].map((e) => e.mimeType)).toContain('sieve/ai-block')
    expect(data.data['sieve/ai-block']).toBe(JSON.stringify({ kind: 'ai-block', id: 'a1', question: 'why?' }))
  })

  // An element rendered read-only still IS an element: PM owns a position for it,
  // so a highlight inside one names that element, not the container.
  it('descends when the highlight lies inside a read-only ELEMENT of the body', () => {
    const { ai, codeFrom } = answered()
    const view = viewOf([ai], (doc) => TextSelection.create(doc, codeFrom + 2, codeFrom + 6))
    const codePre = view.doms[codeFrom].querySelector('pre')
    codePre.setAttribute('contenteditable', 'false') // as a projected code element is
    highlightOver(codePre)
    const data = clip()
    expect(slice(view, { editor }).write(/** @type {any} */ (data))).toBe(true)
    const items = JSON.parse(data.data['sieve/slice'])
    expect(items).toHaveLength(1)
    expect(items[0].map((e) => e.mimeType)).toContain('sieve/code')
    expect(data.data['sieve/ai-block']).toBeUndefined()
    // The highlight is the only reading of that element's text, and the element
    // goes whole as its own kind.
    expect(data.data['text/plain']).toBe('fmt.Println(1)')
    expect(data.data['sieve/code']).toBe(JSON.stringify({ kind: 'code', id: 'c1', language: 'go' }))
  })

  it('leaves a container whose content hosts no blocks whole', () => {
    const para = schema.nodes.paragraph.create(null, schema.text('clipped prose'))
    const clipNode = schema.nodes['sieve-web-clip'].create(null, [para])
    const view = viewOf([clipNode], (doc) => TextSelection.create(doc, 3, 8))
    const data = clip()
    slice(view, { editor }).write(/** @type {any} */ (data))
    const items = JSON.parse(data.data['sieve/slice'])
    expect(items).toHaveLength(1)
    expect(items[0].map((e) => e.mimeType)).toContain('sieve/web-clip')
  })
})

// The text views of a highlight PM DOES own follow the document range, node by
// node. Reading them off the DOM instead reports the WHOLE highlight for the first
// node and then each later node's share again, so text/plain repeated itself.
describe('text views of a highlight spanning more than one node', () => {
  it('carry each top-level node\'s text exactly once', () => {
    const para = schema.nodes.paragraph.create(null, schema.text('prose here'))
    const log = schema.nodes['sieve-log'].create(null, schema.text(LOG))
    const view = viewOf([para, log], (doc) => TextSelection.create(doc, 3, para.nodeSize + 6))
    highlightAcross(view.doms[0].querySelector('pre'), view.doms[para.nodeSize].querySelector('pre'))
    const data = clip()
    expect(slice(view, { editor }).write(/** @type {any} */ (data))).toBe(true)
    expect(data.data['text/plain']).toBe('ose here\n\nline ')
  })

  it('carry each element of a container\'s body exactly once', () => {
    const para = schema.nodes.paragraph.create(null, schema.text('the prose'))
    const code = schema.nodes['sieve-code'].create(null, schema.text('fmt.Println(1)'))
    const ai = schema.nodes['sieve-ai-block'].create(null, [para, code])
    const codeFrom = 1 + para.nodeSize
    const view = viewOf([ai], (doc) => TextSelection.create(doc, 3, codeFrom + 4))
    highlightAcross(view.doms[1].querySelector('pre'), view.doms[codeFrom].querySelector('pre'))
    const data = clip()
    expect(slice(view, { editor }).write(/** @type {any} */ (data))).toBe(true)
    expect(data.data['text/plain']).toBe('he prose\n\nfmt')
  })
})

describe('a highlight in a region ProseMirror does not own', () => {
  // The question title is read-only DOM inside a container the clipboard would
  // otherwise descend into. The highlight names no document range, so there is
  // nothing to compose children from: the node is claimed whole, and the text views
  // are the highlighted characters. This holds even when PM's caret sits in the
  // body, where the retarget cannot fire because PM's selection already covers the
  // block.
  it('claims a container whole rather than descending into its elements', () => {
    const para = schema.nodes.paragraph.create(null, schema.text('the prose'))
    const code = schema.nodes['sieve-code'].create(null, schema.text('fmt.Println(1)'))
    const ai = schema.nodes['sieve-ai-block'].create(null, [para, code])
    const view = viewOf([ai], (doc) => TextSelection.create(doc, 3)) // caret in the BODY
    highlightOver(view.doms[0].querySelector('.ai-block__question'))
    const data = clip()
    expect(slice(view, { editor }).write(/** @type {any} */ (data))).toBe(true)
    expect(data.data['text/plain']).toBe('why?')
    expect(JSON.parse(data.data['sieve/slice'])).toHaveLength(1)
    expect(data.data['sieve/ai-block']).toBe(JSON.stringify({ kind: 'ai-block', id: 'a1', question: 'why?' }))
  })

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
