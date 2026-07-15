import './helpers/seed-vendor.js'
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { docWithRange, docWithNodeSelection, docWithCaretNear, build } from './helpers/editor-fixture.js'
import { contextFor } from './helpers/selection-context.js'
import { WysiwygSurface } from '../src/static/editor/surfaces/wysiwyg-surface.js'
import { buildAiContext } from '../src/static/editor/extensions.js'
import { getSieveBlockLabel, domSelectionBlockRange } from '../src/static/block/sieve-block-extension.js'
import { getBlockSelectionRange } from '../src/static/editor/block-chrome.js'

// ask-context.test.js — P3.D (stateless Ask panel, #29 task 5). Harness redone P4.E
// once extensions.js became a real ES module.
//
// The Ask panel no longer captures a pinned side-channel (pendingAskCtx / precomputedCtx
// were DELETED). Every path resolves through the ONE `context.target` the editor stored
// (P3.C), and the send PULLS the live context at send time.
//
// TDD anchor: D1 is a TRUE RED-first unit — `buildAiContext` over a NodeSelection of an
// ai-block used to emit "<ref>,<id>" (frontend pre-walking one chain link, Go's job). The
// fix collapses the ai-block branch so it returns the single block id. The guard
// assertions (multi-block "A,B,C", single "pr-1") STAY green throughout.
//
// F1 (send pulls live) and F4-glow-source were DELETION-PROVEN — their failing form lived
// only in the deleted stateful side-channel, so we do NOT fabricate a failing unit against
// resurrected code. We PIN the post-change invariants here so a future regression re-fails;
// the live smoke on :34115 is their acceptance.
//
// Harness: buildAiContext is now a genuine `export function` in extensions.js (P4.E),
// reached the honest way — `import()` the real module and call the export directly. The
// only wrinkle is extensions.js's OWN vendor dependency: it reads
// `import { T as VENDOR } from '../base/tiptap-vendor.js'` (a live bag over
// globalThis.TipTap, installed once by test/setup.js) and calls VENDOR.Extension.create/
// .extend and `new VENDOR.PluginKey(...)` at MODULE-EVAL time (Search, SelectionHighlight,
// HighlightMark, AiShortcuts are built as the module loads, not lazily). Those vendor
// members must therefore exist on globalThis.TipTap BEFORE extensions.js is first
// imported. Static imports hoist, so the fix is a dynamic `import()` inside beforeAll:
// mutate the individual VENDOR members extensions.js touches at module scope onto the
// shared globalThis.TipTap object (never reassign the object itself — tiptap-vendor.js
// already captured a reference to it), THEN import() the module. No eval(), so
// extensions.js's own `import` declaration is no longer a SyntaxError. The context
// buildAiContext consumes is still a REAL descriptor from buildSelectionDescriptor (the
// exact PM→descriptor core the surface runs) via the contextFor adapter over
// editor-fixture fixtures — no fakes bypass the real path.

