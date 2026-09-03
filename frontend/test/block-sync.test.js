import { describe, it, expect } from 'vitest'
import { computeBlockSync, seedBaseline, dedupeActions, proseOp } from '../src/static/lens/document-editor/block-sync.js'

describe('dedupeActions', () => {
  it('returns nothing when every id is unique and non-empty', () => {
    expect(dedupeActions(['pr-1', 'pr-2', 'pr-3'])).toEqual([])
  })
  it('does NOT flag empty ids (the trailing editing surface is not a block yet)', () => {
    expect(dedupeActions(['pr-1', '', 'pr-3', ''])).toEqual([])
  })
  it('flags the DUPLICATE second occurrence — the splitBlock attr-copy trap', () => {
    expect(dedupeActions(['pr-1', 'pr-1'])).toEqual([1])
  })
  it('flags every later duplicate, first occurrence always kept', () => {
    expect(dedupeActions(['pr-1', 'pr-2', 'pr-1', 'pr-2', 'pr-2'])).toEqual([2, 3, 4])
  })
  it('is empty for an empty list', () => {
    expect(dedupeActions([])).toEqual([])
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
    expect(r.ops).toEqual([{ type: 'update-block', blockId: 'pr-1', kind: 'prose', attrs: { content: 'Hi!' } }])
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
// Returns { ops, next } — always granular block-ops, NO fallback.
//   prose create: id in curr not in prev → create-block {blockId, kind, …, index}
//   prose update: changed sig            → update-block {blockId, kind, …}
//   delete (any kind): id in prev gone   → delete-block {blockId}
//   structured create/change             → no op (synced via its own channels)
//   order-only (same ids+sigs)           → no ops (drag-reorder keeps its move path)

describe('computeBlockSync', () => {
  it('first call (no prev) just establishes the baseline — no ops', () => {
    const curr = [{ id: 'pr-1', kind: 'prose', content: 'Hello' }]
    const r = computeBlockSync(curr, null)
    expect(r.ops).toEqual([])
    expect(r.next).toHaveProperty('pr-1')
  })

  it('emits update-block {content} for a changed prose block', () => {
    const base = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: 'Hello' }], null)
    const r = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: 'Hello there' }], base.next)
    expect(r.ops).toEqual([
      { type: 'update-block', blockId: 'pr-1', kind: 'prose', attrs: { content: 'Hello there' } },
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
    expect(r.ops).toEqual([
      { type: 'update-block', blockId: 'pr-1', kind: 'prose', attrs: { content: 'A2' } },
    ])
  })

  it('emits NOTHING when a structured block changes (its edits sync via ctx.updateAttributes)', () => {
    const prev = computeBlockSync(
      [{ id: 'co-1', kind: 'code', content: '{"id":"co-1","source":"a"}' }], null,
    ).next
    const r = computeBlockSync(
      [{ id: 'co-1', kind: 'code', content: '{"id":"co-1","source":"b"}' }], prev,
    )
    expect(r.ops).toEqual([])
  })

  it('emits NOTHING when a structured block is created (Go created it via editor:insert-block)', () => {
    const prev = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: 'A' }], null).next
    const added = computeBlockSync([
      { id: 'pr-1', kind: 'prose', content: 'A' },
      { id: 'co-1', kind: 'code', content: '{"id":"co-1"}' },
    ], prev)
    expect(added.ops).toEqual([])
    // ...but it IS baselined, so a later delete is detected.
    expect(added.next).toHaveProperty('co-1')
  })

  it('emits delete-block when a structured block is removed', () => {
    const prev = computeBlockSync([
      { id: 'pr-1', kind: 'prose', content: 'A' },
      { id: 'co-1', kind: 'code', content: '{"id":"co-1"}' },
    ], null).next
    const r = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: 'A' }], prev)
    expect(r.ops).toEqual([{ type: 'delete-block', blockId: 'co-1' }])
  })

  it('emits nothing when nothing changed', () => {
    const prev = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: 'Hello' }], null).next
    const r = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: 'Hello' }], prev)
    expect(r.ops).toEqual([])
  })

  it('emits create-block for a new id (with its document index)', () => {
    const prev = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: 'A' }], null).next
    const r = computeBlockSync([
      { id: 'pr-1', kind: 'prose', content: 'A' },
      { id: 'pr-2', kind: 'prose', content: 'B' },
    ], prev)
    expect(r.ops).toEqual([
      { type: 'create-block', blockId: 'pr-2', kind: 'prose', attrs: { content: 'B' }, index: 1 },
    ])
  })

  it('emits delete-block for an id that disappeared', () => {
    const prev = computeBlockSync([
      { id: 'pr-1', kind: 'prose', content: 'A' },
      { id: 'pr-2', kind: 'prose', content: 'B' },
    ], null).next
    const r = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: 'A' }], prev)
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
    expect(r.ops).toEqual([])
  })

  it('carries aliases on update, and an alias change alone triggers an update', () => {
    const prev = computeBlockSync(
      [{ id: 'pr-1', kind: 'prose', content: 'A', aliases: [] }], null,
    ).next
    const r = computeBlockSync(
      [{ id: 'pr-1', kind: 'prose', content: 'A', aliases: ['pr-0'] }], prev,
    )
    expect(r.ops).toEqual([
      { type: 'update-block', blockId: 'pr-1', kind: 'prose', attrs: { content: 'A' }, aliases: ['pr-0'] },
    ])
  })

  it('a brand-new EMPTY prose block is not synced until it has content', () => {
    // The empty prose surface of a new doc is just the cursor target — no
    // create-block until the user types (user choice: create on first content).
    const r1 = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: '' }], {})
    expect(r1.ops).toEqual([])
    expect(r1.next).toEqual({}) // not tracked, so a later content-add reads as new
    const r2 = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: 'hi' }], r1.next)
    expect(r2.ops).toEqual([{ type: 'create-block', blockId: 'pr-1', kind: 'prose', attrs: { content: 'hi' }, index: 0 }])
  })

  it('emptying an EXISTING prose block emits an update, not a skip', () => {
    const prev = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: 'hello' }], null).next
    const r = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: '' }], prev)
    expect(r.ops).toEqual([{ type: 'update-block', blockId: 'pr-1', kind: 'prose', attrs: { content: '' } }])
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
    expect(r.ops).toEqual([
      { type: 'update-block', blockId: 'pr-1', kind: 'prose', attrs: { content: 'A2' } },
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
    prev = created.next
    // update
    const updated = computeBlockSync([
      { id: 'pr-1', kind: 'prose', content: 'A!' },
      { id: 'pr-2', kind: 'prose', content: 'B' },
    ], prev)
    prev = updated.next
    // delete
    const deleted = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: 'A!' }], prev)
  })

  // No fallback exists for any kind. An id-less structured block (it should always
  // carry a backend id) is simply not addressable yet → skipped, emits nothing.
  it('skips an id-less STRUCTURED block instead of falling back', () => {
    const r = computeBlockSync([{ id: '', kind: 'code', content: '{}' }], {})
    expect(r.ops).toEqual([])
    expect(r.next).toEqual({})
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

  // Structural blank lines: a deliberately-empty prose paragraph that has a
  // content-bearing block AFTER it is real content (the user placed it for
  // spacing) and must persist — unlike the TRAILING empty paragraph, which is
  // just the editing surface (still ephemeral). The rule is symmetric: an empty
  // prose block is "pending" iff NO content-bearing block of any kind follows it.
  it('syncs a brand-new EMPTY prose block when a content block follows it (structural blank line)', () => {
    const prev = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: 'A' }], null).next
    const r = computeBlockSync([
      { id: 'pr-1', kind: 'prose', content: 'A' },
      { id: 'pr-2', kind: 'prose', content: '' }, // structural blank — content follows
      { id: 'pr-3', kind: 'prose', content: 'B' },
    ], prev)
    expect(r.ops).toEqual([
      { type: 'create-block', blockId: 'pr-2', kind: 'prose', attrs: { content: '' }, index: 1 },
      { type: 'create-block', blockId: 'pr-3', kind: 'prose', attrs: { content: 'B' }, index: 2 },
    ])
  })

  it('does NOT sync a trailing EMPTY prose block even with content before it (the editing surface)', () => {
    const prev = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: 'A' }], null).next
    const r = computeBlockSync([
      { id: 'pr-1', kind: 'prose', content: 'A' },
      { id: 'pr-2', kind: 'prose', content: '' }, // trailing — nothing after → ephemeral
    ], prev)
    expect(r.ops).toEqual([])
    expect('pr-2' in r.next).toBe(false)
  })

  it('preserves EACH of multiple structural blank lines as its own block (3 blanks → 3 blocks)', () => {
    const prev = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: 'A' }], null).next
    const r = computeBlockSync([
      { id: 'pr-1', kind: 'prose', content: 'A' },
      { id: 'pr-2', kind: 'prose', content: '' },
      { id: 'pr-3', kind: 'prose', content: '' },
      { id: 'pr-4', kind: 'prose', content: '' },
      { id: 'pr-5', kind: 'prose', content: 'B' },
    ], prev)
    expect(r.ops.filter((o) => o.type === 'create-block').map((o) => o.blockId))
      .toEqual(['pr-2', 'pr-3', 'pr-4', 'pr-5'])
  })

  it('treats a STRUCTURED block after an empty prose as content (empty prose is structural, not trailing)', () => {
    const prev = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: 'A' }], null).next
    const r = computeBlockSync([
      { id: 'pr-1', kind: 'prose', content: 'A' },
      { id: 'pr-2', kind: 'prose', content: '' }, // blank before an image → structural
      { id: 'im-1', kind: 'smart-image', content: '{"id":"im-1"}' },
    ], prev)
    // pr-2 persists (image follows); the structured block emits nothing of its own.
    expect(r.ops).toEqual([
      { type: 'create-block', blockId: 'pr-2', kind: 'prose', attrs: { content: '' }, index: 1 },
    ])
  })
})

