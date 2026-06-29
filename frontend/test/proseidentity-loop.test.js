import { describe, it, expect } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import { EditorState, Plugin, PluginKey } from '@tiptap/pm/state'
import { dedupeActions } from '../src/static/block/block-sync.js'

// Contract + loop-stability harness for prose-block.js's identity appendTransaction
// under the BACKEND-AUTHORITATIVE id model (B-A retired). The plugin:
//   - STAMPS a transient token (tok-…) on any REAL prose block with no id+token:
//     a content-bearing prose, or a STRUCTURAL blank (empty paragraph with a
//     content-bearing block after it → its childIdx < lastContentIdx);
//   - Leaves the TRAILING empty surface bare (childIdx >= lastContentIdx);
//   - NEVER fills a durable id (Go mints it; the insert-block ack swaps it in);
//   - CLEARS the 2nd occurrence of any duplicate id/token (the splitBlock attr-copy
//     trap) so the new half re-acquires its own token → one create round-trip;
//   - CONVERGES (only fills/clears attrs, creates no nodes) — a runaway counter
//     turns a regression into a throw, not a frozen main thread.

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block', content: 'inline*',
      attrs: { id: { default: '' }, token: { default: '' } },
      toDOM: () => ['p', 0],
    },
    text: { group: 'inline' },
  },
})
const n = schema.nodes
const mintToken = () => 'tok-' + Math.random().toString(16).slice(2, 10)

const LIMIT = 100
function identityPlugin(counter) {
  return new Plugin({
    key: new PluginKey('blockIdentity'),
    appendTransaction(trs, _oldState, newState) {
      counter.n++
      if (counter.n > LIMIT) throw new Error('blockIdentity never stabilised (infinite appendTransaction loop)')
      if (!trs.some((tr) => tr.docChanged)) return null
      // Walk every top-level child once: collect prose nodes for identity stamping,
      // and compute lastContentIdx = the index of the LAST child that is a real
      // content-bearing block. A blank prose BEFORE lastContentIdx is a STRUCTURAL
      // blank (a real block); AT/AFTER it is the trailing editing surface.
      // (In this harness all nodes are prose paragraphs, so no isProse guard is needed.)
      const ids = [], tokens = [], positions = [], childIdxs = []
      let lastContentIdx = -1, ci = -1
      newState.doc.forEach((node, pos) => {
        ci++
        const emptyProse = node.textContent.length === 0
        if (!emptyProse) lastContentIdx = ci
        ids.push(node.attrs.id || '')
        tokens.push(node.attrs.token || '')
        positions.push(pos)
        childIdxs.push(ci)
      })
      const clearId = {}, clearTok = {}
      dedupeActions(ids).forEach((i) => { clearId[i] = true })
      dedupeActions(tokens).forEach((i) => { clearTok[i] = true })
      let tr = null
      positions.forEach((pos, idx) => {
        const node = newState.doc.nodeAt(pos)
        if (!node) return
        const attrs = Object.assign({}, node.attrs)
        let changed = false
        if (clearId[idx]) { attrs.id = ''; changed = true }
        if (clearTok[idx]) { attrs.token = ''; changed = true }
        const isRealBlock = (node.textContent && node.textContent.length > 0) || childIdxs[idx] < lastContentIdx
        if (!attrs.id && !attrs.token && isRealBlock) { attrs.token = mintToken(); changed = true }
        if (changed) { if (!tr) tr = newState.tr; tr.setNodeMarkup(pos, undefined, attrs) }
      })
      if (tr) tr.setMeta('addToHistory', false)
      return tr
    },
  })
}
function stateWith(doc, counter) {
  return EditorState.create({ schema, doc, plugins: [identityPlugin(counter)] })
}

