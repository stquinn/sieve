// @ts-check
// #117 step 2 — the ANSWER projects into the editor as ELEMENT-MODE SIEVE NODES.
//
// An ai-block's COMPLETE answer is a list of blocks. In the editor lens each
// element is projected into the block's content as a node of its OWN KIND, so it
// draws through that kind's NodeView — a rendered diagram, a gutter, chrome —
// while ProseMirror keeps owning selection and copy, which is the property the
// whole design exists to protect.
//
// A projected node is an ELEMENT, not a document block: it lives inside its
// parent's payload, resolves to nothing the container holds, and the four
// guarantees that make that safe are what this file pins —
//
//   1. SAVE IS BLIND TO IT      the save diff walks the document's TOP LEVEL and
//                               signs a sieve block by its ATTRS alone, so
//                               nested nodes emit no op and dirty nothing.
//   2. IDENTITY IS SUPPRESSED   no data-id/data-block-id, no chrome, no block
//                               verbs of its own — a gesture lands on the HOST.
//   3. IT IS PROJECTED ONCE     only a body that actually changed is written
//                               back; a keystroke elsewhere re-renders nothing.
//   4. EDITING STAYS BLOCKED    the ai-block's guard plugins hold over the
//                               nested nodes as they did over nested text.
//
// The schema and the parse are REAL ProseMirror (see helpers/sieve-pm-schema.js);
// what is faked is only the editor PANE, so a NodeView can be built and its
// transactions counted without an EditorView.

import { describe, it, expect, beforeAll } from 'vitest'
import { DOMParser as PMDOMParser } from '@tiptap/pm/model'
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state'
import { buildSieveSchema } from './helpers/sieve-pm-schema.js'
import { getBlockKind } from '../src/static/renderers/block-kinds.js'
import { AiBlockRenderer } from '../src/static/renderers/ai-block-renderer.js'
import { SieveBlock } from '../src/static/contract/sieve-block.js'
import { computeBlockSync, seedBaseline } from '../src/static/lens/document-editor/block-sync.js'

const VENDOR = /** @type {any} */ (globalThis).TipTap

/** The kinds the showcase answer spans, plus the block hosting it. */
const KINDS = ['ai-block', 'code', 'log', 'diagram', 'reference']

/** The answer of the committed showcase document, verbatim:
 *  sieve/block/processors/testdata/answer-list-showcase/…-000000000001.md */
const SHOWCASE_ANSWER = Object.freeze([
  { kind: 'prose', attrs: { id: '0198c1a0-0001-7000-8000-000000000201', content: 'The third attempt never ran — the connection pool was exhausted first.' } },
  { kind: 'code', attrs: { id: '0198c1a0-0001-7000-8000-000000000202', language: 'go', source: 'func backoff(attempt int) time.Duration {\n    // the RFC writes it as:\n    // ```go\n    // min(base<<attempt, ceiling)\n    // ```\n    return min(base<<attempt, ceiling)\n}' } },
  { kind: 'log', attrs: { id: '0198c1a0-0001-7000-8000-000000000203', source: '2026-08-27 11:04:06 WARN  pool exhausted, queueing\n2026-08-27 11:04:10 ERROR giving up after 4 attempts' } },
  { kind: 'diagram', attrs: { id: '0198c1a0-0001-7000-8000-000000000204', diagramType: 'mermaid', mode: 'render', source: 'graph TD\n    A[attempt] --> B{pool free?}' } },
  { kind: 'reference', attrs: { id: '0198c1a0-0001-7000-8000-000000000205', uri: 'sieve://0198c1a0-ffff-7000-8000-0000000000ff/0198c1a0-ffff-7000-8000-000000000010', cache: { title: 'Retry RFC §4' } } },
  { kind: 'prose', attrs: { id: '0198c1a0-0001-7000-8000-000000000206', content: 'Raise the pool ceiling first.' } },
])

const AI_ID = '0198c1a0-0001-7000-8000-000000000020'

