import { describe, it, expect, beforeEach } from 'vitest'
import { docWithCaret, docWithCaretAt, docWithRange, docWithNodeSelection, build } from './helpers/editor-fixture.js'

// D-r.7 piece 3 — blockInsertPos is the single source for every additive block
// insert. A block kind lands as a NEW SIBLING after the enclosing top-level block
// (never at the caret → never splits a paragraph); an inline kind lands at the
// caret; a NodeSelection is already positioned after its node.
let blockInsertPos
beforeEach(async () => {
  global.window.TipTap = global.window.TipTap || {}
  await import('../src/static/ai-target.js')
  blockInsertPos = window.TipTap.blockInsertPos
})

describe('blockInsertPos — additive block placement', () => {
  it('caret mid-paragraph, BLOCK kind → after the top-level paragraph (no split)', () => {
    const { editor } = docWithCaret([build.p('hello world', 'pr-1')], 0, 4)
    const after = editor.state.doc.firstChild.nodeSize // = doc.content.size here
    expect(blockInsertPos(editor.state, false)).toBe(after)
    expect(blockInsertPos(editor.state, false)).not.toBe(editor.state.selection.to)
  })

  it('caret mid-paragraph, INLINE kind → the caret itself', () => {
    const { editor } = docWithCaret([build.p('hello world', 'pr-1')], 0, 4)
    expect(blockInsertPos(editor.state, true)).toBe(editor.state.selection.to)
  })

  it('selection across TWO blocks, block kind → after the LAST block', () => {
    const nodes = [build.p('aaa', 'pr-1'), build.p('bbb', 'pr-2')]
    const { editor } = docWithRange(nodes, 2, 7) // from in block 0, to in block 1
    const afterLast = nodes[0].nodeSize + nodes[1].nodeSize
    expect(blockInsertPos(editor.state, false)).toBe(afterLast)
  })

  it('NodeSelection of a block → position after the node', () => {
    const { editor } = docWithNodeSelection([build.p('x', 'pr-1'), build.sieveCode('co-1')], 1)
    expect(blockInsertPos(editor.state, false)).toBe(editor.state.selection.to)
  })

  it('caret inside a nested paragraph (blockquote) → after the WHOLE blockquote', () => {
    const nodes = [build.blockquote('pr-q', [build.p('inside')])]
    // caret inside the blockquote's paragraph (depth 2); after(1) = after the bq
    const { editor } = docWithCaretAt(nodes, 2)
    expect(blockInsertPos(editor.state, false)).toBe(nodes[0].nodeSize)
  })

  it('caret at a doc-level gap (depth 0) → the gap itself (valid top-level point)', () => {
    const nodes = [build.p('x', 'pr-1'), build.hr('hr-1')]
    const end = nodes[0].nodeSize + nodes[1].nodeSize
    const { editor } = docWithCaretAt(nodes, end)
    expect(blockInsertPos(editor.state, false)).toBe(end)
  })
})
