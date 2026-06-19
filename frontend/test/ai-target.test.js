import { describe, it, expect, beforeEach } from 'vitest'
import { docWithCaret, docWithCaretNear, docWithCaretAt, docWithRange, docWithNodeSelection, build } from './helpers/editor-fixture.js'

// D-r.7 piece 2 — resolveAiTarget keyed on node CHARACTER + uniform id.
// A Sieve block is a top-level (depth-1) node identified by attrs.id, regardless
// of kind. The discriminator is whether that node is FLOWING TEXT (paragraph or
// heading) or a UNIT (everything else). Four ordered cases:
//   (a) NodeSelection of any block      → kind 'block', ref = its id
//   (b) non-empty TextSelection         → kind 'selection', ref = ids of EVERY
//                                          top-level block crossed (doc order)
//   (c) bare caret in a UNIT            → kind 'block', ref = its id
//   (d) bare caret in flowing text / ∅  → kind 'document', ref 'doc'

let resolveAiTarget
beforeEach(async () => {
  global.window.TipTap = global.window.TipTap || {}
  window.TipTap.getSieveBlockLabel = (node) => (node.attrs.kind === 'code' ? 'Code Block' : 'Block')
  await import('../src/static/ai-target.js')
  resolveAiTarget = window.TipTap.resolveAiTarget
})

describe('resolveAiTarget — selection ref chains (bug-1 fix)', () => {
  it('selection inside ONE paragraph → kind selection, ref = that block id', () => {
    const { editor } = docWithRange([build.p('hello', 'pr-1')], 1, 4)
    const tg = resolveAiTarget(editor, false)
    expect(tg.kind).toBe('selection')
    expect(tg.ref).toBe('pr-1')
    expect(tg.range).toEqual({ from: 1, to: 4 })
  })

  it('selection dragged across TWO paragraphs → ref chain of both ids in order', () => {
    const { editor } = docWithRange([build.p('aaa', 'pr-1'), build.p('bbb', 'pr-2')], 2, 7)
    expect(resolveAiTarget(editor, false).ref).toBe('pr-1,pr-2')
  })

  it('selection across THREE paragraphs → all three ids in document order', () => {
    const { editor } = docWithRange(
      [build.p('aaa', 'pr-1'), build.p('bbb', 'pr-2'), build.p('ccc', 'pr-3')], 2, 12)
    expect(resolveAiTarget(editor, false).ref).toBe('pr-1,pr-2,pr-3')
  })
})

describe('resolveAiTarget — bare caret by node character', () => {
  it('caret in a plain paragraph → document', () => {
    const { editor } = docWithCaret([build.p('just text', 'pr-1')], 0, 2)
    expect(resolveAiTarget(editor, false).kind).toBe('document')
  })

  it('caret in a heading → document (flowing text)', () => {
    const { editor } = docWithCaretNear([build.heading('Title', 'h-1')], 1)
    expect(resolveAiTarget(editor, false).kind).toBe('document')
  })

  it('caret in a bullet list → block, ref = the list id', () => {
    const { editor } = docWithCaretNear([build.bulletList('pr-l', ['a', 'b'])], 3)
    const tg = resolveAiTarget(editor, false)
    expect(tg.kind).toBe('block')
    expect(tg.ref).toBe('pr-l')
  })

  it('caret in a table → block, ref = the table id', () => {
    const { editor } = docWithCaretNear([build.table('pr-t', 'cell')], 2)
    const tg = resolveAiTarget(editor, false)
    expect(tg.kind).toBe('block')
    expect(tg.ref).toBe('pr-t')
  })

  it('caret in a code block → block, ref = the code id', () => {
    const { editor } = docWithCaretNear([build.code('const x = 1', 'pr-c')], 1)
    const tg = resolveAiTarget(editor, false)
    expect(tg.kind).toBe('block')
    expect(tg.ref).toBe('pr-c')
  })

  it('caret in a blockquote → block, ref = the blockquote id', () => {
    const { editor } = docWithCaretNear([build.blockquote('pr-q', [build.p('hi')])], 2)
    const tg = resolveAiTarget(editor, false)
    expect(tg.kind).toBe('block')
    expect(tg.ref).toBe('pr-q')
  })

  it('caret at a gap after a horizontal rule → block, ref = the hr id', () => {
    // doc: <p>x</p><hr> ; caret at doc end (depth 0) resolves to the adjacent unit
    const nodes = [build.p('x', 'pr-1'), build.hr('hr-1')]
    const size = nodes[0].nodeSize + nodes[1].nodeSize
    const { editor } = docWithCaretAt(nodes, size)
    const tg = resolveAiTarget(editor, false)
    expect(tg.kind).toBe('block')
    expect(tg.ref).toBe('hr-1')
  })

  it('empty doc (single empty paragraph) → document', () => {
    const { editor } = docWithCaretNear([build.p('', 'pr-1')], 1)
    expect(resolveAiTarget(editor, false).kind).toBe('document')
  })
})

describe('resolveAiTarget — NodeSelection units', () => {
  it('NodeSelection of an image → block, ref = the image id', () => {
    const { editor } = docWithNodeSelection([build.p('x', 'pr-1'), build.image('img-1')], 1)
    const tg = resolveAiTarget(editor, false)
    expect(tg.kind).toBe('block')
    expect(tg.ref).toBe('img-1')
  })

  it('NodeSelection of a horizontal rule → block, ref = the hr id', () => {
    const { editor } = docWithNodeSelection([build.p('x', 'pr-1'), build.hr('hr-1')], 1)
    expect(resolveAiTarget(editor, false).ref).toBe('hr-1')
  })

  it('NodeSelection of a sieve-* block → block, ref = its id', () => {
    const { editor } = docWithNodeSelection([build.p('x', 'pr-1'), build.sieveCode('co-1')], 1)
    const tg = resolveAiTarget(editor, false)
    expect(tg.kind).toBe('block')
    expect(tg.ref).toBe('co-1')
    expect(tg.node.type.name).toBe('sieve-code')
  })

  it('NodeSelection of an ai-block → block carrying the ai node (for follow-up chaining)', () => {
    const { editor } = docWithNodeSelection([build.p('x', 'pr-1'), build.aiBlock('ai-1', 'co-9')], 1)
    const tg = resolveAiTarget(editor, false)
    expect(tg.kind).toBe('block')
    expect(tg.node.type.name).toBe('sieve-ai-block')
  })
})

describe('resolveAiTarget — purity + labels', () => {
  it('performs no mutation (doc identity unchanged)', () => {
    const { editor } = docWithRange([build.p('hello', 'pr-1')], 1, 4)
    const before = editor.state.doc
    resolveAiTarget(editor, false)
    expect(editor.state.doc).toBe(before)
  })

  it('selection label quotes a short word', () => {
    const { editor } = docWithRange([build.p('product', 'pr-1')], 1, 8)
    expect(resolveAiTarget(editor, false).label).toBe('"product"')
  })

  it('sieve block label comes from getSieveBlockLabel', () => {
    const { editor } = docWithNodeSelection([build.p('x', 'pr-1'), build.sieveCode('co-1')], 1)
    expect(resolveAiTarget(editor, false).label).toBe('Code Block')
  })

  it('ai-block label is Follow-up', () => {
    const { editor } = docWithNodeSelection([build.p('x', 'pr-1'), build.aiBlock('ai-1')], 1)
    expect(resolveAiTarget(editor, false).label).toBe('Follow-up')
  })

  it('document label is Document', () => {
    const { editor } = docWithCaret([build.p('hi', 'pr-1')], 0, 1)
    expect(resolveAiTarget(editor, false).label).toBe('Document')
  })
})