/** @type {any} */ let registry
/** @type {import('@tiptap/pm/model').Schema} */ let schema
/** @type {any} */ let sieveBlockAttrs
/** @type {any[]} */ let probeContexts

/** A doc built from top-level nodes. @param {any[]} nodes */
const docOf = (nodes) => schema.nodes.doc.create(null, nodes)

/** An ai-block node holding `answer`, whose content is the projected HTML's nodes.
 *  @param {any} answer @param {any[]} [content] */
function aiBlock(answer, content) {
  return schema.nodes['sieve-ai-block'].create(
    { id: AI_ID, kind: 'ai-block', status: 'COMPLETE', answer: answer },
    content && content.length ? content : schema.nodes.paragraph.create(),
  )
}

/** The nodes projection HTML denotes. @param {string} html @returns {any[]} */
function parseNodes(html) {
  const holder = document.createElement('div')
  holder.innerHTML = html
  /** @type {any[]} */
  const out = []
  PMDOMParser.fromSchema(schema).parse(holder).content.forEach((n) => out.push(n))
  return out
}

/** The position of the first node satisfying `pick`. @param {any} doc @param {(n: any) => boolean} pick */
function posOf(doc, pick) {
  let found = -1
  doc.descendants((/** @type {any} */ node, /** @type {number} */ pos) => {
    if (found < 0 && pick(node)) found = pos
  })
  return found
}

/** A stand-in editor pane: real state, real transactions, no EditorView.
 *  @param {any} initial @param {any} [provider] */
function fakePane(initial, provider) {
  let state = initial
  /** @type {any} */
  const pane = {
    get state() { return state },
    blockProvider: provider || null,
    sieveHost: null,
    /** @type {any[]} */ dispatched: [],
  }
  pane.view = {
    get state() { return state },
    dom: document.createElement('div'),
    focus() {},
    dispatch(/** @type {any} */ tr) { pane.dispatched.push(tr); state = state.apply(tr) },
  }
  return pane
}

/** Lets the projection's deferred transaction run. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/** The minted node config for a kind. @param {string} name */
const configOf = (name) => registry.nodes().find((/** @type {any} */ c) => c.name === name)

/** Builds a NodeView through the FRAMEWORK factory — the seam under test.
 *  @param {string} name @param {any} pane @param {number} pos @returns {any} */
function nodeViewAt(name, pane, pos) {
  const node = pane.state.doc.nodeAt(pos)
  return configOf(name).addNodeView()({ node, editor: pane, getPos: () => pos })
}

