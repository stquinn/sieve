import { describe, it, expect } from 'vitest'
import { computeBlockSync, seedBaseline, mintActions } from '../src/static/block-sync.js'

// mintActions is the pure minting decision: given the blockIds of the top-level
// nodes in document order, return the INDICES that need a fresh id. A node needs
// one when its id is empty OR already seen earlier in the pass — the latter is
// THE splitBlock trap: ProseMirror's Enter copies the node's attrs, so the new
// half is born with the SAME blockId as the original. First occurrence keeps the
// id; the duplicate (later in doc order) is re-minted. Minting only FILLS ids
// (creates no nodes), so the follow-on transaction finds nothing to do →
// convergent (no runaway).
describe('mintActions', () => {
  it('returns nothing when every id is unique and non-empty', () => {
    expect(mintActions(['pr-1', 'pr-2', 'pr-3'])).toEqual([])
  })

  it('flags an empty id', () => {
    expect(mintActions(['pr-1', '', 'pr-3'])).toEqual([1])
  })

  it('flags the DUPLICATE (second occurrence) — the splitBlock attr-copy trap', () => {
    // Enter split: both halves carry pr-1. The first keeps it; the second is re-minted.
    expect(mintActions(['pr-1', 'pr-1'])).toEqual([1])
  })

  it('flags both empties and duplicates, first occurrence always kept', () => {
    expect(mintActions(['pr-1', '', 'pr-1', 'pr-2', 'pr-2'])).toEqual([1, 2, 4])
  })

  it('is empty for an empty doc', () => {
    expect(mintActions([])).toEqual([])
  })

  it('converges: after minting (all unique), a second pass needs nothing', () => {
    const ids = ['pr-1', 'pr-1']
    const need = mintActions(ids)
    // simulate minting fresh ids at the flagged indices
    need.forEach((i, k) => { ids[i] = 'pr-new' + k })
    expect(mintActions(ids)).toEqual([])
  })
})

// seedBaseline builds the initial change-signature map from the SERVER's blocks
// (what Go already holds). Every id'd server block belongs in the baseline —
// INCLUDING an empty one — so the first edit to it is an update-block, never a
// duplicate create-block. (Regression: a loaded empty prose block was wrongly
// excluded via the pending-empty filter, so typing into it create-block'd an id
// Go already had → two blocks with the same id on disk.)
describe('seedBaseline', () => {
  it('includes a loaded empty prose block so its first content is an update, not a duplicate create', () => {
    const loaded = [{ id: 'pr-1', kind: 'prose', content: '' }]
    const base = seedBaseline(loaded)
    expect('pr-1' in base).toBe(true)

    const r = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: 'Hi!' }], base)
    expect(r.mode).toBe('ops')
    expect(r.ops).toEqual([{ type: 'update-block', blockId: 'pr-1', kind: 'prose', content: 'Hi!' }])
  })

  it('skips id-less blocks (a fresh client surface with no server origin)', () => {
    const base = seedBaseline([{ id: '', kind: 'prose', content: '' }])
    expect(Object.keys(base)).toHaveLength(0)
  })

  it('seeds structured blocks by their stable content signature', () => {
    const base = seedBaseline([{ id: 'co-1', kind: 'code', content: '```code\nid: co-1\n```' }])
    expect('co-1' in base).toBe(true)
  })
})

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

  it('a brand-new EMPTY prose block is not synced until it has content', () => {
    // The empty prose surface of a new doc is just the cursor target — no
    // create-block until the user types (user choice: create on first content).
    const r1 = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: '' }], {})
    expect(r1.ops).toEqual([])
    expect(r1.next).toEqual({}) // not tracked, so a later content-add reads as new
    const r2 = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: 'hi' }], r1.next)
    expect(r2.ops).toEqual([{ type: 'create-block', blockId: 'pr-1', kind: 'prose', content: 'hi', index: 0 }])
  })

  it('emptying an EXISTING prose block emits an update, not a skip', () => {
    const prev = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: 'hello' }], null).next
    const r = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: '' }], prev)
    expect(r.ops).toEqual([{ type: 'update-block', blockId: 'pr-1', kind: 'prose', content: '' }])
  })

  // D-r.5: the prose-path doc-update fallback is retired. An id-less PROSE node is
  // a pending editing surface — minting (the appendTransaction plugin) fills its id
  // before the next sync — so it is SKIPPED (emits nothing) rather than forcing a
  // whole-document doc-update. The addressable prose blocks still sync granularly.
  it('skips an id-less prose node (pending) instead of falling back', () => {
    const prev = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: 'A' }], null).next
    const r = computeBlockSync([
      { id: 'pr-1', kind: 'prose', content: 'A2' },
      { id: '', kind: 'prose', content: 'new' }, // minting fills this id next sync
    ], prev)
    expect(r.mode).toBe('ops')
    expect(r.ops).toEqual([
      { type: 'update-block', blockId: 'pr-1', kind: 'prose', content: 'A2' },
    ])
  })

  // The whole point of D-r.5: a session that only ever touches prose must emit
  // granular block-ops on every sync and NEVER drop to the doc-update fallback.
  it('a prose-only edit session never produces a doc-update fallback', () => {
    // create
    let prev = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: 'A' }], null).next
    const created = computeBlockSync([
      { id: 'pr-1', kind: 'prose', content: 'A' },
      { id: 'pr-2', kind: 'prose', content: 'B' },
    ], prev)
    expect(created.mode).toBe('ops')
    prev = created.next
    // update
    const updated = computeBlockSync([
      { id: 'pr-1', kind: 'prose', content: 'A!' },
      { id: 'pr-2', kind: 'prose', content: 'B' },
    ], prev)
    expect(updated.mode).toBe('ops')
    prev = updated.next
    // delete
    const deleted = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: 'A!' }], prev)
    expect(deleted.mode).toBe('ops')
  })

  // The fallback survives ONLY for structured blocks, whose granular sync isn't
  // wired yet. A structured block should always carry a backend-authoritative id,
  // but if one ever arrives id-less it can't be addressed → defensive fallback.
  it('still falls back for an id-less STRUCTURED block (defensive)', () => {
    const r = computeBlockSync([{ id: '', kind: 'code', content: '```code\n```' }], {})
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
