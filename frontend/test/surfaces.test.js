// surfaces.test.js — P2.B unit tests for the input-surface classes.
// Imports the REAL surface modules (dual-use ES modules). MarkdownSurface is
// exercised end-to-end (happy-dom textarea + fake timers). WysiwygSurface's
// applyServerOp is exercised as CALL-SHAPE tests against real ProseMirror docs
// (editor-fixture schema) with an injected fake TipTap bundle — these pin the
// undo-history-sacred semantics: tracked insertContentAt at the server's index,
// replace-by-id as a tracked range insert, and addToHistory:false ONLY on the
// token-swap and attrs-update paths. Full TipTap island mounting is exercised
// with a recording fake bundle (the extension list is config, not behavior).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { DOMParser as PMDOMParser, Schema } from '@tiptap/pm/model'

// P4.E: WysiwygSurface now imports its app helpers from their OWNING modules (the
// shared TipTap bus is retired). The three side-effect extension modules build
// `Extension.create(...)` at module-eval time, so importing WysiwygSurface would
// throw against the bare test/setup.js vendor bag; the `let`-exported registry
// symbols (getSieveNodes, serializeNode, …) are undefined until app registration.
// We mock those owner modules with vi.mock + per-test vi.mocked overrides. Pure
// helper modules (block-render, block-kinds, render-empty) stay REAL.
// getBlockSelectionRange's default mirrors the pre-P4.E "no block-range" fallback
// (the live PM selection) so the basic feedSelection tests read the same range
// they used to; richness tests override it.
//
// P4.F: the surfaces IMPORT `T` from editor/surfaces/tiptap-vendor.js (the shared
// globalThis.TipTap bag installed by test/setup.js) instead of taking a host.T
// seam. Tests seed the fake vendor members onto that bag (the established P4.E
// pattern — Object.assign(globalThis.TipTap, …), never reassign) and clear them
// after each test so a fake bundle never leaks forward.
vi.mock('../src/static/editor/extensions.js', () => ({
  Search: {}, SelectionHighlight: {}, HighlightMark: {},
  AiShortcuts: { configure: () => ({}) },
}))
vi.mock('../src/static/editor/block-chrome.js', () => ({
  BlockChrome: {},
  getBlockSelectionRange: vi.fn((view) => {
    const sel = view.state.selection
    return { from: sel.from, to: sel.to, active: !sel.empty, isBlockRange: false, isNodeSelection: !!sel.node }
  }),
}))
vi.mock('../src/static/ai/ai-target-decoration.js', () => ({ AiTargetDecoration: {} }))
vi.mock('../src/static/block/prose-block.js', () => ({ BlockId: {} }))
vi.mock('../src/static/block/prose-group.js', () => ({
  ProseGroup: {},
  proseBlockNodes: vi.fn((content) => { const out = []; content.forEach((n) => out.push(n)); return out }),
}))
// Only the two PM-bound entry points are stubbed; the pure half (DEFAULT_POLICY,
// textInputEdit, applyTextEdit, handleSubstitutionGuard — which the markdown
// surface uses for its pair/substitution rules) comes through REAL, so these
// tests exercise the shipped transforms rather than a fake of them.
vi.mock('../src/static/editor/interaction-policy.js', async (importOriginal) => ({
  ...(await importOriginal()),
  policyEnterKeydown: vi.fn(() => false),
  buildInteractionPolicyExtension: vi.fn(() => ({})),
}))
vi.mock('../src/static/block/sieve-block-extension.js', () => ({
  getSieveNodes: vi.fn(() => []),
  getSieveBlockLabel: vi.fn(() => null),
  serializeNode: vi.fn(() => 'ser'),
  sieveBlockAttrs: vi.fn((n) => n.attrs),
  sieveBlockEntries: vi.fn(() => []),
  rendererFor: vi.fn(() => null),
}))
vi.mock('../src/static/block/block-selection.js', () => ({
  BlockSelection: { blockRange: vi.fn(() => null), textInside: vi.fn(() => null) },
}))
vi.mock('../src/static/block/block-sync.js', () => ({
  seedBaseline: vi.fn((triples) => { const m = {}; triples.forEach((t) => { if (t.id) m[t.id] = t.content }); return m }),
  computeBlockSync: vi.fn(() => ({ next: {}, ops: [] })),
  computeOrderOp: vi.fn(() => ({ op: null, next: null })),
}))
vi.mock('../src/static/editor/surfaces/block-position.js', () => ({
  docPosForBlockIndex: vi.fn(() => 7),
  blockIndexAfter: vi.fn(() => -1),
}))
vi.mock('../src/static/editor/paste-context.js', () => ({
  caretInRawTextBlock: vi.fn(() => false),
}))

import { AbstractSurface, SurfaceEvent } from '../src/static/editor/surfaces/abstract-surface.js'
import { MarkdownSurface } from '../src/static/editor/surfaces/markdown-surface.js'
import { WysiwygSurface, MAX_ATTACHMENT_BYTES } from '../src/static/editor/surfaces/wysiwyg-surface.js'
import { buildBlocksHTML } from '../src/static/block/block-render.js'
import { SieveBlock } from '../src/static/block/sieve-block.js'
import { getBlockSelectionRange } from '../src/static/editor/block-chrome.js'
import { BlockSelection } from '../src/static/block/block-selection.js'
import { computeBlockSync, computeOrderOp } from '../src/static/block/block-sync.js'
import { docPosForBlockIndex, blockIndexAfter } from '../src/static/editor/surfaces/block-position.js'
import { caretInRawTextBlock } from '../src/static/editor/paste-context.js'
import { schema as fxSchema, build, docWithCaret, docWithCaretAt, docWithRange, docWithNodeSelection } from './helpers/editor-fixture.js'

// window.isMod is an index.html global in the app; provide it for keydown tests.
beforeEach(() => { window.isMod = (e) => !!(e.ctrlKey || e.metaKey) })
afterEach(() => { vi.useRealTimers() })

// The shared vendor bag (installed by test/setup.js; editor/surfaces/tiptap-vendor.js's `T`
// is the same object). Seed fake vendor members onto it; clear them after each
// test so a fake TipTap bundle from one test never leaks into the next.
const VENDOR = /** @type {any} */ (globalThis).TipTap
function seedVendor(members) { Object.assign(VENDOR, members) }
afterEach(() => { for (const k of Object.keys(VENDOR)) delete VENDOR[k] })

// The app-helper module mocks are shared across tests: clear call history AND
// re-establish default implementations before each test, so a per-test
// vi.mocked(...).mockReturnValue override (feedSelection richness / caret-in-raw)
// never leaks forward and `toHaveBeenCalledTimes` counts only this test's calls.
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(getBlockSelectionRange).mockImplementation((view) => {
    const sel = view.state.selection
    return { from: sel.from, to: sel.to, active: !sel.empty, isBlockRange: false, isNodeSelection: !!sel.node }
  })
  vi.mocked(BlockSelection.blockRange).mockReturnValue(null)
  vi.mocked(docPosForBlockIndex).mockReturnValue(7)
  vi.mocked(blockIndexAfter).mockReturnValue(-1)
  vi.mocked(computeBlockSync).mockReturnValue({ next: {}, ops: [] })
  vi.mocked(caretInRawTextBlock).mockReturnValue(false)
})

// ── MarkdownSurface ───────────────────────────────────────────────────────────

// A fake host (the parent editor): the markdown surface calls its public API
// directly (P4.F) — onSurfaceEvent / setRawContent / takeInsertPos / softReload.
function mdHost(overrides = {}) {
  return Object.assign({
    setRawContent: vi.fn(),
    softReload: vi.fn(),
    takeInsertPos: vi.fn(() => null),
    onSurfaceEvent: vi.fn(),
  }, overrides)
}

function mountMd(content = 'seed body', host = mdHost()) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const s = new MarkdownSurface(host)
  s.mount(root, content)
  return { s, root, host, textarea: root.querySelector('textarea.markdown-editor') }
}

