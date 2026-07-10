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
import { AbstractSurface, SurfaceEvent } from '../src/static/shell/surfaces/abstract-surface.js'
import { MarkdownSurface } from '../src/static/shell/surfaces/markdown-surface.js'
import { WysiwygSurface } from '../src/static/shell/surfaces/wysiwyg-surface.js'
import { buildBlocksHTML } from '../src/static/block/block-render.js'
import { schema as fxSchema, build, docWithCaret, docWithCaretAt, docWithRange, docWithNodeSelection } from './helpers/editor-fixture.js'

// window.isMod is an index.html global in the app; provide it for keydown tests.
beforeEach(() => { window.isMod = (e) => !!(e.ctrlKey || e.metaKey) })
afterEach(() => { vi.useRealTimers() })

// ── MarkdownSurface ───────────────────────────────────────────────────────────

function mdDeps(overrides = {}) {
  return Object.assign({
    updateText: vi.fn(),
    requestReload: vi.fn(),
    takeInsertPos: vi.fn(() => null),
    notify: vi.fn(),
  }, overrides)
}

function mountMd(content = 'seed body', deps = mdDeps()) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const s = new MarkdownSurface(deps)
  s.mount(root, content)
  return { s, root, deps, textarea: root.querySelector('textarea.markdown-editor') }
}