beforeAll(async () => {
  // DiagramRenderer injects a real <script> when window.mermaid is absent, which
  // happy-dom fetches synchronously against a server that is not there.
  /** @type {any} */ (window).mermaid = {
    initialize() {},
    render() { return Promise.resolve({ svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>' }) },
  }
  Object.assign(VENDOR, {
    PluginKey: class PluginKey {},
    Extension: { create: (/** @type {any} */ o) => o },
    Plugin: class Plugin { constructor(/** @type {any} */ spec) { Object.assign(this, spec) } },
    ProseMirrorDOMParser: PMDOMParser,
    NodeSelection: NodeSelection,
  })
  // Node.create hands back the raw config, which the schema helper transcribes.
  VENDOR.Node = { create: (/** @type {any} */ cfg) => cfg }
  VENDOR.mergeAttributes = (/** @type {any} */ a, /** @type {any} */ b) => Object.assign({}, a, b)

  for (const kind of KINDS) {
    await import(`../src/static/lens/document-editor/surfaces/node-views/${kind}-node-view.js`)
  }
  const ext = await import('../src/static/lens/document-editor/surfaces/sieve-block-extension.js')
  sieveBlockAttrs = ext.sieveBlockAttrs

  registry = new ext.NodeViewRegistry()
  for (const kind of KINDS) registry.register(kind, getBlockKind(kind).renderer)

  // A KIND-BLIND probe: it records the context the framework handed it and
  // stamps the identity a real renderer stamps, so what the seam does to an
  // element is observable without any one kind's rendering in the way.
  probeContexts = []
  registry.register('probe', {
    nodeConfig: { atom: true },
    makeNodeView(/** @type {any} */ node, /** @type {any} */ _pane, /** @type {any} */ _getPos, /** @type {any} */ ctx) {
      probeContexts.push(ctx)
      const dom = document.createElement('div')
      dom.setAttribute('data-id', node.attrs.id)
      dom.setAttribute('data-block-id', node.attrs.id)
      const inner = document.createElement('span')
      inner.setAttribute('data-id', node.attrs.id + '-inner')
      dom.appendChild(inner)
      return { dom }
    },
  })

  schema = buildSieveSchema(registry.nodes())
})

// ── The projection ───────────────────────────────────────────────────────────

describe('the answer projects as element-mode sieve nodes', () => {
  it('every element becomes a node of its own kind, in authored order', () => {
    const elements = new AiBlockRenderer(
      new SieveBlock('ai-block', { id: AI_ID, status: 'COMPLETE', answer: SHOWCASE_ANSWER }),
    ).bodyElements()
    const nodes = parseNodes(registry.elementsHTML(elements))
    expect(nodes.map((n) => n.type.name)).toEqual([
      'paragraph', 'sieve-code', 'sieve-log', 'sieve-diagram', 'sieve-reference', 'paragraph',
    ])
  })

  it("a structured element carries its kind's attrs, not a rendering of them", () => {
    const nodes = parseNodes(registry.elementsHTML(SHOWCASE_ANSWER))
    const code = nodes[1]
    expect(code.attrs.kind).toBe('code')
    expect(code.attrs.language).toBe('go')
    expect(nodes[3].attrs.diagramType).toBe('mermaid')
    expect(nodes[4].attrs.uri).toBe(SHOWCASE_ANSWER[4].attrs.uri)
  })

  it('literal source text survives the costume verbatim, newlines and inner fences included', () => {
    const nodes = parseNodes(registry.elementsHTML(SHOWCASE_ANSWER))
    expect(nodes[1].textContent).toBe(SHOWCASE_ANSWER[1].attrs.source)
    expect(nodes[2].textContent).toBe(SHOWCASE_ANSWER[2].attrs.source)
  })

  it('a prose element reads as native prose — there is no sieve-prose node', () => {
    const nodes = parseNodes(registry.elementsHTML([SHOWCASE_ANSWER[0]]))
    expect(nodes.map((n) => n.type.name)).toEqual(['paragraph'])
    expect(nodes[0].textContent).toContain('connection pool was exhausted')
  })

  it('a kind with no node type of its own still reads, rather than vanishing', () => {
    const nodes = parseNodes(registry.elementsHTML([{ kind: 'not-a-kind', attrs: { content: 'still legible' } }]))
    expect(nodes.length).toBe(1)
    expect(nodes[0].textContent).toContain('still legible')
  })

  it("the ai-block's content admits them — the projection is schema-legal", () => {
    const nodes = parseNodes(registry.elementsHTML(SHOWCASE_ANSWER))
    const doc = docOf([aiBlock(SHOWCASE_ANSWER, nodes)])
    expect(() => doc.check()).not.toThrow()
    const hosted = []
    doc.child(0).forEach((n) => hosted.push(n.type.name))
    expect(hosted).toContain('sieve-diagram')
  })

  it('an empty ai-block still auto-fills with prose, not a stray sieve atom', () => {
    // Widening the content expression widens what createAndFill may reach for,
    // and the fill lands wherever a body is emptied.
    const filled = schema.nodes['sieve-ai-block'].createAndFill({ id: AI_ID, kind: 'ai-block' })
    expect(filled).not.toBeNull()
    expect(/** @type {any} */ (filled).firstChild.type.name).toBe('paragraph')
  })

  it('only a COMPLETE answer projects as blocks; a status line stays text', () => {
    const pending = new AiBlockRenderer(
      new SieveBlock('ai-block', { id: AI_ID, status: 'PENDING', answer: SHOWCASE_ANSWER }),
    )
    expect(pending.bodyElements()).toBeNull()
    // Null is what sends the seam down the MARKDOWN branch, and what it finds
    // there is the status line, never the answer waiting behind it.
    expect(pending.bodyMarkdown()).not.toContain('connection pool')
  })
})

// ── Constraint 1 — save is blind to a projected element ──────────────────────

describe('save-blindness: a projected element is invisible to the sync diff', () => {
  /** The rule #topBlockTriple applies, transcribed: a sieve block signs itself by
   *  its ATTRS, never by its content. @param {any} doc */
  const triples = (doc) => {
    /** @type {any[]} */
    const out = []
    doc.forEach((/** @type {any} */ node) => {
      out.push(node.type.name.indexOf('sieve-') === 0
        ? { id: node.attrs.id || '', kind: node.attrs.kind, content: JSON.stringify(sieveBlockAttrs(node)) }
        : { id: node.attrs.id || '', kind: 'prose', content: node.textContent })
    })
    return out
  }

  it('projecting the answer emits no block-op and moves no baseline', () => {
    const before = docOf([aiBlock(SHOWCASE_ANSWER)])
    const after = docOf([aiBlock(SHOWCASE_ANSWER, parseNodes(registry.elementsHTML(SHOWCASE_ANSWER)))])
    const baseline = seedBaseline(triples(before))
    const sync = computeBlockSync(triples(after), baseline)
    expect(sync.ops).toEqual([])
  })

  it("the block's change signature is its attrs, so nested nodes cannot move it", () => {
    const bare = aiBlock(SHOWCASE_ANSWER)
    const projected = aiBlock(SHOWCASE_ANSWER, parseNodes(registry.elementsHTML(SHOWCASE_ANSWER)))
    expect(JSON.stringify(sieveBlockAttrs(projected))).toBe(JSON.stringify(sieveBlockAttrs(bare)))
  })

  it('the top-level walk sees one block, whatever the answer is composed of', () => {
    const doc = docOf([aiBlock(SHOWCASE_ANSWER, parseNodes(registry.elementsHTML(SHOWCASE_ANSWER)))])
    expect(doc.childCount).toBe(1)
    expect(triples(doc).map((t) => t.kind)).toEqual(['ai-block'])
  })
})

// ── Constraint 2 — identity suppressed, read affordances only ────────────────

describe('element mode: what the seam takes away, and from whom', () => {
  /** A doc with the SAME kind both at top level and nested inside an ai-block. */
  function twoPlaces() {
    const probe = (/** @type {string} */ id) => schema.nodes['sieve-probe'].create({ id, kind: 'probe' })
    const doc = docOf([probe('top-level-block'), aiBlock([], [probe('nested-element')])])
    return fakePane(EditorState.create({ schema, doc }), { getBlock: () => null, requestSetBlock() {} })
  }

  it('a sieve node inside another sieve node is an ELEMENT; one at top level is not', () => {
    const ext = registry
    const pane = twoPlaces()
    const doc = pane.state.doc
    const top = posOf(doc, (n) => n.attrs.id === 'top-level-block')
    const nested = posOf(doc, (n) => n.attrs.id === 'nested-element')
    expect(ext.constructor.isElementPosition(pane, () => nested)).toBe(true)
    expect(ext.constructor.isElementPosition(pane, () => top)).toBe(false)
  })

  it('an unresolvable position reads as document-level, never as an element', () => {
    const Registry = registry.constructor
    const pane = twoPlaces()
    expect(Registry.isElementPosition(pane, () => 100000)).toBe(false)
    expect(Registry.isElementPosition(pane, () => { throw new Error('stale') })).toBe(false)
    expect(Registry.isElementPosition(pane, null)).toBe(false)
  })

  it('an element is handed NO provider and READ-ONLY; a document block is handed both', () => {
    const pane = twoPlaces()
    probeContexts.length = 0
    nodeViewAt('sieve-probe', pane, posOf(pane.state.doc, (n) => n.attrs.id === 'nested-element'))
    nodeViewAt('sieve-probe', pane, posOf(pane.state.doc, (n) => n.attrs.id === 'top-level-block'))
    const [element, block] = probeContexts
    expect(element.provider).toBeNull()
    expect(element.renderOptions.readOnly).toBe(true)
    expect(block.provider).toBe(pane.blockProvider)
    expect(block.renderOptions.readOnly).toBe(false)
  })

  it('an element presents no document-block identity, anywhere in its DOM', () => {
    const pane = twoPlaces()
    const view = nodeViewAt('sieve-probe', pane, posOf(pane.state.doc, (n) => n.attrs.id === 'nested-element'))
    expect(view.dom.hasAttribute('data-id')).toBe(false)
    expect(view.dom.hasAttribute('data-block-id')).toBe(false)
    expect(view.dom.querySelectorAll('[data-id], [data-block-id]').length).toBe(0)
  })

  it('identity a kind stamps LATER is taken off too', async () => {
    const pane = twoPlaces()
    const view = nodeViewAt('sieve-probe', pane, posOf(pane.state.doc, (n) => n.attrs.id === 'nested-element'))
    const late = document.createElement('div')
    late.setAttribute('data-id', 'mermaid-edge-3')
    view.dom.appendChild(late)
    await settle()
    expect(late.hasAttribute('data-id')).toBe(false)
  })

  it('a document block keeps its identity and its chrome; an element gets neither', () => {
    const pane = twoPlaces()
    const element = nodeViewAt('sieve-probe', pane, posOf(pane.state.doc, (n) => n.attrs.id === 'nested-element'))
    const block = nodeViewAt('sieve-probe', pane, posOf(pane.state.doc, (n) => n.attrs.id === 'top-level-block'))
    expect(block.dom.getAttribute('data-id')).toBe('top-level-block')
    expect(block.dom.querySelector('.block-chrome-host')).not.toBeNull()
    expect(element.dom.querySelector('.block-chrome-host')).toBeNull()
  })

  it('an element offers no context menu of its own — the gesture reaches its host', () => {
    const pane = twoPlaces()
    const element = nodeViewAt('sieve-probe', pane, posOf(pane.state.doc, (n) => n.attrs.id === 'nested-element'))
    const block = nodeViewAt('sieve-probe', pane, posOf(pane.state.doc, (n) => n.attrs.id === 'top-level-block'))
    /** @type {string[]} */
    const menus = []
    const listen = () => menus.push('opened')
    document.addEventListener('sieve:contextmenu', listen)
    try {
      element.dom.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      expect(menus.length).toBe(0)
      block.dom.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
      expect(menus.length).toBe(1)
    } finally {
      document.removeEventListener('sieve:contextmenu', listen)
    }
  })

  it('an element does not claim the selection — the click belongs to its host', () => {
    const pane = twoPlaces()
    const element = nodeViewAt('sieve-probe', pane, posOf(pane.state.doc, (n) => n.attrs.id === 'nested-element'))
    element.dom.dispatchEvent(new window.MouseEvent('mouseup', { bubbles: true }))
    expect(pane.dispatched.length).toBe(0)
  })
})

// ── The contentDOM a projected node hands ProseMirror ────────────────────────

describe('a content-bearing node keeps its contentDOM attached in every mode', () => {
  /** The showcase's diagram element, which is authored in RENDER mode. */
  const DIAGRAM = SHOWCASE_ANSWER[3]

  /** A pane holding `nodes` at the document's top level. @param {any[]} nodes */
  const paneOver = (nodes) => fakePane(EditorState.create({ schema, doc: docOf(nodes) }))

  /** The diagram view's two mode surfaces. @param {any} view */
  const surfaces = (view) => ({
    edit: /** @type {HTMLElement} */ (view.dom.querySelector('.sieve-block__body')),
    render: /** @type {HTMLElement} */ (view.dom.querySelector('.diagram-block__render')),
  })

  // A node claiming text content whose contentDOM is not in the document reads
  // to ProseMirror as text the user deleted, and it dispatches a replace to
  // match — inside a body the projection then writes back, which is a loop.
  it('a NESTED render-mode diagram holds its contentDOM under its own dom', () => {
    const nested = parseNodes(registry.elementsHTML([DIAGRAM]))
    const pane = paneOver([aiBlock([DIAGRAM], nested)])
    const view = nodeViewAt('sieve-diagram', pane, posOf(pane.state.doc, (n) => n.type.name === 'sieve-diagram'))
    expect(view.contentDOM).toBeTruthy()
    expect(view.dom.contains(view.contentDOM)).toBe(true)
    // The <code> of the EDIT surface, which render mode hides rather than detaches.
    expect(surfaces(view).edit.contains(view.contentDOM)).toBe(true)
  })

  it('a TOP-LEVEL render-mode diagram holds it too', () => {
    const pane = paneOver(parseNodes(registry.elementsHTML([DIAGRAM])))
    const view = nodeViewAt('sieve-diagram', pane, 0)
    expect(view.dom.contains(view.contentDOM)).toBe(true)
  })

  it('render mode shows the render surface and hides the edit one, attaching both', () => {
    const pane = paneOver(parseNodes(registry.elementsHTML([DIAGRAM])))
    const { edit, render } = surfaces(nodeViewAt('sieve-diagram', pane, 0))
    expect(edit).toBeTruthy()
    expect(render).toBeTruthy()
    expect(edit.hidden).toBe(true)
    expect(render.hidden).toBe(false)
  })

  it('an element is drawn read-only, and read-only still keeps both surfaces', () => {
    const editable = { kind: 'diagram', attrs: Object.assign({}, DIAGRAM.attrs, { mode: 'edit' }) }
    const nested = parseNodes(registry.elementsHTML([editable]))
    const pane = paneOver([aiBlock([editable], nested)])
    const view = nodeViewAt('sieve-diagram', pane, posOf(pane.state.doc, (n) => n.type.name === 'sieve-diagram'))
    const { edit, render } = surfaces(view)
    expect(view.dom.contains(view.contentDOM)).toBe(true)
    expect(render.hidden).toBe(false)
    expect(edit.hidden).toBe(true)
  })
})

// ── Constraint 3 — projected once, on change only ────────────────────────────

describe('churn guard: a body is written back only when it changed', () => {
  /** A pane holding one ai-block with `answer`, and the position of that block. */
  function hosting(/** @type {any} */ answer) {
    const doc = docOf([aiBlock(answer)])
    const pane = fakePane(EditorState.create({ schema, doc }))
    return { pane, pos: posOf(doc, (n) => n.type.name === 'sieve-ai-block') }
  }

  it('the answer projects once when the block is built', async () => {
    const { pane, pos } = hosting(SHOWCASE_ANSWER)
    nodeViewAt('sieve-ai-block', pane, pos)
    await settle()
    expect(pane.dispatched.length).toBe(1)
    const hosted = []
    pane.state.doc.nodeAt(pos).forEach((/** @type {any} */ n) => hosted.push(n.type.name))
    expect(hosted).toEqual(['paragraph', 'sieve-code', 'sieve-log', 'sieve-diagram', 'sieve-reference', 'paragraph'])
  })

  it('the projection is a tracked, non-undoable, non-dirtying transaction', async () => {
    const { pane, pos } = hosting(SHOWCASE_ANSWER)
    nodeViewAt('sieve-ai-block', pane, pos)
    await settle()
    const tr = pane.dispatched[0]
    expect(tr.getMeta('sieve-md-sync')).toBe(true)
    expect(tr.getMeta('addToHistory')).toBe(false)
  })

  it('an update carrying the SAME answer projects nothing', async () => {
    const { pane, pos } = hosting(SHOWCASE_ANSWER)
    const view = nodeViewAt('sieve-ai-block', pane, pos)
    await settle()
    expect(pane.dispatched.length).toBe(1)
    // A fresh node object with an equal answer — what a redraw off the container
    // model hands back on an edit somewhere else in the document.
    view.update(aiBlock(SHOWCASE_ANSWER.map((el) => ({ kind: el.kind, attrs: Object.assign({}, el.attrs) }))))
    await settle()
    expect(pane.dispatched.length).toBe(1)
  })

  // A doc change destroys and rebuilds the NodeView, and construction projects
  // unconditionally. Writing back a body that already matches would recreate the
  // view that wrote it, so the pass has to end at the comparison.
  it('a view rebuilt over the body it already projected writes nothing back', async () => {
    const { pane, pos } = hosting(SHOWCASE_ANSWER)
    nodeViewAt('sieve-ai-block', pane, pos)
    await settle()
    expect(pane.dispatched.length).toBe(1)
    nodeViewAt('sieve-ai-block', pane, pos)
    await settle()
    expect(pane.dispatched.length).toBe(1)
  })

  it('an update carrying a DIFFERENT answer projects again', async () => {
    const { pane, pos } = hosting(SHOWCASE_ANSWER)
    const view = nodeViewAt('sieve-ai-block', pane, pos)
    await settle()
    view.update(aiBlock([{ kind: 'prose', attrs: { id: 'x', content: 'a second thought' } }]))
    await settle()
    expect(pane.dispatched.length).toBe(2)
  })
})

// ── Constraint 4 — editing stays blocked over the nested nodes ───────────────

describe('the guard plugins hold over projected elements', () => {
  const props = () => {
    const plugins = getBlockKind('ai-block').renderer.buildPlugins(schema.nodes['sieve-ai-block'])
    return /** @type {any} */ (plugins[0]).props
  }

  /** A doc whose ai-block holds the projected answer. */
  function projected() {
    const doc = docOf([
      schema.nodes.paragraph.create({ id: 'pr-1' }, schema.text('outside')),
      aiBlock(SHOWCASE_ANSWER, parseNodes(registry.elementsHTML(SHOWCASE_ANSWER))),
    ])
    return EditorState.create({ schema, doc })
  }

  it('typing inside a projected element is refused', () => {
    const state = projected()
    const code = posOf(state.doc, (n) => n.type.name === 'sieve-code')
    expect(props().handleTextInput({ state }, code + 1, code + 1, 'x')).toBe(true)
  })

  it('typing outside the block is untouched', () => {
    const state = projected()
    expect(props().handleTextInput({ state }, 1, 1, 'x')).toBe(false)
  })

  it('pasting into a projected element is refused', () => {
    const state = projected()
    const code = posOf(state.doc, (n) => n.type.name === 'sieve-code')
    const inside = state.apply(state.tr.setSelection(TextSelection.create(state.doc, code + 1)))
    expect(props().handlePaste({ state: inside }, null, null)).toBe(true)
  })

  it('Backspace on a projected element would edit the body, so it is refused', () => {
    const state = projected()
    const diagram = posOf(state.doc, (n) => n.type.name === 'sieve-diagram')
    const selected = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, diagram)))
    expect(props().handleKeyDown({ state: selected }, { key: 'Backspace' })).toBe(true)
  })

  it('Backspace on the WHOLE ai-block still deletes it — a mistake stays undoable', () => {
    const state = projected()
    const ai = posOf(state.doc, (n) => n.type.name === 'sieve-ai-block')
    const selected = state.apply(state.tr.setSelection(NodeSelection.create(state.doc, ai)))
    expect(props().handleKeyDown({ state: selected }, { key: 'Backspace' })).toBe(false)
  })
})