function typeInto(textarea, value) {
  textarea.value = value
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('MarkdownSurface (P2.B)', () => {
  it('is an AbstractSurface with mode markdown and null editorPane', () => {
    const s = new MarkdownSurface(mdHost())
    expect(s).toBeInstanceOf(AbstractSurface)
    expect(s.mode).toBe('markdown')
    expect(s.editorPane).toBeNull()
  })

  it('mount builds gutter + textarea under the root and seeds body', () => {
    const { s, root, textarea } = mountMd('hello world')
    expect(root.querySelector('.markdown-gutter')).toBeTruthy()
    expect(textarea).toBeTruthy()
    expect(textarea.value).toBe('hello world')
    expect(s.body).toBe('hello world')
  })

  it('stats() derives chars/lines/blockCount from its OWN body (surface owns the read, P4.D)', () => {
    const { s } = mountMd('line one\nline two\nline three')
    expect(s.stats()).toEqual({ chars: 28, lines: 3, blockCount: 3 })
    const { s: empty } = mountMd('')
    expect(empty.stats()).toEqual({ chars: 0, lines: 0, blockCount: 0 })
  })

  it('input debounces 500ms then submits ONE domain setRawContent; body updates immediately', () => {
    vi.useFakeTimers()
    const { s, host, textarea } = mountMd('a')
    typeInto(textarea, 'ab')
    expect(s.body).toBe('ab')            // body tracks the keystroke
    expect(host.setRawContent).not.toHaveBeenCalled()
    vi.advanceTimersByTime(499)
    expect(host.setRawContent).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(host.setRawContent).toHaveBeenCalledTimes(1)
    // Domain-shaped: the raw markdown only — NO wire envelope, NO uuid.
    expect(host.setRawContent).toHaveBeenCalledWith('ab')
  })

  it('input notifies the producer-named doc-changed event (no consumer knowledge)', () => {
    const { host, textarea } = mountMd('a')
    typeInto(textarea, 'ab')
    expect(host.onSurfaceEvent).toHaveBeenCalledWith(SurfaceEvent.DOC_CHANGED)
    expect(Object.isFrozen(SurfaceEvent.DOC_CHANGED)).toBe(true)
  })

  it('flushPending cancels the timer and submits immediately; idle flush is a no-op', () => {
    vi.useFakeTimers()
    const { s, host, textarea } = mountMd('a')
    s.flushPending()                      // idle → nothing
    expect(host.setRawContent).not.toHaveBeenCalled()
    typeInto(textarea, 'abc')
    s.flushPending()                      // pending → immediate submit
    expect(host.setRawContent).toHaveBeenCalledTimes(1)
    expect(host.setRawContent).toHaveBeenCalledWith('abc')
    vi.advanceTimersByTime(1000)          // timer cancelled → no double-submit
    expect(host.setRawContent).toHaveBeenCalledTimes(1)
  })

  it('applyServerOp(insert-block) appends the markdown, clears insert pos, submits the buffer', () => {
    const { s, host, textarea } = mountMd('hello')
    s.applyServerOp({ type: 'insert-block', markdown: '```js\ncode\n```' })
    expect(host.takeInsertPos).toHaveBeenCalledTimes(1)
    expect(s.body).toBe('hello\n\n```js\ncode\n```\n')
    expect(textarea.value).toBe(s.body)
    expect(host.setRawContent).toHaveBeenCalledWith(s.body)
  })

  it('applyServerOp(replace-block) requests a reload; block-attrs-updated is a no-op', () => {
    const { s, host } = mountMd('x')
    s.applyServerOp({ type: 'replace-block', oldId: 'a', newId: 'b' })
    expect(host.softReload).toHaveBeenCalledTimes(1)
    s.applyServerOp({ type: 'block-attrs-updated', id: 'a', attrs: { status: 'done' } })
    expect(host.setRawContent).not.toHaveBeenCalled()
    expect(host.softReload).toHaveBeenCalledTimes(1) // unchanged
  })

  it('unmount removes the DOM and kills a pending debounce', () => {
    vi.useFakeTimers()
    const { s, root, host, textarea } = mountMd('a')
    typeInto(textarea, 'ab')
    s.unmount()
    expect(root.children.length).toBe(0)
    vi.advanceTimersByTime(1000)
    expect(host.setRawContent).not.toHaveBeenCalled()
  })

  it('handles NO app-level chords: Mod+S / Mod+J bubble out untouched', () => {
    // Chord transport is the transitional document-level listener in editor.js
    // (P2.C owns the proper migration) — the surface must not consume the keys.
    const { textarea } = mountMd('a')
    const modS = new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true })
    textarea.dispatchEvent(modS)
    expect(modS.defaultPrevented).toBe(false)
    const modJ = new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, bubbles: true, cancelable: true })
    textarea.dispatchEvent(modJ)
    expect(modJ.defaultPrevented).toBe(false)
  })

  it('replaceBody swaps the buffer + textarea (softReload path)', () => {
    const { s, textarea } = mountMd('old')
    s.replaceBody('fresh from disk')
    expect(s.body).toBe('fresh from disk')
    expect(textarea.value).toBe('fresh from disk')
  })

  it('feedSelection reports a none descriptor (opaque buffer, no block model) — the document target', () => {
    const s = new MarkdownSurface(mdHost())
    expect(s.feedSelection()).toEqual({
      selectionType: 'none', caret: null, range: null, selectedText: null,
      blockId: null, blockIds: [], blockKind: null, ref: null, blockCursor: null,
      // P3.C: markdown mode with no textarea selection → the document target.
      target: { kind: 'document', ref: 'doc', range: null, label: 'Document' },
    })
  })
})

// ── WysiwygSurface: applyServerOp call-shape (undo-history sacred) ─────────────

// A schema with a token attr on paragraphs (the pending-prose flight path).
const tokSchema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block', content: 'inline*',
      attrs: { id: { default: '' }, token: { default: '' } },
      toDOM: (nd) => ['p', { 'data-id': nd.attrs.id }, 0], parseDOM: [{ tag: 'p' }],
    },
    text: { group: 'inline' },
  },
})

// A fake host (the parent editor): the wysiwyg surface calls its public API
// directly (P4.F) — onSurfaceEvent / flushSave / takeInsertPos and
// the insert-index math (insertIndexForBlock = commitInsertIndex(captureInsertPos()),
// insertIndexForBlockAt(pos) = commitInsertIndex(pos), plus clearInsertPos) —
// and reaches the SERVICE PAIR through documentService/blockService (issue #49
// Phase 1: the observer's op batch decomposes into service verbs). `uuid`
// is read by the surface constructor. TestWysiwygSurface overrides uuid per call.
function wyHost(overrides = {}) {
  return Object.assign({
    // pasteSlice / smartPaste front the paste pipelines (issue #49 Phase 4 — the
    // stray HTTP fetches now leave through DocumentService, not bare fetch()).
    documentService: {
      createBlock: vi.fn(),
      deleteBlock: vi.fn(),
      setBlockOrder: vi.fn(),
      pasteSlice: vi.fn(() => Promise.resolve({})),
      smartPaste: vi.fn(() => Promise.resolve({ outcome: 'none' })),
    },
    blockService: { updateAttributes: vi.fn() },
    flushSave: vi.fn(),
    insertIndexForBlock: vi.fn(() => 0),
    insertIndexForBlockAt: vi.fn(() => 0),
    // issue #33: the paste/drop path PEEKS (side-effect-free) and consumes the empty-
    // paragraph anchor only on a confirmed match. Defaults: no anchor to consume.
    peekInsertIndexForBlock: vi.fn(() => ({ index: 0, anchor: null })),
    peekInsertIndexAt: vi.fn(() => ({ index: 0, anchor: null })),
    consumeInsertAnchor: vi.fn(),
    clearInsertPos: vi.fn(),
    takeInsertPos: vi.fn(() => null),
    onSurfaceEvent: vi.fn(),
    uuid: 'doc-1',
  }, overrides)
}

// A recorded fake editor over a REAL ProseMirror EditorState, so doc scans,
// setNodeMarkup, and addToHistory metas are the real thing while commands are
// recorded call-shapes.
function fakeEditorOver(schema, docNodes) {
  const doc = schema.nodes.doc.create(null, docNodes)
  const state = EditorState.create({ schema, doc })
  const dom = document.createElement('div')
  const calls = []
  const dispatched = []
  return {
    calls,
    dispatched,
    state,
    schema,
    storage: { markdown: { parser: { md: { render: (t) => '<p>' + t + '</p>' } } } },
    view: { dom, dispatch: (tr) => { dispatched.push(tr); calls.push(['dispatch']) } },
    commands: {
      insertContentAt: (pos, content) => { calls.push(['insertContentAt', pos, content]); return true },
      focus: () => { calls.push(['focus']); return true },
      setTextSelection: (pos) => { calls.push(['setTextSelection', pos]); return true },
      command: (fn) => { const tr = state.tr; fn({ tr, state }); dispatched.push(tr); return true },
    },
    chain: () => {
      const c = { focus: () => c, setTextSelection: () => c, run: () => {} }
      return c
    },
  }
}

// A surface whose live editor is injected (the mount path builds the real island
// in-app; these tests pin the applyServerOp contract on the instance). The uuid is
// merged into the host (the surface reads host.uuid, P4.F) so the ('doc-1', host,
// ed) call shape is preserved.
class TestWysiwygSurface extends WysiwygSurface {
  constructor(uuid, host, editor) { super(Object.assign(host, { uuid })); this._ed = editor }
  get editorPane() { return this._ed }
}

