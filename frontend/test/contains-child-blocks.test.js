import { describe, it, expect } from 'vitest'
import { Schema } from 'prosemirror-model'
import { containsChildBlocks } from '../src/static/block/block-kinds.js'

// Mirrors the real sieve-block schema shapes:
//   container ('block+')  → ai-block, web-clip  — hold child BLOCKS
//   textleaf  ('text*')   → code, diagram        — hold their own text
//   atomleaf  (atom)      → smart-image          — leaf, no content
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    text: { group: 'inline' },
    paragraph: { group: 'block', content: 'text*' },
    container: { group: 'block', content: 'block+' },
    textleaf: { group: 'block', content: 'text*' },
    atomleaf: { group: 'block', atom: true },
  },
})

describe('containsChildBlocks', () => {
  it('is true for a block+ container (ai-block / web-clip)', () => {
    const n = schema.nodes.container.create(null, schema.nodes.paragraph.create())
    expect(containsChildBlocks(n)).toBe(true)
  })

  it('is false for a text* leaf (code / diagram own text, not children)', () => {
    expect(containsChildBlocks(schema.nodes.textleaf.create())).toBe(false)
  })

  it('is false for an atom leaf (smart-image)', () => {
    expect(containsChildBlocks(schema.nodes.atomleaf.create())).toBe(false)
  })
})
