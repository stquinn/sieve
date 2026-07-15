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
import { EditorState } from '@tiptap/pm/state'
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
// P4.F: the surfaces IMPORT `T` from base/tiptap-vendor.js (the shared
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
vi.mock('../src/static/editor/interaction-policy.js', () => ({
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
  domSelectionBlockRange: vi.fn(() => null),
  domSelectionTextInside: vi.fn(() => null),
}))
vi.mock('../src/static/block/block-sync.js', () => ({
  seedBaseline: vi.fn((triples) => { const m = {}; triples.forEach((t) => { if (t.id) m[t.id] = t.content }); return m }),
  computeBlockSync: vi.fn(() => ({ next: {}, ops: [] })),
}))
vi.mock('../src/static/base/block-position.js', () => ({
  docPosForBlockIndex: vi.fn(() => 7),
  blockIndexAfter: vi.fn(() => -1),
}))
vi.mock('../src/static/editor/paste-context.js', () => ({
  caretInRawTextBlock: vi.fn(() => false),
}))

import { AbstractSurface, SurfaceEvent } from '../src/static/shell/surfaces/abstract-surface.js'
import { MarkdownSurface } from '../src/static/shell/surfaces/markdown-surface.js'
import { WysiwygSurface } from '../src/static/shell/surfaces/wysiwyg-surface.js'
import { buildBlocksHTML } from '../src/static/block/block-render.js'
import { getBlockSelectionRange } from '../src/static/editor/block-chrome.js'
import { domSelectionBlockRange } from '../src/static/block/sieve-block-extension.js'
import { computeBlockSync } from '../src/static/block/block-sync.js'
import { docPosForBlockIndex, blockIndexAfter } from '../src/static/base/block-position.js'
import { caretInRawTextBlock } from '../src/static/editor/paste-context.js'
import { schema as fxSchema, build, docWithCaret, docWithCaretAt, docWithRange, docWithNodeSelection } from './helpers/editor-fixture.js'

// window.isMod is an index.html global in the app; provide it for keydown tests.
beforeEach(() => { window.isMod = (e) => !!(e.ctrlKey || e.metaKey) })
afterEach(() => { vi.useRealTimers() })

// The shared vendor bag (installed by test/setup.js; base/tiptap-vendor.js's `T`
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
  vi.mocked(domSelectionBlockRange).mockReturnValue(null)
  vi.mocked(docPosForBlockIndex).mockReturnValue(7)
  vi.mocked(blockIndexAfter).mockReturnValue(-1)
  vi.mocked(computeBlockSync).mockReturnValue({ next: {}, ops: [] })
  vi.mocked(caretInRawTextBlock).mockReturnValue(false)
})

// ── MarkdownSurface ───────────────────────────────────────────────────────────