// P4.E: WysiwygSurface imports its app helpers from their owner modules. We need
// extensions.js REAL (buildAiContext) — seed-vendor (imported FIRST) seeds the vendor
// bag so its Extension.create at module-eval doesn't throw. The controllable
// descriptor helpers (block-chrome.getBlockSelectionRange, sieve-block-extension.*)
// and the other side-effect / registry modules are vi.mocked — replacing the retired
// deps.T / shared-bus injection the ContextSurface adapter used to feed.
vi.mock('../src/static/editor/block-chrome.js', () => ({
  BlockChrome: {},
  getBlockSelectionRange: vi.fn((view) => {
    const sel = view.state.selection
    return { from: sel.from, to: sel.to, active: !sel.empty, isBlockRange: false, isNodeSelection: !!sel.node }
  }),
}))
vi.mock('../src/static/ai/ai-target-decoration.js', () => ({ AiTargetDecoration: {} }))
vi.mock('../src/static/block/prose-block.js', () => ({ BlockId: {} }))
vi.mock('../src/static/block/prose-group.js', () => ({ ProseGroup: {}, proseBlockNodes: vi.fn(() => []) }))
vi.mock('../src/static/editor/interaction-policy.js', () => ({
  policyEnterKeydown: vi.fn(() => false), buildInteractionPolicyExtension: vi.fn(() => ({})),
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

beforeEach(() => {
  // Rich sieve labels: feedSelection's #labelFor reads the getSieveBlockLabel import
  // (the shim copied from ai-target.test.js) so it resolves 'Code Block' etc.
  const renderers = {
    code: { buildAiCtx: () => ({ contextLabel: 'Code Block' }) },
  }
  vi.mocked(getSieveBlockLabel).mockImplementation((node) => {
    const kind = node && node.attrs ? node.attrs.kind : ''
    const r = renderers[kind]
    const base = (r && typeof r.buildAiCtx === 'function') ? r.buildAiCtx(node) : null
    const fallback = kind ? (kind.charAt(0).toUpperCase() + kind.slice(1).replace(/-/g, ' ')) : 'Block'
    return (base && base.contextLabel) || fallback
  })
  // Default effective range = the plain live PM selection (block-chrome absent → the
  // pre-P4.E fallback the adapter relied on); the dom fold is off. F5 overrides both.
  vi.mocked(getBlockSelectionRange).mockImplementation((view) => {
    const sel = view.state.selection
    return { from: sel.from, to: sel.to, active: !sel.empty, isBlockRange: false, isNodeSelection: !!sel.node }
  })
  vi.mocked(domSelectionBlockRange).mockReturnValue(null)
})

describe('buildAiContext — ai-block follow-up sends the SINGLE block id (D1)', () => {
  it('NodeSelection of an ai-block → blockRef is the single id, no comma, no back-pointer prefix', () => {
    // The ai-block carries ref 'co-9' (what it points at) and its own id 'ai-1'. The old
    // branch computed "co-9,ai-1"; the fix sends 'ai-1' and Go walks the chain.
    const { editor } = docWithNodeSelection([build.p('x', 'pr-1'), build.aiBlock('ai-1', 'co-9')], 1)
    const context = contextFor(editor, false)
    const ai = buildAiContext(context, '', 'u')
    expect(ai.blockRef).toBe('ai-1')          // single id — NOT "co-9,ai-1"
    expect(ai.contextLabel).toBe('Follow-up')
  })

  it('GUARD: multi-block text selection still sends the joined chain "A,B,C"', () => {
    const { editor } = docWithRange(
      [build.p('aaa', 'pr-1'), build.p('bbb', 'pr-2'), build.p('ccc', 'pr-3')], 2, 12)
    const ai = buildAiContext(contextFor(editor, false), '', 'u')
    expect(ai.blockRef).toBe('pr-1,pr-2,pr-3')
  })

  it('GUARD: single-paragraph selection still sends the single id "pr-1"', () => {
    const { editor } = docWithRange([build.p('hello', 'pr-1')], 1, 4)
    const ai = buildAiContext(contextFor(editor, false), '', 'u')
    expect(ai.blockRef).toBe('pr-1')
  })

  it('GUARD: NodeSelection of a plain sieve block → its own single id', () => {
    const { editor } = docWithNodeSelection([build.p('x', 'pr-1'), build.sieveCode('co-1')], 1)
    const ai = buildAiContext(contextFor(editor, false), '', 'u')
    expect(ai.blockRef).toBe('co-1')
    expect(ai.contextLabel).toBe('Code Block')
  })

  it('GUARD: bare caret in flowing text → the document', () => {
    const { editor } = docWithCaretNear([build.p('just text', 'pr-1')], 1)
    const ai = buildAiContext(contextFor(editor, false), '', 'u')
    expect(ai.blockRef).toBe('doc')
    expect(ai.contextLabel).toBe('Document')
  })
})

describe('buildAiContext is a PURE function of the passed context (F1: send pulls live)', () => {
  // After D2 there is no captured pendingAskCtx — doAsk resolves the target by PULLING
  // _activeEditor().getSelectionContext() AT SEND. The property that makes F1
  // unrepresentable is that buildAiContext holds no hidden state: two contexts → two
  // answers. "Pin A, then move to B, send targets B" reduces to this purity.
  it('two different contexts yield two different refs (no hidden pin)', () => {
    // step 1: "pin" A — a NodeSelection of ai-block A resolves ref 'ai-a'. Nothing stored.
    const aCtx = contextFor(
      docWithNodeSelection([build.p('x', 'pr-1'), build.aiBlock('ai-a', 'co-9')], 1).editor, false)
    // step 2: caret moves to sieve block B.
    const bCtx = contextFor(
      docWithNodeSelection([build.p('x', 'pr-1'), build.sieveCode('co-b')], 1).editor, false)

    // SEND resolves NOW off whichever context is live:
    expect(buildAiContext(aCtx, '', 'u').blockRef).toBe('ai-a')
    expect(buildAiContext(bCtx, '', 'u').blockRef).toBe('co-b')  // B, not A
  })
})

describe('glow range === send range over the SAME frozen context (F4)', () => {
  // The glow source (textarea focus handler) and the send source (doAsk) both read
  // context.target.range off the SAME getSelectionContext() — one frozen context, so the
  // painted extent and the sent target can never disagree.
  it('the range the glow paints is the range the send targets', () => {
    const context = contextFor(docWithRange([build.p('hello', 'pr-1')], 1, 4).editor, false)
    const glowRange = context.target.range            // what the focus handler reads
    buildAiContext(context, '', 'u')     // what doAsk reads (same context)
    expect(glowRange).toEqual({ from: 1, to: 4 })
    expect(context.target.range).toEqual({ from: 1, to: 4 })
  })
})

describe('read-only-region DOM drag folds into a non-document target (F5)', () => {
  // P3.B folded read-only-region DOM highlights into the descriptor: a drag inside a
  // read-only NodeView region yields a `selection` target whose range IS the folded
  // region, never a `document` target. The panel just reads context.target — this guards
  // the fold P3.D relies on.
  //
  // P3.F folded the descriptor core into WysiwygSurface, so this drives the REAL
  // dom-fold path (the surfaces.test.js F5 recipe): a caret in the doc, then a stubbed
  // window.getSelection + injected T.domSelectionBlockRange retarget the effective range
  // onto the sieve region and supply the drag text. More faithful than the old
  // hand-built `er` — it runs feedSelection's actual read-only-region fold branch.

  // Local surface driving the fixture through feedSelection (the TestWysiwygSurface
  // seam: public ctor over a `host` + `get editorPane()` override — no backdoor). P4.F:
  // the surface IMPORTS `T` from the vendor bag (seeded by helpers/seed-vendor.js at
  // the top of this file), so #T is truthy and the rich-label path runs.
  class F5Surface extends WysiwygSurface {
    constructor(editor) {
      super({
        uuid: 't', applyBlockOps() {}, flushSave() {},
        takeInsertPos() { return null }, onSurfaceEvent() {},
      })
      this._ed = editor
    }
    get editorPane() { return this._ed }
  }

  it('a dom-fold selection over a sieve region → range/selection target, not document', () => {
    const nodes = [build.p('x', 'pr-1'), build.sieveCode('co-1')]
    const { editor } = docWithCaretNear(nodes, 1)   // caret in the doc; the DOM fold drives the range
    const regionFrom = nodes[0].nodeSize             // start of the sieve-code node
    const regionTo = regionFrom + nodes[1].nodeSize  // its end
    vi.mocked(getBlockSelectionRange).mockReturnValue({ from: 1, to: 1, active: false, isBlockRange: false, isNodeSelection: false })
    vi.mocked(domSelectionBlockRange).mockReturnValue({ from: regionFrom, to: regionTo })
    const prev = window.getSelection
    window.getSelection = () => ({ isCollapsed: false, toString: () => 'dragged text', rangeCount: 1 })
    try {
      const raw = new F5Surface(editor).feedSelection()
      expect(raw.selectionType).toBe('range')          // dom fold → 'range' (descriptor rule)
      expect(raw.target.kind).toBe('selection')        // NOT 'document'
      expect(raw.target.range).toEqual({ from: regionFrom, to: regionTo })
    } finally {
      window.getSelection = prev
    }
  })
})