describe('WysiwygSurface.applyServerOp (P2.B call-shape, undo-sacred)', () => {
  // P4.F: the render pipeline (#blockToNodes) reads ProseMirrorDOMParser off the
  // imported `T` (the shared vendor bag) — seed it (the retired callShapeT bundle,
  // now the ONE vendor member the applyServerOp path needs).
  beforeEach(() => {
    vi.useFakeTimers() // deferred focus/scroll callbacks never run
    seedVendor({ ProseMirrorDOMParser: PMDOMParser })
  })

  it('insert-block at msg.index → TRACKED insertContentAt(docPosForBlockIndex(index))', () => {
    const ed = fakeEditorOver(fxSchema, [build.p('one', 'b1')])
    const s = new TestWysiwygSurface('doc-1', wyHost(), ed)
    s.applyServerOp({ type: 'insert-block', kind: 'prose', id: 'srv-1', attrs: { id: 'srv-1', content: 'Hello' }, index: 1 })
    expect(docPosForBlockIndex).toHaveBeenCalledWith(ed.state.doc, 1)
    const ins = ed.calls.find((c) => c[0] === 'insertContentAt')
    expect(ins).toBeTruthy()
    expect(ins[1]).toBe(7)                    // the server's index, mapped — never a JS-chosen pos
    expect(ins[2].length).toBeGreaterThan(0)  // the server's node content
    expect(ed.dispatched.length).toBe(0)      // NO raw transaction — tracked command only
  })

  it('insert-block falls back to the captured numeric insert pos when no index', () => {
    const ed = fakeEditorOver(fxSchema, [build.p('one', 'b1')])
    const host = wyHost({ takeInsertPos: vi.fn(() => 3) })
    const s = new TestWysiwygSurface('doc-1', host, ed)
    s.applyServerOp({ type: 'insert-block', kind: 'prose', id: 'srv-2', attrs: { id: 'srv-2', content: 'Hi' } })
    expect(host.takeInsertPos).toHaveBeenCalledTimes(1)
    const ins = ed.calls.find((c) => c[0] === 'insertContentAt')
    expect(ins[1]).toBe(3)
  })

  it('insert-block skip-if-present: an echoed id already in the DOM never re-inserts', () => {
    const ed = fakeEditorOver(fxSchema, [build.p('one', 'srv-3')])
    ed.view.dom.innerHTML = '<p data-id="srv-3">one</p>'
    const s = new TestWysiwygSurface('doc-1', wyHost(), ed)
    s.applyServerOp({ type: 'insert-block', kind: 'prose', id: 'srv-3', attrs: { id: 'srv-3', content: 'one' }, index: 0 })
    expect(ed.calls.find((c) => c[0] === 'insertContentAt')).toBeUndefined()
  })

  it('insert-block token swap: setNodeMarkup with addToHistory:false, no insert', () => {
    const p = tokSchema.nodes.paragraph.create({ id: '', token: 'tok-1' }, tokSchema.text('typed'))
    const ed = fakeEditorOver(tokSchema, [p])
    const s = new TestWysiwygSurface('doc-1', wyHost(), ed)
    s.applyServerOp({ type: 'insert-block', kind: 'prose', token: 'tok-1', id: 'real-1' })
    expect(ed.dispatched.length).toBe(1)
    const tr = ed.dispatched[0]
    expect(tr.getMeta('addToHistory')).toBe(false)     // never a re-insert, never undoable
    const node = tr.doc.child(0)
    expect(node.attrs.id).toBe('real-1')
    expect(node.attrs.token).toBe('')
    expect(ed.calls.find((c) => c[0] === 'insertContentAt')).toBeUndefined()
  })

  it('insert-block token orphan (node deleted in flight): deletes by authoritative id', () => {
    const ed = fakeEditorOver(tokSchema, [tokSchema.nodes.paragraph.create({ id: 'x', token: '' }, tokSchema.text('t'))])
    const host = wyHost()
    const s = new TestWysiwygSurface('doc-1', host, ed)
    s.applyServerOp({ type: 'insert-block', kind: 'prose', token: 'tok-gone', id: 'real-2' })
    // Domain-shaped: the delete verb only — the WS envelope is the service's.
    expect(host.documentService.deleteBlock).toHaveBeenCalledWith('doc-1', 'real-2')
    expect(ed.dispatched.length).toBe(0)
    expect(ed.calls.find((c) => c[0] === 'insertContentAt')).toBeUndefined()
  })

  it('replace-block: TRACKED insertContentAt over the oldId range (undoable transform)', () => {
    const first = build.p('first', 'old-1')
    const ed = fakeEditorOver(fxSchema, [first, build.p('second', 'keep-1')])
    const s = new TestWysiwygSurface('doc-1', wyHost(), ed)
    s.applyServerOp({ type: 'replace-block', oldId: 'old-1', newId: 'new-1', newKind: 'prose', attrs: { content: 'Replaced' } })
    const ins = ed.calls.find((c) => c[0] === 'insertContentAt')
    expect(ins).toBeTruthy()
    expect(ins[1]).toEqual({ from: 0, to: first.nodeSize }) // replace-by-id range
    expect(ed.dispatched.length).toBe(0)                    // tracked command, no raw tr
  })

  it('replace-block with unknown oldId does nothing', () => {
    const ed = fakeEditorOver(fxSchema, [build.p('first', 'a')])
    const s = new TestWysiwygSurface('doc-1', wyHost(), ed)
    s.applyServerOp({ type: 'replace-block', oldId: 'nope', newId: 'new', newKind: 'prose', attrs: {} })
    expect(ed.calls.find((c) => c[0] === 'insertContentAt')).toBeUndefined()
  })

  it('block-attrs-updated: setNodeMarkup by id with addToHistory:false', () => {
    const ed = fakeEditorOver(fxSchema, [build.sieveCode('blk-1'), build.p('txt', 'p1')])
    const s = new TestWysiwygSurface('doc-1', wyHost(), ed)
    s.applyServerOp({ type: 'block-attrs-updated', id: 'blk-1', attrs: { ref: 'r-9' } })
    expect(ed.dispatched.length).toBe(1)
    const tr = ed.dispatched[0]
    expect(tr.getMeta('addToHistory')).toBe(false)
    expect(tr.doc.child(0).attrs.ref).toBe('r-9')
  })

  it('applyServerOp without a live editor is a safe no-op', () => {
    const s = new TestWysiwygSurface('doc-1', wyHost(), null)
    expect(() => s.applyServerOp({ type: 'insert-block', id: 'x', index: 0 })).not.toThrow()
  })
})

// ── WysiwygSurface: mount / debounce / flushPending with a recording bundle ──

function mountBundle(state) {
  // `extend` returns the same stub so an extended-then-configured extension
  // (Image, whose src attribute is re-rendered) reads like every other one here.
  const ext = { configure: () => ({}), extend: () => ext, name: 'ext' }
  let lastEditor = null
  const T = {
    Node: { create: (cfg) => cfg },
    Extension: { create: (cfg) => cfg },
    Plugin: function (cfg) { this.cfg = cfg },
    DecorationSet: { empty: [], create: () => [] },
    Decoration: { node: () => ({}) },
    StarterKit: ext, Placeholder: ext, Table: ext, Image: ext, Markdown: ext,
    AiShortcuts: ext, TaskItem: ext,
    TableRow: {}, TableHeader: {}, TableCell: {}, Search: {}, TaskList: {},
    BlockChrome: {}, AiTargetDecoration: {},
    HighlightMark: {}, SelectionHighlight: {}, BlockId: {},
    buildInteractionPolicyExtension: () => ({}),
    getSieveNodes: () => [],
    serializeNode: () => 'ser',
    sieveBlockAttrs: (n) => n.attrs,
    seedBaseline: (triples) => { const m = {}; triples.forEach((t) => { if (t.id) m[t.id] = t.content }); return m },
    computeBlockSync: vi.fn(() => ({ next: {}, ops: [{ type: 'update-block', blockId: 'b1' }] })),
    Editor: function (opts) {
      lastEditor = this
      this.options = opts
      this.state = state
      this.schema = state.schema
      this.view = { dom: document.createElement('div'), dispatch: vi.fn() }
      this.storage = { markdown: { parser: { md: { render: (t) => t } } } }
      this.commands = { insertContentAt: vi.fn(), insertContent: vi.fn(), focus: vi.fn(), scrollIntoView: vi.fn() }
      this.destroyed = false
      this.destroy = () => { this.destroyed = true }
      if (opts.onCreate) opts.onCreate()
    },
  }
  return { T, editor: () => lastEditor }
}

