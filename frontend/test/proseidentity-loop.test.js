import { describe, it, expect } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import { EditorState, Plugin, PluginKey } from '@tiptap/pm/state'
import { dedupeActions } from '../src/static/lens/document-editor/block-sync.js'
import { Ident } from '../src/static/ident/ident.js'

// Contract + loop-stability harness for prose-block.js's identity
// appendTransaction under the BIRTH-IDENTITY model (issue #96). The plugin:
//   - MINTS a real UUIDv7 on any REAL prose block with no id: a content-bearing
//     prose, or a STRUCTURAL blank (an empty paragraph with a content-bearing
//     block after it → its childIdx < lastContentIdx);
//   - Leaves the TRAILING empty surface bare (childIdx >= lastContentIdx) — it is
//     not a block yet;
//   - RE-MINTS the 2nd occurrence of a duplicated id (the splitBlock attr-copy
//     trap) in the SAME pass, so the doc never holds two nodes under one name for
//     even a transaction;
//   - CONVERGES (only writes attrs, creates no nodes) — a runaway counter turns a
//     regression into a throw, not a frozen main thread.
//
// The plugin body is mirrored here rather than imported because the real one is
// built against the TipTap vendor bundle; the split-defense DECISION is the real
// `dedupeActions`, and the mint is the real `Ident`.

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block', content: 'inline*',
      attrs: { id: { default: '' } },
      toDOM: () => ['p', 0],
    },
    text: { group: 'inline' },
  },
})
const n = schema.nodes

const LIMIT = 100
function identityPlugin(counter) {
  return new Plugin({
    key: new PluginKey('blockIdentity'),
    appendTransaction(trs, _oldState, newState) {
      counter.n++
      if (counter.n > LIMIT) throw new Error('blockIdentity never stabilised (infinite appendTransaction loop)')
      if (!trs.some((tr) => tr.docChanged)) return null
      // Walk every top-level child once: collect prose nodes for identity
      // stamping, and compute lastContentIdx = the index of the LAST child that is
      // a real content-bearing block. A blank prose BEFORE lastContentIdx is a
      // STRUCTURAL blank (a real block); AT/AFTER it is the trailing editing
      // surface. (In this harness all nodes are prose paragraphs, so no isProse
      // guard is needed.)
      const ids = [], positions = [], childIdxs = []
      let lastContentIdx = -1, ci = -1
      newState.doc.forEach((node, pos) => {
        ci++
        const emptyProse = node.textContent.length === 0
        if (!emptyProse) lastContentIdx = ci
        ids.push(node.attrs.id || '')
        positions.push(pos)
        childIdxs.push(ci)
      })
      const reMint = {}
      dedupeActions(ids).forEach((i) => { reMint[i] = true })
      let tr = null
      positions.forEach((pos, idx) => {
        const node = newState.doc.nodeAt(pos)
        if (!node) return
        const attrs = Object.assign({}, node.attrs)
        const isRealBlock = (node.textContent && node.textContent.length > 0) || childIdxs[idx] < lastContentIdx
        if (reMint[idx] || (!attrs.id && isRealBlock)) {
          attrs.id = isRealBlock ? Ident.mint() : ''
          if (!tr) tr = newState.tr
          tr.setNodeMarkup(pos, undefined, attrs)
        }
      })
      if (tr) tr.setMeta('addToHistory', false)
      return tr
    },
  })
}
function stateWith(doc, counter) {
  return EditorState.create({ schema, doc, plugins: [identityPlugin(counter)] })
}

