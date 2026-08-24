import { describe, it, expect } from 'vitest'
import { proseChainHits } from '../src/static/renderers/block-kinds.js'
import { build, docWithCaretAt } from './helpers/editor-fixture.js'

// proseChainHits is the pure selection behind the AI ref-chain hover glow: given
// the chain's block ids, it picks the top-level NATIVE PROSE nodes to decorate.
// Structured sieve blocks (NodeViews) are excluded — they take the class via
// classList in ai-block-renderer; only native prose needs the PM decoration,
// because ProseMirror reverts a class set directly on a native node.
describe('proseChainHits — AI ref-chain decoration selection', () => {
  function doc(nodes) {
    return docWithCaretAt(nodes, 1).state.doc
  }

  it('selects the native prose chain-member, skipping sieve blocks and non-members', () => {
    const d = doc([
      build.p('first', 'pr-1'),       // prose, in chain → hit
      build.aiBlock('ai-1', 'pr-1'),  // sieve ai-block, in chain → EXCLUDED (NodeView)
      build.p('second', 'pr-2'),      // prose, NOT in chain → skipped
    ])
    const hits = proseChainHits(d, ['pr-1', 'ai-1'])
    expect(hits.map((h) => h.id)).toEqual(['pr-1'])
  })

  it('selects multiple prose members in document order', () => {
    const d = doc([
      build.p('a', 'pr-1'),
      build.p('b', 'pr-2'),
      build.p('c', 'pr-3'),
    ])
    const hits = proseChainHits(d, ['pr-3', 'pr-1'])
    expect(hits.map((h) => h.id)).toEqual(['pr-1', 'pr-3'])
  })

  it('returns ranges that wrap exactly one node (from..from+nodeSize)', () => {
    const d = doc([build.p('only', 'pr-1')])
    const hits = proseChainHits(d, ['pr-1'])
    expect(hits).toHaveLength(1)
    const node = d.child(0)
    expect(hits[0].to - hits[0].from).toBe(node.nodeSize)
  })

  it('returns nothing for an empty id list', () => {
    const d = doc([build.p('x', 'pr-1')])
    expect(proseChainHits(d, [])).toEqual([])
  })
})