describe('WysiwygSurface mount lifecycle (P2.B, recording bundle)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    // These mounts hold a single block b1; the debounced sync emits its update-block
    // op (the recording bundle's old computeBlockSync default, now the mocked import).
    vi.mocked(computeBlockSync).mockReturnValue({ next: {}, ops: [{ type: 'update-block', blockId: 'b1' }] })
    // Order is quiet unless a test says otherwise — reset so one test's reorder
    // cannot leak a set-order into the next.
    vi.mocked(computeOrderOp).mockReturnValue({ op: null, next: null })
  })

  function mountWy() {
    const doc = fxSchema.nodes.doc.create(null, [build.p('one', 'b1')])
    const state = EditorState.create({ schema: fxSchema, doc })
    const { T, editor } = mountBundle(state)
    seedVendor(T) // the surface imports T from the vendor bag (P4.F) — seed the fake bundle
    const host = wyHost()
    const s = new WysiwygSurface(host)
    const root = document.createElement('div')
    document.body.appendChild(root)
    s.mount(root, { body: '', blocks: [] })
    return { s, root, host, T, ed: editor() }
  }

  it('mount constructs the island on the root and exposes editorPane + window.__tiptap', () => {
    const { s, root, ed } = mountWy()
    expect(ed).toBeTruthy()
    expect(ed.options.element).toBe(root)
    expect(s.editorPane).toBe(ed)
    expect(window.__tiptap).toBe(ed)
    expect(s.mode).toBe('wysiwyg')
  })

  // #67, 2026-07-27: link activation (Mod+Click → BrowserOpenURL) is APP-GLOBAL —
  // a document-level CAPTURE listener in shell/workspace.js bootEditorLifecycle().
  // Capture on `document` runs before anything on view.dom AND calls
  // stopPropagation(), so a PM-level click handler here can never see a Mod+Click.
  // One existed and was measured at 0 invocations in the running app; this pins the
  // deletion so it is not "helpfully" restored (docs/editor-interaction-contract.md).
  it('declares NO editorProps click handler — link activation is owned app-globally', () => {
    const { ed } = mountWy()
    expect(ed.options.editorProps.handleDOMEvents.click).toBeUndefined()
  })

  it('mount stamps the parent Editor onto the pane as sieveHost (the NodeView→Editor handle)', () => {
    // P4.F Brief C: a block capability (ctx.getEditor) reaches the Editor through
    // editorPane.sieveHost — the pane the surface built, stamped with its host.
    const { host, ed } = mountWy()
    expect(ed.sieveHost).toBe(host)
  })

  it('onUpdate debounces 500ms then submits granular block-domain ops through the service pair', () => {
    vi.mocked(computeBlockSync).mockReturnValue({ next: {}, ops: [{ type: 'update-block', blockId: 'b1', kind: 'prose', attrs: { content: 'x' } }] })
    const { host, ed } = mountWy()
    ed.options.onUpdate({ editor: ed })
    expect(host.blockService.updateAttributes).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)
    expect(computeBlockSync).toHaveBeenCalledTimes(1)
    // update-block decomposes to BlockService.updateAttributes (aliases lifted).
    expect(host.blockService.updateAttributes).toHaveBeenCalledWith('b1', { content: 'x' }, { aliases: undefined })
  })

  it('#submitOps maps the observer batch IN ORDER: create → explicit-index createBlock, update → updateAttributes, delete → deleteBlock', () => {
    const order = []
    const host = wyHost({
      documentService: {
        createBlock: vi.fn((...a) => order.push(['create', ...a])),
        deleteBlock: vi.fn((...a) => order.push(['delete', ...a])),
      },
      blockService: { updateAttributes: vi.fn((...a) => order.push(['update', ...a])) },
    })
    vi.mocked(computeBlockSync).mockReturnValue({ next: {}, ops: [
      { type: 'create-block', blockId: '', kind: 'prose', attrs: { content: 'new' }, index: 2, token: 'tok-9', aliases: ['old-1'] },
      { type: 'update-block', blockId: 'b1', kind: 'prose', attrs: { content: 'x' }, aliases: ['b0'] },
      { type: 'delete-block', blockId: 'b2' },
    ] })
    const doc = fxSchema.nodes.doc.create(null, [build.p('one', 'b1')])
    const state = EditorState.create({ schema: fxSchema, doc })
    const bundle = mountBundle(state)
    seedVendor(bundle.T)
    const s = new WysiwygSurface(Object.assign(host, { uuid: 'doc-1' }))
    const root = document.createElement('div')
    document.body.appendChild(root)
    s.mount(root, { body: '', blocks: [] })
    const ed = bundle.editor()
    ed.options.onUpdate({ editor: ed })
    vi.advanceTimersByTime(500)
    // Emission order preserved exactly; the create rides the EXPLICIT-INDEX
    // path (opts.index bypasses resolveInsertIndex) with token/aliases/blockId.
    expect(order).toEqual([
      ['create', 'doc-1', 'prose', { content: 'new' }, undefined, { index: 2, token: 'tok-9', aliases: ['old-1'], blockId: '' }],
      ['update', 'b1', { content: 'x' }, { aliases: ['b0'] }],
      ['delete', 'doc-1', 'b2'],
    ])
  })

  it('onUpdate notifies doc-changed; selection/transaction/focus emit their events', () => {
    const { host, ed } = mountWy()
    ed.options.onUpdate({ editor: ed })
    expect(host.onSurfaceEvent).toHaveBeenCalledWith(SurfaceEvent.DOC_CHANGED)
    ed.options.onSelectionUpdate({ editor: ed })
    expect(host.onSurfaceEvent).toHaveBeenCalledWith(SurfaceEvent.SELECTION_CHANGED)
    ed.options.onTransaction({ editor: ed })
    expect(host.onSurfaceEvent).toHaveBeenCalledWith(SurfaceEvent.TRANSACTION)
    ed.view.dom.dispatchEvent(new Event('focusin'))
    expect(host.onSurfaceEvent).toHaveBeenCalledWith(SurfaceEvent.FOCUS_CHANGED)
  })

  it('a body-projection transaction reports doc-projected, never doc-changed (#90)', () => {
    // The NodeView body projection (sieve-block-extension syncMdInto) dispatches a
    // DEFERRED transaction that materialises the server's own body markdown into
    // contentDOM — after the mount's suppression window has closed. It changes the
    // doc, so PM reports it, but nothing the USER authored changed: reporting it as
    // doc-changed made every freshly opened document show the dirty dot before a
    // keystroke. It is still a content change, so stats must still see it.
    const { host, ed } = mountWy()
    const projection = { getMeta: (k) => (k === 'sieve-md-sync' ? true : undefined) }
    ed.options.onUpdate({ editor: ed, transaction: projection })
    expect(host.onSurfaceEvent).toHaveBeenCalledWith(SurfaceEvent.DOC_PROJECTED)
    expect(host.onSurfaceEvent).not.toHaveBeenCalledWith(SurfaceEvent.DOC_CHANGED)
  })

  it('a user transaction still reports doc-changed even though both carry a transaction', () => {
    const { host, ed } = mountWy()
    const userTr = { getMeta: () => undefined }
    ed.options.onUpdate({ editor: ed, transaction: userTr })
    expect(host.onSurfaceEvent).toHaveBeenCalledWith(SurfaceEvent.DOC_CHANGED)
    expect(host.onSurfaceEvent).not.toHaveBeenCalledWith(SurfaceEvent.DOC_PROJECTED)
  })

  it('a reorder submits ONE set-order op through DocumentService, after the batch (#94)', () => {
    // The observer's signature is positionless, so order is reported separately —
    // and LAST, because set-order installs a COMPLETE order and must land after
    // this tick's creates and deletes have moved the server's set.
    vi.mocked(computeBlockSync).mockReturnValue({ next: {}, ops: [{ type: 'delete-block', blockId: 'gone' }] })
    vi.mocked(computeOrderOp).mockReturnValue({ op: { type: 'set-order', order: ['b1', 'b2'] }, next: ['b1', 'b2'] })
    const { host, ed } = mountWy()
    ed.options.onUpdate({ editor: ed })
    vi.advanceTimersByTime(500)
    expect(host.documentService.setBlockOrder).toHaveBeenCalledWith('doc-1', ['b1', 'b2'])
    expect(host.documentService.deleteBlock.mock.invocationCallOrder[0])
      .toBeLessThan(host.documentService.setBlockOrder.mock.invocationCallOrder[0])
  })

  it('sends nothing when neither content nor order moved', () => {
    vi.mocked(computeBlockSync).mockReturnValue({ next: {}, ops: [] })
    vi.mocked(computeOrderOp).mockReturnValue({ op: null, next: ['b1'] })
    const { host, ed } = mountWy()
    ed.options.onUpdate({ editor: ed })
    vi.advanceTimersByTime(500)
    expect(host.documentService.setBlockOrder).not.toHaveBeenCalled()
    expect(host.blockService.updateAttributes).not.toHaveBeenCalled()
  })

  it('flushPending fires the pending sync immediately, exactly once', () => {
    vi.mocked(computeBlockSync).mockReturnValue({ next: {}, ops: [{ type: 'update-block', blockId: 'b1', kind: 'prose', attrs: { content: 'x' } }] })
    const { s, host, ed } = mountWy()
    ed.options.onUpdate({ editor: ed })
    s.flushPending()
    expect(host.blockService.updateAttributes).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(host.blockService.updateAttributes).toHaveBeenCalledTimes(1) // timer cancelled — no double sync
    s.flushPending()                                      // idle → no-op
    expect(host.blockService.updateAttributes).toHaveBeenCalledTimes(1)
  })

  it('unmount destroys the island, clears the root and window.__tiptap, kills the timer', () => {
    const { s, root, host, ed } = mountWy()
    ed.options.onUpdate({ editor: ed })
    s.unmount()
    expect(ed.destroyed).toBe(true)
    expect(root.innerHTML).toBe('')
    expect(window.__tiptap).toBeNull()
    expect(s.editorPane).toBeNull()
    vi.advanceTimersByTime(1000)
    expect(host.blockService.updateAttributes).not.toHaveBeenCalled()
  })
})

// ── WysiwygSurface: #handleSmartPaste / #handleSmartDrop (P4.A) ────────────────
// The smart-paste / smart-drop pipelines moved off editor.js's IIFE into the
// surface as #private methods, wired at editorProps.handlePaste / handleDrop.
// They call the editor-sourced insert-index host (insertIndexForBlock /
// insertIndexForBlockAt / clearInsertPos) rather than the retired IIFE closures.
// Undo-sacred: the ai-block reimport insertContent stays a TRACKED command.