// A fake host (the parent editor): the markdown surface calls its public API
// directly (P4.F) — onSurfaceEvent / updateText / takeInsertPos / softReload.
function mdHost(overrides = {}) {
  return Object.assign({
    updateText: vi.fn(),
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

  it('input debounces 500ms then submits ONE domain updateText; body updates immediately', () => {
    vi.useFakeTimers()
    const { s, host, textarea } = mountMd('a')
    typeInto(textarea, 'ab')
    expect(s.body).toBe('ab')            // body tracks the keystroke
    expect(host.updateText).not.toHaveBeenCalled()
    vi.advanceTimersByTime(499)
    expect(host.updateText).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(host.updateText).toHaveBeenCalledTimes(1)
    // Domain-shaped: the raw markdown only — NO wire envelope, NO uuid.
    expect(host.updateText).toHaveBeenCalledWith('ab')
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
    expect(host.updateText).not.toHaveBeenCalled()
    typeInto(textarea, 'abc')
    s.flushPending()                      // pending → immediate submit
    expect(host.updateText).toHaveBeenCalledTimes(1)
    expect(host.updateText).toHaveBeenCalledWith('abc')
    vi.advanceTimersByTime(1000)          // timer cancelled → no double-submit
    expect(host.updateText).toHaveBeenCalledTimes(1)
  })

  it('applyServerOp(insert-block) appends the markdown, clears insert pos, submits the buffer', () => {
    const { s, host, textarea } = mountMd('hello')
    s.applyServerOp({ type: 'insert-block', markdown: '```js\ncode\n```' })
    expect(host.takeInsertPos).toHaveBeenCalledTimes(1)
    expect(s.body).toBe('hello\n\n```js\ncode\n```\n')
    expect(textarea.value).toBe(s.body)
    expect(host.updateText).toHaveBeenCalledWith(s.body)
  })

  it('applyServerOp(replace-block) requests a reload; block-attrs-updated is a no-op', () => {
    const { s, host } = mountMd('x')
    s.applyServerOp({ type: 'replace-block', oldId: 'a', newId: 'b' })
    expect(host.softReload).toHaveBeenCalledTimes(1)
    s.applyServerOp({ type: 'block-attrs-updated', id: 'a', attrs: { status: 'done' } })
    expect(host.updateText).not.toHaveBeenCalled()
    expect(host.softReload).toHaveBeenCalledTimes(1) // unchanged
  })

  it('unmount removes the DOM and kills a pending debounce', () => {
    vi.useFakeTimers()
    const { s, root, host, textarea } = mountMd('a')
    typeInto(textarea, 'ab')
    s.unmount()
    expect(root.children.length).toBe(0)
    vi.advanceTimersByTime(1000)
    expect(host.updateText).not.toHaveBeenCalled()
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
// directly (P4.F) — onSurfaceEvent / applyBlockOps / flushSave / takeInsertPos and
// the insert-index math (insertIndexForBlock = commitInsertIndex(captureInsertPos()),
// insertIndexForBlockAt(pos) = commitInsertIndex(pos), plus clearInsertPos). `uuid`
// is read by the surface constructor. TestWysiwygSurface overrides uuid per call.
function wyHost(overrides = {}) {
  return Object.assign({
    applyBlockOps: vi.fn(),
    flushSave: vi.fn(),
    insertIndexForBlock: vi.fn(() => 0),
    insertIndexForBlockAt: vi.fn(() => 0),
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
    // Domain-shaped: the delete-block op only — the WS envelope is NoteEditor's.
    expect(host.applyBlockOps).toHaveBeenCalledWith([{ type: 'delete-block', blockId: 'real-2' }])
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
  const ext = { configure: () => ({}), name: 'ext' }
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
      this.commands = { insertContentAt: vi.fn(), insertContent: vi.fn(), focus: vi.fn() }
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

  it('mount stamps the parent Editor onto the pane as sieveHost (the NodeView→Editor handle)', () => {
    // P4.F Brief C: a block capability (ctx.getEditor) reaches the Editor through
    // editorPane.sieveHost — the pane the surface built, stamped with its host.
    const { host, ed } = mountWy()
    expect(ed.sieveHost).toBe(host)
  })

  it('onUpdate debounces 500ms then submits granular block-domain ops', () => {
    vi.mocked(computeBlockSync).mockReturnValue({ next: {}, ops: [{ type: 'update-block', blockId: 'b1' }] })
    const { host, ed } = mountWy()
    ed.options.onUpdate({ editor: ed })
    expect(host.applyBlockOps).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)
    expect(computeBlockSync).toHaveBeenCalledTimes(1)
    expect(host.applyBlockOps).toHaveBeenCalledWith([{ type: 'update-block', blockId: 'b1' }])
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

  it('flushPending fires the pending sync immediately, exactly once', () => {
    const { s, host, ed } = mountWy()
    ed.options.onUpdate({ editor: ed })
    s.flushPending()
    expect(host.applyBlockOps).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(host.applyBlockOps).toHaveBeenCalledTimes(1) // timer cancelled — no double sync
    s.flushPending()                                      // idle → no-op
    expect(host.applyBlockOps).toHaveBeenCalledTimes(1)
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
    expect(host.applyBlockOps).not.toHaveBeenCalled()
  })
})

// ── WysiwygSurface: #handleSmartPaste / #handleSmartDrop (P4.A) ────────────────
// The smart-paste / smart-drop pipelines moved off editor.js's IIFE into the
// surface as #private methods, wired at editorProps.handlePaste / handleDrop.
// They call the editor-sourced insert-index host (insertIndexForBlock /
// insertIndexForBlockAt / clearInsertPos) rather than the retired IIFE closures.
// Undo-sacred: the ai-block reimport insertContent stays a TRACKED command.

describe('WysiwygSurface #handleSmartPaste / #handleSmartDrop (P4.A)', () => {
  let prevFetch
  let prevWinFetch
  let prevJsyaml
  beforeEach(() => {
    prevFetch = global.fetch
    prevWinFetch = window.fetch
    prevJsyaml = window.jsyaml
    window.jsyaml = { load: (s) => JSON.parse(s) }
    // The moved code now reads the caretInRawTextBlock ES import (paste-context.js,
    // mocked above). Default false (a normal prose caret); tests override per-case.
    vi.mocked(caretInRawTextBlock).mockReturnValue(false)
  })
  afterEach(() => {
    global.fetch = prevFetch
    window.fetch = prevWinFetch
    window.jsyaml = prevJsyaml
  })

  // The surface calls bare fetch() — stub BOTH global + window so no test hits
  // the network (happy-dom binds window.fetch).
  function stubFetch(fn) { global.fetch = fn; window.fetch = fn }

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

  it('smart-paste pipeline: computes the block index via insertIndexForBlock, POSTs, returns true', async () => {
    const fetchMock = vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ matched: true }) }))
    stubFetch(fetchMock)
    const host = wyHost({ insertIndexForBlock: vi.fn(() => 4) })
    const strItem = { kind: 'string', type: 'text/plain', getAsString: (cb) => cb('hello') }
    const { props } = mountPaste(host, 'doc-1')
    const event = { clipboardData: Object.assign(clip({ text: 'hello', items: [strItem] }), { items: [strItem] }), target: {}, preventDefault: vi.fn() }
    const handled = props.handlePaste({}, event)
    expect(handled).toBe(true)
    expect(host.insertIndexForBlock).toHaveBeenCalledTimes(1)
    expect(event.preventDefault).toHaveBeenCalled()
    await new Promise((r) => setTimeout(r, 0))
    expect(fetchMock).toHaveBeenCalledWith('/api/editor/smart-paste', expect.objectContaining({ method: 'POST' }))
    const body = JSON.parse(fetchMock.mock.calls[0][1].body)
    expect(body.index).toBe(4)
  })

  it('smart-paste no-match fallback: replays the original clipboard content via TRACKED insertContent', async () => {
    stubFetch(vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ matched: false }) })))
    const strItem = { kind: 'string', type: 'text/plain', getAsString: (cb) => cb('hello') }
    const { ed, host, props } = mountPaste(wyHost(), 'doc-1')
    const event = { clipboardData: Object.assign(clip({ text: 'hello', items: [strItem] }), { items: [strItem] }), target: {}, preventDefault: vi.fn() }
    props.handlePaste({}, event)
    // Drain the async chain: Promise.all → fetch → r.json() → result handler.
    await new Promise((r) => setTimeout(r, 0))
    expect(host.clearInsertPos).toHaveBeenCalled()   // stale insert pos cleared
    expect(ed.commands.insertContent).toHaveBeenCalledWith('hello')
  })

  it('handleSmartDrop: image file → insertIndexForBlockAt(dropPos), POSTs smart-paste, returns true', async () => {
    // happy-dom's FileReader rejects on a non-Blob stub file, leaking an unhandled
    // rejection AFTER this test's synchronous assertions pass. This test asserts only
    // the sync drop path, so stub a no-op reader (its Promise stays pending, never rejects).
    const OrigFileReader = globalThis.FileReader
    globalThis.FileReader = class { readAsDataURL() {} }
    try {
    const fetchMock = vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ matched: true }) }))
    stubFetch(fetchMock)
    const host = wyHost({ insertIndexForBlockAt: vi.fn(() => 9) })
    const { ed, props } = mountPaste(host, 'doc-1')
    // The surface reads posAtCoords + selection.to off the live editor.
    ed.view.posAtCoords = () => ({ pos: 12 })
    ed.state.selection = { to: 0 }
    const fileItem = { kind: 'file', getAsFile: () => ({ type: 'image/png', name: 'x.png' }) }
    const dt = { items: [fileItem] }
    const event = { dataTransfer: dt, clientX: 1, clientY: 1, preventDefault: vi.fn() }
    const handled = props.handleDrop({}, event, null, false)
    expect(handled).toBe(true)
    expect(host.insertIndexForBlockAt).toHaveBeenCalledWith(12)
    expect(event.preventDefault).toHaveBeenCalled()
    } finally { globalThis.FileReader = OrigFileReader }
  })

  it('handleSmartDrop with no files → returns false (native drop)', () => {
    const { props } = mountPaste(wyHost(), 'doc-1')
    const strItem = { kind: 'string', type: 'text/plain', getAsString: (cb) => cb('t') }
    const event = { dataTransfer: { items: [strItem] }, clientX: 1, clientY: 1, preventDefault: vi.fn() }
    expect(props.handleDrop({}, event, null, false)).toBe(false)
  })

  it('paste in a prompt: uuid prompt: → no server round trip (returns false)', () => {
    const { props } = mountPaste(wyHost(), 'prompt:p')
    const event = { clipboardData: clip({ text: 'plain', items: [] }), target: {}, preventDefault: vi.fn() }
    expect(props.handlePaste({}, event)).toBe(false)
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
  // domSelectionBlockRange (the read-only-region fold) are ES imports (mocked
  // above); each test drives them via vi.mocked. The surface reads BOTH, never
  // raw state.selection alone. The global beforeEach re-establishes their defaults.
  function surfaceWith(fixture) {
    return new TestWysiwygSurface('doc-1', wyHost(), fixture.editor)
  }
  const setRange = (range) => vi.mocked(getBlockSelectionRange).mockReturnValue(range)
  const setFold = (fold) => vi.mocked(domSelectionBlockRange).mockReturnValue(fold)

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

  it('read-only-region DOM highlight (F5): domSelectionBlockRange fold → range on that block', () => {
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
