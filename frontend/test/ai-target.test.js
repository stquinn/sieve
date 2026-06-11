import { describe, it, expect, beforeEach } from 'vitest'
import { docWithCaret, docWithRange, build } from './helpers/editor-fixture.js'

let resolveAiTarget
beforeEach(async () => {
  // ai-target.js is a non-module IIFE that attaches to window.TipTap.
  global.window.TipTap = global.window.TipTap || {}
  // Stub the sieve label lookup (real impl lives in sieve-block-extension.js).
  window.TipTap.getSieveBlockLabel = (node) => (node.attrs.kind === 'code' ? 'Code Block' : 'Block')
  await import('../src/static/ai-target.js')
  resolveAiTarget = window.TipTap.resolveAiTarget
})

describe('resolveAiTarget — kinds', () => {
  it('caret in plain paragraph → document', () => {
    const { editor } = docWithCaret([build.p('just text')], 0, 2)
    expect(resolveAiTarget(editor, false).kind).toBe('document')
  })

  it('text selection in a paragraph → selection with range', () => {
    // doc: <p>hello</p>; select "hel" = positions 1..4
    const { editor } = docWithRange([build.p('hello')], 1, 4)
    const t = resolveAiTarget(editor, false)
    expect(t.kind).toBe('selection')
    expect(t.range).toEqual({ from: 1, to: 4 })
  })

  it('caret inside a sieve block → sieveBlock with id + node range', () => {
    const { editor } = docWithCaret([build.p('x'), build.aiBlock('ai-1')], 0, 0)
    // move selection onto the atom via NodeSelection helper instead:
    const ns = docWithRange([build.p('x'), build.sieveCode('c-1')], 4, 4) // caret just before atom
    const t = resolveAiTarget(ns.editor, false)
    expect(t.kind).toBe('sieveBlock')
    expect(t.id).toBe('c-1')
    expect(t.range).toBeTruthy()
  })

  it('caret inside an existing anchor (blockRef) → anchor with id', () => {
    const { editor } = docWithCaret([build.anchor('blk-9', [build.p('inside')])], 0, 1)
    const t = resolveAiTarget(editor, false)
    expect(t.kind).toBe('anchor')
    expect(t.id).toBe('blk-9')
  })

  it('native code block is NOT a target → document (dropped scope)', () => {
    const { editor } = docWithCaret([build.code('const x = 1')], 0, 2)
    expect(resolveAiTarget(editor, false).kind).toBe('document')
  })

  it('performs no mutation (doc identity unchanged)', () => {
    const { editor } = docWithRange([build.p('hello')], 1, 4)
    const before = editor.state.doc
    resolveAiTarget(editor, false)
    expect(editor.state.doc).toBe(before)
  })
})

describe('resolveAiTarget — labels', () => {
  it('selection label quotes a short word', () => {
    const { editor } = docWithRange([build.p('product')], 1, 8) // "product"
    expect(resolveAiTarget(editor, false).label).toBe('"product"')
  })

  it('selection label truncates long text on a word boundary', () => {
    const { editor } = docWithRange([build.p('the quarterly revenue summary')], 1, 30)
    const label = resolveAiTarget(editor, false).label
    expect(label.startsWith('"the quarterly')).toBe(true)
    expect(label.endsWith('…"')).toBe(true)
    expect(label.length).toBeLessThan(26)
  })

  it('sieve block label comes from getSieveBlockLabel', () => {
    const { editor } = docWithRange([build.p('x'), build.sieveCode('c-1')], 4, 4)
    expect(resolveAiTarget(editor, false).label).toBe('Code Block')
  })

  it('ai-block label is Follow-up', () => {
    const { editor } = docWithRange([build.p('x'), build.aiBlock('ai-1')], 4, 4)
    expect(resolveAiTarget(editor, false).label).toBe('Follow-up')
  })

  it('document label is Document', () => {
    const { editor } = docWithCaret([build.p('hi')], 0, 1)
    expect(resolveAiTarget(editor, false).label).toBe('Document')
  })
})