describe('WysiwygSurface #handleSmartPaste / #handleSmartDrop (P4.A)', () => {
  let prevJsyaml
  beforeEach(() => {
    prevJsyaml = window.jsyaml
    window.jsyaml = { load: (s) => JSON.parse(s) }
    // The moved code now reads the caretInRawTextBlock ES import (paste-context.js,
    // mocked above). Default false (a normal prose caret); tests override per-case.
    vi.mocked(caretInRawTextBlock).mockReturnValue(false)
  })
  afterEach(() => {
    window.jsyaml = prevJsyaml
  })

  // The surface no longer speaks fetch — the paste pipelines leave through
  // DocumentService.smartPaste / pasteSlice (issue #49 Phase 4). Tests stub those
  // verbs on the host's documentService (wyHost defaults; override per-case).

  // Mount a real WysiwygSurface via the recording bundle; expose the editorProps
  // handlers (the wiring the editor gives ProseMirror) + the fake editor + host.
  function mountPaste(host = wyHost(), uuid = 'doc-1', opts = {}) {
    if (opts.caretInRawTextBlock) vi.mocked(caretInRawTextBlock).mockImplementation(opts.caretInRawTextBlock)
    const doc = fxSchema.nodes.doc.create(null, [build.p('one', 'b1')])
    const state = EditorState.create({ schema: fxSchema, doc })
    const bundle = mountBundle(state)
    seedVendor(bundle.T) // the surface imports T from the vendor bag (P4.F)
    const s = new WysiwygSurface(Object.assign(host, { uuid }))
    const root = document.createElement('div')
    document.body.appendChild(root)
    s.mount(root, { body: '', blocks: [] })
    const ed = bundle.editor()
    return { s, ed, host, props: ed.options.editorProps, uuid }
  }

  function clip({ text = '', html = '', slice = '', items = [] } = {}) {
    return {
      getData: (mime) => ({ 'text/plain': text, 'text/html': html, 'sieve/slice': slice }[mime] || ''),
      items,
      files: [],
    }
  }

  it('editorProps.handlePaste is wired to the surface pipeline (not a retired onPaste dep)', () => {
    const { props } = mountPaste()
    expect(typeof props.handlePaste).toBe('function')
    expect(typeof props.handleDrop).toBe('function')
  })

  it('ai-block reimport: a pasted ```ai-block fence → TRACKED commands.insertContent(sieve-ai-block), returns true', () => {
    const { ed, props } = mountPaste()
    const yaml = 'id: ab-1\nref: doc\nstatus: PENDING'
    const text = '```ai-block\n' + JSON.stringify({ id: 'ab-1', ref: 'doc', status: 'PENDING' }) + '\n```'
    const event = { clipboardData: clip({ text }), target: {}, preventDefault: vi.fn() }
    const handled = props.handlePaste({}, event)
    expect(handled).toBe(true)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(ed.commands.insertContent).toHaveBeenCalledTimes(1)
    const arg = ed.commands.insertContent.mock.calls[0][0]
    expect(arg.type).toBe('sieve-ai-block')
    expect(arg.attrs.id).toBe('ab-1')
  })

  it('caret in a raw-text block → returns false (native paste), no insert', () => {
    const { ed, props } = mountPaste(wyHost(), 'doc-1', { caretInRawTextBlock: () => true })
    const event = { clipboardData: clip({ text: 'plain' }), target: {}, preventDefault: vi.fn() }
    expect(props.handlePaste({}, event)).toBe(false)
    expect(ed.commands.insertContent).not.toHaveBeenCalled()
  })

  it('smart-paste pipeline: PEEKS the block index (side-effect-free), calls the service verb, consumes the anchor on outcome:block, returns true', async () => {
    // The surface no longer speaks fetch — it calls DocumentService.smartPaste
    // (issue #49 Phase 4). Stub the verb on the host, not global fetch.
    const anchor = { id: 'p-1', token: '' }
    const host = wyHost({ peekInsertIndexForBlock: vi.fn(() => ({ index: 4, anchor })) })
    host.documentService.smartPaste.mockReturnValue(Promise.resolve({ outcome: 'block', kind: 'code', id: 'co-1' }))
    const strItem = { kind: 'string', type: 'text/plain', getAsString: (cb) => cb('hello') }
    const { ed, props } = mountPaste(host, 'doc-1')
    const event = { clipboardData: Object.assign(clip({ text: 'hello', items: [strItem] }), { items: [strItem] }), target: {}, preventDefault: vi.fn() }
    const handled = props.handlePaste({}, event)
    expect(handled).toBe(true)
    expect(host.peekInsertIndexForBlock).toHaveBeenCalledTimes(1)
    expect(host.insertIndexForBlock).not.toHaveBeenCalled() // no EAGER consume
    expect(event.preventDefault).toHaveBeenCalled()
    await new Promise((r) => setTimeout(r, 0))
    expect(host.documentService.smartPaste).toHaveBeenCalledWith('doc-1', expect.objectContaining({ index: 4 }))
    // outcome:block → the blank line is consumed NOW, by the peeked anchor handle.
    expect(host.consumeInsertAnchor).toHaveBeenCalledWith(anchor)
    // The block arrives over the insert-block render-back — the surface must NOT
    // also replay the clipboard locally (the #67 double-paste regression: with the
    // `matched` flag gone, a stale reader saw undefined and took the replay branch).
    expect(ed.commands.insertContent).not.toHaveBeenCalled()
  })

  // issue #33: the regression guard. A no-match smart-paste must NOT consume the
  // empty-paragraph anchor — the blank line and caret stay intact, so insertContent
  // replays into the empty paragraph, never into an adjacent code:true block.
  it('smart-paste outcome:none → replays clipboard content AND never consumes the anchor (issue #33)', async () => {
    const anchor = { id: 'p-1', token: '' }
    const host = wyHost({ peekInsertIndexForBlock: vi.fn(() => ({ index: 0, anchor })) })
    host.documentService.smartPaste.mockReturnValue(Promise.resolve({ outcome: 'none' }))
    const strItem = { kind: 'string', type: 'text/plain', getAsString: (cb) => cb('hello') }
    const { ed, props } = mountPaste(host, 'doc-1')
    const event = { clipboardData: Object.assign(clip({ text: 'hello', items: [strItem] }), { items: [strItem] }), target: {}, preventDefault: vi.fn() }
    props.handlePaste({}, event)
    // Drain the async chain: Promise.all → fetch → r.json() → result handler.
    await new Promise((r) => setTimeout(r, 0))
    expect(host.clearInsertPos).toHaveBeenCalled()   // stale insert pos cleared
    expect(ed.commands.insertContent).toHaveBeenCalledWith('hello')
    expect(host.consumeInsertAnchor).not.toHaveBeenCalled() // blank line preserved
    // Our preventDefault()'d smart-paste robbed PM of its native scroll-to-caret —
    // the local replay must restore it so the view follows the pasted text.
    expect(ed.commands.scrollIntoView).toHaveBeenCalled()
  })

  // ── outcome:content — the #67 link paste ────────────────────────────────────
  // Go composed an anchor for the caret (a link whose <title> it fetched). There is
  // no block and no render-back: the surface inserts Go's fragment INSTEAD of the
  // clipboard, and leaves the empty-paragraph anchor alone (it was minted to hold a
  // BLOCK's place; this is an inline insert into that very paragraph).
  it('smart-paste outcome:content → inserts GO\'s fragment, not the clipboard, and never consumes the anchor', async () => {
    const anchor = { id: 'p-1', token: '' }
    const host = wyHost({ peekInsertIndexForBlock: vi.fn(() => ({ index: 0, anchor })) })
    const frag = '<a href="https://example.com">Example Domain</a>'
    host.documentService.smartPaste.mockReturnValue(Promise.resolve({ outcome: 'content', html: frag }))
    const strItem = { kind: 'string', type: 'text/plain', getAsString: (cb) => cb('https://example.com') }
    const { ed, props } = mountPaste(host, 'doc-1')
    const event = { clipboardData: Object.assign(clip({ text: 'https://example.com', items: [strItem] }), { items: [strItem] }), target: {}, preventDefault: vi.fn() }
    expect(props.handlePaste({}, event)).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
    expect(host.clearInsertPos).toHaveBeenCalled()
    expect(ed.commands.insertContent).toHaveBeenCalledTimes(1)
    expect(ed.commands.insertContent).toHaveBeenCalledWith(frag)
    expect(host.consumeInsertAnchor).not.toHaveBeenCalled()
    expect(ed.commands.scrollIntoView).toHaveBeenCalled()
  })

  // The union must FAIL SAFE. A build that meets an outcome it does not know (Go
  // grows one) has to replay the clipboard — the one behaviour that never loses the
  // user's paste. Silently dropping it is the failure mode this pins shut.
  it.each([
    ['an unknown outcome', { outcome: 'quantum-block' }],
    ['a missing outcome', {}],
    ['content with no fragment', { outcome: 'content', html: '' }],
    ['a null body', null],
  ])('smart-paste degrades %s to the local replay (never a swallowed paste)', async (_label, result) => {
    const anchor = { id: 'p-1', token: '' }
    const host = wyHost({ peekInsertIndexForBlock: vi.fn(() => ({ index: 0, anchor })) })
    host.documentService.smartPaste.mockReturnValue(Promise.resolve(result))
    const strItem = { kind: 'string', type: 'text/plain', getAsString: (cb) => cb('hello') }
    const { ed, props } = mountPaste(host, 'doc-1')
    const event = { clipboardData: Object.assign(clip({ text: 'hello', items: [strItem] }), { items: [strItem] }), target: {}, preventDefault: vi.fn() }
    props.handlePaste({}, event)
    await new Promise((r) => setTimeout(r, 0))
    expect(ed.commands.insertContent).toHaveBeenCalledWith('hello')
    expect(host.consumeInsertAnchor).not.toHaveBeenCalled()
  })

  it('smart-paste outcome:none prefers the text/html clipboard view when there is one', async () => {
    const host = wyHost()
    host.documentService.smartPaste.mockReturnValue(Promise.resolve({ outcome: 'none' }))
    const strItem = { kind: 'string', type: 'text/plain', getAsString: (cb) => cb('hello') }
    const { ed, props } = mountPaste(host, 'doc-1')
    const event = { clipboardData: Object.assign(clip({ text: 'hello', html: '<p><b>hello</b></p>', items: [strItem] }), { items: [strItem] }), target: {}, preventDefault: vi.fn() }
    props.handlePaste({}, event)
    await new Promise((r) => setTimeout(r, 0))
    expect(ed.commands.insertContent).toHaveBeenCalledWith('<p><b>hello</b></p>')
  })

  it('multi-block slice paste → DocumentService.pasteSlice(uuid, {slice, index}), clears insert pos, returns true', () => {
    const host = wyHost({ insertIndexForBlock: vi.fn(() => 7) })
    const { props } = mountPaste(host, 'doc-1')
    const slice = [{ kind: 'prose', content: 'a' }, { kind: 'code', content: 'b' }]
    const event = { clipboardData: clip({ slice: JSON.stringify(slice) }), target: {}, preventDefault: vi.fn() }
    const handled = props.handlePaste({}, event)
    expect(handled).toBe(true)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(host.clearInsertPos).toHaveBeenCalled()
    expect(host.documentService.pasteSlice).toHaveBeenCalledWith('doc-1', { slice, index: 7 })
  })

  it('handleSmartDrop: image file → PEEKS insertIndexAt(dropPos) (side-effect-free), POSTs, returns true', async () => {
    // happy-dom's FileReader rejects on a non-Blob stub file, leaking an unhandled
    // rejection AFTER this test's synchronous assertions pass. This test asserts only
    // the sync drop path, so stub a no-op reader (its Promise stays pending, never rejects).
    const OrigFileReader = globalThis.FileReader
    globalThis.FileReader = class { readAsDataURL() {} }
    try {
    const host = wyHost({ peekInsertIndexAt: vi.fn(() => ({ index: 9, anchor: null })) })
    host.documentService.smartPaste.mockReturnValue(Promise.resolve({ outcome: 'block', kind: 'smart-image', id: 'si-1' }))
    const { ed, props } = mountPaste(host, 'doc-1')
    // The surface reads posAtCoords + selection.to off the live editor.
    ed.view.posAtCoords = () => ({ pos: 12 })
    ed.state.selection = { to: 0 }
    const fileItem = { kind: 'file', getAsFile: () => ({ type: 'image/png', name: 'x.png' }) }
    const dt = { items: [fileItem] }
    const event = { dataTransfer: dt, clientX: 1, clientY: 1, preventDefault: vi.fn() }
    const handled = props.handleDrop({}, event, null, false)
    expect(handled).toBe(true)
    expect(host.peekInsertIndexAt).toHaveBeenCalledWith(12)
    expect(host.insertIndexForBlockAt).not.toHaveBeenCalled() // no EAGER consume on drop
    expect(event.preventDefault).toHaveBeenCalled()
    } finally { globalThis.FileReader = OrigFileReader }
  })

  // The drop handler reads the SAME union as paste, so its branch selection is
  // pinned the same way. A resolving FileReader stub is needed here (unlike the
  // sync-path test above) because these assertions live past the await.
  describe('handleSmartDrop consumes the paste union', () => {
    let OrigFileReader
    beforeEach(() => {
      OrigFileReader = globalThis.FileReader
      globalThis.FileReader = class {
        readAsDataURL() { setTimeout(() => this.onload({ target: { result: 'data:image/png;base64,AA==' } }), 0) }
      }
    })
    afterEach(() => { globalThis.FileReader = OrigFileReader })

    function drop(host, result) {
      host.documentService.smartPaste.mockReturnValue(Promise.resolve(result))
      const { ed, props } = mountPaste(host, 'doc-1')
      ed.view.posAtCoords = () => ({ pos: 12 })
      ed.state.selection = { to: 0 }
      const fileItem = { kind: 'file', getAsFile: () => ({ type: 'image/png', name: 'x.png' }) }
      const event = { dataTransfer: { items: [fileItem] }, clientX: 1, clientY: 1, preventDefault: vi.fn() }
      expect(props.handleDrop({}, event, null, false)).toBe(true)
      return ed
    }

    it('outcome:block → consumes the anchor, inserts nothing locally', async () => {
      const anchor = { id: 'p-1', token: '' }
      const host = wyHost({ peekInsertIndexAt: vi.fn(() => ({ index: 9, anchor })) })
      const ed = drop(host, { outcome: 'block', kind: 'smart-image', id: 'si-1' })
      await new Promise((r) => setTimeout(r, 0))
      expect(host.consumeInsertAnchor).toHaveBeenCalledWith(anchor)
      expect(ed.commands.insertContentAt).not.toHaveBeenCalled()
    })

    it("outcome:content → inserts Go's fragment AT THE DROP POSITION, keeping the anchor", async () => {
      const anchor = { id: 'p-1', token: '' }
      const host = wyHost({ peekInsertIndexAt: vi.fn(() => ({ index: 9, anchor })) })
      const frag = '<a href="https://example.com">Example Domain</a>'
      const ed = drop(host, { outcome: 'content', html: frag })
      await new Promise((r) => setTimeout(r, 0))
      expect(host.clearInsertPos).toHaveBeenCalled()
      // 12 is posAtCoords — the DROP coordinate, never the caret.
      expect(ed.commands.insertContentAt).toHaveBeenCalledWith(12, frag)
      expect(host.consumeInsertAnchor).not.toHaveBeenCalled()
      expect(ed.commands.scrollIntoView).toHaveBeenCalled()
    })

    it('outcome:none → never touches the document (a drop has no clipboard to replay)', async () => {
      const host = wyHost({ peekInsertIndexAt: vi.fn(() => ({ index: 9, anchor: { id: 'p-1', token: '' } })) })
      const ed = drop(host, { outcome: 'none' })
      await new Promise((r) => setTimeout(r, 0))
      expect(ed.commands.insertContentAt).not.toHaveBeenCalled()
      expect(ed.commands.insertContent).not.toHaveBeenCalled()
      expect(host.consumeInsertAnchor).not.toHaveBeenCalled()
    })
  })

  it('handleSmartDrop with no files → returns false (native drop)', () => {
    const { props } = mountPaste(wyHost(), 'doc-1')
    const strItem = { kind: 'string', type: 'text/plain', getAsString: (cb) => cb('t') }
    const event = { dataTransfer: { items: [strItem] }, clientX: 1, clientY: 1, preventDefault: vi.fn() }
    expect(props.handleDrop({}, event, null, false)).toBe(false)
  })

  // ── Dropping a file that is not an image (#38) ───────────────────────────────
  // The handler used to throw every non-image file away before Go saw it, which
  // is why a document could hold an image and nothing else. It now hands EVERY
  // file to smart-paste and lets the registry pick the kind, so the routing lives
  // in one place (Go) rather than being pre-decided by a mime test here.
  describe('handleSmartDrop hands every file to Go (#38)', () => {
    let OrigFileReader
    let OrigAlert
    beforeEach(() => {
      OrigFileReader = globalThis.FileReader
      globalThis.FileReader = class {
        readAsDataURL(file) {
          setTimeout(() => this.onload({ target: { result: 'data:' + (file.type || 'application/octet-stream') + ';base64,AA==' } }), 0)
        }
      }
      OrigAlert = window.alert
      window.alert = vi.fn()
    })
    afterEach(() => { globalThis.FileReader = OrigFileReader; window.alert = OrigAlert })

    function fileItem(file) { return { kind: 'file', getAsFile: () => file } }

    function dropFiles(host, files) {
      host.documentService.smartPaste.mockReturnValue(Promise.resolve({ outcome: 'block', kind: 'attachment', id: 'at-1' }))
      const { ed, props } = mountPaste(host, 'doc-1')
      ed.view.posAtCoords = () => ({ pos: 12 })
      ed.state.selection = { to: 0 }
      const event = { dataTransfer: { items: files.map(fileItem) }, clientX: 1, clientY: 1, preventDefault: vi.fn() }
      return { handled: props.handleDrop({}, event, null, false), event }
    }

    it('a dropped yaml file is POSTed with its ORIGINAL FILENAME in the entry context', async () => {
      const host = wyHost({ peekInsertIndexAt: vi.fn(() => ({ index: 9, anchor: null })) })
      const { handled } = dropFiles(host, [{ type: 'text/yaml', name: 'swagger.yml', size: 4096 }])
      expect(handled).toBe(true)
      await new Promise((r) => setTimeout(r, 0))
      expect(host.documentService.smartPaste).toHaveBeenCalledWith('doc-1', {
        entries: [{
          mimeType: 'text/yaml',
          content: 'data:text/yaml;base64,AA==',
          // readAsDataURL carries the bytes and nothing else; without this the chip
          // could only label itself with the id the asset is stored under.
          context: { filename: 'swagger.yml' },
        }],
        index: 9,
      })
    })

    it('an image drop carries the filename too — one rule for every file, no per-kind branch here', async () => {
      const host = wyHost({ peekInsertIndexAt: vi.fn(() => ({ index: 9, anchor: null })) })
      dropFiles(host, [{ type: 'image/png', name: 'shot.png', size: 2048 }])
      await new Promise((r) => setTimeout(r, 0))
      expect(host.documentService.smartPaste).toHaveBeenCalledWith('doc-1', expect.objectContaining({
        entries: [expect.objectContaining({ mimeType: 'image/png', context: { filename: 'shot.png' } })],
      }))
    })

    // The failure being designed out is the SILENT one: before this, an over-large
    // drop did nothing at all and said nothing about why.
    it('a file over the ceiling is REFUSED OUT LOUD — named, sized, and never read into memory', async () => {
      const host = wyHost({ peekInsertIndexAt: vi.fn(() => ({ index: 9, anchor: null })) })
      const { handled, event } = dropFiles(host, [{ type: 'video/mp4', name: 'huge.mp4', size: 500 * 1024 * 1024 }])
      // Handled, not ignored: the browser must not navigate away to the file.
      expect(handled).toBe(true)
      expect(event.preventDefault).toHaveBeenCalled()
      const msg = vi.mocked(window.alert).mock.calls[0][0]
      expect(msg).toContain('huge.mp4')    // WHICH file
      expect(msg).toContain('500.0 MB')    // how big it actually is
      expect(msg).toContain('25.0 MB')     // and what the limit is
      // Never read: the FileReader stub would have resolved an entry.
      await new Promise((r) => setTimeout(r, 0))
      expect(host.documentService.smartPaste).not.toHaveBeenCalled()
    })

    // The ceiling is a >, not a >=: a file of exactly the limit is within it, and
    // this is the pair Go's backstop test asserts on its own side.
    it('a file of exactly the ceiling still attaches', async () => {
      const host = wyHost({ peekInsertIndexAt: vi.fn(() => ({ index: 9, anchor: null })) })
      dropFiles(host, [{ type: 'application/pdf', name: 'big.pdf', size: MAX_ATTACHMENT_BYTES }])
      expect(window.alert).not.toHaveBeenCalled()
      await new Promise((r) => setTimeout(r, 0))
      expect(host.documentService.smartPaste).toHaveBeenCalled()
    })

    it('an over-size file among several does not cost the others their drop', async () => {
      const host = wyHost({ peekInsertIndexAt: vi.fn(() => ({ index: 9, anchor: null })) })
      dropFiles(host, [
        { type: 'video/mp4', name: 'huge.mp4', size: 500 * 1024 * 1024 },
        { type: 'text/yaml', name: 'swagger.yml', size: 4096 },
      ])
      expect(window.alert).toHaveBeenCalledTimes(1)
      await new Promise((r) => setTimeout(r, 0))
      expect(host.documentService.smartPaste).toHaveBeenCalledWith('doc-1', expect.objectContaining({
        entries: [expect.objectContaining({ context: { filename: 'swagger.yml' } })],
      }))
    })
  })

  it('paste in a prompt: uuid prompt: → no server round trip (returns false)', () => {
    const { props } = mountPaste(wyHost(), 'prompt:p')
    const event = { clipboardData: clip({ text: 'plain', items: [] }), target: {}, preventDefault: vi.fn() }
    expect(props.handlePaste({}, event)).toBe(false)
  })

  // ── insertLink — the Insert-from-URL ladder's "Link" rung (#67) ──────────────
  // It is a CALLER of the paste path, not a second link-inserting mechanism: the
  // same DocumentService.smartPaste round-trip (which is what fetches the title in
  // Go), the same peek/consume anchor contract, the same union reader. These pin
  // that reuse — a hand-rolled local `<a>` build would fail every one of them.
  describe('WysiwygSurface.insertLink (Link rung reuses the paste round-trip)', () => {
    it("sends the URL as a text/plain entry at the PEEKED index, and inserts GO's anchor at the caret", async () => {
      const anchor = { id: 'p-1', token: '' }
      const host = wyHost({ peekInsertIndexForBlock: vi.fn(() => ({ index: 3, anchor })) })
      const frag = '<a href="https://example.com">Example Domain</a>'
      host.documentService.smartPaste.mockReturnValue(Promise.resolve({ outcome: 'content', html: frag }))
      const { s, ed } = mountPaste(host, 'doc-1')

      await expect(s.insertLink('https://example.com')).resolves.toBe(true)

      expect(host.documentService.smartPaste).toHaveBeenCalledWith('doc-1', {
        entries: [{ mimeType: 'text/plain', content: 'https://example.com' }],
        index: 3,
      })
      expect(ed.commands.insertContent).toHaveBeenCalledWith(frag)
      // Inline insert into the caret's own paragraph — the block anchor is untouched.
      expect(host.consumeInsertAnchor).not.toHaveBeenCalled()
      expect(ed.commands.scrollIntoView).toHaveBeenCalled()
    })

    it('an outcome:block URL (an image) becomes that BLOCK — the pipeline decides, this rung does not second-guess it', async () => {
      const anchor = { id: 'p-1', token: '' }
      const host = wyHost({ peekInsertIndexForBlock: vi.fn(() => ({ index: 3, anchor })) })
      host.documentService.smartPaste.mockReturnValue(Promise.resolve({ outcome: 'block', kind: 'smart-image', id: 'si-1' }))
      const { s, ed } = mountPaste(host, 'doc-1')

      await expect(s.insertLink('https://example.com/cat.png')).resolves.toBe(true)
      expect(host.consumeInsertAnchor).toHaveBeenCalledWith(anchor)
      expect(ed.commands.insertContent).not.toHaveBeenCalled()
    })

    it('outcome:none replays the bare URL (the degraded outcome a paste of it gives)', async () => {
      const host = wyHost({ peekInsertIndexForBlock: vi.fn(() => ({ index: 0, anchor: null })) })
      host.documentService.smartPaste.mockReturnValue(Promise.resolve({ outcome: 'none' }))
      const { s, ed } = mountPaste(host, 'doc-1')

      await expect(s.insertLink('https://example.com')).resolves.toBe(false)
      expect(ed.commands.insertContent).toHaveBeenCalledWith('https://example.com')
    })

    it('a failed round-trip resolves false and inserts NOTHING (no title-less fallback anchor)', async () => {
      const host = wyHost()
      host.documentService.smartPaste.mockReturnValue(Promise.reject(new Error('offline')))
      const { s, ed } = mountPaste(host, 'doc-1')
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})

      await expect(s.insertLink('https://example.com')).resolves.toBe(false)
      expect(ed.commands.insertContent).not.toHaveBeenCalled()
      err.mockRestore()
    })

    it('no url, and a prompt buffer, are inert (no round trip)', async () => {
      const host = wyHost()
      const { s } = mountPaste(host, 'doc-1')
      await expect(s.insertLink('')).resolves.toBe(false)

      const promptHost = wyHost()
      const p = mountPaste(promptHost, 'prompt:p')
      await expect(p.s.insertLink('https://example.com')).resolves.toBe(false)

      expect(host.documentService.smartPaste).not.toHaveBeenCalled()
      expect(promptHost.documentService.smartPaste).not.toHaveBeenCalled()
    })
  })
})

