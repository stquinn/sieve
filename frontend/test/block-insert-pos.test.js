import { describe, it, expect } from 'vitest'
import { docWithCaret, docWithCaretAt, docWithRange, docWithNodeSelection, build } from './helpers/editor-fixture.js'
import { blockInsertPos } from '../src/static/lens/document-editor/surfaces/ai-target.js'
import { emptyParagraphAnchor } from '../src/static/lens/document-editor/surfaces/block-position.js'

// D-r.7 piece 3 — blockInsertPos is the single source for every additive block
// insert. A block always lands as a NEW SIBLING after the enclosing top-level block
// (never at the caret → never splits a paragraph); a NodeSelection is already
// positioned after its node. (P4.F: the inline branch is gone — there is no
// block-path inline creation, so blockInsertPos takes only `state`.)

describe('blockInsertPos — additive block placement', () => {
  it('caret mid-paragraph → after the top-level paragraph (no split)', () => {
    const { editor } = docWithCaret([build.p('hello world', 'pr-1')], 0, 4)
    const after = editor.state.doc.firstChild.nodeSize // = doc.content.size here
    expect(blockInsertPos(editor.state)).toBe(after)
    expect(blockInsertPos(editor.state)).not.toBe(editor.state.selection.to)
  })

  it('selection across TWO blocks → after the LAST block', () => {
    const nodes = [build.p('aaa', 'pr-1'), build.p('bbb', 'pr-2')]
    const { editor } = docWithRange(nodes, 2, 7) // from in block 0, to in block 1
    const afterLast = nodes[0].nodeSize + nodes[1].nodeSize
    expect(blockInsertPos(editor.state)).toBe(afterLast)
  })

  it('NodeSelection of a block → position after the node', () => {
    const { editor } = docWithNodeSelection([build.p('x', 'pr-1'), build.sieveCode('co-1')], 1)
    expect(blockInsertPos(editor.state)).toBe(editor.state.selection.to)
  })

  it('caret inside a nested paragraph (blockquote) → after the WHOLE blockquote', () => {
    const nodes = [build.blockquote('pr-q', [build.p('inside')])]
    // caret inside the blockquote's paragraph (depth 2); after(1) = after the bq
    const { editor } = docWithCaretAt(nodes, 2)
    expect(blockInsertPos(editor.state)).toBe(nodes[0].nodeSize)
  })

  it('caret at a doc-level gap (depth 0) → the gap itself (valid top-level point)', () => {
    const nodes = [build.p('x', 'pr-1'), build.hr('hr-1')]
    const end = nodes[0].nodeSize + nodes[1].nodeSize
    const { editor } = docWithCaretAt(nodes, end)
    expect(blockInsertPos(editor.state)).toBe(end)
  })
})

// Contract "Block insertion placement": an empty paragraph is a placement
// TARGET, not an anchor — the new block takes its index and the paragraph is
// consumed (editor.js commitInsertIndex deletes it at commit time).
describe('emptyParagraphAnchor — empty paragraph is a placement target', () => {
  it('caret on an empty paragraph between blocks → its own index + bounds', () => {
    const nodes = [build.p('above', 'pr-1'), build.p('', 'pr-2'), build.p('below', 'pr-3')]
    const { editor } = docWithCaret(nodes, 1, 0)
    const pos = blockInsertPos(editor.state) // boundary after the empty para
    const anchor = emptyParagraphAnchor(editor.state.doc, pos)
    expect(anchor).not.toBeNull()
    expect(anchor.index).toBe(1)
    expect(anchor.from).toBe(nodes[0].nodeSize)
    expect(anchor.to).toBe(nodes[0].nodeSize + nodes[1].nodeSize)
  })

  it('whitespace-only paragraph counts as empty', () => {
    const nodes = [build.p('   ', 'pr-1'), build.p('x', 'pr-2')]
    const { editor } = docWithCaret(nodes, 0, 1)
    const pos = blockInsertPos(editor.state)
    expect(emptyParagraphAnchor(editor.state.doc, pos)).not.toBeNull()
  })

  it('non-empty paragraph → null (insert stays after)', () => {
    const nodes = [build.p('text', 'pr-1')]
    const { editor } = docWithCaret(nodes, 0, 2)
    const pos = blockInsertPos(editor.state)
    expect(emptyParagraphAnchor(editor.state.doc, pos)).toBeNull()
  })

  it('empty HEADING → null (structural emptiness is chosen, not consumed)', () => {
    const nodes = [build.heading('', 'h-1'), build.p('x', 'pr-2')]
    const { editor } = docWithCaret(nodes, 0, 0)
    const pos = blockInsertPos(editor.state)
    expect(emptyParagraphAnchor(editor.state.doc, pos)).toBeNull()
  })

  it('null pos and {from,to} range form → null', () => {
    const { editor } = docWithCaret([build.p('x', 'pr-1')], 0, 0)
    expect(emptyParagraphAnchor(editor.state.doc, null)).toBeNull()
    expect(emptyParagraphAnchor(editor.state.doc, { from: 0, to: 2 })).toBeNull()
  })
})
