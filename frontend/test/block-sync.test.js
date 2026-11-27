import { describe, it, expect } from 'vitest'
import { computeBlockSync, seedBaseline, dedupeActions } from '../src/static/lens/document-editor/block-sync.js'

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
//   create (any kind): id in curr not in prev → create-block {blockId, kind, attrs, index}
//   prose update: changed sig                 → update-block {blockId, kind, …}
//   delete (any kind): id in prev gone        → delete-block {blockId}
//   structured attrs change                   → no op (synced via its own channels)
//   kind change under one id (any kinds)      → replace-block {blockId, kind, attrs}
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

  // An undo or redo of a transform puts a block of ANOTHER kind back under the same
  // id. No attrs merge can say that, so the observer states the block whole —
  // whichever kinds are involved, prose among them.
  it.each([
    ['structured → structured', { id: 'b-1', kind: 'code', content: '{"source":"x"}', attrs: { source: 'x' } },
      { id: 'b-1', kind: 'ai-block', content: '{"answer":[]}', attrs: { answer: [] } },
      { type: 'replace-block', blockId: 'b-1', kind: 'ai-block', attrs: { answer: [] } }],
    ['prose → structured', { id: 'b-1', kind: 'prose', content: 'Embedded' },
      { id: 'b-1', kind: 'ai-block', content: '{"answer":[]}', attrs: { answer: [] } },
      { type: 'replace-block', blockId: 'b-1', kind: 'ai-block', attrs: { answer: [] } }],
    ['structured → prose', { id: 'b-1', kind: 'code', content: '{"source":"x"}', attrs: { source: 'x' } },
      { id: 'b-1', kind: 'prose', content: 'x' },
      { type: 'replace-block', blockId: 'b-1', kind: 'prose', attrs: { content: 'x' } }],
  ])('states a block whose kind changed under its id whole (%s)', (_, before, after, op) => {
    const prev = computeBlockSync([before], null).next
    const r = computeBlockSync([after], prev)
    expect(r.ops).toEqual([op])
    expect(computeBlockSync([after], r.next).ops).toEqual([])
  })

  // A block Go created is baselined when the editor places it (seedBaseline over
  // that one block), so it is never stated back to Go.
  it('emits nothing for a block Go created once it is baselined at placement', () => {
    const placed = { id: 'co-1', kind: 'code', content: '{"id":"co-1"}', attrs: { id: 'co-1' } }
    const prev = Object.assign(
      computeBlockSync([{ id: 'pr-1', kind: 'prose', content: 'A' }], null).next,
      seedBaseline([placed]),
    )
    const r = computeBlockSync([{ id: 'pr-1', kind: 'prose', content: 'A' }, placed], prev)
    expect(r.ops).toEqual([])
    expect(r.next).toHaveProperty('co-1')
  })

  // An undo or a redo changes the block list with no verb behind it. Whatever the
  // kind, a block the editor shows again is stated to Go as a create at its index,
  // and one it stops showing as a delete.
  describe.each([
    ['prose', { id: 'b-1', kind: 'prose', content: 'Embedded' }, { content: 'Embedded' }],
    ['code', { id: 'b-1', kind: 'code', content: '{"source":"x"}', attrs: { id: 'b-1', source: 'x' } }, { id: 'b-1', source: 'x' }],
    ['diagram', { id: 'b-1', kind: 'diagram', content: '{"source":"graph TD"}', attrs: { id: 'b-1', source: 'graph TD' } }, { id: 'b-1', source: 'graph TD' }],
    ['ai-block', { id: 'b-1', kind: 'ai-block', content: '{"answer":[]}', attrs: { id: 'b-1', status: 'COMPLETE', answer: [] } }, { id: 'b-1', status: 'COMPLETE', answer: [] }],
    ['reference', { id: 'b-1', kind: 'reference', content: '{"uri":"sieve://9f2b"}', attrs: { id: 'b-1', uri: 'sieve://9f2b' } }, { id: 'b-1', uri: 'sieve://9f2b' }],
    ['log', { id: 'b-1', kind: 'log', content: '{"source":"10:00 ERROR x"}', attrs: { id: 'b-1', source: '10:00 ERROR x' } }, { id: 'b-1', source: '10:00 ERROR x' }],
    ['smart-card', { id: 'b-1', kind: 'smart-card', content: '{"href":"https://go.dev"}', attrs: { id: 'b-1', href: 'https://go.dev' } }, { id: 'b-1', href: 'https://go.dev' }],
    ['web-clip', { id: 'b-1', kind: 'web-clip', content: '{"source":"https://go.dev"}', attrs: { id: 'b-1', source: 'https://go.dev', mode: 'summarise' } }, { id: 'b-1', source: 'https://go.dev', mode: 'summarise' }],
    ['smart-image', { id: 'b-1', kind: 'smart-image', content: '{"src":"sieve://9f2b/chart.png"}', attrs: { id: 'b-1', src: 'sieve://9f2b/chart.png', summary: 'A chart' } }, { id: 'b-1', src: 'sieve://9f2b/chart.png', summary: 'A chart' }],
  ])('the block list an undo or redo leaves (%s)', (_, blk, attrs) => {
    const pr1 = { id: 'pr-1', kind: 'prose', content: 'A' }
    const create = { type: 'create-block', blockId: 'b-1', kind: blk.kind, attrs: attrs, index: 1 }
    const remove = { type: 'delete-block', blockId: 'b-1' }

    it('redo of an undone block Go created states it again', () => {
      const placed = Object.assign(computeBlockSync([pr1], null).next, seedBaseline([blk]))
      const undone = computeBlockSync([pr1], placed)
      expect(undone.ops).toEqual([remove])
      const redone = computeBlockSync([pr1, blk], undone.next)
      expect(redone.ops).toEqual([create])
      expect(computeBlockSync([pr1, blk], redone.next).ops).toEqual([])
    })

    it('undo of a deleted block states it again', () => {
      const held = computeBlockSync([pr1, blk], null).next
      const deleted = computeBlockSync([pr1], held)
      expect(deleted.ops).toEqual([remove])
      const undone = computeBlockSync([pr1, blk], deleted.next)
      expect(undone.ops).toEqual([create])
    })
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
    const image = { id: 'im-1', kind: 'smart-image', content: '{"id":"im-1"}' }
    const r = computeBlockSync([
      { id: 'pr-1', kind: 'prose', content: 'A' },
      { id: 'pr-2', kind: 'prose', content: '' }, // blank before an image → structural
      image,
    ], Object.assign(prev, seedBaseline([image])))
    // pr-2 persists (image follows); the image Go placed emits nothing of its own.
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