describe('WysiwygSurface.feedSelection (P3.A raw descriptor from live PM)', () => {
  // Injects a real PM state (fixture) as the surface's live editor and reads
  // feedSelection — PLAIN strings only, no PM node escapes.
  function surfaceOver(fixture) {
    return new TestWysiwygSurface('doc-1', wyHost(), fixture.editor)
  }

  it('no editor → a none descriptor', () => {
    const s = new TestWysiwygSurface('doc-1', wyHost(), null)
    expect(s.feedSelection()).toEqual({
      selectionType: 'none', caret: null, range: null, selectedText: null,
      blockId: null, blockIds: [], blockKind: null, ref: null, blockCursor: null,
      // P3.C: no editor → the document target.
      target: { kind: 'document', ref: 'doc', range: null, label: 'Document' },
    })
  })

  it('a caret in a prose block → caret, blockId + native kind, single-block span', () => {
    const s = surfaceOver(docWithCaret([build.p('hello world', 'b1')], 0, 2))
    const d = s.feedSelection()
    expect(d.selectionType).toBe('caret')
    expect(d.range.from).toBe(d.range.to) // collapsed
    expect(d.blockId).toBe('b1')
    expect(d.blockIds).toEqual(['b1'])
    expect(d.blockKind).toBe('paragraph') // native node type name
    expect(d.selectedText).toBeNull()
    expect(d.ref).toBeNull()
    // P3.C: label lives inside the resolved target; a caret in flowing prose → document.
    expect(d.target).toEqual({ kind: 'document', ref: 'doc', range: null, label: 'Document' })
  })

  it('a non-empty text selection → range with selectedText', () => {
    // "hello world" in block b1: select a middle span.
    const s = surfaceOver(docWithRange([build.p('hello world', 'b1')], 2, 7))
    const d = s.feedSelection()
    expect(d.selectionType).toBe('range')
    expect(d.range).toEqual({ from: 2, to: 7 })
    expect(typeof d.selectedText).toBe('string')
    expect(d.selectedText.length).toBeGreaterThan(0)
    expect(d.blockId).toBe('b1')
  })

  it('a NodeSelection on a sieve block → block, its kind + ref, no PM node', () => {
    const s = surfaceOver(docWithNodeSelection([build.aiBlock('ai-1', 'anchor-x')], 0))
    const d = s.feedSelection()
    expect(d.selectionType).toBe('block')
    expect(d.blockId).toBe('ai-1')
    expect(d.blockIds).toEqual(['ai-1'])
    expect(d.blockKind).toBe('ai-block') // sieve node attrs.kind, not type.name
    expect(d.ref).toBe('anchor-x')
    // The resolved target is plain values only (P3.C: no PM node in or out).
    expect(d.target.kind).toBe('block')
    expect(d.target.ref).toBe('ai-1')
    expect(d.target.label).toBe('Follow-up')
    expect('node' in d.target).toBe(false)
    // No PM node leaks into the plain descriptor (target is a plain sub-object).
    Object.values(d).forEach((v) => {
      if (v === null || Array.isArray(v)) return
      if (typeof v !== 'object') return
      if ('from' in v) return                 // a range
      if ('kind' in v) return                 // the plain target sub-object
      throw new Error('unexpected object in descriptor: ' + JSON.stringify(v))
    })
  })
})

