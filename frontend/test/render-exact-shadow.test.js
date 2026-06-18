import { describe, it, expect } from 'vitest'
import { Schema, Fragment, Slice } from '@tiptap/pm/model'
import { EditorState } from '@tiptap/pm/state'

// Faithful-ish step-5 schema: doc = sieveBlock+, prose (block+), and a log block
// that mirrors log-renderer.js (atom:false, content 'text*', code, defining).
const schema = new Schema({
  nodes: {
    doc: { content: 'sieveBlock+' },
    'sieve-prose': {
      group: 'sieveBlock', content: 'block+', defining: true,
      attrs: { id: { default: '' } },
      toDOM: () => ['div', { 'data-type': 'sieve-prose' }, 0],
    },
    'sieve-log': {
      group: 'sieveBlock', content: 'text*', code: true, defining: true,
      attrs: { id: { default: '' } },
      toDOM: () => ['pre', ['code', 0]],
    },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    text: { group: 'inline' },
  },
})

const n = schema.nodes
const logNode = (id, text) => n['sieve-log'].create({ id }, text ? schema.text(text) : null)

function seedState() {
  // The editor seeds one empty prose, exactly like editor.js `content:`.
  const doc = n.doc.create(null, [n['sieve-prose'].create({ id: '' }, n.paragraph.create())])
  return EditorState.create({ schema, doc })
}

describe('render produces EXACTLY the shadow blocks (no PM-fabricated trailing prose)', () => {
  it('replaceWith [log, log] must not append a trailing prose', () => {
    let state = seedState()
    const nodes = [logNode('lo-1', 'aaa'), logNode('lo-2', 'bbb')]
    const tr = state.tr.replaceWith(0, state.doc.content.size, nodes)
    state = state.apply(tr)
    const kinds = []
    state.doc.forEach((c) => kinds.push(c.type.name + ':' + c.content.size))
    expect(kinds).toEqual(['sieve-log:3', 'sieve-log:3'])
  })

  it('replace via a 0/0 Slice also stays exact', () => {
    let state = seedState()
    const nodes = [logNode('lo-1', 'aaa'), logNode('lo-2', 'bbb')]
    const slice = new Slice(Fragment.from(nodes), 0, 0)
    const tr = state.tr.replace(0, state.doc.content.size, slice)
    state = state.apply(tr)
    const kinds = []
    state.doc.forEach((c) => kinds.push(c.type.name))
    expect(kinds).toEqual(['sieve-log', 'sieve-log'])
  })
})
