// surfaces.test.js — P2.B unit tests for the input-surface classes.
// Imports the REAL surface modules (dual-use ES modules). MarkdownSurface is
// exercised end-to-end (happy-dom textarea + fake timers). WysiwygSurface's
// applyContainerChange is exercised as CALL-SHAPE tests against real ProseMirror docs
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
// P4.F: the surfaces IMPORT `T` from lens/surfaces/tiptap-vendor.js (the shared
// globalThis.TipTap bag installed by test/setup.js) instead of taking a host.T
// seam. Tests seed the fake vendor members onto that bag (the established P4.E
// pattern — Object.assign(globalThis.TipTap, …), never reassign) and clear them
// after each test so a fake bundle never leaks forward.
vi.mock('../src/static/lens/extensions.js', () => ({
  SelectionHighlight: {}, HighlightMark: {},
  AiShortcuts: { configure: () => ({}) },
}))
vi.mock('../src/static/lens/document-editor/block-chrome.js', () => ({
  BlockChrome: {},
  getBlockSelectionRange: vi.fn((view) => {
    const sel = view.state.selection
    return { from: sel.from, to: sel.to, active: !sel.empty, isBlockRange: false, isNodeSelection: !!sel.node }
  }),
}))
vi.mock('../src/static/lens/document-editor/surfaces/ai-target-decoration.js', () => ({ AiTargetDecoration: {} }))
vi.mock('../src/static/lens/document-editor/surfaces/prose-block.js', () => ({ BlockId: {} }))
vi.mock('../src/static/lens/document-editor/surfaces/prose-group.js', () => ({
  ProseGroup: {},
  proseBlockNodes: vi.fn((content) => { const out = []; content.forEach((n) => out.push(n)); return out }),
}))
// Only the two PM-bound entry points are stubbed; the pure half (DEFAULT_POLICY,
// textInputEdit, applyTextEdit, handleSubstitutionGuard — which the markdown
// surface uses for its pair/substitution rules) comes through REAL, so these
// tests exercise the shipped transforms rather than a fake of them.
vi.mock('../src/static/lens/document-editor/interaction-policy.js', async (importOriginal) => ({
  ...(await importOriginal()),
  policyEnterKeydown: vi.fn(() => false),
  buildInteractionPolicyExtension: vi.fn(() => ({})),
}))
vi.mock('../src/static/lens/document-editor/surfaces/sieve-block-extension.js', () => ({
  getSieveNodes: vi.fn(() => []),
  getSieveBlockLabel: vi.fn(() => null),
  serializeNode: vi.fn(() => 'ser'),
  sieveBlockAttrs: vi.fn((n) => n.attrs),
  sieveBlockEntries: vi.fn(() => []),
  rendererFor: vi.fn(() => null),
}))
vi.mock('../src/static/lens/document-editor/block-selection.js', () => ({
  BlockSelection: { blockRange: vi.fn(() => null), textInside: vi.fn(() => null) },
}))
vi.mock('../src/static/lens/document-editor/block-sync.js', () => ({
  seedBaseline: vi.fn((triples) => { const m = {}; triples.forEach((t) => { if (t.id) m[t.id] = t.content }); return m }),
  computeBlockSync: vi.fn(() => ({ next: {}, ops: [] })),
  computeOrderOp: vi.fn(() => ({ op: null, next: null })),
}))
vi.mock('../src/static/lens/document-editor/surfaces/block-position.js', () => ({
  docPosForBlockIndex: vi.fn(() => 7),
  blockIndexAfter: vi.fn(() => -1),
}))
vi.mock('../src/static/lens/document-editor/paste-context.js', () => ({
  caretInRawTextBlock: vi.fn(() => false),
}))

import { AbstractSurface, SurfaceEvent } from '../src/static/lens/document-editor/surfaces/abstract-surface.js'
import { MarkdownSurface } from '../src/static/lens/document-editor/surfaces/markdown-surface.js'
import { WysiwygSurface } from '../src/static/lens/document-editor/surfaces/wysiwyg-surface.js'
import { SPELL_FEATURE } from '../src/static/lens/document-editor/surfaces/spell-decoration.js'
import { FIND_FEATURE } from '../src/static/lens/document-editor/surfaces/find-decoration.js'
import { buildBlocksHTML } from '../src/static/lens/document-editor/surfaces/block-render.js'
import { SieveBlock } from '../src/static/contract/sieve-block.js'
import { getBlockSelectionRange } from '../src/static/lens/document-editor/block-chrome.js'
import { BlockSelection } from '../src/static/lens/document-editor/block-selection.js'
import { computeBlockSync, computeOrderOp } from '../src/static/lens/document-editor/block-sync.js'
import { docPosForBlockIndex, blockIndexAfter } from '../src/static/lens/document-editor/surfaces/block-position.js'
import { caretInRawTextBlock } from '../src/static/lens/document-editor/paste-context.js'
import { ActionMacro } from '../src/static/shell/trigger-providers.js'
import { LensCapability } from '../src/static/contract/lens-capabilities.js'
import { policyEnterKeydown } from '../src/static/lens/document-editor/interaction-policy.js'
import { schema as fxSchema, build, docWithCaret, docWithCaretAt, docWithRange, docWithNodeSelection } from './helpers/editor-fixture.js'
// The REAL token rule: the chips pair against the surface's flat text with it,
// so a test asserting they agree must ask the same question they do.
import { MentionTokens } from '../src/static/renderers/mention-tokens.js'

// The trigger providers the surface builds are the REAL ones, recorded at
// construction: which of them a mount registers is what #mountTriggerPicker
// decides, and the only way to see that decision is to watch the constructions.
const triggerSpy = vi.hoisted(() => ({ /** @type {any[]} */ slash: [], /** @type {any[]} */ mention: [] }))
vi.mock('../src/static/shell/trigger-providers.js', async (importOriginal) => {
  const actual = /** @type {any} */ (await importOriginal())
  return Object.assign({}, actual, {
    SlashCommandProvider: class extends actual.SlashCommandProvider {
      constructor(commands, inScope) { super(commands, inScope); triggerSpy.slash.push({ commands, inScope }) }
    },
    MentionProvider: class extends actual.MentionProvider {
      constructor(source, onAccept, options) {
        super(source, onAccept, options)
        triggerSpy.mention.push({ source })
      }
    },
  })
})

// window.isMod is an index.html global in the app; provide it for keydown tests.
beforeEach(() => { window.isMod = (e) => !!(e.ctrlKey || e.metaKey) })
afterEach(() => { vi.useRealTimers() })

// The shared vendor bag (installed by test/setup.js; lens/surfaces/tiptap-vendor.js's `T`
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
// directly — onSurfaceEvent / setRawContent / reload.
function mdHost(overrides = {}) {
  return Object.assign({
    setRawContent: vi.fn(),
    reload: vi.fn(),
    onSurfaceEvent: vi.fn(),
  }, overrides)
}