describe('WysiwygSurface.feedSelection richness (P3.B: block-range, dom-fold, multi-block)', () => {
  // P4.E: getBlockSelectionRange (block-chrome's authoritative range) and
  // BlockSelection.blockRange (the read-only-region fold) are ES imports (mocked
  // above); each test drives them via vi.mocked. The surface reads BOTH, never
  // raw state.selection alone. The global beforeEach re-establishes their defaults.
  function surfaceWith(fixture) {
    return new TestWysiwygSurface('doc-1', wyHost(), fixture.editor)
  }
  const setRange = (range) => vi.mocked(getBlockSelectionRange).mockReturnValue(range)
  const setFold = (fold) => vi.mocked(BlockSelection.blockRange).mockReturnValue(fold)

  it('block-chrome multi-block range (isBlockRange) → range spanning every overlapped blockId', () => {
    // Three prose blocks; block-chrome reports a gutter range covering b1 + b2.
    const nodes = [build.p('alpha', 'b1'), build.p('beta', 'b2'), build.p('gamma', 'b3')]
    const fx = docWithCaret(nodes, 0, 0) // PM selection is a caret in b1; the block-range overrides
    // Doc positions: b1 [0..7), b2 [7..13), b3 [13..20) roughly — cover b1..b2.
    const b1End = nodes[0].nodeSize            // 7
    setRange({ from: 1, to: b1End + 2, active: true, isBlockRange: true, isNodeSelection: false })
    const d = surfaceWith(fx).feedSelection()
    expect(d.selectionType).toBe('range')          // block-range folds to 'range'
    expect(d.blockIds).toEqual(['b1', 'b2'])        // full overlap span
    expect(d.blockId).toBe('b1')                    // primary = first/head block
    expect(d.blockIds).toContain(d.blockId)         // blockIds ⊇ [blockId]
  })

  it('a single NodeSelection is still block (not folded to range)', () => {
    const fx = docWithNodeSelection([build.aiBlock('ai-1', 'r')], 0)
    // block-chrome falls back to the PM NodeSelection (isBlockRange:false).
    const sel = fx.editor.state.selection
    setRange({ from: sel.from, to: sel.to, active: true, isBlockRange: false, isNodeSelection: true })
    const d = surfaceWith(fx).feedSelection()
    expect(d.selectionType).toBe('block')
    expect(d.blockIds).toEqual(['ai-1'])
  })

  it('read-only-region DOM highlight (F5): BlockSelection.blockRange fold → range on that block', () => {
    // PM selection is a caret in b1, but the user highlighted read-only text in b2.
    const nodes = [build.p('alpha', 'b1'), build.aiBlock('ai-2', 'r2')]
    const fx = docWithCaret(nodes, 0, 0)
    const b1End = nodes[0].nodeSize
    setRange({ from: 1, to: 1, active: false, isBlockRange: false, isNodeSelection: false })
    // The fold re-targets onto b2's range.
    setFold({ from: b1End, to: b1End + nodes[1].nodeSize })
    // Stub window.getSelection so the surface can read the highlighted string.
    const prev = window.getSelection
    window.getSelection = () => ({ isCollapsed: false, toString: () => 'highlighted', rangeCount: 1 })
    try {
      const d = surfaceWith(fx).feedSelection()
      expect(d.selectionType).toBe('range')     // folded to range
      expect(d.blockId).toBe('ai-2')            // the block the highlight actually lives in
      expect(d.blockIds).toContain('ai-2')
      expect(d.selectedText).toBe('highlighted')
    } finally {
      window.getSelection = prev
    }
  })

  it('a collapsed caret AT a block boundary reports a single-block blockIds === [blockId]', () => {
    // child(0) is an empty paragraph (nodeSize 2), so pos 2 is the exact boundary
    // between the two blocks — the defect: overlap matched BOTH. A collapsed caret
    // spans exactly one block (its primary); blockIds must be [blockId].
    const nodes = [build.p('', 'lo-223d'), build.p('interior', 'co-48ef')]
    const boundary = nodes[0].nodeSize // 2 — end of block 0 / start of block 1
    const fx = docWithCaretAt(nodes, boundary)
    setRange({ from: boundary, to: boundary, active: false, isBlockRange: false, isNodeSelection: false })
    const d = surfaceWith(fx).feedSelection()
    expect(d.selectionType).toBe('caret')
    expect(d.blockIds).toEqual([d.blockId]) // single-block; no spurious second block
    expect(d.blockIds.length).toBe(1)
  })

  it('a caret straddling a block boundary within the same primary block is stable (no spurious blockIds change)', () => {
    // Two caret positions whose PRIMARY block is the SAME (co-48ef): the boundary
    // caret (pos 2) and an interior caret (pos 4). blockIds must be identical so
    // the model's meaningful-diff coalesces the move (no spurious push).
    const nodes = [build.p('', 'lo-223d'), build.p('interior', 'co-48ef')]
    const boundary = nodes[0].nodeSize            // 2
    const interior = boundary + 2                 // 4 — inside co-48ef
    setRange({ from: boundary, to: boundary, active: false, isBlockRange: false, isNodeSelection: false })
    const atBoundary = surfaceWith(docWithCaretAt(nodes, boundary)).feedSelection()
    setRange({ from: interior, to: interior, active: false, isBlockRange: false, isNodeSelection: false })
    const atInterior = surfaceWith(docWithCaretAt(nodes, interior)).feedSelection()
    // Both carets sit in co-48ef (the boundary caret STARTS co-48ef). blockId +
    // blockIds identical → the meaningful-diff won't fire on the 2→4 move.
    expect(atBoundary.blockId).toBe('co-48ef')
    expect(atInterior.blockId).toBe('co-48ef')
    expect(atBoundary.blockIds).toEqual(atInterior.blockIds)
  })

  it('no block-range and no dom fold → the P3.A single-block behaviour is preserved', () => {
    const fx = docWithRange([build.p('hello world', 'b1')], 2, 7)
    setRange({ from: 2, to: 7, active: true, isBlockRange: false, isNodeSelection: false })
    const prev = window.getSelection
    window.getSelection = () => ({ isCollapsed: true, toString: () => '', rangeCount: 0 })
    try {
      const d = surfaceWith(fx).feedSelection()
      expect(d.selectionType).toBe('range')
      expect(d.blockId).toBe('b1')
      expect(d.blockIds).toEqual(['b1'])
    } finally {
      window.getSelection = prev
    }
  })
})