describe('blockIdentity: birth mint, split re-mint, no infinite loop', () => {
  it('mints a REAL uuid on a content-bearing prose — the block is named from birth', () => {
    const counter = { n: 0 }
    const doc = n.doc.create(null, [n.paragraph.create(null, schema.text('hi'))])
    let state = stateWith(doc, counter)
    // a docChanged trigger
    state = state.apply(state.tr.insertText('!', 1))
    const p = state.doc.child(0)
    expect(Ident.valid(p.attrs.id)).toBe(true)
    expect(counter.n).toBeLessThan(LIMIT)
  })

  it('a TRAILING empty surface (nothing after) stays bare — not a block yet', () => {
    const counter = { n: 0 }
    // para('x') has content; the trailing empty paragraph has NOTHING after it →
    // it is the ephemeral editing surface, not a real block.
    const doc = n.doc.create(null, [n.paragraph.create(null, schema.text('x')), n.paragraph.create()])
    let state = stateWith(doc, counter)
    // trigger inside para('x') at position 1 — does not change which paras are empty
    state = state.apply(state.tr.insertText('!', 1))
    expect(Ident.valid(state.doc.child(0).attrs.id)).toBe(true) // content-bearing → named
    expect(state.doc.child(1).attrs.id).toBe('')                // trailing empty → bare
    expect(counter.n).toBeLessThan(LIMIT)
  })

  it('a STRUCTURAL blank (empty paragraph with content after) is named like any block', () => {
    const counter = { n: 0 }
    const doc = n.doc.create(null, [n.paragraph.create(), n.paragraph.create(null, schema.text('x'))])
    let state = stateWith(doc, counter)
    // trigger inside para('x') — the empty para stays empty (structural)
    state = state.apply(state.tr.insertText('!', state.doc.child(0).nodeSize + 1))
    expect(Ident.valid(state.doc.child(0).attrs.id)).toBe(true)
    expect(Ident.valid(state.doc.child(1).attrs.id)).toBe(true)
    expect(state.doc.child(0).attrs.id).not.toBe(state.doc.child(1).attrs.id)
    expect(counter.n).toBeLessThan(LIMIT)
  })

  it('RE-MINTS the split-copied id on the new half — the attr-copy trap, fixed at source', () => {
    const counter = { n: 0 }
    // Both halves born with the same id, both content-bearing (post-split). The
    // first keeps the name Go already knows; the second becomes a block of its own
    // IN THE SAME PASS — there is no transaction in which two nodes share one id.
    const original = Ident.mint()
    const doc = n.doc.create(null, [
      n.paragraph.create({ id: original }, schema.text('left')),
      n.paragraph.create({ id: original }, schema.text('right')),
    ])
    let state = stateWith(doc, counter)
    state = state.apply(state.tr.insertText('!', 1)) // docChanged trigger
    expect(state.doc.child(0).attrs.id).toBe(original)
    expect(Ident.valid(state.doc.child(1).attrs.id)).toBe(true)
    expect(state.doc.child(1).attrs.id).not.toBe(original)
    expect(counter.n).toBeLessThan(LIMIT)
  })

  it('re-mints EVERY later duplicate, not just the second', () => {
    const counter = { n: 0 }
    const original = Ident.mint()
    const doc = n.doc.create(null, [
      n.paragraph.create({ id: original }, schema.text('a')),
      n.paragraph.create({ id: original }, schema.text('b')),
      n.paragraph.create({ id: original }, schema.text('c')),
    ])
    let state = stateWith(doc, counter)
    state = state.apply(state.tr.insertText('!', 1))
    const ids = [0, 1, 2].map((i) => state.doc.child(i).attrs.id)
    expect(ids[0]).toBe(original)
    expect(new Set(ids).size).toBe(3)
    for (const id of ids) expect(Ident.valid(id)).toBe(true)
    expect(counter.n).toBeLessThan(LIMIT)
  })

  it('a split-copied id on a node that is NOT a block is cleared, not re-minted', () => {
    const counter = { n: 0 }
    // Enter at the end of a paragraph: the new half is empty and trailing, so it
    // is the editing surface — it must not become a second block.
    const original = Ident.mint()
    const doc = n.doc.create(null, [
      n.paragraph.create({ id: original }, schema.text('typed')),
      n.paragraph.create({ id: original }),
    ])
    let state = stateWith(doc, counter)
    state = state.apply(state.tr.insertText('!', 1))
    expect(state.doc.child(0).attrs.id).toBe(original)
    expect(state.doc.child(1).attrs.id).toBe('')
    expect(counter.n).toBeLessThan(LIMIT)
  })

  it('converges: once every real block has an id, a further edit mints nothing new', () => {
    const counter = { n: 0 }
    const original = Ident.mint()
    const doc = n.doc.create(null, [n.paragraph.create({ id: original }, schema.text('hi'))])
    let state = stateWith(doc, counter)
    state = state.apply(state.tr.insertText('!', 1))
    expect(state.doc.child(0).attrs.id).toBe(original)
    expect(counter.n).toBeLessThan(LIMIT)
  })
})
