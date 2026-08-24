import { describe, it, expect, beforeEach, vi } from 'vitest'
import { docWithCaret, docWithCaretNear, docWithCaretAt, docWithRange, docWithNodeSelection, build } from './helpers/editor-fixture.js'
import { contextFor } from './helpers/selection-context.js'

// P4.E: contextFor → WysiwygSurface.feedSelection now imports its descriptor helpers
// from their owner modules (the shared TipTap bus is retired). Mock the three
// side-effect extension modules + the controllable descriptor helpers, replacing the
// old bus-based getSieveBlockLabel injection. This file does not use buildAiContext,
// so extensions.js is mocked too (no vendor seed needed).
vi.mock('../src/static/lens/extensions.js', () => ({
  Search: {}, SelectionHighlight: {}, HighlightMark: {}, AiShortcuts: { configure: () => ({}) },
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
vi.mock('../src/static/lens/document-editor/surfaces/prose-group.js', () => ({ ProseGroup: {}, proseBlockNodes: vi.fn(() => []) }))
vi.mock('../src/static/lens/document-editor/interaction-policy.js', () => ({
  policyEnterKeydown: vi.fn(() => false), buildInteractionPolicyExtension: vi.fn(() => ({})),
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

import { getSieveBlockLabel } from '../src/static/lens/document-editor/surfaces/sieve-block-extension.js'
import { BlockSelection } from '../src/static/lens/document-editor/block-selection.js'
import { getBlockSelectionRange } from '../src/static/lens/document-editor/block-chrome.js'

// P3.C — the AI target is RESOLVED IN THE SURFACE and STORED in the SelectionContext
// as `context.target = { kind, ref, range, label }` (plain values; NO PM node). The
// standalone resolveAiTarget symbol is retired (store-only). These tests assert
// against the REAL stored target the production PM→descriptor core produces, via the
// `contextFor` adapter (which reuses buildSelectionDescriptor — the same path the
// surface runs, so it cannot drift).
//
// D-r.7 four ordered cases (keyed on node CHARACTER + uniform id):
//   (a) NodeSelection of any block      → target.kind 'block', ref = its id
//   (b) non-empty TextSelection         → target.kind 'selection', ref = ids of EVERY
//                                          top-level block crossed (doc order)
//   (c) bare caret in a UNIT            → target.kind 'block', ref = its id
//   (d) bare caret in flowing text / ∅  → target.kind 'document', ref 'doc'

// A shared renderer registry the mocked getSieveBlockLabel reads (the rich-label
// test mutates renderers.code directly).
const renderers = {}

beforeEach(() => {
  // getSieveBlockLabel (import, mocked): reads renderer.buildAiCtx(node).contextLabel,
  // falling back to a title-cased kind — the rich-label test exercises the contextLabel
  // branch, not just the fallback (see sieve-block-extension.js:853).
  Object.keys(renderers).forEach((k) => delete renderers[k])
  renderers.code = { buildAiCtx: () => ({ contextLabel: 'Code Block' }) }
  vi.mocked(getSieveBlockLabel).mockImplementation((node) => {
    const kind = node && node.attrs ? node.attrs.kind : ''
    const r = renderers[kind]
    const base = (r && typeof r.buildAiCtx === 'function') ? r.buildAiCtx(node) : null
    const fallback = kind ? (kind.charAt(0).toUpperCase() + kind.slice(1).replace(/-/g, ' ')) : 'Block'
    return (base && base.contextLabel) || fallback
  })
  // Default effective range = the plain live PM selection (the pre-P4.E fallback);
  // no dom fold. block-chrome's mock default already mirrors this, reset it here too.
  vi.mocked(getBlockSelectionRange).mockImplementation((view) => {
    const sel = view.state.selection
    return { from: sel.from, to: sel.to, active: !sel.empty, isBlockRange: false, isNodeSelection: !!sel.node }
  })
  vi.mocked(BlockSelection.blockRange).mockReturnValue(null)
})

describe('AI target — selection ref chains (bug-1 fix)', () => {
  it('selection inside ONE paragraph → kind selection, ref = that block id', () => {
    const { editor } = docWithRange([build.p('hello', 'pr-1')], 1, 4)
    const tg = contextFor(editor, false).target
    expect(tg.kind).toBe('selection')
    expect(tg.ref).toBe('pr-1')
    expect(tg.range).toEqual({ from: 1, to: 4 })
  })

  it('selection dragged across TWO paragraphs → ref chain of both ids in order', () => {
    const { editor } = docWithRange([build.p('aaa', 'pr-1'), build.p('bbb', 'pr-2')], 2, 7)
    expect(contextFor(editor, false).target.ref).toBe('pr-1,pr-2')
  })

  it('selection across THREE paragraphs → all three ids in document order', () => {
    const { editor } = docWithRange(
      [build.p('aaa', 'pr-1'), build.p('bbb', 'pr-2'), build.p('ccc', 'pr-3')], 2, 12)
    expect(contextFor(editor, false).target.ref).toBe('pr-1,pr-2,pr-3')
  })
})

describe('AI target — bare caret by node character', () => {
  it('caret in a plain paragraph → document', () => {
    const { editor } = docWithCaret([build.p('just text', 'pr-1')], 0, 2)
    expect(contextFor(editor, false).target.kind).toBe('document')
  })

  it('caret in a heading → document (flowing text)', () => {
    const { editor } = docWithCaretNear([build.heading('Title', 'h-1')], 1)
    expect(contextFor(editor, false).target.kind).toBe('document')
  })

  it('caret inside a proseGroup paragraph → document (invisible grouping is flowing text)', () => {
    // A proseGroup is one backend prose block (import/embed) rendered under a
    // shared id — visually identical to minted paragraphs, so a bare caret must
    // resolve the same way: to the document, never to a "ProseGroup" block.
    const { editor } = docWithCaretNear([build.proseGroup('pr-g', ['first para', 'second para'])], 3)
    const tg = contextFor(editor, false).target
    expect(tg.kind).toBe('document')
    expect(tg.ref).toBe('doc')
  })

  it('NodeSelection of a proseGroup → selection over its passage, never a block target', () => {
    const { editor } = docWithNodeSelection([build.p('x', 'pr-1'), build.proseGroup('pr-g', ['aa', 'bb'])], 1)
    const tg = contextFor(editor, false).target
    expect(tg.kind).toBe('selection')
    expect(tg.ref).toBe('pr-g')
  })

  it('text selection inside a proseGroup → selection, ref = the group id', () => {
    const { editor } = docWithRange([build.proseGroup('pr-g', ['hello there', 'world'])], 3, 8)
    const tg = contextFor(editor, false).target
    expect(tg.kind).toBe('selection')
    expect(tg.ref).toBe('pr-g')
  })

  it('caret in a bullet list → block, ref = the list id', () => {
    const { editor } = docWithCaretNear([build.bulletList('pr-l', ['a', 'b'])], 3)
    const tg = contextFor(editor, false).target
    expect(tg.kind).toBe('block')
    expect(tg.ref).toBe('pr-l')
  })

  it('caret in a table → block, ref = the table id', () => {
    const { editor } = docWithCaretNear([build.table('pr-t', 'cell')], 2)
    const tg = contextFor(editor, false).target
    expect(tg.kind).toBe('block')
    expect(tg.ref).toBe('pr-t')
  })

  it('caret in a code block → block, ref = the code id', () => {
    const { editor } = docWithCaretNear([build.code('const x = 1', 'pr-c')], 1)
    const tg = contextFor(editor, false).target
    expect(tg.kind).toBe('block')
    expect(tg.ref).toBe('pr-c')
  })

  it('caret in a blockquote → block, ref = the blockquote id', () => {
    const { editor } = docWithCaretNear([build.blockquote('pr-q', [build.p('hi')])], 2)
    const tg = contextFor(editor, false).target
    expect(tg.kind).toBe('block')
    expect(tg.ref).toBe('pr-q')
  })

  it('caret at a gap after a horizontal rule → block, ref = the hr id', () => {
    // doc: <p>x</p><hr> ; caret at doc end (depth 0) resolves to the adjacent unit
    const nodes = [build.p('x', 'pr-1'), build.hr('hr-1')]
    const size = nodes[0].nodeSize + nodes[1].nodeSize
    const { editor } = docWithCaretAt(nodes, size)
    const tg = contextFor(editor, false).target
    expect(tg.kind).toBe('block')
    expect(tg.ref).toBe('hr-1')
  })

  it('empty doc (single empty paragraph) → document', () => {
    const { editor } = docWithCaretNear([build.p('', 'pr-1')], 1)
    expect(contextFor(editor, false).target.kind).toBe('document')
  })
})

describe('AI target — NodeSelection units', () => {
  it('NodeSelection of an image → block, ref = the image id', () => {
    const { editor } = docWithNodeSelection([build.p('x', 'pr-1'), build.image('img-1')], 1)
    const tg = contextFor(editor, false).target
    expect(tg.kind).toBe('block')
    expect(tg.ref).toBe('img-1')
  })

  it('NodeSelection of a horizontal rule → block, ref = the hr id', () => {
    const { editor } = docWithNodeSelection([build.p('x', 'pr-1'), build.hr('hr-1')], 1)
    expect(contextFor(editor, false).target.ref).toBe('hr-1')
  })

  it('NodeSelection of a sieve-* block → block, ref = its id', () => {
    const { editor } = docWithNodeSelection([build.p('x', 'pr-1'), build.sieveCode('co-1')], 1)
    const tg = contextFor(editor, false).target
    expect(tg.kind).toBe('block')
    expect(tg.ref).toBe('co-1')
    // The leak is gone: no PM node in the stored outcome (was `.node.type.name`).
    expect(tg.node).toBeUndefined()
    expect('node' in tg).toBe(false)
  })

  it('NodeSelection of an ai-block → block, label Follow-up (for follow-up chaining)', () => {
    const { editor } = docWithNodeSelection([build.p('x', 'pr-1'), build.aiBlock('ai-1', 'co-9')], 1)
    const tg = contextFor(editor, false).target
    expect(tg.kind).toBe('block')
    // The leak is gone: identity rides label/ref, not a leaked `.node`.
    expect(tg.label).toBe('Follow-up')
    expect(tg.node).toBeUndefined()
  })
})

describe('AI target — purity + labels', () => {
  it('performs no mutation (doc identity unchanged)', () => {
    const { editor } = docWithRange([build.p('hello', 'pr-1')], 1, 4)
    const before = editor.state.doc
    contextFor(editor, false)
    expect(editor.state.doc).toBe(before)
  })

  it('selection label quotes a short word', () => {
    const { editor } = docWithRange([build.p('product', 'pr-1')], 1, 8)
    expect(contextFor(editor, false).target.label).toBe('"product"')
  })

  it('sieve block label comes from getSieveBlockLabel', () => {
    const { editor } = docWithNodeSelection([build.p('x', 'pr-1'), build.sieveCode('co-1')], 1)
    expect(contextFor(editor, false).target.label).toBe('Code Block')
  })

  it('ai-block label is Follow-up', () => {
    const { editor } = docWithNodeSelection([build.p('x', 'pr-1'), build.aiBlock('ai-1')], 1)
    expect(contextFor(editor, false).target.label).toBe('Follow-up')
  })

  it('document label is Document', () => {
    const { editor } = docWithCaret([build.p('hi', 'pr-1')], 0, 1)
    expect(contextFor(editor, false).target.label).toBe('Document')
  })
})

describe('AI target — P3.C store-only contract', () => {
  it('the resolved target never carries a PM node (leak gone) — block / caret-unit / range / document', () => {
    const nodeSel = docWithNodeSelection([build.p('x', 'pr-1'), build.image('img-1')], 1)
    const caretUnit = docWithCaretNear([build.bulletList('pr-l', ['a', 'b'])], 3)
    const range = docWithRange([build.p('hello', 'pr-1')], 1, 4)
    const document = docWithCaret([build.p('just text', 'pr-1')], 0, 2)
    for (const { editor } of [nodeSel, caretUnit, range, document]) {
      const tg = contextFor(editor, false).target
      expect(tg.node).toBeUndefined()
      expect('node' in tg).toBe(false)
    }
  })

  it('label is ALWAYS populated — a caret in a UNIT gets a friendly name, not empty', () => {
    const { editor } = docWithCaretNear([build.bulletList('pr-l', ['a', 'b'])], 3)
    // universal label: a list caret targets the block → its friendly noun.
    expect(contextFor(editor, false).target.label).toBe('List')
  })

  it('RICH labels survive: getSieveBlockLabel → renderer.buildAiCtx().contextLabel (NOT title-case fallback)', () => {
    // Register a renderer whose buildAiCtx surfaces a rich contextLabel — the
    // surface must call getSieveBlockLabel while holding the node so this richness
    // reaches target.label, never regressing to a bare title-cased 'Code'.
    renderers.code = { buildAiCtx: () => ({ contextLabel: 'Javascript Code Block' }) }
    const { editor } = docWithNodeSelection([build.p('x', 'pr-1'), build.sieveCode('co-1')], 1)
    expect(contextFor(editor, false).target.label).toBe('Javascript Code Block')
  })

  it('mid-doc gap caret: <p>x</p><hr><p>y</p>, caret between hr and p → the hr unit', () => {
    // A caret at a doc-level gap adjacent to a non-flowing UNIT targets that unit
    // (the enclosing/adjacent block by id), NOT the document.
    const nodes = [build.p('x', 'pr-1'), build.hr('hr-1'), build.p('y', 'pr-2')]
    const pos = nodes[0].nodeSize + nodes[1].nodeSize // right after the hr, before <p>y</p>
    const { editor } = docWithCaretAt(nodes, pos)
    const tg = contextFor(editor, false).target
    expect(tg.kind).toBe('block')
    expect(tg.ref).toBe('hr-1')
  })

  it('markdown mode → the document target with a Document label', () => {
    const { editor } = docWithCaret([build.p('anything', 'pr-1')], 0, 1)
    const tg = contextFor(editor, true).target
    expect(tg.kind).toBe('document')
    expect(tg.ref).toBe('doc')
    expect(tg.label).toBe('Document')
  })
})