// P3.E — the blockCursor half of the coordinate + the symmetric WRITE side, now
// OWNED by the surface (inlined, symmetric with MarkdownSurface.applyPosition). The
// block branch is DOM-only (no editor); the doc-caret branch drives `this.editorPane`.
describe('WysiwygSurface blockCursor capture + applyPosition (P3.E)', () => {
  // A surface over a real PM fixture, so feedSelection gets past the `!ed` guard and
  // we can read the surface-merged blockCursor (the block-inner DOM read).
  function surfaceWithDoc() {
    return new TestWysiwygSurface('doc-1', wyHost(), docWithCaret([build.p('hello', 'b1')], 0, 2).editor)
  }
  beforeEach(() => { document.body.innerHTML = '' })
  afterEach(() => { document.body.innerHTML = '' })

  // ── capture (feedSelection merges the block-inner cursor) ──────────────────────
  it('focus not in a block → feedSelection blockCursor is null', () => {
    const s = surfaceWithDoc()
    expect(s.feedSelection().blockCursor).toBeNull()
  })

  it('focused .sieve-block__edit → feedSelection blockCursor is the { start, end } token', () => {
    const host = document.createElement('div')
    host.setAttribute('data-id', 'code-7')
    const ta = document.createElement('textarea')
    ta.className = 'sieve-block__edit'
    ta.value = 'print(1)'
    host.appendChild(ta)
    document.body.appendChild(host)
    ta.focus()
    ta.selectionStart = ta.selectionEnd = 5

    const token = surfaceWithDoc().feedSelection().blockCursor
    expect(token.start).toBe(5)
    expect(token.end).toBe(5)
  })

  it('per-flavour hook overrides the generic textarea read', () => {
    const host = document.createElement('div')
    host.setAttribute('data-id', 'blk-9')
    host.__sieveFocus = { capture: () => ({ pane: 'stdout', line: 12 }) }
    const ta = document.createElement('textarea')
    ta.className = 'sieve-block__edit'
    host.appendChild(ta)
    document.body.appendChild(host)
    ta.focus()

    expect(surfaceWithDoc().feedSelection().blockCursor).toEqual({ pane: 'stdout', line: 12 })
  })

  // ── restore (applyPosition) ────────────────────────────────────────────────────
  it('block ctx → focuses the block textarea and restores selection', () => {
    const host = document.createElement('div')
    host.setAttribute('data-id', 'code-7')
    const ta = document.createElement('textarea')
    ta.className = 'sieve-block__edit'
    ta.value = 'print(1)'
    host.appendChild(ta)
    document.body.appendChild(host)

    new TestWysiwygSurface('doc-1', wyHost(), null)
      .applyPosition({ blockId: 'code-7', blockCursor: { start: 3, end: 6 } })
    expect(document.activeElement).toBe(ta)
    expect(ta.selectionStart).toBe(3)
    expect(ta.selectionEnd).toBe(6)
  })

  it('per-flavour restore hook is used when present', () => {
    const host = document.createElement('div')
    host.setAttribute('data-id', 'blk-9')
    let restored = null
    host.__sieveFocus = { restore: (t) => { restored = t } }
    document.body.appendChild(host)

    new TestWysiwygSurface('doc-1', wyHost(), null)
      .applyPosition({ blockId: 'blk-9', blockCursor: { pane: 'stdout' } })
    expect(restored).toEqual({ pane: 'stdout' })
  })

  it('clamps a stale token past the textarea length', () => {
    const host = document.createElement('div')
    host.setAttribute('data-id', 'code-7')
    const ta = document.createElement('textarea')
    ta.className = 'sieve-block__edit'
    ta.value = 'ab'
    host.appendChild(ta)
    document.body.appendChild(host)

    new TestWysiwygSurface('doc-1', wyHost(), null)
      .applyPosition({ blockId: 'code-7', blockCursor: { start: 99, end: 99 } })
    expect(ta.selectionStart).toBe(2)
    expect(ta.selectionEnd).toBe(2)
  })

  // ── round-trip: capture → context → applyPosition restores the inner cursor ─────
  it('blockCursor round-trips through capture → context → applyPosition', () => {
    const host = document.createElement('div')
    host.setAttribute('data-id', 'code-7')
    const ta = document.createElement('textarea')
    ta.className = 'sieve-block__edit'
    ta.value = 'print(1)'
    host.appendChild(ta)
    document.body.appendChild(host)
    ta.focus()
    ta.selectionStart = ta.selectionEnd = 4

    const blockCursor = surfaceWithDoc().feedSelection().blockCursor
    expect(blockCursor).toEqual({ start: 4, end: 4 })

    ta.blur()
    new TestWysiwygSurface('doc-1', wyHost(), null)
      .applyPosition({ blockId: 'code-7', blockCursor, caret: 12 })
    expect(document.activeElement).toBe(ta)
    expect(ta.selectionStart).toBe(4)
  })

  // ── doc-caret CLAMP branch, driving the surface's own this.editorPane seam ──────
  it('doc-caret branch clamps a range past the current doc size', () => {
    let captured = null
    const stubEd = {
      view: { focus() {} },
      state: { doc: { content: { size: 10 } } },
      commands: { setTextSelection(r) { captured = r } },
    }
    new TestWysiwygSurface('doc-1', wyHost(), stubEd)
      .applyPosition({ blockId: null, blockCursor: null, range: { from: 99, to: 99 } })
    expect(captured).toEqual({ from: 10, to: 10 })
  })
})

describe('WysiwygSurface.reloadFromBlocks — load render parks the caret+scroll at the TOP (issue #51)', () => {
  // A whole-doc replaceWith maps the prior selection to the END of the new
  // content; left there, the mount/reload focus scrolls every opened document
  // to its bottom (defect observed 2026-07-22: "documents always open scrolled
  // to the end"). A load is not an edit — the caret belongs at the doc start.
  //
  // issue #51 root-caused the SCROLL half of this: a captured WebKitGTK stack
  // trace showed ProseMirror's own updateStateInner PRESERVING the scroller's
  // prior offset across the replace (its default for what looks like an
  // ordinary edit) unless the transaction's scrollToSelection counter
  // advanced. The fix folds the caret reset AND `tr.scrollIntoView()` into the
  // SAME transaction as the replace — no separate post-dispatch
  // commands.setTextSelection call (that would be a second, later transaction
  // PM has no reason to scroll for). softReload's own caret/scroll restore
  // runs AFTER reloadFromBlocks, so genuine mid-session reloads still put the
  // user back where they had been.
  beforeEach(() => {
    vi.useFakeTimers()
    seedVendor({ ProseMirrorDOMParser: PMDOMParser, TextSelection })
  })

  it('the dispatched transaction carries the doc-start selection AND requests scrollIntoView', () => {
    const ed = fakeEditorOver(fxSchema, [build.p('old content', 'b1')])
    const s = new TestWysiwygSurface('doc-1', wyHost(), ed)
    s.reloadFromBlocks([new SieveBlock('prose', { id: 'p1', content: 'hello' })])
    expect(ed.dispatched).toHaveLength(1)
    const tr = ed.dispatched[0]
    expect(tr.scrolledIntoView).toBe(true) // PM itself takes the "scroll to selection" branch
    expect(tr.selection.from).toBe(TextSelection.atStart(tr.doc).from) // doc start, not the replace's default end-of-content
    // The old two-dispatch mechanism (a separate commands.setTextSelection(0)
    // AFTER the replace landed) is retired — everything rides one transaction.
    expect(ed.calls.some((c) => c[0] === 'setTextSelection')).toBe(false)
  })
})
