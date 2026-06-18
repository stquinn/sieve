import { describe, it, expect } from 'vitest'
import { computeBlockSync } from '../src/static/block-sync.js'

// computeBlockSync(curr, prev) is the pure heart of the D.3 thin observer.
//   curr: [{ id, kind, content }] top-level blocks in document order, where
//         `content` is the block's serialized form (prose markdown / fence text).
//   prev: { [id]: content } cache from the last successful sync, or null on the
//         very first call (baseline only — never emits ops).
// It returns { mode, ops, next } where mode is 'ops' (granular block-ops are
// safe) or 'fallback' (caller must send a whole-document doc-update because a
// block can't be addressed granularly yet).

describe('computeBlockSync', () => {
  it('first call (no prev) just establishes the baseline — no ops', () => {
    const curr = [{ id: 'pr-1', kind: 'prose', content: 'Hello' }]
    const r = computeBlockSync(curr, null)
    expect(r.mode).toBe('ops')
    expect(r.ops).toEqual([])
    expect(r.next).toEqual({ 'pr-1': 'Hello' })
  })

  it('emits one update-block for a changed block', () => {
    const prev = { 'pr-1': 'Hello', 'pr-2': 'World' }
    const curr = [
      { id: 'pr-1', kind: 'prose', content: 'Hello there' },
      { id: 'pr-2', kind: 'prose', content: 'World' },
    ]
    const r = computeBlockSync(curr, prev)
    expect(r.mode).toBe('ops')
    expect(r.ops).toEqual([
      { type: 'update-block', blockId: 'pr-1', kind: 'prose', content: 'Hello there' },
    ])
    expect(r.next).toEqual({ 'pr-1': 'Hello there', 'pr-2': 'World' })
  })

  it('emits nothing when nothing changed', () => {
    const prev = { 'pr-1': 'Hello' }
    const curr = [{ id: 'pr-1', kind: 'prose', content: 'Hello' }]
    const r = computeBlockSync(curr, prev)
    expect(r.mode).toBe('ops')
    expect(r.ops).toEqual([])
  })

  it('falls back when a structured block changes (Attrs contract is Go-side — D.4+)', () => {
    // The Go update-block contract for structured blocks carries parsed Attrs,
    // not fence text. The client only has the fence string, so a changed
    // structured block defers to a whole-document doc-update rather than emit a
    // wrong op. An UNCHANGED structured block must not force a fallback.
    const prev = { 'co-1': '```code\nid: co-1\nsource: a\n```' }
    const curr = [{ id: 'co-1', kind: 'code', content: '```code\nid: co-1\nsource: b\n```' }]
    expect(computeBlockSync(curr, prev).mode).toBe('fallback')

    const same = [{ id: 'co-1', kind: 'code', content: '```code\nid: co-1\nsource: a\n```' }]
    const r = computeBlockSync(same, prev)
    expect(r.mode).toBe('ops')
    expect(r.ops).toEqual([])
  })

  it('falls back when any block has no id (identity not minted yet — D.4)', () => {
    const prev = { 'pr-1': 'Hello' }
    const curr = [
      { id: 'pr-1', kind: 'prose', content: 'Hello' },
      { id: '', kind: 'prose', content: 'new para' },
    ]
    const r = computeBlockSync(curr, prev)
    expect(r.mode).toBe('fallback')
  })

  it('falls back when the top-level block set changed (split/merge — D.4)', () => {
    const prev = { 'pr-1': 'Hello', 'pr-2': 'World' }
    const curr = [{ id: 'pr-1', kind: 'prose', content: 'Hello' }] // pr-2 removed
    const r = computeBlockSync(curr, prev)
    expect(r.mode).toBe('fallback')
  })

  it('emits an op per changed block, in document order', () => {
    const prev = { 'pr-1': 'a', 'pr-2': 'b', 'pr-3': 'c' }
    const curr = [
      { id: 'pr-1', kind: 'prose', content: 'a2' },
      { id: 'pr-2', kind: 'prose', content: 'b' },
      { id: 'pr-3', kind: 'prose', content: 'c2' },
    ]
    const r = computeBlockSync(curr, prev)
    expect(r.ops.map(o => o.blockId)).toEqual(['pr-1', 'pr-3'])
  })
})