/** A container stub: `blocks` maps id → {id, kind, attrs, text?}, in `order`. */
function containerOf(order, blocks) {
  return { getOrder: () => order, getBlock: (id) => blocks[id] || null }
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

  it('the FIRST cue only records what the container holds — the load is already in the buffer', () => {
    const { s, host } = mountMd('hello')
    s.applyContainerChange({ blockIds: ['a'], orderChanged: true },
      containerOf(['a'], { a: { id: 'a', kind: 'code', attrs: {}, text: '```js\nseeded\n```' } }))
    expect(s.body).toBe('hello')
    expect(host.setRawContent).not.toHaveBeenCalled()
  })

  it('a block ARRIVING appends its serialized form to the buffer and hands the buffer over', () => {
    // A dialog insert while the user is in markdown mode. The buffer is what gets
    // saved and what a flip back re-parses, so a block that reached only Go's tree
    // would be lost by both.
    const { s, host, textarea } = mountMd('hello')
    s.applyContainerChange({ blockIds: [], orderChanged: false }, containerOf([], {}))
    s.applyContainerChange({ blockIds: ['c1'], orderChanged: true },
      containerOf(['c1'], { c1: { id: 'c1', kind: 'code', attrs: {}, text: '```js\ncode\n```' } }))
    expect(s.body).toBe('hello\n\n```js\ncode\n```\n')
    expect(textarea.value).toBe(s.body)
    expect(host.setRawContent).toHaveBeenCalledWith(s.body)
  })

  it('appends a block ONCE, however many times its cue names it', () => {
    const { s, host } = mountMd('hello')
    s.applyContainerChange({ blockIds: [], orderChanged: false }, containerOf([], {}))
    const held = containerOf(['c1'], { c1: { id: 'c1', kind: 'code', attrs: {}, text: 'FENCE' } })
    s.applyContainerChange({ blockIds: ['c1'], orderChanged: true }, held)
    s.applyContainerChange({ blockIds: ['c1'], orderChanged: false }, held)
    expect(s.body).toBe('hello\n\nFENCE\n')
    expect(host.setRawContent).toHaveBeenCalledTimes(1)
  })

  it('a block LEAVING asks the host to reload — a verbatim buffer cannot express a removal', () => {
    const { s, host } = mountMd('x')
    s.applyContainerChange({ blockIds: [], orderChanged: false },
      containerOf(['a'], { a: { id: 'a', kind: 'code', attrs: {} } }))
    s.applyContainerChange({ blockIds: ['a'], orderChanged: true }, containerOf([], {}))
    expect(host.reload).toHaveBeenCalledTimes(1)
    expect(host.setRawContent).not.toHaveBeenCalled()
  })

  it('an attrs change has no raw-markdown representation and is correctly ignored', () => {
    const { s, host } = mountMd('x')
    const held = containerOf(['a'], { a: { id: 'a', kind: 'code', attrs: { status: 'PENDING' } } })
    s.applyContainerChange({ blockIds: [], orderChanged: false }, held)
    s.applyContainerChange({ blockIds: ['a'], orderChanged: false }, held)
    expect(host.setRawContent).not.toHaveBeenCalled()
    expect(host.reload).not.toHaveBeenCalled()
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

// ── WysiwygSurface: the container cue's placement (undo-history sacred) ───────

// A fake host (the parent editor): the wysiwyg surface calls its public API
// directly — onSurfaceEvent / flushSave, the insert-ANCHOR family, and the
// container `provider`, which is the whole of its outbound surface. `uuid` is
// read by the surface constructor; TestWysiwygSurface overrides it per call.
function wyHost(overrides = {}) {
  return Object.assign({
    // The ONE business dependency: a container provider. Every outbound intent —
    // block ops, the four paste kinds — leaves through it, and there is no
    // transport anywhere in the surface's reach.
    provider: {
      paste: vi.fn(() => Promise.resolve({ outcome: 'none' })),
      detectExtractions: vi.fn(() => Promise.resolve([])),
      requestAddBlock: vi.fn(),
      requestSetBlock: vi.fn(),
      requestRemoveBlock: vi.fn(),
      requestSetOrder: vi.fn(),
      subscribe: vi.fn(),
      unsubscribe: vi.fn(),
      getUuid: () => 'doc-1',
      getKind: () => 'note',
      getOrder: vi.fn(() => []),
      getBlock: vi.fn(() => null),
    },
    flushSave: vi.fn(),
    // The insert ANCHOR family: a surface names the block a new one should follow,
    // never a position. issue #33: paste/drop PEEK (side-effect-free) and consume
    // the empty-paragraph anchor only on a confirmed match.
    insertAnchorForBlock: vi.fn(() => null),
    peekInsertAnchorForBlock: vi.fn(() => ({ afterBlockId: null, anchor: null })),
    peekInsertAnchorAt: vi.fn(() => ({ afterBlockId: null, anchor: null })),
    consumeInsertAnchor: vi.fn(),
    onSurfaceEvent: vi.fn(),
    // The lens's published spec, which the surface reads to compose the `{`
    // picker. A note mount's answer: everything but `/`, which it is handed no
    // command service for.
    getCapabilities: () => NOTE_CAPS,
    // The base lens claims no key at all; a mount that claims one says so here.
    claimKey: () => false,
    uuid: 'doc-1',
  }, overrides)
}

/** What a NOTE mount publishes: a block-capable container, a mention service and
 *  no command service. The arrangement `macrosFor` must leave untouched. */
const NOTE_CAPS = Object.freeze({ markdown: true, mentions: true, commands: false, blocks: true })

/** What a COMPOSER mount publishes: a draft mints no blocks, and `/` is its own. */
const COMPOSER_CAPS = Object.freeze({ markdown: true, mentions: true, commands: true, blocks: false })

/** A host whose container speaks WHOLE-CONTENT only — a prompt has no block tree. */
function wyPromptHost(overrides = {}) {
  return wyHost(Object.assign({
    provider: {
      subscribe: vi.fn(), unsubscribe: vi.fn(),
      getUuid: () => 'prompt:p', getKind: () => 'prompt',
      getOrder: () => [], getBlock: () => null,
      getContents: vi.fn(), setContents: vi.fn(), flushContents: vi.fn(),
    },
    uuid: 'prompt:p',
  }, overrides))
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
// in-app; these tests pin the applyContainerChange contract on the instance). The uuid is
// merged into the host (the surface reads host.uuid, P4.F) so the ('doc-1', host,
// ed) call shape is preserved.
class TestWysiwygSurface extends WysiwygSurface {
  constructor(uuid, host, editor) { super(Object.assign(host, { uuid })); this._ed = editor }
  get editorPane() { return this._ed }
}

describe('WysiwygSurface.applyContainerChange (placement, undo-sacred)', () => {
  // The render pipeline (#blockToNodes) reads ProseMirrorDOMParser off the
  // imported `T` (the shared vendor bag) — seed it: the ONE vendor member the
  // placement path needs.
  beforeEach(() => {
    vi.useFakeTimers() // deferred focus/scroll callbacks never run
    seedVendor({ ProseMirrorDOMParser: PMDOMParser })
  })

  /**
   * A surface already past its bootstrap paint, so the cues below are DELTAS.
   * The paint's own transaction is cleared off the recorder — it is the load
   * semantics, pinned separately, and would otherwise be counted as placement.
   */
  function painted(ed, host = wyHost()) {
    const s = new TestWysiwygSurface('doc-1', host, ed)
    s.paintContainer(containerOf([], {}))
    ed.dispatched.length = 0
    ed.calls.length = 0
    return s
  }

  const cue = (blockIds, orderChanged = false, replaced = []) => ({ blockIds, orderChanged, replaced })

  it('a block the doc does not hold is PLACED at its container index, TRACKED', () => {
    const ed = fakeEditorOver(fxSchema, [build.p('one', 'b1')])
    const s = painted(ed)
    s.applyContainerChange(cue(['srv-1']), containerOf(['b1', 'srv-1'], {
      'srv-1': { id: 'srv-1', kind: 'prose', attrs: { id: 'srv-1', content: 'Hello' } },
    }))
    expect(docPosForBlockIndex).toHaveBeenCalledWith(ed.state.doc, 1)
    const ins = ed.calls.find((c) => c[0] === 'insertContentAt')
    expect(ins).toBeTruthy()
    expect(ins[1]).toBe(7)                    // the container's index, mapped — never a JS-chosen pos
    expect(ins[2].length).toBeGreaterThan(0)  // the server's node content
    expect(ed.dispatched.length).toBe(0)      // NO raw transaction — tracked command only
  })

  it('a block the doc ALREADY holds is never re-placed — the lens drew it', () => {
    // A prose block the user typed: the lens named it, Go echoed it back. There
    // is nothing to insert, and inserting would duplicate the paragraph.
    const ed = fakeEditorOver(fxSchema, [build.p('one', 'srv-3')])
    const s = painted(ed)
    s.applyContainerChange(cue(['srv-3']), containerOf(['srv-3'], {
      'srv-3': { id: 'srv-3', kind: 'prose', attrs: { id: 'srv-3', content: 'one' } },
    }))
    expect(ed.calls.find((c) => c[0] === 'insertContentAt')).toBeUndefined()
    expect(ed.dispatched.length).toBe(0)
  })

  it("a prose block the doc holds is NOT repainted — the lens owns its own text", () => {
    const ed = fakeEditorOver(fxSchema, [build.p('typed so far', 'p1')])
    const s = painted(ed)
    s.applyContainerChange(cue(['p1']), containerOf(['p1'], {
      p1: { id: 'p1', kind: 'prose', attrs: { id: 'p1', content: 'what Go last heard' } },
    }))
    expect(ed.dispatched.length).toBe(0)
    expect(ed.calls.find((c) => c[0] === 'insertContentAt')).toBeUndefined()
  })

  // The skip above is about text the lens is legitimately AHEAD of Go on. A
  // REPLACED block is the other case entirely: Go executed the rewrite — a
  // spelling correction the user asked for — so its text is the authoritative
  // one, and prose is placed by id like every other kind.
  it('a prose block the container REPLACED is placed by id — TRACKED, so the rewrite is undoable', () => {
    const held = build.p('teh cat', 'p1')
    const ed = fakeEditorOver(fxSchema, [held])
    const s = painted(ed)
    s.applyContainerChange(cue(['p1'], false, ['p1']), containerOf(['p1'], {
      p1: { id: 'p1', kind: 'prose', attrs: { id: 'p1', content: 'the cat' } },
    }))
    const ins = ed.calls.find((c) => c[0] === 'insertContentAt')
    expect(ins).toBeTruthy()
    expect(ins[1]).toEqual({ from: 0, to: held.nodeSize }) // replace-by-id range
    expect(JSON.stringify(ins[2])).toContain('the cat')    // the server's content, not the doc's
    expect(ed.dispatched.length).toBe(0)                   // tracked command, never addToHistory:false
  })

  // A reference declaring a `rel` is a QUESTION ELEMENT — the role stamp a
  // composer gesture mints — and no surface paints one: it belongs to the
  // question some block IS, not to the text being written. A document's own
  // references carry an EMPTY `rel`, so they stay body and place like the kinds
  // above.
  it('a reference declaring a rel is NOT painted — it is a question element, not body', () => {
    const ed = fakeEditorOver(fxSchema, [build.p('one', 'b1')])
    const s = painted(ed)
    s.applyContainerChange(cue(['att-1'], true), containerOf(['b1', 'att-1'], {
      'att-1': {
        id: 'att-1',
        kind: 'reference',
        attrs: { id: 'att-1', uri: 'sieve://other', rel: 'attach', cache: { title: 'Auth Design' } },
      },
    }))
    expect(ed.calls.find((c) => c[0] === 'insertContentAt')).toBeUndefined()
    expect(ed.dispatched.length).toBe(0)
  })

  it('a block whose KIND changed is replaced by id — TRACKED, so a transform is undoable', () => {
    const first = build.sieveCode('blk-1')
    const ed = fakeEditorOver(fxSchema, [first, build.p('second', 'keep-1')])
    const s = painted(ed)
    s.applyContainerChange(cue(['blk-1']), containerOf(['blk-1', 'keep-1'], {
      'blk-1': { id: 'blk-1', kind: 'prose', attrs: { id: 'blk-1', content: 'Replaced' } },
    }))
    const ins = ed.calls.find((c) => c[0] === 'insertContentAt')
    expect(ins).toBeTruthy()
    expect(ins[1]).toEqual({ from: 0, to: first.nodeSize }) // replace-by-id range
    expect(ed.dispatched.length).toBe(0)                    // tracked command, no raw tr
  })

  it("a block that LEFT the container is removed UNTRACKED — it is not this user's edit", () => {
    const gone = build.sieveCode('blk-1')
    const ed = fakeEditorOver(fxSchema, [gone, build.p('second', 'keep-1')])
    const s = painted(ed)
    s.applyContainerChange(cue(['blk-1'], true), containerOf(['keep-1'], {
      'keep-1': { id: 'keep-1', kind: 'prose', attrs: { id: 'keep-1' } },
    }))
    expect(ed.dispatched.length).toBeGreaterThan(0)
    expect(ed.dispatched[0].getMeta('addToHistory')).toBe(false)
    expect(ed.dispatched[0].doc.childCount).toBe(1)
  })

  it('an attrs change on a structured block is setNodeMarkup by id, addToHistory:false', () => {
    const ed = fakeEditorOver(fxSchema, [build.sieveCode('blk-1'), build.p('txt', 'p1')])
    const s = painted(ed)
    s.applyContainerChange(cue(['blk-1']), containerOf(['blk-1', 'p1'], {
      'blk-1': { id: 'blk-1', kind: 'code', attrs: { id: 'blk-1', ref: 'r-9' } },
    }))
    expect(ed.dispatched.length).toBe(1)
    const tr = ed.dispatched[0]
    expect(tr.getMeta('addToHistory')).toBe(false)
    expect(tr.doc.child(0).attrs.ref).toBe('r-9')
  })

  it('a cue naming a block NEITHER side holds does nothing at all', () => {
    const ed = fakeEditorOver(fxSchema, [build.p('first', 'a')])
    const s = painted(ed)
    s.applyContainerChange(cue(['nope']), containerOf(['a'], { a: { id: 'a', kind: 'prose', attrs: {} } }))
    expect(ed.calls.find((c) => c[0] === 'insertContentAt')).toBeUndefined()
    expect(ed.dispatched.length).toBe(0)
  })

  it('a cue without a live editor is a safe no-op', () => {
    const s = new TestWysiwygSurface('doc-1', wyHost(), null)
    expect(() => s.applyContainerChange(cue(['x']), containerOf([], {}))).not.toThrow()
  })

  it('the FIRST cue paints the whole container — bootstrap is just the first cue', () => {
    const ed = fakeEditorOver(fxSchema, [build.p('stale', 'old')])
    const s = new TestWysiwygSurface('doc-1', wyHost(), ed) // never painted
    s.applyContainerChange(cue(['n1'], true), containerOf(['n1'], {
      n1: { id: 'n1', kind: 'prose', attrs: { id: 'n1', content: 'fresh' } },
    }))
    // One whole-document replace, non-undoable — the load semantics, and the ONE
    // place they are legitimate.
    expect(ed.dispatched.length).toBe(1)
    expect(ed.dispatched[0].getMeta('addToHistory')).toBe(false)
  })

  it('re-orders the doc to match the container, UNTRACKED, only when the sets already agree', () => {
    const ed = fakeEditorOver(fxSchema, [build.p('one', 'b1'), build.p('two', 'b2')])
    const s = painted(ed)
    const held = {
      b1: { id: 'b1', kind: 'prose', attrs: {} },
      b2: { id: 'b2', kind: 'prose', attrs: {} },
    }
    s.applyContainerChange(cue([], true), containerOf(['b2', 'b1'], held))
    expect(ed.dispatched.length).toBe(1)
    expect(ed.dispatched[0].getMeta('addToHistory')).toBe(false)
    expect(ed.dispatched[0].doc.child(0).attrs.id).toBe('b2')
  })

  it('leaves the order alone while the doc holds something the container does not', () => {
    // A create still in flight, or the trailing editing surface: the two lists
    // describe different things, and reordering against the shorter one would
    // move a block past something the container cannot see.
    const ed = fakeEditorOver(fxSchema, [build.p('one', 'b1'), build.p('pending', '')])
    const s = painted(ed)
    s.applyContainerChange(cue([], true), containerOf(['b1', 'b2'], {
      b1: { id: 'b1', kind: 'prose', attrs: {} },
      b2: { id: 'b2', kind: 'prose', attrs: {} },
    }))
    expect(ed.dispatched.length).toBe(0)
  })

  it('says nothing when the doc is already in the container order', () => {
    const ed = fakeEditorOver(fxSchema, [build.p('one', 'b1'), build.p('two', 'b2')])
    const s = painted(ed)
    s.applyContainerChange(cue([], true), containerOf(['b1', 'b2'], {
      b1: { id: 'b1', kind: 'prose', attrs: {} },
      b2: { id: 'b2', kind: 'prose', attrs: {} },
    }))
    expect(ed.dispatched.length).toBe(0)
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
    // A real PluginKey reads its plugin's own state out of the editor state; this
    // one reads the slot its name gives it, which is the same relationship — and
    // is what lets a test stage what a decoration set is holding.
    PluginKey: function (name) { this.name = name; this.getState = (s) => (s && s[name]) || null },
    DecorationSet: { empty: [], create: () => [] },
    Decoration: { node: () => ({}), inline: () => ({}) },
    StarterKit: ext, Placeholder: ext, Table: ext, Image: ext, Markdown: ext,
    AiShortcuts: ext, TaskItem: ext,
    TableRow: {}, TableHeader: {}, TableCell: {}, TaskList: {},
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
      this.view = { dom: document.createElement('div'), dispatch: vi.fn(), state: state }
      this.storage = { markdown: { parser: { md: { render: (t) => t } } } }
      // The event seam a real Editor carries: the surface's trigger picker
      // subscribes to `update`/`blur` through it on every mount.
      this.handlers = {}
      this.on = (event, fn) => { (this.handlers[event] = this.handlers[event] || []).push(fn) }
      this.off = (event, fn) => {
        this.handlers[event] = (this.handlers[event] || []).filter((h) => h !== fn)
      }
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

  function mountWy(host = wyHost()) {
    const doc = fxSchema.nodes.doc.create(null, [build.p('one', 'b1')])
    const state = EditorState.create({ schema: fxSchema, doc })
    const { T, editor } = mountBundle(state)
    seedVendor(T) // the surface imports T from the vendor bag (P4.F) — seed the fake bundle
    const s = new WysiwygSurface(host)
    const root = document.createElement('div')
    document.body.appendChild(root)
    s.mount(root, null)
    return { s, root, host, T, ed: editor() }
  }

  // WHOSE MARKS THIS SURFACE DRAWS. Marks arrive for every switched-on producer,
  // and this surface has a decoration set per producer it can draw: anything
  // else is dropped, because there is nothing here that knows how to draw it.
  // The filter is the surface's own, since the surface owns the decoration sets.
  describe('the marks this mount draws', () => {
    const mark = { locator: 'content', quote: 'teh', occurrence: 0, grain: 'word', class: 'prose', suggestions: [] }

    it.each([
      ['spelling squiggles', SPELL_FEATURE, 1],
      ['find highlights', FIND_FEATURE, 1],
      ['a producer nothing here can draw', 'nonesuch', 0],
    ])('%s → %i dispatch', (_name, feature, dispatches) => {
      const { s, ed } = mountWy()
      s.setTextMarks(feature, 'b1', [mark])
      expect(ed.view.dispatch).toHaveBeenCalledTimes(dispatches)
    })

    // AND WHAT IT ADVERTISES IS ALL OF THEM. The selection descriptor carries
    // every set's marks under the caret in one flat list, each stamped with the
    // feature that drew it, and a consumer filters. The plugin states are staged
    // directly: which marks resolve where is spell-marks.test.js's business.
    /** @param {string} blockId */
    const held = (blockId) => ({
      hits: [{ blockId: blockId, mark: mark, ranges: [{ from: 1, to: 4 }] }],
    })

    it('advertises EVERY set\'s marks under the caret, each stamped with its feature', () => {
      const { s, ed } = mountWy()
      ed.state.sieveSpellDecoration = held('b1')
      ed.state.sieveFindDecoration = held('b1')
      const marks = s.feedSelection().textMarks
      expect(marks.map((/** @type {any} */ m) => m.feature)).toEqual([SPELL_FEATURE, FIND_FEATURE])
      expect(marks.map((/** @type {any} */ m) => m.quote)).toEqual(['teh', 'teh'])
      expect(marks.every((/** @type {any} */ m) => m.blockId === 'b1')).toBe(true)
    })

    it('advertises the sets that have something there, and nothing at all from the rest', () => {
      const { s, ed } = mountWy()
      ed.state.sieveFindDecoration = held('b1')
      expect(s.feedSelection().textMarks.map((/** @type {any} */ m) => m.feature)).toEqual([FIND_FEATURE])
    })

    it('advertises none where no set is drawing anything under the caret', () => {
      const { s } = mountWy()
      expect(s.feedSelection().textMarks).toEqual([])
    })
  })

  // THE TRIGGERS ONE MOUNT ANSWERS TO (#118). `{` is unconditional; `@` and `/`
  // are each registered only for a mount actually handed the service behind them.
  describe('the trigger picker this mount builds', () => {
    beforeEach(() => { triggerSpy.slash.length = 0; triggerSpy.mention.length = 0 })

    it('registers neither `@` nor `/` for a mount handed neither service', () => {
      mountWy()
      expect(triggerSpy.mention).toEqual([])
      expect(triggerSpy.slash).toEqual([])
    })

    it('registers `@` against the mention service it was handed', () => {
      const mentionService = { search: () => Promise.resolve([]) }
      mountWy(wyHost({ mentionService }))
      expect(triggerSpy.mention.map((m) => m.source)).toEqual([mentionService])
      expect(triggerSpy.slash).toEqual([])
    })

    it('registers `/` against the command service it was handed, scoped by a predicate', () => {
      const commandService = { list: () => [] }
      mountWy(wyHost({ commandService, getCapabilities: () => COMPOSER_CAPS }))
      expect(triggerSpy.slash).toHaveLength(1)
      expect(triggerSpy.slash[0].commands).toBe(commandService)
      expect(typeof triggerSpy.slash[0].inScope).toBe('function')
    })
  })

  // ── THE MOUNT'S OWN KEY CLAIMS (#118 2c) ──────────────────────────────────
  //
  // A claim is resolved BY FOCUS, and by construction: this hook fires on the
  // view the keystroke landed in, so what these pin is the ORDER inside one
  // mount — the claim runs pre-core, ahead of the Enter family's own pre-core
  // routing, and a mount that claims nothing changes nothing.
  describe('the key claims this mount makes', () => {
    beforeEach(() => { vi.mocked(policyEnterKeydown).mockClear() })
    const keydown = (key) => ({ key, preventDefault: vi.fn(), shiftKey: false, altKey: false, metaKey: false, ctrlKey: false })

    it('asks the LENS first, and consumes the key it claims', () => {
      const claimKey = vi.fn(() => true)
      const { ed } = mountWy(wyHost({ claimKey }))
      const event = keydown('Enter')
      expect(ed.options.editorProps.handleKeyDown(ed.view, event)).toBe(true)
      expect(claimKey).toHaveBeenCalledWith(event)
      expect(event.preventDefault).toHaveBeenCalled()
      // The policy never saw it: a claimed key is settled before the Enter family.
      expect(policyEnterKeydown).not.toHaveBeenCalled()
    })

    it('a mount that claims NOTHING leaves the Enter family exactly where it was', () => {
      const claimKey = vi.fn(() => false)
      const { ed } = mountWy(wyHost({ claimKey }))
      const event = keydown('Enter')
      ed.options.editorProps.handleKeyDown(ed.view, event)
      expect(claimKey).toHaveBeenCalled()
      expect(event.preventDefault).not.toHaveBeenCalled()
      expect(policyEnterKeydown).toHaveBeenCalled()
    })

    it('the claim is asked of EVERY key, not only Enter — a mount decides what it owns', () => {
      const claimKey = vi.fn(() => false)
      const { ed } = mountWy(wyHost({ claimKey }))
      for (const key of ['Escape', 'Tab', 'a']) {
        ed.options.editorProps.handleKeyDown(ed.view, keydown(key))
      }
      expect(claimKey.mock.calls.map((c) => c[0].key)).toEqual(['Escape', 'Tab', 'a'])
    })
  })

  // ── THE FLAT TEXT A CHIP ROW READS (#118 2d) ──────────────────────────────
  describe('the surface as a message someone else can read and edit', () => {
    it('reads its text blocks as ONE string, joined by newlines', () => {
      const doc = fxSchema.nodes.doc.create(null, [build.p('one', 'b1'), build.p('two', 'b2')])
      const { s } = mountWy()
      s.editorPane.state = EditorState.create({ schema: fxSchema, doc })
      expect(s.plainText()).toBe('one\ntwo')
    })

    it('cuts a span back out of that string, as one dispatched edit', () => {
      const doc = fxSchema.nodes.doc.create(null, [build.p('ask @Auth about it', 'b1')])
      const { s } = mountWy()
      const state = EditorState.create({ schema: fxSchema, doc })
      s.editorPane.state = state
      s.deletePlainRange(4, 10)                     // '@Auth '
      const [tr] = s.editorPane.view.dispatch.mock.calls[0]
      expect(tr.doc.textContent).toBe('ask about it')
    })

    it('an empty range dispatches nothing', () => {
      const { s } = mountWy()
      s.editorPane.view.dispatch.mockClear()
      s.deletePlainRange(3, 3)
      expect(s.editorPane.view.dispatch).not.toHaveBeenCalled()
    })

    // A hard break costs a document position and contributes nothing to
    // `textContent`, so a flat reading built off `textContent` drifts one place
    // per Shift+Enter — and the chips, which pair against that reading, drift
    // with it while the mark stays exact. These pin the two ways that showed.
    describe('a hard break is a character of the message', () => {
      /** @param {any[]} content */
      const over = (content) => {
        const doc = fxSchema.nodes.doc.create(null, [build.inline(content, 'b1')])
        const { s } = mountWy()
        s.editorPane.state = EditorState.create({ schema: fxSchema, doc })
        return s
      }

      it('reads as a NEWLINE, so a token opening the second line is a token', () => {
        const s = over([build.text('see:'), build.br(), build.text('@Notes')])
        expect(s.plainText()).toBe('see:\n@Notes')
        // The boundary character is the break, not the `:` the old reading glued on.
        expect(MentionTokens.spans(s.plainText(), 'Notes')).toEqual([{ start: 5, end: 11 }])
      })

      it('cuts the token the flat reading names, not the character before it', () => {
        const s = over([build.br(), build.text('@Notes here')])
        expect(s.plainText()).toBe('\n@Notes here')
        const [span] = MentionTokens.spans(s.plainText(), 'Notes')
        s.deletePlainRange(span.start, span.end)
        const [tr] = s.editorPane.view.dispatch.mock.calls[0]
        expect(tr.doc.textContent).toBe(' here')
        expect(tr.doc.firstChild.firstChild.type.name).toBe('hardBreak')
      })

      it('is itself cuttable, as the one character it reads as', () => {
        const s = over([build.text('ask'), build.br(), build.text('now')])
        s.deletePlainRange(3, 4)
        const [tr] = s.editorPane.view.dispatch.mock.calls[0]
        expect(tr.doc.textContent).toBe('asknow')
        expect(tr.doc.firstChild.childCount).toBe(1)
      })
    })

    // The newline BETWEEN two blocks is one the reading invents: no position
    // holds it, so a cut spanning it must not join the blocks.
    it('a cut across two blocks takes the text and leaves the blocks', () => {
      const doc = fxSchema.nodes.doc.create(null, [build.p('one', 'b1'), build.p('two', 'b2')])
      const { s } = mountWy()
      s.editorPane.state = EditorState.create({ schema: fxSchema, doc })
      s.deletePlainRange(2, 5)                      // 'e', the newline, 't'
      const [tr] = s.editorPane.view.dispatch.mock.calls[0]
      expect(tr.doc.childCount).toBe(2)
      expect(tr.doc.child(0).textContent).toBe('on')
      expect(tr.doc.child(1).textContent).toBe('wo')
    })
  })

  it('mount constructs the island on the root and exposes editorPane + window.__tiptap', () => {
    const { s, root, ed } = mountWy()
    expect(ed).toBeTruthy()
    expect(ed.options.element).toBe(root)
    expect(s.editorPane).toBe(ed)
    expect(window.__tiptap).toBe(ed)
    expect(s.mode).toBe('wysiwyg')
  })

  // The global names THE DOCUMENT pane: block-chrome and the app menu read it,
  // so a draft mounted elsewhere on the page must not aim them at itself.
  it('a mount that holds NO blocks leaves window.__tiptap alone', () => {
    const { ed } = mountWy()
    expect(window.__tiptap).toBe(ed)          // the document mount claimed it
    const draft = mountWy(wyHost({ getCapabilities: () => COMPOSER_CAPS }))
    expect(window.__tiptap).toBe(ed)          // …and the draft left it there
    draft.s.unmount()
    expect(window.__tiptap).toBe(ed)          // nor did unmounting the draft clear it
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
    // A block capability (ctx.getEditor) reaches the Editor through
    // editorPane.sieveHost — the pane the surface built, stamped with its host.
    const { host, ed } = mountWy()
    expect(ed.sieveHost).toBe(host)
  })

  it('mount stamps the CONTAINER PROVIDER onto the pane — a NodeView reaches no transport', () => {
    const { host, ed } = mountWy()
    expect(ed.blockProvider).toBe(host.provider)
  })

  it('mount paints NOTHING — the container\'s bootstrap cue is what paints', () => {
    const { s, ed } = mountWy()
    expect(ed.view.dispatch).not.toHaveBeenCalled()
    // …and the surface says so, by subscribing rather than by having been handed
    // a block list: nothing was passed to mount at all.
    expect(s.editorPane).toBe(ed)
  })

  it('onUpdate debounces 500ms then submits granular block intents through the provider', () => {
    vi.mocked(computeBlockSync).mockReturnValue({ next: {}, ops: [{ type: 'update-block', blockId: 'b1', kind: 'prose', attrs: { content: 'x' } }] })
    const { host, ed } = mountWy()
    ed.options.onUpdate({ editor: ed })
    expect(host.provider.requestSetBlock).not.toHaveBeenCalled()
    vi.advanceTimersByTime(500)
    expect(computeBlockSync).toHaveBeenCalledTimes(1)
    expect(host.provider.requestSetBlock).toHaveBeenCalledWith('b1', { content: 'x' })
  })

  it('#submitOps maps the observer batch IN ORDER, and a create NAMES ITSELF', () => {
    const order = []
    const host = wyHost()
    host.provider.requestAddBlock = vi.fn((...a) => order.push(['add', ...a]))
    host.provider.requestSetBlock = vi.fn((...a) => order.push(['set', ...a]))
    host.provider.requestRemoveBlock = vi.fn((...a) => order.push(['remove', ...a]))
    vi.mocked(computeBlockSync).mockReturnValue({ next: {}, ops: [
      { type: 'create-block', blockId: 'pr-new', kind: 'prose', attrs: { content: 'new' }, index: 1 },
      { type: 'update-block', blockId: 'b1', kind: 'prose', attrs: { content: 'x' } },
      { type: 'delete-block', blockId: 'b2' },
    ] })
    const doc = fxSchema.nodes.doc.create(null, [build.p('one', 'b1')])
    const state = EditorState.create({ schema: fxSchema, doc })
    const bundle = mountBundle(state)
    seedVendor(bundle.T)
    const s = new WysiwygSurface(Object.assign(host, { uuid: 'doc-1' }))
    const root = document.createElement('div')
    document.body.appendChild(root)
    s.mount(root, null)
    const ed = bundle.editor()
    ed.options.onUpdate({ editor: ed })
    vi.advanceTimersByTime(500)
    // Emission order preserved exactly. The create carries the id the identity
    // plugin minted at birth, and an ANCHOR — the block it follows — never an index.
    expect(order).toEqual([
      ['add', 'prose', { content: 'new', id: 'pr-new' }, 'b1'],
      ['set', 'b1', { content: 'x' }],
      ['remove', 'b2'],
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

  it('a reorder submits ONE requestSetOrder, after the batch (#94)', () => {
    // The observer's signature is positionless, so order is reported separately —
    // and LAST, because set-order installs a COMPLETE order and must land after
    // this tick's creates and deletes have moved the server's set.
    vi.mocked(computeBlockSync).mockReturnValue({ next: {}, ops: [{ type: 'delete-block', blockId: 'gone' }] })
    vi.mocked(computeOrderOp).mockReturnValue({ op: { type: 'set-order', order: ['b1', 'b2'] }, next: ['b1', 'b2'] })
    const { host, ed } = mountWy()
    ed.options.onUpdate({ editor: ed })
    vi.advanceTimersByTime(500)
    expect(host.provider.requestSetOrder).toHaveBeenCalledWith(['b1', 'b2'])
    expect(host.provider.requestRemoveBlock.mock.invocationCallOrder[0])
      .toBeLessThan(host.provider.requestSetOrder.mock.invocationCallOrder[0])
  })

  it('sends nothing when neither content nor order moved', () => {
    vi.mocked(computeBlockSync).mockReturnValue({ next: {}, ops: [] })
    vi.mocked(computeOrderOp).mockReturnValue({ op: null, next: ['b1'] })
    const { host, ed } = mountWy()
    ed.options.onUpdate({ editor: ed })
    vi.advanceTimersByTime(500)
    expect(host.provider.requestSetOrder).not.toHaveBeenCalled()
    expect(host.provider.requestSetBlock).not.toHaveBeenCalled()
  })

  it('flushPending fires the pending sync immediately, exactly once', () => {
    vi.mocked(computeBlockSync).mockReturnValue({ next: {}, ops: [{ type: 'update-block', blockId: 'b1', kind: 'prose', attrs: { content: 'x' } }] })
    const { s, host, ed } = mountWy()
    ed.options.onUpdate({ editor: ed })
    s.flushPending()
    expect(host.provider.requestSetBlock).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(host.provider.requestSetBlock).toHaveBeenCalledTimes(1) // timer cancelled — no double sync
    s.flushPending()                                      // idle → no-op
    expect(host.provider.requestSetBlock).toHaveBeenCalledTimes(1)
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
    expect(host.provider.requestSetBlock).not.toHaveBeenCalled()
  })
})

// ── WysiwygSurface: #handleSmartPaste / #handleSmartDrop ──────────────────────
// The paste / drop pipelines are #private methods wired at
// editorProps.handlePaste / handleDrop. They ask the CONTAINER what to make of
// the gesture — ONE query, four payload kinds — and name where with an ANCHOR
// the host resolved, never an index. Undo-sacred: the local replay's
// insertContent stays a TRACKED command.

describe('WysiwygSurface #handleSmartPaste / #handleSmartDrop (P4.A)', () => {
  beforeEach(() => {
    // The moved code now reads the caretInRawTextBlock ES import (paste-context.js,
    // mocked above). Default false (a normal prose caret); tests override per-case.
    vi.mocked(caretInRawTextBlock).mockReturnValue(false)
  })

  // The surface speaks no transport at all: every gesture leaves through
  // provider.paste, and the tests stub that one query (wyHost's default answers
  // `none`; override per case).

  // Mount a real WysiwygSurface via the recording bundle; expose the editorProps
  // handlers (the wiring the editor gives ProseMirror) + the fake editor + host.
  function mountPaste(host = wyHost(), uuid = 'doc-1', opts = {}) {
    if (opts.caretInRawTextBlock) vi.mocked(caretInRawTextBlock).mockImplementation(opts.caretInRawTextBlock)
    const doc = fxSchema.nodes.doc.create(null, [build.p('one', 'b1')])
    const state = EditorState.create({ schema: fxSchema, doc })
    const bundle = mountBundle(state)
    seedVendor(bundle.T) // the surface imports T from the vendor bag
    const s = new WysiwygSurface(Object.assign(host, { uuid }))
    const root = document.createElement('div')
    document.body.appendChild(root)
    s.mount(root, null)
    const ed = bundle.editor()
    return { s, ed, host, props: ed.options.editorProps, uuid }
  }

  /** The kinds this host's provider was asked about, in order. */
  const pasteKinds = (host) => host.provider.paste.mock.calls.map((c) => c[0].kind)

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

  // A pasted ```ai-block fence is a block arriving in its own serialized form, so
  // it is a structural mutation and Go owns it (the ai-block processor claims its
  // own fence; the block comes back over insert-block). The surface used to
  // reconstruct the node itself — the one place a paste minted structure locally.
  it('a pasted ai-block fence goes to Go like any other paste — no local node is built', async () => {
    const host = wyHost({ peekInsertAnchorForBlock: vi.fn(() => ({ afterBlockId: 'b-2', anchor: null })) })
    host.provider.paste.mockReturnValue(Promise.resolve({ outcome: 'block', kind: 'ai-block', id: 'ab-9' }))
    const text = '```ai-block\nid: ab-1\nref: doc\nstatus: COMPLETE\n```'
    const strItem = { kind: 'string', type: 'text/plain', getAsString: (cb) => cb(text) }
    const { ed, props } = mountPaste(host, 'doc-1')
    const event = { clipboardData: Object.assign(clip({ text, items: [strItem] }), { items: [strItem] }), target: {}, preventDefault: vi.fn() }

    expect(props.handlePaste({}, event)).toBe(true)
    expect(event.preventDefault).toHaveBeenCalled()
    await new Promise((r) => setTimeout(r, 0))

    expect(host.provider.paste).toHaveBeenCalledWith(
      { kind: 'smart', entries: [{ mimeType: 'text/plain', content: text }] }, 'b-2')
    // Nothing local: the block is Go's to create and its render-back is what
    // renders it.
    expect(ed.commands.insertContent).not.toHaveBeenCalled()
  })

  it('caret in a raw-text block → returns false (native paste), no insert', () => {
    const { ed, props } = mountPaste(wyHost(), 'doc-1', { caretInRawTextBlock: () => true })
    const event = { clipboardData: clip({ text: 'plain' }), target: {}, preventDefault: vi.fn() }
    expect(props.handlePaste({}, event)).toBe(false)
    expect(ed.commands.insertContent).not.toHaveBeenCalled()
  })

  it('smart paste: PEEKS the anchor (side-effect-free), asks the container, consumes the anchor on outcome:block, returns true', async () => {
    const anchor = { id: 'p-1' }
    const host = wyHost({ peekInsertAnchorForBlock: vi.fn(() => ({ afterBlockId: 'b-4', anchor })) })
    host.provider.paste.mockReturnValue(Promise.resolve({ outcome: 'block', kind: 'code', id: 'co-1' }))
    const strItem = { kind: 'string', type: 'text/plain', getAsString: (cb) => cb('hello') }
    const { ed, props } = mountPaste(host, 'doc-1')
    const event = { clipboardData: Object.assign(clip({ text: 'hello', items: [strItem] }), { items: [strItem] }), target: {}, preventDefault: vi.fn() }
    const handled = props.handlePaste({}, event)
    expect(handled).toBe(true)
    expect(host.peekInsertAnchorForBlock).toHaveBeenCalledTimes(1)
    expect(host.insertAnchorForBlock).not.toHaveBeenCalled() // no EAGER consume
    expect(event.preventDefault).toHaveBeenCalled()
    await new Promise((r) => setTimeout(r, 0))
    expect(host.provider.paste).toHaveBeenCalledWith(expect.objectContaining({ kind: 'smart' }), 'b-4')
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
    const anchor = { id: 'p-1' }
    const host = wyHost({ peekInsertAnchorForBlock: vi.fn(() => ({ afterBlockId: 'b-0', anchor })) })
    host.provider.paste.mockReturnValue(Promise.resolve({ outcome: 'none' }))
    const strItem = { kind: 'string', type: 'text/plain', getAsString: (cb) => cb('hello') }
    const { ed, props } = mountPaste(host, 'doc-1')
    const event = { clipboardData: Object.assign(clip({ text: 'hello', items: [strItem] }), { items: [strItem] }), target: {}, preventDefault: vi.fn() }
    props.handlePaste({}, event)
    // Drain the async chain: Promise.all → fetch → r.json() → result handler.
    await new Promise((r) => setTimeout(r, 0))
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
    const anchor = { id: 'p-1' }
    const host = wyHost({ peekInsertAnchorForBlock: vi.fn(() => ({ afterBlockId: 'b-0', anchor })) })
    const frag = '<a href="https://example.com">Example Domain</a>'
    host.provider.paste.mockReturnValue(Promise.resolve({ outcome: 'content', content: frag }))
    const strItem = { kind: 'string', type: 'text/plain', getAsString: (cb) => cb('https://example.com') }
    const { ed, props } = mountPaste(host, 'doc-1')
    const event = { clipboardData: Object.assign(clip({ text: 'https://example.com', items: [strItem] }), { items: [strItem] }), target: {}, preventDefault: vi.fn() }
    expect(props.handlePaste({}, event)).toBe(true)
    await new Promise((r) => setTimeout(r, 0))
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
    ['content with no fragment', { outcome: 'content', content: '' }],
    ['a null body', null],
  ])('smart-paste degrades %s to the local replay (never a swallowed paste)', async (_label, result) => {
    const anchor = { id: 'p-1' }
    const host = wyHost({ peekInsertAnchorForBlock: vi.fn(() => ({ afterBlockId: 'b-0', anchor })) })
    host.provider.paste.mockReturnValue(Promise.resolve(result))
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
    host.provider.paste.mockReturnValue(Promise.resolve({ outcome: 'none' }))
    const strItem = { kind: 'string', type: 'text/plain', getAsString: (cb) => cb('hello') }
    const { ed, props } = mountPaste(host, 'doc-1')
    const event = { clipboardData: Object.assign(clip({ text: 'hello', html: '<p><b>hello</b></p>', items: [strItem] }), { items: [strItem] }), target: {}, preventDefault: vi.fn() }
    props.handlePaste({}, event)
    await new Promise((r) => setTimeout(r, 0))
    expect(ed.commands.insertContent).toHaveBeenCalledWith('<p><b>hello</b></p>')
  })

  it('a multi-block slice is the SAME query with kind:slice, anchored at the caret', () => {
    const host = wyHost({ insertAnchorForBlock: vi.fn(() => 'b-7') })
    const { props } = mountPaste(host, 'doc-1')
    const slice = [{ kind: 'prose', content: 'a' }, { kind: 'code', content: 'b' }]
    const event = { clipboardData: clip({ slice: JSON.stringify(slice) }), target: {}, preventDefault: vi.fn() }
    const handled = props.handlePaste({}, event)
    expect(handled).toBe(true)
    expect(event.preventDefault).toHaveBeenCalled()
    expect(host.provider.paste).toHaveBeenCalledWith({ kind: 'slice', slice }, 'b-7')
  })

  // ── The NATIVE CLIPBOARD (#87) ───────────────────────────────────────────────
  // Two paste shapes the page can see but cannot READ. A file-manager COPY offers
  // the same `text/uri-list` a desktop drag does, so it takes the drop verb; and a
  // screenshot copied by an ordinary desktop tool arrives as a DataTransfer that
  // exists and is completely empty, which no handler can salvage — so the
  // emptiness is the signal and Go reads the clipboard itself.
  describe('the native clipboard (#87)', () => {
    // A clipboard as WebKitGTK hands one over for a Spectacle screenshot.
    function emptyClip() {
      return { getData: () => '', types: [], items: [], files: [] }
    }
    function uriListClip(list) {
      return {
        getData: (mime) => (mime === 'text/uri-list' ? list : ''),
        types: ['text/uri-list'], items: [], files: [],
      }
    }

    it('an EMPTY DataTransfer → nativeClipboardPaste at the PEEKED caret index, and the gesture is claimed', async () => {
      const anchor = { id: 'p-1' }
      const host = wyHost({ peekInsertAnchorForBlock: vi.fn(() => ({ afterBlockId: 'b-4', anchor })) })
      host.provider.paste.mockReturnValue(
        Promise.resolve({ outcome: 'block', kind: 'smart-image', id: 'si-1' }))
      const { ed, props } = mountPaste(host, 'doc-1')
      const event = { clipboardData: emptyClip(), target: {}, preventDefault: vi.fn() }

      expect(props.handlePaste({}, event)).toBe(true)
      expect(event.preventDefault).toHaveBeenCalled()
      expect(host.insertAnchorForBlock).not.toHaveBeenCalled() // no EAGER consume
      await new Promise((r) => setTimeout(r, 0))
      // NO clipboard rides the payload: there was none to send, and that is the point.
      expect(host.provider.paste).toHaveBeenCalledWith({ kind: 'native-clipboard' }, 'b-4')
      expect(pasteKinds(host)).toEqual(['native-clipboard'])
      expect(host.consumeInsertAnchor).toHaveBeenCalledWith(anchor)
      expect(ed.commands.insertContent).not.toHaveBeenCalled()
    })

    it('an empty clipboard the server makes nothing of consumes no anchor and replays nothing', async () => {
      const anchor = { id: 'p-1' }
      const host = wyHost({ peekInsertAnchorForBlock: vi.fn(() => ({ afterBlockId: 'b-0', anchor })) })
      host.provider.paste.mockReturnValue(Promise.resolve({ outcome: 'none' }))
      const { ed, props } = mountPaste(host, 'doc-1')

      props.handlePaste({}, { clipboardData: emptyClip(), target: {}, preventDefault: vi.fn() })
      await new Promise((r) => setTimeout(r, 0))
      expect(host.consumeInsertAnchor).not.toHaveBeenCalled() // blank line preserved
      // The page never held the content, so there is nothing to put back.
      expect(ed.commands.insertContent).not.toHaveBeenCalled()
    })

    it('a COPIED FILE the page can name still goes to the NATIVE clipboard read', async () => {
      const host = wyHost({ peekInsertAnchorForBlock: vi.fn(() => ({ afterBlockId: 'b-4', anchor: null })) })
      host.provider.paste.mockReturnValue(Promise.resolve({ outcome: 'block' }))
      const { props } = mountPaste(host, 'doc-1')
      const event = { clipboardData: uriListClip('file:///home/u/report.pdf\r\n'), target: {}, preventDefault: vi.fn() }
      expect(props.handlePaste({}, event)).toBe(true)
      await new Promise((r) => setTimeout(r, 0))
      // One backend mechanism for every native gesture: the page's list is only
      // the recogniser; Go asks GTK for the clipboard's own uris.
      expect(host.provider.paste).toHaveBeenCalledWith({ kind: 'native-clipboard' }, 'b-4')
      expect(pasteKinds(host)).toEqual(['native-clipboard'])
    })

    it('a copied http URL is not a file — the ordinary pipeline still gets it', async () => {
      const host = wyHost()
      const { props } = mountPaste(host, 'doc-1')
      const strItem = { kind: 'string', type: 'text/uri-list', getAsString: (cb) => cb('https://example.com/page') }
      const event = {
        clipboardData: Object.assign(uriListClip('https://example.com/page\r\n'), { items: [strItem] }),
        target: {}, preventDefault: vi.fn(),
      }

      expect(props.handlePaste({}, event)).toBe(true)
      await new Promise((r) => setTimeout(r, 0))
      expect(pasteKinds(host)).toEqual(['smart'])
    })

    // The REGRESSION GUARD on the emptiness test. A DataTransfer that answers
    // getData while exposing no `types` still HAS content — reading the
    // collections alone would send every such paste to Go with nothing on it.
    // THE DOLPHIN-COPY SHAPE: flavours advertised, every getData '', no file
    // items. Advertised-but-unreadable is the native-read signal — Go asks GTK
    // for the uris itself.
    it('a copied file the page cannot read — types advertised, nothing readable — goes native', async () => {
      const host = wyHost({ peekInsertAnchorForBlock: vi.fn(() => ({ afterBlockId: 'b-4', anchor: null })) })
      host.provider.paste.mockReturnValue(Promise.resolve({ outcome: 'block' }))
      const { props } = mountPaste(host, 'doc-1')
      const event = {
        clipboardData: {
          types: ['text/uri-list', 'text/plain'],
          getData: () => '',
          items: [{ kind: 'string', type: 'text/uri-list', getAsString: () => {} }],
          files: [],
        },
        target: {}, preventDefault: vi.fn(),
      }
      expect(props.handlePaste({}, event)).toBe(true)
      await new Promise((r) => setTimeout(r, 0))
      expect(host.provider.paste).toHaveBeenCalledWith({ kind: 'native-clipboard' }, 'b-4')
      expect(pasteKinds(host)).toEqual(['native-clipboard'])
    })

    it('a clipboard that answers getData but lists no types is NOT empty', async () => {
      const host = wyHost()
      const { props } = mountPaste(host, 'doc-1')
      const strItem = { kind: 'string', type: 'text/plain', getAsString: (cb) => cb('hello') }
      const event = {
        clipboardData: Object.assign(clip({ text: 'hello' }), { items: [strItem] }),
        target: {}, preventDefault: vi.fn(),
      }

      expect(props.handlePaste({}, event)).toBe(true)
      await new Promise((r) => setTimeout(r, 0))
      expect(pasteKinds(host)).toEqual(['smart'])
    })

    it('a paste into a WHOLE-CONTENT container is left to PM — a prompt has no block tree', () => {
      // The exclusion is by TYPE, not by a uuid test: the provider carries no
      // paste query at all, because there is nothing to paste a block into.
      const host = wyPromptHost()
      const { props } = mountPaste(host, 'prompt:p')
      expect(props.handlePaste({}, { clipboardData: emptyClip(), target: {}, preventDefault: vi.fn() })).toBe(false)
      expect(props.handlePaste({}, {
        clipboardData: uriListClip('file:///a.png\r\n'), target: {}, preventDefault: vi.fn(),
      })).toBe(false)
      expect(host.provider.paste).toBeUndefined()
    })
  })

  // ── The DROP path (#86) ──────────────────────────────────────────────────────
  // WebKitGTK hands the page no readable File for a file-manager drag — only the
  // `text/uri-list` the OS put on the drag — so the surface owns the GESTURE and
  // the PLACEMENT and Go does the reading. These pin that split: what counts as a
  // desktop file drag, that the uri-list is forwarded verbatim, and that the
  // union is read exactly as the paste path reads it.

  // The ONE drop mechanism: every external drop is the GESTURE paging the
  // backend — the frame carries only the index, and Go redeems the native drop
  // bucket (Wails OnFileDrop). The page's view of the drop is never consulted;
  // dt models it only to prove that NOTHING in it matters.
  function dt(uriList = '') {
    return {
      types: uriList !== '' ? ['text/uri-list', 'text/html'] : ['text/plain'],
      getData: (mime) => (mime === 'text/uri-list' ? uriList : ''),
      items: [],
    }
  }

  function dropUriList(host, uriList, result) {
    host.provider.paste.mockReturnValue(Promise.resolve(result || { outcome: 'none' }))
    const { ed, props } = mountPaste(host, 'doc-1')
    ed.view.posAtCoords = () => ({ pos: 12 })
    ed.state.selection = { to: 0 }
    const event = { dataTransfer: dt(uriList), clientX: 1, clientY: 1, preventDefault: vi.fn() }
    return { ed, handled: props.handleDrop({}, event, null, false), event }
  }

  it('an external drop PEEKS insertIndexAt(dropPos), redeems the bucket with what it read as the hint', async () => {
    const host = wyHost({ peekInsertAnchorAt: vi.fn(() => ({ afterBlockId: 'b-9', anchor: null })) })
    const list = 'file:///home/u/swagger.yml\r\n'
    const { handled, event } = dropUriList(host, list, { outcome: 'block' })
    expect(handled).toBe(true)
    expect(host.peekInsertAnchorAt).toHaveBeenCalledWith(12)
    expect(host.insertAnchorForBlock).not.toHaveBeenCalled() // no EAGER consume on drop
    // Without this PM inserts the file:/// path as text — the whole #86 symptom.
    expect(event.preventDefault).toHaveBeenCalled()
    await new Promise((r) => setTimeout(r, 0))
    // The bucket is the source; readable text rides only as the bucket-miss hint.
    expect(host.provider.paste).toHaveBeenCalledWith(
      { kind: 'native-drop', entries: [{ mimeType: 'text/uri-list', content: list }] }, 'b-9')
  })

  it('a drop whose DataTransfer is COMPLETELY unreadable redeems with an empty hint', async () => {
    const host = wyHost({ peekInsertAnchorAt: vi.fn(() => ({ afterBlockId: 'b-9', anchor: null })) })
    const { handled, event } = dropUriList(host, '', { outcome: 'block' })
    expect(handled).toBe(true)
    expect(event.preventDefault).toHaveBeenCalled()
    await new Promise((r) => setTimeout(r, 0))
    expect(host.provider.paste).toHaveBeenCalledWith({ kind: 'native-drop', entries: [] }, 'b-9')
  })

  it('an internal PM drag (moved, or view.dragging) is never claimed', () => {
    const host = wyHost()
    const { ed, props } = mountPaste(host, 'doc-1')
    const event = { dataTransfer: { types: [], getData: () => '', items: [] }, clientX: 1, clientY: 1, preventDefault: vi.fn() }
    expect(props.handleDrop({}, event, { content: [] }, true)).toBe(false)
    ed.view.dragging = { slice: {}, move: false }
    expect(props.handleDrop({}, event, { content: [] }, false)).toBe(false)
    expect(host.provider.paste).not.toHaveBeenCalled()
  })

  // THE TRAP that shipped path-as-text: PM parses an external drop's text into a
  // slice too, so a non-null slice must NOT read as "internal" — and that slice
  // is ALSO the one readable view of a VSCode-style drop (WebKitGTK starves
  // getData for every flavour; PM got the text through WebKit's internal
  // channel), so its text rides the frame as the page hint.
  it('an external drop only the SLICE could read → claimed, slice text is the hint', async () => {
    const host = wyHost({ peekInsertAnchorAt: vi.fn(() => ({ afterBlockId: 'b-9', anchor: null })) })
    host.provider.paste.mockReturnValue(Promise.resolve({ outcome: 'block' }))
    const { ed, props } = mountPaste(host, 'doc-1')
    ed.view.posAtCoords = () => ({ pos: 12 })
    ed.view.dragging = null
    ed.state.selection = { to: 0 }
    const slice = { content: { size: 30, textBetween: () => '/home/u/dragged/handler.go' } }
    const event = { dataTransfer: { types: ['text/plain'], getData: () => '', items: [] }, clientX: 1, clientY: 1, preventDefault: vi.fn() }
    expect(props.handleDrop({}, event, slice, false)).toBe(true)
    expect(event.preventDefault).toHaveBeenCalled()
    await new Promise((r) => setTimeout(r, 0))
    expect(host.provider.paste).toHaveBeenCalledWith(
      { kind: 'native-drop', entries: [{ mimeType: 'text/plain', content: '/home/u/dragged/handler.go' }] }, 'b-9')
  })

  it('a drop into a WHOLE-CONTENT container is left to PM — a prompt has no block tree', () => {
    const host = wyPromptHost()
    const { props } = mountPaste(host, 'prompt:p')
    const event = { dataTransfer: dt('file:///a.png\r\n'), clientX: 1, clientY: 1, preventDefault: vi.fn() }
    expect(props.handleDrop({}, event, null, false)).toBe(false)
    expect(host.provider.paste).toBeUndefined()
  })

  // The drop handler reads the SAME union as paste, so its branch selection is
  // pinned the same way.
  describe('handleSmartDrop consumes the paste union', () => {
    const LIST = 'file:///home/u/x.png\r\n'

    it('outcome:block → consumes the anchor, inserts nothing locally', async () => {
      const anchor = { id: 'p-1' }
      const host = wyHost({ peekInsertAnchorAt: vi.fn(() => ({ afterBlockId: 'b-9', anchor })) })
      const { ed } = dropUriList(host, LIST, { outcome: 'block', kind: 'smart-image', id: 'si-1' })
      await new Promise((r) => setTimeout(r, 0))
      expect(host.consumeInsertAnchor).toHaveBeenCalledWith(anchor)
      expect(ed.commands.insertContentAt).not.toHaveBeenCalled()
    })

    it("outcome:content → inserts Go's fragment AT THE DROP POSITION, keeping the anchor", async () => {
      const anchor = { id: 'p-1' }
      const host = wyHost({ peekInsertAnchorAt: vi.fn(() => ({ afterBlockId: 'b-9', anchor })) })
      const frag = '<a href="https://example.com">Example Domain</a>'
      const { ed } = dropUriList(host, LIST, { outcome: 'content', content: frag })
      await new Promise((r) => setTimeout(r, 0))
      // 12 is posAtCoords — the DROP coordinate, never the caret.
      expect(ed.commands.insertContentAt).toHaveBeenCalledWith(12, frag)
      expect(host.consumeInsertAnchor).not.toHaveBeenCalled()
      expect(ed.commands.scrollIntoView).toHaveBeenCalled()
    })

    // A drag naming a file this machine no longer has answers `none`. The caret's
    // empty paragraph must survive it — which is what the PEEK is for.
    it('outcome:none → never touches the document (a drop has no clipboard to replay)', async () => {
      const host = wyHost({ peekInsertIndexAt: vi.fn(() => ({ index: 9, anchor: { id: 'p-1' } })) })
      const { ed } = dropUriList(host, LIST, { outcome: 'none' })
      await new Promise((r) => setTimeout(r, 0))
      expect(ed.commands.insertContentAt).not.toHaveBeenCalled()
      expect(ed.commands.insertContent).not.toHaveBeenCalled()
      expect(host.consumeInsertAnchor).not.toHaveBeenCalled()
    })
  })

  it('paste in a whole-content container: no round trip at all (returns false)', () => {
    const { props } = mountPaste(wyPromptHost(), 'prompt:p')
    const event = { clipboardData: clip({ text: 'plain', items: [] }), target: {}, preventDefault: vi.fn() }
    expect(props.handlePaste({}, event)).toBe(false)
  })

  // ── insertLink — the Insert-from-URL ladder's "Link" rung (#67) ──────────────
  // It is a CALLER of the paste path, not a second link-inserting mechanism: the
  // same paste query (which is what fetches the title in Go), the same
  // peek/consume anchor contract, the same decision reader. These pin that reuse —
  // a hand-rolled local `<a>` build would fail every one of them.
  describe('WysiwygSurface.insertLink (Link rung reuses the paste round-trip)', () => {
    it("sends the URL as a text/plain entry at the PEEKED index, and inserts GO's anchor at the caret", async () => {
      const anchor = { id: 'p-1' }
      const host = wyHost({ peekInsertAnchorForBlock: vi.fn(() => ({ afterBlockId: 'b-3', anchor })) })
      const frag = '<a href="https://example.com">Example Domain</a>'
      host.provider.paste.mockReturnValue(Promise.resolve({ outcome: 'content', content: frag }))
      const { s, ed } = mountPaste(host, 'doc-1')

      await expect(s.insertLink('https://example.com')).resolves.toBe(true)

      expect(host.provider.paste).toHaveBeenCalledWith(
        { kind: 'smart', entries: [{ mimeType: 'text/plain', content: 'https://example.com' }] }, 'b-3')
      expect(ed.commands.insertContent).toHaveBeenCalledWith(frag)
      // Inline insert into the caret's own paragraph — the block anchor is untouched.
      expect(host.consumeInsertAnchor).not.toHaveBeenCalled()
      expect(ed.commands.scrollIntoView).toHaveBeenCalled()
    })

    it('an outcome:block URL (an image) becomes that BLOCK — the pipeline decides, this rung does not second-guess it', async () => {
      const anchor = { id: 'p-1' }
      const host = wyHost({ peekInsertAnchorForBlock: vi.fn(() => ({ afterBlockId: 'b-3', anchor })) })
      host.provider.paste.mockReturnValue(Promise.resolve({ outcome: 'block', kind: 'smart-image', id: 'si-1' }))
      const { s, ed } = mountPaste(host, 'doc-1')

      await expect(s.insertLink('https://example.com/cat.png')).resolves.toBe(true)
      expect(host.consumeInsertAnchor).toHaveBeenCalledWith(anchor)
      expect(ed.commands.insertContent).not.toHaveBeenCalled()
    })

    it('outcome:none replays the bare URL (the degraded outcome a paste of it gives)', async () => {
      const host = wyHost({ peekInsertAnchorForBlock: vi.fn(() => ({ afterBlockId: 'b-0', anchor: null })) })
      host.provider.paste.mockReturnValue(Promise.resolve({ outcome: 'none' }))
      const { s, ed } = mountPaste(host, 'doc-1')

      await expect(s.insertLink('https://example.com')).resolves.toBe(false)
      expect(ed.commands.insertContent).toHaveBeenCalledWith('https://example.com')
    })

    it('a failed round-trip resolves false and inserts NOTHING (no title-less fallback anchor)', async () => {
      const host = wyHost()
      host.provider.paste.mockReturnValue(Promise.reject(new Error('offline')))
      const { s, ed } = mountPaste(host, 'doc-1')
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})

      await expect(s.insertLink('https://example.com')).resolves.toBe(false)
      expect(ed.commands.insertContent).not.toHaveBeenCalled()
      err.mockRestore()
    })

    it('no url, and a whole-content container, are inert (no round trip)', async () => {
      const host = wyHost()
      const { s } = mountPaste(host, 'doc-1')
      await expect(s.insertLink('')).resolves.toBe(false)

      const promptHost = wyPromptHost()
      const p = mountPaste(promptHost, 'prompt:p')
      await expect(p.s.insertLink('https://example.com')).resolves.toBe(false)

      expect(host.provider.paste).not.toHaveBeenCalled()
      expect(promptHost.provider.paste).toBeUndefined()
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

describe('WysiwygSurface.paintContainer — a LOAD parks the caret+scroll at the TOP (issue #51)', () => {
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
  // PM has no reason to scroll for). A reload's own caret/scroll restore runs
  // AFTER the paint, so genuine mid-session reloads still put the user back
  // where they had been.
  beforeEach(() => {
    vi.useFakeTimers()
    seedVendor({ ProseMirrorDOMParser: PMDOMParser, TextSelection })
  })

  it('the dispatched transaction carries the doc-start selection AND requests scrollIntoView', () => {
    const ed = fakeEditorOver(fxSchema, [build.p('old content', 'b1')])
    const s = new TestWysiwygSurface('doc-1', wyHost(), ed)
    s.paintContainer(containerOf(['p1'], {
      p1: { id: 'p1', kind: 'prose', attrs: { id: 'p1', content: 'hello' } },
    }))
    expect(ed.dispatched).toHaveLength(1)
    const tr = ed.dispatched[0]
    expect(tr.scrolledIntoView).toBe(true) // PM itself takes the "scroll to selection" branch
    expect(tr.selection.from).toBe(TextSelection.atStart(tr.doc).from) // doc start, not the replace's default end-of-content
    // The old two-dispatch mechanism (a separate commands.setTextSelection(0)
    // AFTER the replace landed) is retired — everything rides one transaction.
    expect(ed.calls.some((c) => c[0] === 'setTextSelection')).toBe(false)
  })
})

// ── The `{` picker's entries (#91 phase 2) ──────────────────────────────────

describe('WysiwygSurface.macrosFor — composing one mount\'s macros', () => {
  /** A live-pane stub recording the command chain a preset drives. */
  function paneStub() {
    /** @type {any[]} */ const calls = []
    /** @type {any} */ const chain = {
      focus: () => { calls.push(['focus']); return chain },
      insertTable: (opts) => { calls.push(['insertTable', opts]); return chain },
      toggleBlockquote: () => { calls.push(['toggleBlockquote']); return chain },
      setHorizontalRule: () => { calls.push(['setHorizontalRule']); return chain },
      setCodeBlock: (opts) => { calls.push(['setCodeBlock', opts]); return chain },
      run: () => { calls.push(['run']); return true },
    }
    return { calls, chain: () => chain }
  }

  /** A host catalog offering `names`, as MacroCatalog does: workspace verbs, so
   *  each mints server-side material and requires `blocks`. */
  function catalogOf(...names) {
    return {
      list: () => names.map((n) => new ActionMacro({
        label: n, requires: LensCapability.BLOCKS, action: () => {},
      })),
    }
  }

  it('leads with everything the HOST offers, then this surface\'s own presets', () => {
    const macros = WysiwygSurface.macrosFor(catalogOf('Code', 'Web Clip'), paneStub(), NOTE_CAPS)
    expect(macros.map((m) => m.label)).toEqual(['Code', 'Web Clip', 'Table', 'Quote', 'Divider', 'Fence'])
  })

  it('offers its presets alone when the host carries no catalog', () => {
    expect(WysiwygSurface.macrosFor(null, paneStub(), NOTE_CAPS).map((m) => m.name)).toEqual(['table', 'blockquote', 'hr', 'fence'])
  })

  it('names and describes each preset, so it reads like any other entry', () => {
    const table = WysiwygSurface.macrosFor(null, paneStub(), NOTE_CAPS)[0]
    expect(table.label).toBe('Table')
    expect(table.description).toBeTruthy()
  })

  // COMPOSING IS NOT REGISTERING: the presets are a class-level declaration read
  // afresh here, so a second mount cannot append a second Table.
  it('composes fresh every time — two mounts produce no duplicate entry', () => {
    const catalog = catalogOf('Code')
    const first = WysiwygSurface.macrosFor(catalog, paneStub(), NOTE_CAPS)
    const second = WysiwygSurface.macrosFor(catalog, paneStub(), NOTE_CAPS)
    expect(second.map((m) => m.label)).toEqual(first.map((m) => m.label))
    expect(second.map((m) => m.label)).toEqual(['Code', 'Table', 'Quote', 'Divider', 'Fence'])
    expect(second[1]).not.toBe(first[1])
  })

  it('binds each preset to the pane it was composed for', () => {
    const pane = paneStub()
    const other = paneStub()
    WysiwygSurface.macrosFor(null, pane, NOTE_CAPS)[0].run(/** @type {any} */ ({ replaceRange: () => {} }), token(0, 6))
    expect(other.calls).toEqual([])
    expect(pane.calls.length).toBeGreaterThan(0)
  })

  it('clears the token, then runs the toolbar\'s OWN insertTable command', () => {
    const pane = paneStub()
    /** @type {any[]} */ const cleared = []
    const host = /** @type {any} */ ({
      replaceRange: (start, end, text) => {
        cleared.push([start, end, text])
        expect(pane.calls).toEqual([]) // the token goes FIRST — a native insert never precedes it
      },
    })

    WysiwygSurface.macrosFor(null, pane, NOTE_CAPS)[0].run(host, token(4, 8))

    expect(cleared).toEqual([[4, 8, '']])
    expect(pane.calls).toEqual([
      ['focus'], ['insertTable', { rows: 3, cols: 3, withHeaderRow: true }], ['run'],
    ])
  })

  it('clears the token, then runs the toolbar\'s OWN toggleBlockquote command', () => {
    const pane = paneStub()
    /** @type {any[]} */ const cleared = []
    const host = /** @type {any} */ ({
      replaceRange: (start, end, text) => {
        cleared.push([start, end, text])
        expect(pane.calls).toEqual([]) // the token goes FIRST — a native insert never precedes it
      },
    })

    WysiwygSurface.macrosFor(null, pane, NOTE_CAPS)[1].run(host, token(4, 8))

    expect(cleared).toEqual([[4, 8, '']])
    expect(pane.calls).toEqual([['focus'], ['toggleBlockquote'], ['run']])
  })

  it('clears the token, then runs the toolbar\'s OWN setHorizontalRule command', () => {
    const pane = paneStub()
    /** @type {any[]} */ const cleared = []
    const host = /** @type {any} */ ({
      replaceRange: (start, end, text) => {
        cleared.push([start, end, text])
        expect(pane.calls).toEqual([]) // the token goes FIRST — a native insert never precedes it
      },
    })

    WysiwygSurface.macrosFor(null, pane, NOTE_CAPS)[2].run(host, token(4, 8))

    expect(cleared).toEqual([[4, 8, '']])
    expect(pane.calls).toEqual([['focus'], ['setHorizontalRule'], ['run']])
  })

  // The Fence preset is a `{` macro AND a target of the token's argument tail
  // (#118 bonus): `{fence:go` carries `go` past the picker into `run` as an
  // ordinary token argument, not a Fence-specific wire.
  describe('Fence — the language rides the token\'s argument tail', () => {
    it('clears the token, then sets a plain code block when no language was typed', () => {
      const pane = paneStub()
      /** @type {any[]} */ const cleared = []
      const host = /** @type {any} */ ({ replaceRange: (start, end, text) => { cleared.push([start, end, text]) } })

      WysiwygSurface.macrosFor(null, pane, NOTE_CAPS)[3].run(host, token(4, 9))

      expect(cleared).toEqual([[4, 9, '']])
      expect(pane.calls).toEqual([['focus'], ['setCodeBlock', undefined], ['run']])
    })

    it('tags the language when the trigger runs it with an argument — the `{fence:go` path', () => {
      const pane = paneStub()
      const host = /** @type {any} */ ({ replaceRange: () => {} })

      WysiwygSurface.macrosFor(null, pane, NOTE_CAPS)[3].run(host, token(4, 12), 'go')

      expect(pane.calls).toEqual([['focus'], ['setCodeBlock', { language: 'go' }], ['run']])
    })

    it('treats a bare separator (`{fence:`) as no language, same as none typed', () => {
      const pane = paneStub()
      const host = /** @type {any} */ ({ replaceRange: () => {} })

      WysiwygSurface.macrosFor(null, pane, NOTE_CAPS)[3].run(host, token(4, 10), '')

      expect(pane.calls).toEqual([['focus'], ['setCodeBlock', undefined], ['run']])
    })
  })

  // ONE CATALOG, MANY MOUNTS (#118). The workspace hands every mount the same
  // entries; what differs is the lens's published spec, and the filter is the
  // same rule for a catalog entry and a preset alike.

  it('leaves a NOTE mount\'s list exactly as it was — everything on offer is supported', () => {
    const macros = WysiwygSurface.macrosFor(catalogOf('Code', 'Web Clip'), paneStub(), NOTE_CAPS)
    expect(macros.map((m) => m.label)).toEqual(['Code', 'Web Clip', 'Table', 'Quote', 'Divider', 'Fence'])
  })

  it('drops every block-minting entry for a COMPOSER mount, keeping the flow presets', () => {
    const macros = WysiwygSurface.macrosFor(catalogOf('Web Clip', 'Attach File'), paneStub(), COMPOSER_CAPS)
    expect(macros.map((m) => m.label)).toEqual(['Table', 'Quote', 'Divider', 'Fence'])
  })

  it('offers nothing at all to a mount that supports neither', () => {
    const caps = Object.freeze({ markdown: false, mentions: false, commands: false, blocks: false })
    expect(WysiwygSurface.macrosFor(catalogOf('Web Clip'), paneStub(), caps)).toEqual([])
  })

  /** @param {number} start @param {number} end */
  function token(start, end) {
    return /** @type {any} */ (Object.freeze({ provider: null, start, end, prefix: 'tab' }))
  }
})
