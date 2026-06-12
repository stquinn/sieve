import { describe, it, expect, beforeEach } from 'vitest'
import { docWithCaret, docWithNodeSelection, build, schema } from './helpers/editor-fixture.js'
import { EditorState, TextSelection } from '@tiptap/pm/state'

let aiInsertPos
beforeEach(async () => {
  global.window.TipTap = global.window.TipTap || {}
  await import('../src/static/ai-target.js')
  aiInsertPos = window.TipTap.aiInsertPos
})

// Build a doc and put a collapsed caret at an absolute doc position.
function docWithCaretAt(nodes, pos) {
  const doc = schema.nodes.doc.create(null, nodes)
  let state = EditorState.create({ schema, doc })
  state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)))
  return { editor: { state }, state }
}

describe('aiInsertPos — answer block placement', () => {
  it('caret inside a blockRef anchor → position AFTER the anchor, not inside it', () => {
    // doc: <blockRef id=blk-1><p>4</p></blockRef>
    //  0 <blockRef>  1 <p>  2 "4"  3 </p>  4 </blockRef>
    const anchor = build.anchor('blk-1', [build.p('4')])
    const { editor, state } = docWithCaretAt([anchor], 2) // caret after "4", inside the anchor
    const pos = aiInsertPos(state)
    expect(pos).toBe(anchor.nodeSize) // == 4 == directly after the blockRef closes
  })

  it('caret in a plain paragraph (document target) → the caret itself', () => {
    const { editor } = docWithCaret([build.p('hello world')], 0, 3)
    expect(aiInsertPos(editor.state)).toBe(editor.state.selection.to)
  })

  it('whole-node selection on a sieve block → position after the node', () => {
    const { editor } = docWithNodeSelection([build.p('x'), build.sieveCode('c-1')], 1)
    expect(aiInsertPos(editor.state)).toBe(editor.state.selection.to)
  })

  it('second-block anchor → after THAT anchor, accounting for the first block', () => {
    const first = build.p('intro')
    const anchor = build.anchor('blk-2', [build.p('body')])
    // caret inside the anchor's paragraph
    const caretPos = first.nodeSize + 2 // into the anchor's <p>
    const { state } = docWithCaretAt([first, anchor], caretPos)
    expect(aiInsertPos(state)).toBe(first.nodeSize + anchor.nodeSize)
  })
})
