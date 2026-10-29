// @ts-check
// ClipboardSlice — the clipboard VIEWS of one selection, as a unit. What the
// policy handler does with the answer (preventDefault, the cut's delete) is
// pinned in interaction-policy.editor.test.js against a real editor; these are
// the decisions that need a DOM and a selection PM cannot see.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection, NodeSelection } from '@tiptap/pm/state'
import { EditorView } from '@tiptap/pm/view'

// A structured kind's own views come from its NodeView adapter, and every one of
// them leads with a WHOLE-BLOCK text/plain (code, log, diagram, reference,
// ai-block). Registering a real adapter needs the TipTap runtime, so the lookup is
// stood in for: without it the framework's sieve/<kind> is the only entry there is,
// and what a single-block copy does with a kind's own text view goes untested.
vi.mock('../src/static/lens/document-editor/surfaces/sieve-block-extension.js', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    rendererFor: (/** @type {string} */ kind) => (RENDERERS[kind] || actual.rendererFor(kind)),
  }
})

// The views code and smart-image really declare (code-node-view.js,
// smart-image-node-view.js): code a whole-source text/plain, an image only the
// address its asset is at.
const RENDERERS = vi.hoisted(() => ({
  code: {
    asContentEntry: (/** @type {any} */ node) => {
      const src = node.textContent || node.attrs.source
      return src ? [{ mimeType: 'text/plain', content: src }] : null
    },
  },
  'smart-image': {
    asContentEntry: (/** @type {any} */ node) => (node.attrs.src ? [{ mimeType: 'text/uri-list', content: node.attrs.src }] : null),
  },
}))

import { ClipboardSlice } from '../src/static/lens/document-editor/clipboard-slice.js'
import { registerBlockKind } from '../src/static/renderers/block-kinds.js'

