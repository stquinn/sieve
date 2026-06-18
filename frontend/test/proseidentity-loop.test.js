import { describe, it, expect } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import { EditorState, Plugin, PluginKey } from '@tiptap/pm/state'

// Reproduction + contract harness for editor.js's proseIdentity appendTransaction.
//
// EditorState.apply runs appendTransaction in a LOOP until every plugin stops
// returning a transaction. A plugin that never stabilises spins apply() forever
// (frozen main thread — the "app + browser locked up" symptom). The two jobs here
// are both idempotent so they stabilise; a runaway counter turns any regression
// into a throw instead of a hang.
//
// Contract:
//   - MINT an id for an id-less sieve-prose that has REAL TEXT content.
//   - Leave an EMPTY prose (only an empty paragraph) and a size-0 artifact id-less
//     — they are editing surfaces / artifacts, NOT committed blocks. Never delete.
//   - ENSURE a trailing prose editing surface: if the doc ends in a non-prose
//     block there is nowhere to type, so append ONE valid empty prose (createAndFill
//     → it has a paragraph, so it is selectable). Idempotent: once the last child
//     is a prose, it is not appended again.

const schema = new Schema({
  nodes: {
    doc: { content: 'sieveBlock+' },
    'sieve-prose': {
      group: 'sieveBlock', content: 'block+', defining: true,
      attrs: { id: { default: '' } },
      toDOM: () => ['div', { 'data-type': 'sieve-prose' }, 0],
    },
    'sieve-log': {
      group: 'sieveBlock', atom: true,
      attrs: { id: { default: '' } },
      toDOM: () => ['div', { 'data-type': 'sieve-log' }],
    },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    text: { group: 'inline' },
  },
})

const n = schema.nodes
const mintProseId = () => 'pr-' + Math.random().toString(16).slice(2, 6)

const LIMIT = 100
function proseIdentityPlugin(counter) {
  return new Plugin({
    key: new PluginKey('proseIdentity'),
    appendTransaction(trs, _oldState, newState) {
      counter.n++
      if (counter.n > LIMIT) throw new Error('proseIdentity never stabilised (infinite appendTransaction loop)')
      if (!trs.some((tr) => tr.docChanged)) return null
      let tr = null
      // 1. Mint ids for id-less prose that has real text content.
      newState.doc.forEach((node, pos) => {
        if (node.type.name !== 'sieve-prose' || node.attrs.id) return
        if (node.textContent.length === 0) return // empty surface/artifact: leave id-less
        if (!tr) tr = newState.tr
        tr.setNodeMarkup(pos, undefined, Object.assign({}, node.attrs, { id: mintProseId() }))
      })
      // 2. Ensure a trailing prose editing surface when the doc ends in a non-prose.
      const last = newState.doc.lastChild
      if (last && last.type.name !== 'sieve-prose') {
        if (!tr) tr = newState.tr
        const surface = n['sieve-prose'].createAndFill()
        if (surface) tr.insert(tr.doc.content.size, surface)
      }
      return tr
    },
  })
}

function stateWith(doc, counter) {
  return EditorState.create({ schema, doc, plugins: [proseIdentityPlugin(counter)] })
}

const kindsOf = (doc) => { const k = []; doc.forEach((c) => k.push(c.type.name)); return k }

describe('proseIdentity: mint, trailing surface, and no infinite loop', () => {
  it('appends a valid, selectable trailing prose when the doc ends in a structured block', () => {
    const counter = { n: 0 }
    const doc = n.doc.create(null, [
      n['sieve-prose'].create({ id: 'pr-1' }, n.paragraph.create(null, schema.text('hi'))),
      n['sieve-log'].create({ id: 'lo-1' }),
    ])
    let state = stateWith(doc, counter)
    const tr = state.tr.setNodeMarkup(state.doc.child(0).nodeSize, undefined, { id: 'lo-1b' })
    state = state.apply(tr)
    expect(kindsOf(state.doc)).toEqual(['sieve-prose', 'sieve-log', 'sieve-prose'])
    const surface = state.doc.lastChild
    expect(surface.childCount).toBe(1)          // has a paragraph → selectable
    expect(surface.attrs.id).toBe('')           // id-less → no create-block until typed
    expect(counter.n).toBeLessThan(LIMIT)       // stabilised, no freeze
  })

  it('does NOT append a surface when the doc already ends in a prose', () => {
    const counter = { n: 0 }
    const doc = n.doc.create(null, [
      n['sieve-log'].create({ id: 'lo-1' }),
      n['sieve-prose'].create({ id: '' }, n.paragraph.create()),
    ])
    let state = stateWith(doc, counter)
    const tr = state.tr.setNodeMarkup(0, undefined, { id: 'lo-1b' })
    state = state.apply(tr)
    expect(kindsOf(state.doc)).toEqual(['sieve-log', 'sieve-prose'])
    expect(counter.n).toBeLessThan(LIMIT)
  })

  it('mints a text-bearing prose but leaves an empty surface and a size-0 artifact id-less', () => {
    const counter = { n: 0 }
    const doc = n.doc.create(null, [
      n['sieve-prose'].create({ id: '' }, n.paragraph.create(null, schema.text('real'))),
      n['sieve-prose'].create({ id: '' }, n.paragraph.create()), // empty surface
      n['sieve-prose'].create({ id: '' }),                       // size-0 artifact
    ])
    let state = stateWith(doc, counter)
    const tr = state.tr.setNodeMarkup(0, undefined, { id: '' }) // docChanged trigger
    state = state.apply(tr)
    expect(state.doc.child(0).attrs.id).toMatch(/^pr-/) // text → minted
    expect(state.doc.child(1).attrs.id).toBe('')        // empty paragraph → id-less
    expect(state.doc.child(2).attrs.id).toBe('')        // size-0 → id-less, not deleted
    expect(counter.n).toBeLessThan(LIMIT)
  })
})
