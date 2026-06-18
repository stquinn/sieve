import { describe, it, expect } from 'vitest'
import { Schema } from '@tiptap/pm/model'

// Step-5 schema design, proven in isolation before touching the live editor
// (this is the area that rotted last time). The invariant we need:
//   - the DOC top-level holds ONLY sieve blocks (group "sieveBlock") — a bare
//     paragraph can never be a top-level node, so "all content is blocks" holds
//     structurally and PM (not a per-keystroke wrapper) enforces it;
//   - a prose block holds the block-level PROSE nodes (paragraph/heading/list,
//     group "block") and EXCLUDES sieve blocks → kind-homogeneity + insert-splits.
//
// The live editor mirrors these exact content/group expressions; this test pins
// the design so the real change is a transcription, not a guess.

const schema = new Schema({
  nodes: {
    doc: { content: 'sieveBlock+' },
    // prose block: a sieve block whose content is the prose nodes, NOT sieve nodes
    'sieve-prose': {
      group: 'sieveBlock',
      content: 'block+',
      attrs: { id: { default: '' } },
      toDOM: (n) => ['div', { 'data-type': 'sieve-prose', 'data-id': n.attrs.id }, 0],
    },
    // a structured sieve block (atom)
    'sieve-code': {
      group: 'sieveBlock',
      atom: true,
      attrs: { id: { default: '' } },
      toDOM: (n) => ['div', { 'data-type': 'sieve-code', 'data-id': n.attrs.id }],
    },
    // prose-level nodes live in group "block" — usable INSIDE sieve-prose, never
    // at the doc top level
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    heading: { group: 'block', content: 'inline*', toDOM: () => ['h1', 0] },
    text: { group: 'inline' },
  },
})

describe('step-5 schema design', () => {
  it('doc top-level accepts a sieve block', () => {
    const m = schema.nodes.doc.contentMatch
    expect(m.matchType(schema.nodes['sieve-prose'])).not.toBeNull()
    expect(m.matchType(schema.nodes['sieve-code'])).not.toBeNull()
  })

  it('doc top-level REJECTS a bare paragraph (no bare top-level nodes)', () => {
    const m = schema.nodes.doc.contentMatch
    expect(m.matchType(schema.nodes.paragraph)).toBeNull()
  })

  it('a prose block accepts prose nodes (paragraph, heading)', () => {
    const m = schema.nodes['sieve-prose'].contentMatch
    expect(m.matchType(schema.nodes.paragraph)).not.toBeNull()
    expect(m.matchType(schema.nodes.heading)).not.toBeNull()
  })

  it('a prose block EXCLUDES sieve blocks (kind-homogeneity → insert-splits)', () => {
    const m = schema.nodes['sieve-prose'].contentMatch
    expect(m.matchType(schema.nodes['sieve-code'])).toBeNull()
    expect(m.matchType(schema.nodes['sieve-prose'])).toBeNull()
  })

  it('createAndFill yields a valid blocks-only doc (>= 1 sieve block, prose fills with a paragraph)', () => {
    const doc = schema.nodes.doc.createAndFill()
    expect(doc).not.toBeNull()
    expect(doc.childCount).toBeGreaterThanOrEqual(1)
    // every top-level child is a sieve block
    doc.forEach((child) => {
      expect(child.type.spec.group).toBe('sieveBlock')
    })
  })

  it('a prose block with paragraphs is a valid top-level child', () => {
    const prose = schema.nodes['sieve-prose'].create(
      { id: 'pr-1' },
      [schema.nodes.paragraph.create(null, schema.text('hello'))],
    )
    const doc = schema.nodes.doc.create(null, [prose])
    expect(doc.firstChild.type.name).toBe('sieve-prose')
    expect(doc.firstChild.firstChild.type.name).toBe('paragraph')
  })
})