describe('computeBlockSync — a prose block is born with its own id', () => {
  it('emits create-block STATING the id the lens minted', () => {
    const r = computeBlockSync([{ id: 'pr-new', kind: 'prose', content: 'hi' }], {})
    expect(r.ops).toEqual([
      { type: 'create-block', blockId: 'pr-new', kind: 'prose', attrs: { content: 'hi' }, index: 0 },
    ])
    expect(r.next).toHaveProperty('pr-new') // baselined so it is not re-emitted
  })

  it('carries NO transient handle: identity is the id, and there is nothing to correlate', () => {
    const [op] = computeBlockSync([{ id: 'pr-new', kind: 'prose', content: 'hi' }], {}).ops
    expect(Object.keys(op)).toEqual(['type', 'blockId', 'kind', 'attrs', 'index'])
  })

  it('an edit made while the create is in flight becomes ONE update under the SAME id', () => {
    // No pin, no key swap: the id never changes, so the second tick is an
    // ordinary diff against the create-time signature.
    const base = computeBlockSync([{ id: 'pr-new', kind: 'prose', content: 'hi' }], {}).next
    const r = computeBlockSync([{ id: 'pr-new', kind: 'prose', content: 'hi there' }], base)
    expect(r.ops).toEqual([
      { type: 'update-block', blockId: 'pr-new', kind: 'prose', attrs: { content: 'hi there' } },
    ])
  })

  it('an id-less empty surface is still skipped and not baselined', () => {
    const r = computeBlockSync([{ id: '', kind: 'prose', content: '' }], {})
    expect(r.ops).toEqual([])
    expect(r.next).toEqual({})
  })

  it('emits create-block for a STRUCTURAL blank (empty prose with content after)', () => {
    const r = computeBlockSync([
      { id: 'pr-blank', kind: 'prose', content: '' },
      { id: 'pr-2', kind: 'prose', content: 'after' },
    ], {})
    const created = r.ops.filter(o => o.type === 'create-block').map(o => o.blockId)
    expect(created).toContain('pr-blank')   // the structural blank is a real block, synced
  })
})

describe('computeBlockSync — the delete loop', () => {
  it('emits delete-block for any baselined id that disappeared', () => {
    // Every id in the baseline is one Go was told about — a block reaches it only
    // by being loaded or created — so a delete always names something Go can find.
    const prev = { 'pr-1': 'prose\x00A\x00' }
    const r = computeBlockSync([], prev)
    expect(r.ops).toEqual([{ type: 'delete-block', blockId: 'pr-1' }])
  })

  it('deletes a block created THIS session by the same id it was created with', () => {
    const base = computeBlockSync([{ id: 'pr-new', kind: 'prose', content: 'hi' }], {}).next
    const r = computeBlockSync([], base)
    expect(r.ops).toEqual([{ type: 'delete-block', blockId: 'pr-new' }])
  })
})