function typeInto(textarea, value) {
  textarea.value = value
  textarea.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('MarkdownSurface (P2.B)', () => {
  it('is an AbstractSurface with mode markdown and null tiptap', () => {
    const s = new MarkdownSurface(mdDeps())
    expect(s).toBeInstanceOf(AbstractSurface)
    expect(s.mode).toBe('markdown')
    expect(s.tiptap).toBeNull()
  })

  it('mount builds gutter + textarea under the root and seeds body', () => {
    const { s, root, textarea } = mountMd('hello world')
    expect(root.querySelector('.markdown-gutter')).toBeTruthy()
    expect(textarea).toBeTruthy()
    expect(textarea.value).toBe('hello world')
    expect(s.body).toBe('hello world')
  })

  it('input debounces 500ms then submits ONE domain updateText; body updates immediately', () => {
    vi.useFakeTimers()
    const { s, deps, textarea } = mountMd('a')
    typeInto(textarea, 'ab')
    expect(s.body).toBe('ab')            // body tracks the keystroke
    expect(deps.updateText).not.toHaveBeenCalled()
    vi.advanceTimersByTime(499)
    expect(deps.updateText).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(deps.updateText).toHaveBeenCalledTimes(1)
    // Domain-shaped: the raw markdown only — NO wire envelope, NO uuid.
    expect(deps.updateText).toHaveBeenCalledWith('ab')
  })

  it('input notifies the producer-named doc-changed event (no consumer knowledge)', () => {
    const { deps, textarea } = mountMd('a')
    typeInto(textarea, 'ab')
    expect(deps.notify).toHaveBeenCalledWith(SurfaceEvent.DOC_CHANGED)
    expect(Object.isFrozen(SurfaceEvent.DOC_CHANGED)).toBe(true)
  })

  it('flushPending cancels the timer and submits immediately; idle flush is a no-op', () => {
    vi.useFakeTimers()
    const { s, deps, textarea } = mountMd('a')
    s.flushPending()                      // idle → nothing
    expect(deps.updateText).not.toHaveBeenCalled()
    typeInto(textarea, 'abc')
    s.flushPending()                      // pending → immediate submit
    expect(deps.updateText).toHaveBeenCalledTimes(1)
    expect(deps.updateText).toHaveBeenCalledWith('abc')
    vi.advanceTimersByTime(1000)          // timer cancelled → no double-submit
    expect(deps.updateText).toHaveBeenCalledTimes(1)
  })

  it('applyServerOp(insert-block) appends the markdown, clears insert pos, submits the buffer', () => {
    const { s, deps, textarea } = mountMd('hello')
    s.applyServerOp({ type: 'insert-block', markdown: '```js\ncode\n```' })
    expect(deps.takeInsertPos).toHaveBeenCalledTimes(1)
    expect(s.body).toBe('hello\n\n```js\ncode\n```\n')
    expect(textarea.value).toBe(s.body)
    expect(deps.updateText).toHaveBeenCalledWith(s.body)
  })

  it('applyServerOp(replace-block) requests a reload; block-attrs-updated is a no-op', () => {
    const { s, deps } = mountMd('x')
    s.applyServerOp({ type: 'replace-block', oldId: 'a', newId: 'b' })
    expect(deps.requestReload).toHaveBeenCalledTimes(1)
    s.applyServerOp({ type: 'block-attrs-updated', id: 'a', attrs: { status: 'done' } })
    expect(deps.updateText).not.toHaveBeenCalled()
    expect(deps.requestReload).toHaveBeenCalledTimes(1) // unchanged
  })

  it('unmount removes the DOM and kills a pending debounce', () => {
    vi.useFakeTimers()
    const { s, root, deps, textarea } = mountMd('a')
    typeInto(textarea, 'ab')
    s.unmount()
    expect(root.children.length).toBe(0)
    vi.advanceTimersByTime(1000)
    expect(deps.updateText).not.toHaveBeenCalled()
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

  it('feedSelection reports a none descriptor (opaque buffer, no block model) — P3.A', () => {
    const s = new MarkdownSurface(mdDeps())
    expect(s.feedSelection()).toEqual({
      selectionType: 'none', caret: null, range: null, selectedText: null,
      blockId: null, blockIds: [], blockKind: null, ref: null, label: '',
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

function wyDeps(overrides = {}) {
  return Object.assign({
    applyBlockOps: vi.fn(),
    requestSave: vi.fn(),
    onPaste: vi.fn(() => false),
    onDrop: vi.fn(() => false),
    takeInsertPos: vi.fn(() => null),
    notify: vi.fn(),
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

// A surface whose live editor is injected (the mount path builds the real
// island in-app; these tests pin the applyServerOp contract on the instance).
class TestWysiwygSurface extends WysiwygSurface {
  constructor(uuid, deps, editor) { super(uuid, deps); this._ed = editor }
  get tiptap() { return this._ed }
}

function callShapeT(overrides = {}) {
  return Object.assign({
    ProseMirrorDOMParser: PMDOMParser,
    buildBlocksHTML: buildBlocksHTML,
    proseBlockNodes: (content) => { const out = []; content.forEach((n) => out.push(n)); return out },
    docPosForBlockIndex: vi.fn(() => 7),
    blockIndexAfter: vi.fn(() => -1),
    seedBaseline: (triples) => { const m = {}; triples.forEach((t) => { if (t.id) m[t.id] = t.content }); return m },
    serializeNode: () => 'ser',
    sieveBlockAttrs: (n) => n.attrs,
  }, overrides)
}

describe('WysiwygSurface.applyServerOp (P2.B call-shape, undo-sacred)', () => {
  beforeEach(() => vi.useFakeTimers()) // deferred focus/scroll callbacks never run

  it('insert-block at msg.index → TRACKED insertContentAt(docPosForBlockIndex(index))', () => {
    const T = callShapeT()
    const ed = fakeEditorOver(fxSchema, [build.p('one', 'b1')])
    const s = new TestWysiwygSurface('doc-1', wyDeps({ T }), ed)
    s.applyServerOp({ type: 'insert-block', kind: 'prose', id: 'srv-1', attrs: { id: 'srv-1', content: 'Hello' }, index: 1 })
    expect(T.docPosForBlockIndex).toHaveBeenCalledWith(ed.state.doc, 1)
    const ins = ed.calls.find((c) => c[0] === 'insertContentAt')
    expect(ins).toBeTruthy()
    expect(ins[1]).toBe(7)                    // the server's index, mapped — never a JS-chosen pos
    expect(ins[2].length).toBeGreaterThan(0)  // the server's node content
    expect(ed.dispatched.length).toBe(0)      // NO raw transaction — tracked command only
  })

  it('insert-block falls back to the captured numeric insert pos when no index', () => {
    const T = callShapeT()
    const ed = fakeEditorOver(fxSchema, [build.p('one', 'b1')])
    const deps = wyDeps({ T, takeInsertPos: vi.fn(() => 3) })
    const s = new TestWysiwygSurface('doc-1', deps, ed)
    s.applyServerOp({ type: 'insert-block', kind: 'prose', id: 'srv-2', attrs: { id: 'srv-2', content: 'Hi' } })
    expect(deps.takeInsertPos).toHaveBeenCalledTimes(1)
    const ins = ed.calls.find((c) => c[0] === 'insertContentAt')
    expect(ins[1]).toBe(3)
  })

  it('insert-block skip-if-present: an echoed id already in the DOM never re-inserts', () => {
    const T = callShapeT()
    const ed = fakeEditorOver(fxSchema, [build.p('one', 'srv-3')])
    ed.view.dom.innerHTML = '<p data-id="srv-3">one</p>'
    const s = new TestWysiwygSurface('doc-1', wyDeps({ T }), ed)
    s.applyServerOp({ type: 'insert-block', kind: 'prose', id: 'srv-3', attrs: { id: 'srv-3', content: 'one' }, index: 0 })
    expect(ed.calls.find((c) => c[0] === 'insertContentAt')).toBeUndefined()
  })

  it('insert-block token swap: setNodeMarkup with addToHistory:false, no insert', () => {
    const T = callShapeT()
    const p = tokSchema.nodes.paragraph.create({ id: '', token: 'tok-1' }, tokSchema.text('typed'))
    const ed = fakeEditorOver(tokSchema, [p])
    const s = new TestWysiwygSurface('doc-1', wyDeps({ T }), ed)
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
    const T = callShapeT()
    const ed = fakeEditorOver(tokSchema, [tokSchema.nodes.paragraph.create({ id: 'x', token: '' }, tokSchema.text('t'))])
    const deps = wyDeps({ T })
    const s = new TestWysiwygSurface('doc-1', deps, ed)
    s.applyServerOp({ type: 'insert-block', kind: 'prose', token: 'tok-gone', id: 'real-2' })
    // Domain-shaped: the delete-block op only — the WS envelope is NoteEditor's.
    expect(deps.applyBlockOps).toHaveBeenCalledWith([{ type: 'delete-block', blockId: 'real-2' }])
    expect(ed.dispatched.length).toBe(0)
    expect(ed.calls.find((c) => c[0] === 'insertContentAt')).toBeUndefined()
  })

  it('replace-block: TRACKED insertContentAt over the oldId range (undoable transform)', () => {
    const T = callShapeT()
    const first = build.p('first', 'old-1')
    const ed = fakeEditorOver(fxSchema, [first, build.p('second', 'keep-1')])
    const s = new TestWysiwygSurface('doc-1', wyDeps({ T }), ed)
    s.applyServerOp({ type: 'replace-block', oldId: 'old-1', newId: 'new-1', newKind: 'prose', attrs: { content: 'Replaced' } })
    const ins = ed.calls.find((c) => c[0] === 'insertContentAt')
    expect(ins).toBeTruthy()
    expect(ins[1]).toEqual({ from: 0, to: first.nodeSize }) // replace-by-id range
    expect(ed.dispatched.length).toBe(0)                    // tracked command, no raw tr
  })

  it('replace-block with unknown oldId does nothing', () => {
    const T = callShapeT()
    const ed = fakeEditorOver(fxSchema, [build.p('first', 'a')])
    const s = new TestWysiwygSurface('doc-1', wyDeps({ T }), ed)
    s.applyServerOp({ type: 'replace-block', oldId: 'nope', newId: 'new', newKind: 'prose', attrs: {} })
    expect(ed.calls.find((c) => c[0] === 'insertContentAt')).toBeUndefined()
  })

  it('block-attrs-updated: setNodeMarkup by id with addToHistory:false', () => {
    const T = callShapeT()
    const ed = fakeEditorOver(fxSchema, [build.sieveCode('blk-1'), build.p('txt', 'p1')])
    const s = new TestWysiwygSurface('doc-1', wyDeps({ T }), ed)
    s.applyServerOp({ type: 'block-attrs-updated', id: 'blk-1', attrs: { ref: 'r-9' } })
    expect(ed.dispatched.length).toBe(1)
    const tr = ed.dispatched[0]
    expect(tr.getMeta('addToHistory')).toBe(false)
    expect(tr.doc.child(0).attrs.ref).toBe('r-9')
  })

  it('applyServerOp without a live editor is a safe no-op', () => {
    const s = new TestWysiwygSurface('doc-1', wyDeps({ T: callShapeT() }), null)
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
    BlockChrome: {}, AiTargetDecoration: {}, AiBlockLegacy: {},
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
      this.commands = { insertContentAt: vi.fn(), focus: vi.fn() }
      this.destroyed = false
      this.destroy = () => { this.destroyed = true }
      if (opts.onCreate) opts.onCreate()
    },
  }
  return { T, editor: () => lastEditor }
}

describe('WysiwygSurface mount lifecycle (P2.B, recording bundle)', () => {
  beforeEach(() => vi.useFakeTimers())

  function mountWy() {
    const doc = fxSchema.nodes.doc.create(null, [build.p('one', 'b1')])
    const state = EditorState.create({ schema: fxSchema, doc })
    const { T, editor } = mountBundle(state)
    const deps = wyDeps({ T })
    const s = new WysiwygSurface('doc-1', deps)
    const root = document.createElement('div')
    document.body.appendChild(root)
    s.mount(root, { body: '', blocks: [] })
    return { s, root, deps, T, ed: editor() }
  }

  it('mount constructs the island on the root and exposes tiptap + window.__tiptap', () => {
    const { s, root, ed } = mountWy()
    expect(ed).toBeTruthy()
    expect(ed.options.element).toBe(root)
    expect(s.tiptap).toBe(ed)
    expect(window.__tiptap).toBe(ed)
    expect(s.mode).toBe('wysiwyg')
  })

  it('onUpdate debounces 500ms then submits granular block-domain ops', () => {
    const { deps, T, ed } = mountWy()
    ed.options.onUpdate({ editor: ed })
    expect(deps.applyBlockOps).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)
    expect(T.computeBlockSync).toHaveBeenCalledTimes(1)
    expect(deps.applyBlockOps).toHaveBeenCalledWith([{ type: 'update-block', blockId: 'b1' }])
  })

  it('onUpdate notifies doc-changed; selection/transaction/focus emit their events', () => {
    const { deps, ed } = mountWy()
    ed.options.onUpdate({ editor: ed })
    expect(deps.notify).toHaveBeenCalledWith(SurfaceEvent.DOC_CHANGED)
    ed.options.onSelectionUpdate({ editor: ed })
    expect(deps.notify).toHaveBeenCalledWith(SurfaceEvent.SELECTION_CHANGED)
    ed.options.onTransaction({ editor: ed })
    expect(deps.notify).toHaveBeenCalledWith(SurfaceEvent.TRANSACTION)
    ed.view.dom.dispatchEvent(new Event('focusin'))
    expect(deps.notify).toHaveBeenCalledWith(SurfaceEvent.FOCUS_CHANGED)
  })

  it('flushPending fires the pending sync immediately, exactly once', () => {
    const { s, deps, ed } = mountWy()
    ed.options.onUpdate({ editor: ed })
    s.flushPending()
    expect(deps.applyBlockOps).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(deps.applyBlockOps).toHaveBeenCalledTimes(1) // timer cancelled — no double sync
    s.flushPending()                                      // idle → no-op
    expect(deps.applyBlockOps).toHaveBeenCalledTimes(1)
  })

  it('unmount destroys the island, clears the root and window.__tiptap, kills the timer', () => {
    const { s, root, deps, ed } = mountWy()
    ed.options.onUpdate({ editor: ed })
    s.unmount()
    expect(ed.destroyed).toBe(true)
    expect(root.innerHTML).toBe('')
    expect(window.__tiptap).toBeNull()
    expect(s.tiptap).toBeNull()
    vi.advanceTimersByTime(1000)
    expect(deps.applyBlockOps).not.toHaveBeenCalled()
  })
})

describe('WysiwygSurface.feedSelection (P3.A raw descriptor from live PM)', () => {
  // Injects a real PM state (fixture) as the surface's live editor and reads
  // feedSelection — PLAIN strings only, no PM node escapes.
  function surfaceOver(fixture) {
    return new TestWysiwygSurface('doc-1', wyDeps(), fixture.editor)
  }

  it('no editor → a none descriptor', () => {
    const s = new TestWysiwygSurface('doc-1', wyDeps(), null)
    expect(s.feedSelection()).toEqual({
      selectionType: 'none', caret: null, range: null, selectedText: null,
      blockId: null, blockIds: [], blockKind: null, ref: null, label: '',
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
    expect(d.label).toBe('')
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
    // No PM node leaks into the plain descriptor.
    Object.values(d).forEach((v) => expect(typeof v !== 'object' || v === null || Array.isArray(v) || ('from' in v)).toBe(true))
  })
})

describe('WysiwygSurface.feedSelection richness (P3.B: block-range, dom-fold, multi-block)', () => {
  // Injects a fake TipTap bundle providing getBlockSelectionRange (block-chrome's
  // authoritative range) + domSelectionBlockRange (the read-only-region fold).
  // The surface reads BOTH through deps.T, never raw state.selection alone.
  function surfaceWith(fixture, T) {
    return new TestWysiwygSurface('doc-1', wyDeps({ T }), fixture.editor)
  }

  it('block-chrome multi-block range (isBlockRange) → range spanning every overlapped blockId', () => {
    // Three prose blocks; block-chrome reports a gutter range covering b1 + b2.
    const nodes = [build.p('alpha', 'b1'), build.p('beta', 'b2'), build.p('gamma', 'b3')]
    const fx = docWithCaret(nodes, 0, 0) // PM selection is a caret in b1; the block-range overrides
    // Doc positions: b1 [0..7), b2 [7..13), b3 [13..20) roughly — cover b1..b2.
    const b1End = nodes[0].nodeSize            // 7
    const T = {
      getBlockSelectionRange: () => ({ from: 1, to: b1End + 2, active: true, isBlockRange: true, isNodeSelection: false }),
      domSelectionBlockRange: () => null,
    }
    const d = surfaceWith(fx, T).feedSelection()
    expect(d.selectionType).toBe('range')          // block-range folds to 'range'
    expect(d.blockIds).toEqual(['b1', 'b2'])        // full overlap span
    expect(d.blockId).toBe('b1')                    // primary = first/head block
    expect(d.blockIds).toContain(d.blockId)         // blockIds ⊇ [blockId]
  })

  it('a single NodeSelection is still block (not folded to range)', () => {
    const fx = docWithNodeSelection([build.aiBlock('ai-1', 'r')], 0)
    // block-chrome falls back to the PM NodeSelection (isBlockRange:false).
    const sel = fx.editor.state.selection
    const T = {
      getBlockSelectionRange: () => ({ from: sel.from, to: sel.to, active: true, isBlockRange: false, isNodeSelection: true }),
      domSelectionBlockRange: () => null,
    }
    const d = surfaceWith(fx, T).feedSelection()
    expect(d.selectionType).toBe('block')
    expect(d.blockIds).toEqual(['ai-1'])
  })

  it('read-only-region DOM highlight (F5): domSelectionBlockRange fold → range on that block', () => {
    // PM selection is a caret in b1, but the user highlighted read-only text in b2.
    const nodes = [build.p('alpha', 'b1'), build.aiBlock('ai-2', 'r2')]
    const fx = docWithCaret(nodes, 0, 0)
    const b1End = nodes[0].nodeSize
    const T = {
      getBlockSelectionRange: () => ({ from: 1, to: 1, active: false, isBlockRange: false, isNodeSelection: false }),
      // The fold re-targets onto b2's range.
      domSelectionBlockRange: () => ({ from: b1End, to: b1End + nodes[1].nodeSize }),
    }
    // Stub window.getSelection so the surface can read the highlighted string.
    const prev = window.getSelection
    window.getSelection = () => ({ isCollapsed: false, toString: () => 'highlighted', rangeCount: 1 })
    try {
      const d = surfaceWith(fx, T).feedSelection()
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
    const T = {
      getBlockSelectionRange: () => ({ from: boundary, to: boundary, active: false, isBlockRange: false, isNodeSelection: false }),
      domSelectionBlockRange: () => null,
    }
    const d = surfaceWith(fx, T).feedSelection()
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
    const rangeT = (pos) => ({
      getBlockSelectionRange: () => ({ from: pos, to: pos, active: false, isBlockRange: false, isNodeSelection: false }),
      domSelectionBlockRange: () => null,
    })
    const atBoundary = surfaceWith(docWithCaretAt(nodes, boundary), rangeT(boundary)).feedSelection()
    const atInterior = surfaceWith(docWithCaretAt(nodes, interior), rangeT(interior)).feedSelection()
    // Both carets sit in co-48ef (the boundary caret STARTS co-48ef). blockId +
    // blockIds identical → the meaningful-diff won't fire on the 2→4 move.
    expect(atBoundary.blockId).toBe('co-48ef')
    expect(atInterior.blockId).toBe('co-48ef')
    expect(atBoundary.blockIds).toEqual(atInterior.blockIds)
  })

  it('no block-range and no dom fold → the P3.A single-block behaviour is preserved', () => {
    const fx = docWithRange([build.p('hello world', 'b1')], 2, 7)
    const T = {
      getBlockSelectionRange: () => ({ from: 2, to: 7, active: true, isBlockRange: false, isNodeSelection: false }),
      domSelectionBlockRange: () => null,
    }
    const prev = window.getSelection
    window.getSelection = () => ({ isCollapsed: true, toString: () => '', rangeCount: 0 })
    try {
      const d = surfaceWith(fx, T).feedSelection()
      expect(d.selectionType).toBe('range')
      expect(d.blockId).toBe('b1')
      expect(d.blockIds).toEqual(['b1'])
    } finally {
      window.getSelection = prev
    }
  })
})
