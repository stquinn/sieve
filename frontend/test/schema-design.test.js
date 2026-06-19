import { describe, it, expect } from 'vitest'
import { Schema } from '@tiptap/pm/model'

// Node-granular schema design (2026-06-19), proven in isolation before touching
// the live editor. The invariants we need now:
//   - the DOC top-level holds NATIVE block nodes (paragraph/heading/list/…, group
//     "block") AND structured sieve blocks (group "sieveBlock") as siblings — a
//     prose block IS one native top-level node, not a custom container;
//   - top-level node types carry a `blockId` attribute (the in-editor identity
//     carrier; durable identity lives in the on-disk markers);
//   - the custom `sieve-prose` `block+` container is RETIRED.
//
// The live editor mirrors these exact content/group expressions; this test pins
// the design so the real change is a transcription, not a guess.

const schema = new Schema({
  nodes: {
    // doc admits native block nodes AND structured sieve blocks at top level.
    doc: { content: '(block | sieveBlock)+' },
    // native top-level prose nodes — each carries a blockId
    paragraph: {
      group: 'block',
      content: 'inline*',
      attrs: { blockId: { default: '' } },
      toDOM: (n) => ['p', { 'data-id': n.attrs.blockId }, 0],
    },
    heading: {
      group: 'block',
      content: 'inline*',
      attrs: { blockId: { default: '' } },
      toDOM: (n) => ['h1', { 'data-id': n.attrs.blockId }, 0],
    },
    bulletList: {
      group: 'block',
      content: 'listItem+',
      attrs: { blockId: { default: '' } },
      toDOM: (n) => ['ul', { 'data-id': n.attrs.blockId }, 0],
    },
    listItem: { content: 'paragraph+', toDOM: () => ['li', 0] },
    // a structured sieve block (atom) — its own kind, payload in attrs
    'sieve-code': {
      group: 'sieveBlock',
      atom: true,
      attrs: { id: { default: '' } },
      toDOM: (n) => ['div', { 'data-type': 'sieve-code', 'data-id': n.attrs.id }],
    },
    text: { group: 'inline' },
  },
})

describe('node-granular schema design', () => {
  it('doc top-level accepts a native paragraph (prose block = native node)', () => {
    const m = schema.nodes.doc.contentMatch
    expect(m.matchType(schema.nodes.paragraph)).not.toBeNull()
  })

  it('doc top-level accepts a heading and a bullet list (any native node is a block)', () => {
    const m = schema.nodes.doc.contentMatch
    expect(m.matchType(schema.nodes.heading)).not.toBeNull()
    expect(m.matchType(schema.nodes.bulletList)).not.toBeNull()
  })

  it('doc top-level accepts a structured sieve block as a sibling', () => {
    const m = schema.nodes.doc.contentMatch
    expect(m.matchType(schema.nodes['sieve-code'])).not.toBeNull()
  })

  it('the sieve-prose container no longer exists in the schema', () => {
    expect(schema.nodes['sieve-prose']).toBeUndefined()
  })

  it('a native top-level node carries a blockId attribute', () => {
    const p = schema.nodes.paragraph.create({ blockId: 'pr-1' }, schema.text('hi'))
    expect(p.attrs.blockId).toBe('pr-1')
  })

  it('createAndFill yields a valid doc whose first child is a native paragraph', () => {
    const doc = schema.nodes.doc.createAndFill()
    expect(doc).not.toBeNull()
    expect(doc.childCount).toBeGreaterThanOrEqual(1)
    expect(doc.firstChild.type.name).toBe('paragraph')
  })

  it('a doc mixing a paragraph, a list, and a sieve block is valid', () => {
    const para = schema.nodes.paragraph.create({ blockId: 'pr-1' }, schema.text('intro'))
    const li = schema.nodes.listItem.create(null, schema.nodes.paragraph.create(null, schema.text('item')))
    const list = schema.nodes.bulletList.create({ blockId: 'pr-2' }, li)
    const code = schema.nodes['sieve-code'].create({ id: 'co-1' })
    const doc = schema.nodes.doc.create(null, [para, list, code])
    expect(doc.childCount).toBe(3)
    expect(doc.child(0).type.name).toBe('paragraph')
    expect(doc.child(1).type.name).toBe('bulletList')
    expect(doc.child(2).type.name).toBe('sieve-code')
  })
})
