import { describe, it, expect } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import { isNativeProseNodeName, proseChainHits } from '../src/static/block-kinds.js'

describe('proseGroup is routed as native prose (the linchpin)', () => {
  it('isNativeProseNodeName("proseGroup") is true (so save/chain/identity treat it as prose)', () => {
    expect(isNativeProseNodeName('proseGroup')).toBe(true)
    // contrast: a sieve-* node is NOT native prose
    expect(isNativeProseNodeName('sieve-ai-block')).toBe(false)
  })
})

describe('proseChainHits matches a proseGroup container', () => {
  const schema = new Schema({
    nodes: {
      doc: { content: 'block+' },
      paragraph: {
        group: 'block', content: 'inline*', attrs: { id: { default: '' } },
        toDOM: (n) => ['p', { 'data-id': n.attrs.id }, 0],
      },
      proseGroup: {
        group: 'block', content: 'block+', attrs: { id: { default: '' } },
        toDOM: (n) => ['div', { 'data-id': n.attrs.id, class: 'block-node prose-group' }, 0],
      },
      text: { group: 'inline' },
    },
  })

  it('returns the container range when its id is in the chain', () => {
    const inner = schema.nodes.paragraph.create({}, schema.text('answer'))
    const group = schema.nodes.proseGroup.create({ id: 'ai-d63e' }, inner)
    const doc = schema.nodes.doc.create({}, group)
    const hits = proseChainHits(doc, ['ai-d63e'])
    expect(hits.length).toBe(1)
    expect(hits[0].id).toBe('ai-d63e')
    expect(hits[0].from).toBe(0)
  })
})
