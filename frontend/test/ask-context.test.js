import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { docWithRange, docWithNodeSelection, docWithCaretNear, build } from './helpers/editor-fixture.js'
import { contextFor } from './helpers/selection-context.js'
import { buildSelectionDescriptor } from '../src/static/shell/surfaces/selection-descriptor.js'

// ask-context.test.js — P3.D (stateless Ask panel, #29 task 5).
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
// Honest harness: buildAiContext is trapped in the extensions.js IIFE (not an ES export),
// so it is reached the way the app reaches it — load extensions.js under a universal
// window.TipTap Proxy stub, then call window.TipTap.buildAiContext. The context it consumes
// is a REAL descriptor from buildSelectionDescriptor (the exact PM→descriptor core the
// surface runs) via the contextFor adapter over editor-fixture fixtures. No fakes bypass
// the real path.

// A universal callable + constructable Proxy: every property access returns another such
// proxy, and .create()/.extend()/new X() all yield one too. This loads the whole
// extensions.js IIFE cleanly (it reads T.Node/T.Extension/… and calls create/extend/new
// PluginKey at parse time) and leaves a working buildAiContext behind.
function universalStub() {
  const handler = {
    get(target, prop) {
      if (prop in target) return target[prop]
      const p = makeProxy()
      target[prop] = p
      return p
    },
  }
  function makeProxy() {
    const fn = function () { return makeProxy() }
    fn.create = () => makeProxy()
    fn.extend = () => makeProxy()
    return new Proxy(fn, {
      apply() { return makeProxy() },
      construct() { return makeProxy() },
      get(t, prop) {
        if (prop in t) return t[prop]
        const child = makeProxy()
        t[prop] = child
        return child
      },
    })
  }
  return new Proxy({}, handler)
}

beforeAll(() => {
  // Install the universal stub, then eval extensions.js so window.TipTap.buildAiContext
  // exists. The IIFE reads `var T = window.TipTap` at parse time, so the stub must be in
  // place first.
  global.window.TipTap = universalStub()
  // vitest runs with cwd = frontend/, so resolve the source relative to cwd (happy-dom's
  // window makes import.meta.url a non-file URL, so new URL(...) can't be used here).
  const src = readFileSync(resolve('src/static/editor/extensions.js'), 'utf8')
  ;(0, eval)(src)
})

beforeEach(() => {
  // Layer the REAL getSieveBlockLabel shim (copied from ai-target.test.js) so the
  // descriptor's labelFor resolves rich sieve labels rather than the proxy's stub.
  const renderers = {
    code: { buildAiCtx: () => ({ contextLabel: 'Code Block' }) },
  }
  window.TipTap.getSieveBlockLabel = (node) => {
    const kind = node && node.attrs ? node.attrs.kind : ''
    const r = renderers[kind]
    const base = (r && typeof r.buildAiCtx === 'function') ? r.buildAiCtx(node) : null
    const fallback = kind ? (kind.charAt(0).toUpperCase() + kind.slice(1).replace(/-/g, ' ')) : 'Block'
    return (base && base.contextLabel) || fallback
  }
})

describe('buildAiContext — ai-block follow-up sends the SINGLE block id (D1)', () => {
  it('NodeSelection of an ai-block → blockRef is the single id, no comma, no back-pointer prefix', () => {
    // The ai-block carries ref 'co-9' (what it points at) and its own id 'ai-1'. The old
    // branch computed "co-9,ai-1"; the fix sends 'ai-1' and Go walks the chain.
    const { editor } = docWithNodeSelection([build.p('x', 'pr-1'), build.aiBlock('ai-1', 'co-9')], 1)
    const context = contextFor(editor, false)
    const ai = window.TipTap.buildAiContext(context, '', 'u')
    expect(ai.blockRef).toBe('ai-1')          // single id — NOT "co-9,ai-1"
    expect(ai.contextLabel).toBe('Follow-up')
  })

  it('GUARD: multi-block text selection still sends the joined chain "A,B,C"', () => {
    const { editor } = docWithRange(
      [build.p('aaa', 'pr-1'), build.p('bbb', 'pr-2'), build.p('ccc', 'pr-3')], 2, 12)
    const ai = window.TipTap.buildAiContext(contextFor(editor, false), '', 'u')
    expect(ai.blockRef).toBe('pr-1,pr-2,pr-3')
  })

  it('GUARD: single-paragraph selection still sends the single id "pr-1"', () => {
    const { editor } = docWithRange([build.p('hello', 'pr-1')], 1, 4)
    const ai = window.TipTap.buildAiContext(contextFor(editor, false), '', 'u')
    expect(ai.blockRef).toBe('pr-1')
  })

  it('GUARD: NodeSelection of a plain sieve block → its own single id', () => {
    const { editor } = docWithNodeSelection([build.p('x', 'pr-1'), build.sieveCode('co-1')], 1)
    const ai = window.TipTap.buildAiContext(contextFor(editor, false), '', 'u')
    expect(ai.blockRef).toBe('co-1')
    expect(ai.contextLabel).toBe('Code Block')
  })

  it('GUARD: bare caret in flowing text → the document', () => {
    const { editor } = docWithCaretNear([build.p('just text', 'pr-1')], 1)
    const ai = window.TipTap.buildAiContext(contextFor(editor, false), '', 'u')
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
    expect(window.TipTap.buildAiContext(aCtx, '', 'u').blockRef).toBe('ai-a')
    expect(window.TipTap.buildAiContext(bCtx, '', 'u').blockRef).toBe('co-b')  // B, not A
  })
})

describe('glow range === send range over the SAME frozen context (F4)', () => {
  // The glow source (textarea focus handler) and the send source (doAsk) both read
  // context.target.range off the SAME getSelectionContext() — one frozen context, so the
  // painted extent and the sent target can never disagree.
  it('the range the glow paints is the range the send targets', () => {
    const context = contextFor(docWithRange([build.p('hello', 'pr-1')], 1, 4).editor, false)
    const glowRange = context.target.range            // what the focus handler reads
    window.TipTap.buildAiContext(context, '', 'u')     // what doAsk reads (same context)
    expect(glowRange).toEqual({ from: 1, to: 4 })
    expect(context.target.range).toEqual({ from: 1, to: 4 })
  })
})

describe('read-only-region DOM drag folds into a non-document target (F5)', () => {
  // P3.B folded read-only-region DOM highlights into the descriptor: a drag inside a
  // read-only NodeView region yields a `selection` target whose range IS the folded
  // region, never a `document` target. The panel just reads context.target — this guards
  // the fold P3.D relies on.
  it('a dom-fold selection over a sieve region → range/selection target, not document', () => {
    const nodes = [build.p('x', 'pr-1'), build.sieveCode('co-1')]
    const { editor } = docWithCaretNear(nodes, 1)   // caret in the doc; the DOM fold drives the range
    const regionFrom = nodes[0].nodeSize             // start of the sieve-code node
    const regionTo = regionFrom + nodes[1].nodeSize  // its end
    const er = { from: regionFrom, to: regionTo, active: true, isBlockRange: false, isNodeSelection: false }
    const raw = buildSelectionDescriptor(
      editor.state.doc, editor.state.selection, er, window.TipTap, 'dragged text')
    expect(raw.selectionType).toBe('range')          // dom fold → 'range' (descriptor rule)
    expect(raw.target.kind).toBe('selection')        // NOT 'document'
    expect(raw.target.range).toEqual({ from: regionFrom, to: regionTo })
  })
})