// Sieve nodes form the 'sieveBlock' group, and only a CONTAINER's content admits
// that group — which is how the clipboard tells a container it must descend into
// (ai-block) from one it must not (web-clip, whose 'block+' admits prose only).
const schema = new Schema({
  nodes: {
    doc: { content: '(block | sieveBlock)+' },
    paragraph: { group: 'block', content: 'text*', toDOM: () => ['p', 0] },
    codeBlock: {
      group: 'block', content: 'text*', marks: '', code: true,
      attrs: { language: { default: 'go' } },
      toDOM: (n) => ['pre', ['code', { class: 'language-' + n.attrs.language }, 0]],
    },
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
    // A container that hosts blocks only AFTER a leading caption. It stands for a
    // future container kind: hosting blocks is not a property of the FIRST position
    // of a content expression.
    'sieve-captioned': {
      group: 'sieveBlock', content: 'paragraph (block | sieveBlock)+',
      attrs: { kind: { default: 'captioned' }, id: { default: 'p1' } },
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
  marks: {
    strong: { toDOM: () => ['strong', 0] },
    link: { attrs: { href: {} }, toDOM: (m) => ['a', { href: m.attrs.href }, 0] },
  },
})

const LOG = 'line one\nline two\nline three'

// The node types whose children are rendered as elements of a body, as a real
// container's contentDOM holds them.
const CONTAINERS = ['sieve-ai-block', 'sieve-captioned']

// The clipboard reads a paragraph through the shared block-kind registry. The real
// definition is prose-block.js, which needs the whole TipTap vendor bootstrap; this
// is the half of its contract that matters here — sieve/prose (the node's markdown,
// from the editor's serializer) plus text/plain (its plain text).
registerBlockKind({
  kind: 'prose',
  native: true,
  asContentEntry: (node, editor) => {
    const md = editor ? editor.serialize(node) : ''
    return md ? [
      { mimeType: 'sieve/prose', content: JSON.stringify({ content: md }) },
      { mimeType: 'text/plain', content: node.textContent },
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

    if (CONTAINERS.indexOf(node.type.name) >= 0) {
      if (node.type.name === 'sieve-ai-block') {
        // The question TITLE is DOM ProseMirror does not own.
        const title = document.createElement('div')
        title.className = 'ai-block__question'
        title.setAttribute('contenteditable', 'false')
        title.textContent = node.attrs.question
        el.appendChild(title)
      }
      // The BODY is the contentDOM, holding one rendered element per child.
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
  // ProseMirror's own clipboard serializer, over this state's schema.
  const serializeForClipboard = (s) =>
    EditorView.prototype.serializeForClipboard.call({ state: withSel, someProp: () => undefined }, s)
  return { state: withSel, nodeDOM: (pos) => doms[pos] || null, doms, serializeForClipboard }
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
  // C3/C4: part of a block is its characters, exactly as the same text copied from
  // another application would be, so a paste can only read it as text.
  it.each([
    ['log', () => schema.nodes['sieve-log'].create(null, schema.text(LOG)), 10, 18, 'line two', 'line two'],
    ['code across a line end', () => schema.nodes['sieve-code'].create(null, schema.text('fmt.Println(1)\nfmt.Println(2)')), 6, 20,
      'rintln(1)\nfmt.', 'rintln(1)<br>fmt.'],
    ['web-clip', () => schema.nodes['sieve-web-clip'].create(null, [schema.nodes.paragraph.create(null, schema.text('clipped prose'))]), 3, 8,
      'lippe', 'lippe'],
  ])('C3: a partial %s range writes its characters and no sieve/* view', (_kind, make, from, to, text, html) => {
    const view = viewOf([make()], (doc) => TextSelection.create(doc, from, to))
    const data = clip()
    expect(slice(view, { editor }).write(/** @type {any} */ (data))).toBe(true)
    expect(data.data).toEqual({ 'text/plain': text, 'text/html': html })
  })

  it('a range of several blocks: one covered in part is its characters as prose, one covered whole keeps its views', () => {
    const para = schema.nodes.paragraph.create(null, schema.text('prose here'))
    const code = schema.nodes['sieve-code'].create(null, schema.text('fmt.Println(1)'))
    const log = schema.nodes['sieve-log'].create(null, schema.text(LOG))
    const logFrom = para.nodeSize + code.nodeSize
    const view = viewOf([para, code, log], (doc) => TextSelection.create(doc, 3, logFrom + 5))
    const data = clip()
    expect(slice(view, { editor }).write(/** @type {any} */ (data))).toBe(true)
    const items = JSON.parse(data.data['sieve/slice'])
    expect(items.map((item) => item.map((e) => e.mimeType))).toEqual([
      ['sieve/prose', 'text/plain'],
      ['text/plain', 'sieve/code'],
      ['sieve/prose', 'text/plain'],
    ])
    expect(JSON.parse(items[2][0].content).content).toBe('line')
    expect(data.data['text/plain']).toBe('ose here\n\nfmt.Println(1)\n\nline')
    expect(data.data['sieve/code']).toBeUndefined()
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

  it('a block\'s own sieve view says which document it was copied from', () => {
    const code = schema.nodes['sieve-code'].create(null, schema.text('fmt.Println(1)'))
    const view = viewOf([code], (doc) => NodeSelection.create(doc, 0))
    const data = clip()
    slice(view, { uuid: 'doc-7' }).write(/** @type {any} */ (data))
    const [item] = JSON.parse(data.data['sieve/slice'])
    expect(item.find((e) => e.mimeType === 'sieve/code').context).toEqual({ container: 'doc-7' })
    expect(item.find((e) => e.mimeType === 'text/plain').context).toBeUndefined()

    // The flat single-block view cannot carry it; a paste reads it back off the slice.
    const flat = [{ mimeType: 'text/plain', content: 'fmt.Println(1)' }, { mimeType: 'sieve/code', content: data.data['sieve/code'] }]
    const restored = ClipboardSlice.withSliceContext(flat, data.data['sieve/slice'])
    expect(restored[1].context).toEqual({ container: 'doc-7' })
    expect(restored[0].context).toBeUndefined()
  })

  it.each([
    ['no slice', ''],
    ['an unparseable slice', '{'],
    ['a multi-item slice', JSON.stringify([[{ mimeType: 'sieve/code', content: '{}', context: { container: 'a' } }], []])],
  ])('withSliceContext leaves the entries alone given %s', (_, sliceData) => {
    const flat = [{ mimeType: 'sieve/code', content: '{}' }]
    expect(ClipboardSlice.withSliceContext(flat, sliceData)).toEqual(flat)
  })

  it('pure prose is refused, so ProseMirror serves it', () => {
    const view = viewOf(
      [schema.nodes.paragraph.create(null, schema.text('hello'))],
      (doc) => TextSelection.create(doc, 1, 4),
    )
    expect(slice(view).write(/** @type {any} */ (clip()))).toBe(false)
  })
})

describe('a selected image is copied as a block', () => {
  // C10: its text view is the address of its asset, never the chrome the host
  // draws around it (gutter number, handle, badge).
  it.each([
    ['with an asset', { src: 'sieve://doc-7/shot.svg' }, 'sieve://doc-7/shot.svg'],
    ['before its asset exists', {}, ''],
  ])('%s, every view is composed', (_, attrs, text) => {
    const view = viewOf(
      [schema.nodes['sieve-smart-image'].create(attrs)],
      (doc) => NodeSelection.create(doc, 0),
    )
    view.doms[0].querySelector('.block-chrome-host').textContent = '2 ⠿ dumb mode'
    const data = clip()
    expect(slice(view, { uuid: 'doc-7' }).write(/** @type {any} */ (data))).toBe(true)
    expect(data.data['text/plain']).toBe(text)
    expect(data.data['text/html']).toBeTruthy()
    expect(JSON.parse(data.data['sieve/smart-image'])).toMatchObject(attrs)
    const [item] = JSON.parse(data.data['sieve/slice'])
    expect(item.find((e) => e.mimeType === 'sieve/smart-image').context).toEqual({ container: 'doc-7' })
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

  it('C7: is composed per element — the answer pastes as the blocks it showed, a part as its characters', () => {
    const { ai, code, paraFrom, codeFrom } = answered()
    const view = viewOf([ai], (doc) => TextSelection.create(doc, paraFrom + 2, codeFrom + code.nodeSize))
    const data = clip()
    expect(slice(view, { editor }).write(/** @type {any} */ (data))).toBe(true)

    const items = JSON.parse(data.data['sieve/slice'])
    expect(items.map((item) => item.map((e) => e.mimeType))).toEqual([
      ['sieve/prose', 'text/plain'],
      ['text/plain', 'sieve/code'],
    ])
    expect(JSON.parse(items[0][0].content).content).toBe('he prose')
    // The container itself is not one of the items, and so cannot be rebuilt whole.
    expect(JSON.stringify(items)).not.toContain('sieve/ai-block')
    expect(data.data['sieve/ai-block']).toBeUndefined()
    // Each element's own covered characters, once.
    expect(data.data['text/plain']).toBe('he prose\n\nfmt.Println(1)')
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

  // A range covering no element whole is characters only: text/plain and the
  // text/html ProseMirror's own copy would write, each element its own slice, so
  // a paste places them natively — inline at the caret, a code block as one.
  const P = (...inline) => schema.nodes.paragraph.create(null, inline)
  const T = (text, ...marks) => schema.text(text, marks)
  it.each([
    ['C14 bold text', () => [P(T('a '), T('bold', schema.marks.strong.create()), T(' word'))], 4, 11,
      'bold wo', '<strong data-pm-slice="0 0 []">bold</strong> wo'],
    ['C14 a link', () => [P(T('see '), T('here', schema.marks.link.create({ href: 'https://example.com/' })), T(' now'))], 5, 12,
      ' here n', ' <a href="https://example.com/">here</a> n'],
    ['C14 a paragraph into its code fence', () => [P(T('Run this:')), schema.nodes.codeBlock.create(null, T('fmt.Println(1)'))], 6, 20,
      'this:\n\nfmt.Pri', '<p data-pm-slice="1 0 []">this:</p>\n<pre data-pm-slice="0 1 []"><code class="language-go">fmt.Pri</code></pre>'],
    ['an answer whose elements are all paragraphs', () => [P(T('Here is the example:')), P(T('public class Hello'))], 10, 30,
      'the example:\n\npublic', '<p data-pm-slice="1 0 []">the example:</p>\n<p data-pm-slice="0 1 []">public</p>'],
  ])('%s, covered in part: text/plain and ProseMirror\'s text/html, no sieve/* view', (_row, children, from, to, text, html) => {
    const view = viewOf([schema.nodes['sieve-ai-block'].create(null, children())], (doc) => TextSelection.create(doc, from, to))
    const data = clip()
    expect(slice(view, { editor }).write(/** @type {any} */ (data))).toBe(true)
    expect(data.data).toEqual({ 'text/plain': text, 'text/html': html })
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

  // Hosting blocks is a property of the whole content expression, not of its first
  // position: a container declaring a caption before its blocks hosts them too, and
  // reading only the first position leaves a range inside it composed as the
  // container — the very flattening this fixes.
  it('descends into a container that hosts blocks after a leading caption', () => {
    const caption = schema.nodes.paragraph.create(null, schema.text('the caption'))
    const code = schema.nodes['sieve-code'].create(null, schema.text('fmt.Println(1)'))
    const captioned = schema.nodes['sieve-captioned'].create(null, [caption, code])
    const codeFrom = 1 + caption.nodeSize
    const view = viewOf([captioned], (doc) => TextSelection.create(doc, 3, codeFrom + 4))
    const data = clip()
    expect(slice(view, { editor }).write(/** @type {any} */ (data))).toBe(true)
    // Descended: the caption is a prose element of its own, the code element its characters.
    expect(data.data['text/html']).toBe('<p data-pm-slice="1 0 []">he caption</p>\nfmt')
    expect(data.data['text/plain']).toBe('he caption\n\nfmt')
    expect(data.data['sieve/captioned']).toBeUndefined()
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
  it('is the container\'s own characters, never its elements', () => {
    const para = schema.nodes.paragraph.create(null, schema.text('the prose'))
    const code = schema.nodes['sieve-code'].create(null, schema.text('fmt.Println(1)'))
    const ai = schema.nodes['sieve-ai-block'].create(null, [para, code])
    const view = viewOf([ai], (doc) => TextSelection.create(doc, 3)) // caret in the BODY
    highlightOver(view.doms[0].querySelector('.ai-block__question'))
    const data = clip()
    expect(slice(view, { editor }).write(/** @type {any} */ (data))).toBe(true)
    // The title is part of the block, so it is copied as the characters it is.
    expect(data.data['text/plain']).toBe('why?')
    expect(data.data['sieve/slice']).toBeUndefined()
    expect(data.data['sieve/ai-block']).toBeUndefined()
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
