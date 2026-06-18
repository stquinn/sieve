import { describe, it, expect } from 'vitest'
import { computeBlockSync } from '../src/static/block-sync.js'

// computeBlockSync(curr, prev) is the pure heart of the D.4 thin observer — a
// full id-keyed diff over top-level blocks.
//   curr: [{ id, kind, content?, attrs?, aliases? }] in document order.
//         prose carries `content` (markdown); structured carries `attrs` (the
//         properties map — the block model is properties-native, no fence text).
//   prev: { [id]: sig } change-signatures from the last sync, or null on the
//         first call (baseline only — never emits ops).
// Returns { mode, ops, next } where mode is 'ops' (granular block-ops) or
// 'fallback' (defensive: a block has no id, so it can't be addressed).
//   create: id in curr not in prev → create-block {blockId, kind, …, index}
//   delete: id in prev not in curr → delete-block {blockId}
//   update: changed sig            → update-block {blockId, kind, …}
//   order-only (same ids+sigs)     → no ops (drag-reorder keeps its move path)

describe('computeBlockSync', () => {
  it('first call (no prev) just establishes the baseline — no ops', () => {
    const curr = [{ id: 'pr-1', kind: 'prose', content: 'Hello' }]
    const r = computeBlockSync(curr, null)
    expect(r.mode).toBe('ops')
    expect(r.ops).toEqual([])
    expect(r.next).toHaveProperty('pr-1')
  })

  it('emits update-block {content} for a changed prose block', () => {
    const base = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: 'Hello' }], null)
    const r = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: 'Hello there' }], base.next)
    expect(r.mode).toBe('ops')
    expect(r.ops).toEqual([
      { type: 'update-block', blockId: 'pr-1', kind: 'prose', content: 'Hello there' },
    ])
  })

  it('does not emit ops for an unchanged structured block (its sync is elsewhere)', () => {
    const prev = computeBlockSync([
      { id: 'pr-1', kind: 'prose', content: 'A' },
      { id: 'co-1', kind: 'code', content: '```code\nid: co-1\nsource: a\n```' },
    ], null).next
    const r = computeBlockSync([
      { id: 'pr-1', kind: 'prose', content: 'A2' },
      { id: 'co-1', kind: 'code', content: '```code\nid: co-1\nsource: a\n```' },
    ], prev)
    expect(r.mode).toBe('ops')
    expect(r.ops).toEqual([
      { type: 'update-block', blockId: 'pr-1', kind: 'prose', content: 'A2' },
    ])
  })

  it('falls back when a structured block changes (structured sync not granular yet)', () => {
    const prev = computeBlockSync(
      [{ id: 'co-1', kind: 'code', content: '```code\nid: co-1\nsource: a\n```' }], null,
    ).next
    const r = computeBlockSync(
      [{ id: 'co-1', kind: 'code', content: '```code\nid: co-1\nsource: b\n```' }], prev,
    )
    expect(r.mode).toBe('fallback')
  })

  it('falls back when a structured block is created or deleted', () => {
    const prev = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: 'A' }], null).next
    const added = computeBlockSync([
      { id: 'pr-1', kind: 'prose', content: 'A' },
      { id: 'co-1', kind: 'code', content: '```code\nid: co-1\n```' },
    ], prev)
    expect(added.mode).toBe('fallback')
  })

  it('emits nothing when nothing changed', () => {
    const prev = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: 'Hello' }], null).next
    const r = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: 'Hello' }], prev)
    expect(r.mode).toBe('ops')
    expect(r.ops).toEqual([])
  })

  it('emits create-block for a new id (with its document index)', () => {
    const prev = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: 'A' }], null).next
    const r = computeBlockSync([
      { id: 'pr-1', kind: 'prose', content: 'A' },
      { id: 'pr-2', kind: 'prose', content: 'B' },
    ], prev)
    expect(r.mode).toBe('ops')
    expect(r.ops).toEqual([
      { type: 'create-block', blockId: 'pr-2', kind: 'prose', content: 'B', index: 1 },
    ])
  })

  it('emits delete-block for an id that disappeared', () => {
    const prev = computeBlockSync([
      { id: 'pr-1', kind: 'prose', content: 'A' },
      { id: 'pr-2', kind: 'prose', content: 'B' },
    ], null).next
    const r = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: 'A' }], prev)
    expect(r.mode).toBe('ops')
    expect(r.ops).toEqual([{ type: 'delete-block', blockId: 'pr-2' }])
  })

  it('order-only change emits no ops (reorder keeps the move path)', () => {
    const prev = computeBlockSync([
      { id: 'pr-1', kind: 'prose', content: 'A' },
      { id: 'pr-2', kind: 'prose', content: 'B' },
    ], null).next
    const r = computeBlockSync([
      { id: 'pr-2', kind: 'prose', content: 'B' },
      { id: 'pr-1', kind: 'prose', content: 'A' },
    ], prev)
    expect(r.mode).toBe('ops')
    expect(r.ops).toEqual([])
  })

  it('carries aliases on update, and an alias change alone triggers an update', () => {
    const prev = computeBlockSync(
      [{ id: 'pr-1', kind: 'prose', content: 'A', aliases: [] }], null,
    ).next
    const r = computeBlockSync(
      [{ id: 'pr-1', kind: 'prose', content: 'A', aliases: ['pr-0'] }], prev,
    )
    expect(r.mode).toBe('ops')
    expect(r.ops).toEqual([
      { type: 'update-block', blockId: 'pr-1', kind: 'prose', content: 'A', aliases: ['pr-0'] },
    ])
  })

  it('falls back when any block has no id (defensive only — minting should precede)', () => {
    const prev = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: 'A' }], null).next
    const r = computeBlockSync([
      { id: 'pr-1', kind: 'prose', content: 'A' },
      { id: '', kind: 'prose', content: 'new' },
    ], prev)
    expect(r.mode).toBe('fallback')
  })

  it('emits one op per changed block, in document order', () => {
    const prev = computeBlockSync([
      { id: 'pr-1', kind: 'prose', content: 'a' },
      { id: 'pr-2', kind: 'prose', content: 'b' },
      { id: 'pr-3', kind: 'prose', content: 'c' },
    ], null).next
    const r = computeBlockSync([
      { id: 'pr-1', kind: 'prose', content: 'a2' },
      { id: 'pr-2', kind: 'prose', content: 'b' },
      { id: 'pr-3', kind: 'prose', content: 'c2' },
    ], prev)
    expect(r.ops.map((o) => o.blockId)).toEqual(['pr-1', 'pr-3'])
  })
})