describe('blockIdentity: token stamp, split clear, no durable mint, no infinite loop', () => {
  it('stamps a TRANSIENT token (not a durable id) on a content-bearing prose', () => {
    const counter = { n: 0 }
    const doc = n.doc.create(null, [n.paragraph.create(null, schema.text('hi'))])
    let state = stateWith(doc, counter)
    // a docChanged trigger
    state = state.apply(state.tr.insertText('!', 1))
    const p = state.doc.child(0)
    expect(p.attrs.id).toBe('')                  // durable id NEVER invented on the frontend
    expect(p.attrs.token).toMatch(/^tok-/)       // transient correlation token only
    expect(counter.n).toBeLessThan(LIMIT)
  })

  it('a TRAILING empty surface (nothing after) stays bare — not a real block', () => {
    const counter = { n: 0 }
    // para('x') has content; the trailing empty paragraph has NOTHING after it →
    // it is the ephemeral editing surface, not a real block.
    const doc = n.doc.create(null, [n.paragraph.create(null, schema.text('x')), n.paragraph.create()])
    let state = stateWith(doc, counter)
    // trigger inside para('x') at position 1 — does not change which paras are empty
    state = state.apply(state.tr.insertText('!', 1))
    expect(state.doc.child(0).attrs.token).toMatch(/^tok-/) // content-bearing → gets token
    expect(state.doc.child(1).attrs.token).toBe('')          // trailing empty → stays bare
    expect(counter.n).toBeLessThan(LIMIT)
  })

  it('a STRUCTURAL blank (empty paragraph with content after) gets a token like any block', () => {
    const counter = { n: 0 }
    // empty para has content after it (para('x')) → STRUCTURAL blank → must get a token
    const doc = n.doc.create(null, [n.paragraph.create(), n.paragraph.create(null, schema.text('x'))])
    let state = stateWith(doc, counter)
    // trigger inside para('x') — empty para stays empty (structural), does NOT become content
    state = state.apply(state.tr.insertText('!', state.doc.child(0).nodeSize + 1))
    expect(state.doc.child(0).attrs.token).toMatch(/^tok-/) // structural blank → gets a token
    expect(state.doc.child(0).attrs.id).toBe('')             // never a durable id
    expect(state.doc.child(1).attrs.token).toMatch(/^tok-/) // content-bearing → also gets token
    expect(counter.n).toBeLessThan(LIMIT)
  })

  it('CLEARS a split-copied token on the new half (the attr-copy trap) → it re-acquires its own', () => {
    const counter = { n: 0 }
    // both halves born with the same token, both content-bearing (post-split)
    const doc = n.doc.create(null, [
      n.paragraph.create({ token: 'tok-aa' }, schema.text('left')),
      n.paragraph.create({ token: 'tok-aa' }, schema.text('right')),
    ])
    let state = stateWith(doc, counter)
    state = state.apply(state.tr.insertText('!', 1)) // docChanged trigger
    expect(state.doc.child(0).attrs.token).toBe('tok-aa')   // first occurrence kept
    expect(state.doc.child(1).attrs.token).toMatch(/^tok-/) // re-stamped fresh
    expect(state.doc.child(1).attrs.token).not.toBe('tok-aa')
    expect(counter.n).toBeLessThan(LIMIT)
  })

  it('CLEARS a split-copied durable id on the new half (acked block split)', () => {
    const counter = { n: 0 }
    const doc = n.doc.create(null, [
      n.paragraph.create({ id: 'pr-1' }, schema.text('left')),
      n.paragraph.create({ id: 'pr-1' }, schema.text('right')),
    ])
    let state = stateWith(doc, counter)
    state = state.apply(state.tr.insertText('!', 1))
    expect(state.doc.child(0).attrs.id).toBe('pr-1')        // original keeps its id
    expect(state.doc.child(1).attrs.id).toBe('')            // duplicate cleared
    expect(state.doc.child(1).attrs.token).toMatch(/^tok-/) // → re-acquires a token
    expect(counter.n).toBeLessThan(LIMIT)
  })

  it('converges: once every node has an id or a token, a further edit stamps nothing new', () => {
    const counter = { n: 0 }
    const doc = n.doc.create(null, [n.paragraph.create({ id: 'pr-1' }, schema.text('hi'))])
    let state = stateWith(doc, counter)
    state = state.apply(state.tr.insertText('!', 1))
    expect(state.doc.child(0).attrs.id).toBe('pr-1')
    expect(state.doc.child(0).attrs.token).toBe('')
    expect(counter.n).toBeLessThan(LIMIT)
  })
})
