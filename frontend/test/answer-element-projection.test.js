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

import { describe, it, expect, beforeAll, vi } from 'vitest'
import MarkdownIt from 'markdown-it'
import { DOMParser as PMDOMParser } from '@tiptap/pm/model'
import { EditorState, NodeSelection, TextSelection } from '@tiptap/pm/state'
import { buildSieveSchema } from './helpers/sieve-pm-schema.js'
import { getBlockKind, registerBlockKind } from '../src/static/renderers/block-kinds.js'
import { AiBlockRenderer } from '../src/static/renderers/ai-block-renderer.js'
import { SieveBlock } from '../src/static/contract/sieve-block.js'
import { computeBlockSync, seedBaseline } from '../src/static/lens/document-editor/block-sync.js'

const VENDOR = /** @type {any} */ (globalThis).TipTap

/** The kinds the showcase answer spans, plus the block hosting it. */
const KINDS = ['ai-block', 'code', 'log', 'diagram', 'reference', 'web-clip', 'smart-image']

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
    MarkdownIt,
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

  // An element landed waiting on its kind's job carries its own status, so its
  // kind draws that state, and the answer projects again when the job's result
  // arrives in it. Every kind an answer can hold waiting has a row.
  it.each([
    ['log', { kind: 'log', attrs: { id: 'l-el', status: 'DISPATCHED', source: '10:00 ERROR pool exhausted' } }, 'sieve-log'],
    ['diagram', { kind: 'diagram', attrs: { id: 'd-el', status: 'PENDING', diagramType: 'plantuml', mode: 'render', source: 'A -> B' } }, 'sieve-diagram'],
    ['web-clip', { kind: 'web-clip', attrs: { id: 'w-el', status: 'PENDING', source: 'https://go.dev/blog/go1.22', mode: 'summarise' } }, 'sieve-web-clip'],
    ['smart-image', { kind: 'smart-image', attrs: { id: 'i-el', status: 'PENDING', src: 'sieve://0198c1a0-0001-7000-8000-000000000001/chart.png', width: '4', height: '3' } }, 'sieve-smart-image'],
  ])('a %s element still waiting on its job projects with its own status', (_kind, element, type) => {
    const waiting = new AiBlockRenderer(new SieveBlock('ai-block', { id: AI_ID, status: 'COMPLETE', answer: [element] })).bodyElements()
    const [node] = parseNodes(registry.elementsHTML(waiting))
    expect([node.type.name, node.attrs.status]).toEqual([type, element.attrs.status])
    const done = new AiBlockRenderer(new SieveBlock('ai-block', { id: AI_ID, status: 'COMPLETE',
      answer: [{ kind: element.kind, attrs: Object.assign({}, element.attrs, { status: 'COMPLETE' }) }] })).bodyElements()
    expect(parseNodes(registry.elementsHTML(done))[0].attrs.status).toBe('COMPLETE')
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

  it('an answer still being written projects its blocks so far and nothing after them', () => {
    const now = new Date().toISOString()
    const running = new AiBlockRenderer(
      new SieveBlock('ai-block', { id: AI_ID, status: 'DISPATCHED', createdAt: now, answer: SHOWCASE_ANSWER.slice(0, 2) }),
    ).bodyElements()
    const nodes = parseNodes(registry.elementsHTML(running))
    expect(nodes.map((n) => n.type.name)).toEqual(['paragraph', 'sieve-code'])
    expect(nodes.map((n) => n.textContent).join('')).not.toContain('thinking')
  })

  it('an answer nothing has landed in yet projects no blocks, and no status line either', () => {
    const r = new AiBlockRenderer(new SieveBlock('ai-block', { id: AI_ID, status: 'PENDING', createdAt: new Date().toISOString() }))
    expect(r.bodyElements()).toEqual([])
    expect(registry.elementsHTML(r.bodyElements())).toBe('')
  })

  it('a failure stays text: a job given up on, a failure', () => {
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    for (const attrs of [
      { status: 'DISPATCHED', createdAt: stale },
      { status: 'ERROR', error: 'the CLI timed out' },
    ]) {
      const r = new AiBlockRenderer(new SieveBlock('ai-block', { id: AI_ID, ...attrs }))
      // Null is what sends the seam down the MARKDOWN branch, to the failure's message.
      expect(r.bodyElements()).toBeNull()
    }
  })

  it('an answer cut short projects the blocks that landed', () => {
    const stale = new Date(Date.now() - 10 * 60 * 1000).toISOString()
    for (const attrs of [
      { status: 'DISPATCHED', createdAt: stale, answer: SHOWCASE_ANSWER.slice(0, 2) },
      { status: 'ERROR', error: 'the CLI timed out', answer: SHOWCASE_ANSWER.slice(0, 2) },
      { status: 'TIMEOUT', error: 'cli timeout after 60 seconds', answer: SHOWCASE_ANSWER.slice(0, 2) },
    ]) {
      const elements = new AiBlockRenderer(new SieveBlock('ai-block', { id: AI_ID, ...attrs })).bodyElements()
      expect(parseNodes(registry.elementsHTML(elements)).map((n) => n.type.name)).toEqual(['paragraph', 'sieve-code'])
    }
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

  it('a document block and an element alike are marked as a structured block, which the framework spaces', () => {
    const pane = twoPlaces()
    for (const id of ['top-level-block', 'nested-element']) {
      expect(nodeViewAt('sieve-probe', pane, posOf(pane.state.doc, (n) => n.attrs.id === id)).dom.classList.contains('sieve-node')).toBe(true)
    }
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

  // A right-click on what an element draws names that element: its own section
  // leads the menu, offering it as a copy of its own kind, and the host's menu
  // follows with its whole-exchange verbs still under their own heading. Every
  // kind an answer can hold has a row; a new kind joins by adding one. The views
  // are each kind's real NodeView, so "what it draws" is the kind's own DOM.
  describe('a right-click on an element', () => {
    /** What the backend offers: a raw image a smart image; a nested source its
     *  own kind as a copy; the whole exchange its Embed in Document alone, in place. */
    const detectExtractions = (/** @type {string} */ kind, /** @type {any[]} */ entries) => Promise.resolve(
      entries.some((e) => e.mimeType === 'text/uri-list') && kind === 'ai-block'
        ? [{ kind: 'smart-image', actions: ['extract'] }]
        : entries.some((e) => e.context && e.context.parentId)
          ? [{ kind, actions: ['extract'] }]
          : [{ kind: 'prose', actions: ['transform'] }])

    /** The element's own view: prose's is the markdown its serializer writes. */
    const ownView = (/** @type {any} */ node) => node.type.name.indexOf('sieve-') === 0
      ? sieveBlockAttrs(node)
      : { content: node.textContent }

    beforeAll(() => {
      if (!getBlockKind('prose')) {
        registerBlockKind({
          kind: 'prose', native: true,
          asContentEntry: (/** @type {any} */ node) => [{ mimeType: 'sieve/prose', content: JSON.stringify({ content: node.textContent }) }],
        })
      }
    })

    const IMAGE_SRC = 'sieve://0198c1a0-0001-7000-8000-000000000001/chart.png'
    const paragraph = (/** @type {string} */ text) => schema.nodes.paragraph.create(null, schema.text(text))
    const smartImage = () => schema.nodes['sieve-smart-image'].create({ kind: 'smart-image', id: 'i-el', src: IMAGE_SRC, status: 'COMPLETE' })
    const clipOf = (/** @type {any} */ body) => schema.nodes['sieve-web-clip'].create({ kind: 'web-clip', id: 'w-el', source: 'https://go.dev/blog/go1.22', status: 'COMPLETE' }, [body])

    /**
     * Right-clicks inside an ai-block whose answer holds `element`, drawn by its
     * kind's NodeView (a prose node as the <p> ProseMirror draws), on the target
     * `pick` chooses. A structured element hosting prose draws its first child as
     * a <p> in its contentDOM. Resolves the whole menu, appended sections included.
     * @param {any} element
     * @param {(parts: {host: HTMLElement, element: HTMLElement, inner: HTMLElement|null}) => Element} pick
     */
    async function rightClick(element, pick) {
      const doc = docOf([schema.nodes['sieve-ai-block'].create({ id: AI_ID, kind: 'ai-block', status: 'COMPLETE', answer: [] }, [element])])
      const pane = fakePane(EditorState.create({ schema, doc }))
      const extract = vi.fn()
      pane.sieveHost = { provider: { detectExtractions }, extract }
      const host = nodeViewAt('sieve-ai-block', pane, 0)
      pane.view.dom.appendChild(host.dom)
      const sieve = element.type.name.indexOf('sieve-') === 0
      const elementView = sieve ? nodeViewAt(element.type.name, pane, 1) : { dom: document.createElement('p'), contentDOM: null }
      ;(host.contentDOM || host.dom).appendChild(elementView.dom)
      /** @type {HTMLElement|null} */
      let inner = null
      if (sieve && element.childCount && element.firstChild.type.name === 'paragraph') {
        inner = document.createElement('p')
        ;(elementView.contentDOM || elementView.dom).appendChild(inner)
      }
      pane.view.nodeDOM = (/** @type {number} */ pos) => (pos === 1 ? elementView.dom : pos === 2 ? inner : null)
      await settle()
      const target = pick({ host: host.dom, element: elementView.dom, inner })

      /** @type {any[]} */
      let items = []
      const listen = (/** @type {any} */ e) => { items = e.detail.context.items }
      const menu = /** @type {any} */ (window)
      menu.SieveContextMenu = { appendItems: (/** @type {any[]} */ more) => { items = items.concat(more) } }
      document.addEventListener('sieve:contextmenu', listen)
      try {
        target.dispatchEvent(new window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
        await settle()
      } finally {
        document.removeEventListener('sieve:contextmenu', listen)
        delete menu.SieveContextMenu
      }
      const labels = items.map((it) => it.type === 'header' ? '# ' + it.label : (it.label || '—'))
      return { items, labels, extract }
    }

    /** The exchange's own menu: its items, then its whole-block section alone. */
    const EXCHANGE = ['# Ask AI', '—', 'Ask AI…', 'Explain', '—', 'Delete', '—', 'Replay', '—', '# FROM THE WHOLE ASK AI', 'Embed in Document']

    it.each([
      ['prose', 'TEXT', () => paragraph('Raise the pool ceiling first.'), (/** @type {any} */ p) => p.element],
      ['code', 'CODE', () => schema.nodes['sieve-code'].create({ kind: 'code', id: 'c-el', language: 'go' }, schema.text('x := 1')),
        (/** @type {any} */ p) => p.element.querySelector('code')],
      ['diagram', 'DIAGRAM', () => schema.nodes['sieve-diagram'].create({ kind: 'diagram', id: 'd-el', diagramType: 'mermaid', mode: 'render', status: 'COMPLETE' }, schema.text('graph TD\n  A --> B')),
        (/** @type {any} */ p) => p.element.querySelector('svg')],
      ['reference', 'REFERENCE', () => schema.nodes['sieve-reference'].create({ kind: 'reference', id: 'r-el', uri: 'sieve://0198c1a0-0001-7000-8000-000000000001' }),
        (/** @type {any} */ p) => p.element.querySelector('.reference-block__line')],
      ['log', 'LOG', () => schema.nodes['sieve-log'].create({ kind: 'log', id: 'l-el' }, schema.text('10:00 ERROR pool exhausted')),
        (/** @type {any} */ p) => p.element.querySelector('code')],
      // Pressed on a paragraph of the clip's own body: the clip is the element named.
      ['web-clip', 'WEB CLIP', () => clipOf(paragraph('Loop variables are per-iteration.')), (/** @type {any} */ p) => p.inner],
      ['smart-image', 'IMAGE', smartImage, (/** @type {any} */ p) => p.element.querySelector('img')],
    ])('on a %s element offers it as a copy above its host\'s menu', async (kind, label, make, pick) => {
      const element = make()
      const { items, labels, extract } = await rightClick(element, pick)
      expect(labels.slice(0, 3)).toEqual(['# FROM ' + label, 'Add to Document', '—'])
      expect(labels).toContain('Ask AI…')
      expect(labels.slice(labels.indexOf('# FROM THE WHOLE ASK AI'))).toEqual(['# FROM THE WHOLE ASK AI', 'Embed in Document'])

      items[1].action()
      expect(extract).toHaveBeenCalledTimes(1)
      const call = extract.mock.calls[0][0]
      expect(call).toMatchObject({ blockId: AI_ID, targetKind: kind, operation: 'extract' })
      const view = call.entries.find((/** @type {any} */ e) => e.mimeType === 'sieve/' + kind)
      expect(JSON.parse(view.content)).toEqual(ownView(element))
      expect(call.entries.every((/** @type {any} */ e) => e.context.parentId === AI_ID)).toBe(true)

      items.find((it) => it.label === 'Embed in Document').action()
      expect(extract.mock.calls[1][0]).toMatchObject({ blockId: AI_ID, targetKind: 'prose', operation: 'transform' })
    })

    // Where nothing an element draws was pressed, the exchange is what was named:
    // the row beside a narrow block, and the answer's own padding.
    it.each([
      ["beside a nested image, on its block's bare root", smartImage, (/** @type {any} */ p) => p.element],
      ["on the answer's padding", smartImage, (/** @type {any} */ p) => p.host],
    ])('%s gives the exchange\'s menu alone', async (_where, make, pick) => {
      const { labels } = await rightClick(make(), pick)
      expect(labels).toEqual(EXCHANGE)
    })

    // A raw image, link or fence is sub-content of its own only inside PROSE.
    it.each([
      ['a prose element', () => paragraph('see the chart'), (/** @type {any} */ p) => p.element],
      ['a nested web clip', () => clipOf(paragraph('see the chart')), (/** @type {any} */ p) => p.inner],
    ])('an image inside %s keeps its sub-content section', async (_where, make, pick) => {
      const { labels } = await rightClick(make(), (parts) => {
        const img = document.createElement('img')
        img.src = 'https://example.com/chart.png'
        return pick(parts).appendChild(img)
      })
      expect(labels).not.toContain('Add to Document')
      expect(labels).not.toContain('# FROM THE WHOLE ASK AI')
      expect(labels.slice(0, EXCHANGE.length - 2)).toEqual(EXCHANGE.slice(0, -2))
      expect(labels[EXCHANGE.length - 2]).toBe('# FROM IMAGE')
    })
  })

  it('an image element is drawn without its resize handles', () => {
    const img = schema.nodes['sieve-smart-image'].create({ kind: 'smart-image', id: 'i-el', src: 'sieve://0198c1a0-0001-7000-8000-000000000001/chart.png', status: 'COMPLETE' })
    const pane = fakePane(EditorState.create({ schema, doc: docOf([aiBlock([], [img])]) }))
    const view = nodeViewAt('sieve-smart-image', pane, posOf(pane.state.doc, (n) => n.type.name === 'sieve-smart-image'))
    expect(view.dom.querySelector('img')).toBeTruthy()
    expect(view.dom.querySelectorAll('.image-resizer').length).toBe(0)
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

// ── A block hosting blocks, nested in a block hosting blocks ─────────────────

describe('a web clip element draws its own body inside the answer', () => {
  const SOURCE = 'https://go.dev/blog/go1.22'
  const SUMMARY = '## Go 1.22\n\nLoop variables are per-iteration.'

  /** A web clip element of `attrs`. @param {Record<string, any>} attrs */
  const clip = (attrs) => ({ kind: 'web-clip', attrs: Object.assign({ id: 'w-el', source: SOURCE, mode: 'summarise' }, attrs) })

  /** A pane whose ai-block holds `el` projected, the clip's position, and its view
   *  built where ProseMirror builds it. @param {any} el */
  function clipIn(el) {
    const pane = fakePane(EditorState.create({ schema, doc: docOf([aiBlock([el], parseNodes(registry.elementsHTML([el])))]) }))
    const pos = posOf(pane.state.doc, (n) => n.type.name === 'sieve-web-clip')
    return { pane, pos, view: nodeViewAt('sieve-web-clip', pane, pos) }
  }

  /** @param {any} view @param {string} sel @returns {HTMLElement} */
  const part = (view, sel) => /** @type {HTMLElement} */ (view.dom.querySelector(sel))

  it('waiting on its job, it draws its own pending state', () => {
    const { view } = clipIn(clip({ status: 'PENDING', createdAt: new Date().toISOString() }))
    expect(part(view, '.web-clip-block__spinner').hidden).toBe(false)
    expect(part(view, '.web-clip-block__label').textContent).toBe('Summarising from ' + SOURCE + '…')
    expect(view.dom.querySelector('.web-clip-block__retry')).toBeNull()
  })

  it('its job result merged, it draws its title and its summary as its own body, read-only', async () => {
    const done = clip({ status: 'COMPLETE', title: 'Go 1.22 is released', content: SUMMARY })
    const { pane, pos, view } = clipIn(done)
    await settle()
    const body = pane.state.doc.nodeAt(pos)
    /** @type {string[]} */
    const hosted = []
    body.forEach((/** @type {any} */ n) => hosted.push(n.type.name))
    expect(hosted).toEqual(['heading', 'paragraph'])
    expect(body.textContent).toBe('Go 1.22Loop variables are per-iteration.')
    expect(() => pane.state.doc.check()).not.toThrow()
    expect(view.dom.textContent).toContain('Go 1.22 is released')
    expect(part(view, '.web-clip-block__source-link').textContent).toBe(SOURCE)
    expect(view.dom.hasAttribute('data-id')).toBe(false)
    expect(view.dom.querySelector('.block-chrome-host')).toBeNull()
  })

  it("the clip's body and the answer's projection settle: the host writes nothing back over it", async () => {
    const done = clip({ status: 'COMPLETE', title: 'Go 1.22 is released', content: SUMMARY })
    const pane = fakePane(EditorState.create({ schema, doc: docOf([aiBlock([done])]) }))
    const host = nodeViewAt('sieve-ai-block', pane, 0)
    await settle()
    nodeViewAt('sieve-web-clip', pane, posOf(pane.state.doc, (n) => n.type.name === 'sieve-web-clip'))
    await settle()
    const written = pane.dispatched.length
    expect(written).toBe(2)
    host.update(pane.state.doc.nodeAt(0))
    await settle()
    expect(pane.dispatched.length).toBe(written)
  })

  it('its job failed, it says so and offers no Retry: an element has no block to retry', () => {
    const { view } = clipIn(clip({ status: 'ERROR', error: 'the page did not load' }))
    expect(part(view, '.web-clip-block__label').textContent).toBe('the page did not load')
    expect(view.dom.querySelector('.web-clip-block__retry')).toBeNull()
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
