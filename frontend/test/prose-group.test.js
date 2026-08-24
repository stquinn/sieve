import { describe, it, expect } from 'vitest'
import { Schema, Fragment } from '@tiptap/pm/model'
import { proseBlockNodes, proseGroupMarkdownSerialize } from '../src/static/lens/document-editor/surfaces/prose-group.js'

// A minimal schema mirroring the live doc's relevant shape: native prose nodes
// (group "block") + the proseGroup container (group "block", content "block+").
// This pins the design; the live ProseGroup node transcribes it.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: {
      group: 'block', content: 'inline*', attrs: { id: { default: '' } },
      toDOM: (n) => ['p', { 'data-id': n.attrs.id }, 0],
    },
    heading: {
      group: 'block', content: 'inline*', attrs: { id: { default: '' } },
      toDOM: (n) => ['h1', { 'data-id': n.attrs.id }, 0],
    },
    proseGroup: {
      group: 'block', content: 'block+', attrs: { id: { default: '' } },
      toDOM: (n) => ['div', { 'data-id': n.attrs.id, class: 'block-node prose-group' }, 0],
    },
    text: { group: 'inline' },
  },
})

describe('proseBlockNodes', () => {
  it('1 node → that node with the block id stamped (no container)', () => {
    const p = schema.nodes.paragraph.create({}, schema.text('hello'))
    const out = proseBlockNodes(Fragment.from(p), 'pr-1', schema)
    expect(out.length).toBe(1)
    expect(out[0].type.name).toBe('paragraph')
    expect(out[0].attrs.id).toBe('pr-1')
  })

  it('>1 nodes → ONE proseGroup carrying the id, wrapping all children', () => {
    const h = schema.nodes.heading.create({}, schema.text('Title'))
    const p = schema.nodes.paragraph.create({}, schema.text('body'))
    const out = proseBlockNodes(Fragment.fromArray([h, p]), 'ai-d63e', schema)
    expect(out.length).toBe(1)
    expect(out[0].type.name).toBe('proseGroup')
    expect(out[0].attrs.id).toBe('ai-d63e')
    expect(out[0].childCount).toBe(2)
    expect(out[0].child(0).type.name).toBe('heading')
    expect(out[0].child(1).type.name).toBe('paragraph')
  })

  it('0 nodes → [] (caller logs an empty-block error)', () => {
    expect(proseBlockNodes(Fragment.empty, 'pr-x', schema)).toEqual([])
  })
})

describe('proseGroupMarkdownSerialize', () => {
  it('is transparent — delegates to renderContent and writes no wrapper/markers', () => {
    const calls = { rendered: [], writes: [] }
    const fakeState = {
      renderContent(node) { calls.rendered.push(node) },
      write(s) { calls.writes.push(s) },
    }
    const node = { type: { name: 'proseGroup' } }
    proseGroupMarkdownSerialize(fakeState, node)
    expect(calls.rendered).toEqual([node]) // children rendered…
    expect(calls.writes).toEqual([])        // …and nothing else written
  })
})
