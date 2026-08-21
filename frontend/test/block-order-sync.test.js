// @ts-check
// block-order-sync.test.js — the ORDER half of the observer (#94).
//
// computeBlockSync is an id-keyed diff: a block's signature is kind + content +
// aliases, and nothing in it is positional. A drag-handle reorder therefore
// changed no signature, added no id and removed none, so the batch was empty and
// the backend never heard about it — the reorder was lost on the next load.
//
// Order is reported as ONE set-order op carrying the complete id order, because
// applying a whole order is idempotent where a sequence of moves is not.
import { describe, it, expect } from 'vitest'
import { computeOrderOp } from '../src/static/block/block-sync.js'

const b = (id, kind) => ({ id, kind: kind || 'prose', content: 'x' })

describe('computeOrderOp — a reorder is a change the backend must hear', () => {
  it('seeds on the first call without emitting an op', () => {
    const r = computeOrderOp([b('a'), b('c')], null, [])
    expect(r.op).toBeNull()
    expect(r.next).toEqual(['a', 'c'])
  })

  it('emits nothing while the order is unchanged', () => {
    const r = computeOrderOp([b('a'), b('c')], ['a', 'c'], [])
    expect(r.op).toBeNull()
    expect(r.next).toEqual(['a', 'c'])
  })

  it('emits ONE set-order op carrying the whole order when blocks are reordered', () => {
    const r = computeOrderOp([b('c'), b('a'), b('d')], ['a', 'c', 'd'], [])
    expect(r.op).toEqual({ type: 'set-order', order: ['c', 'a', 'd'] })
    expect(r.next).toEqual(['c', 'a', 'd'])
  })

  it('reorders structured blocks too — order is kind-agnostic', () => {
    const r = computeOrderOp([b('d', 'diagram'), b('a')], ['a', 'd'], [])
    expect(r.op).toEqual({ type: 'set-order', order: ['d', 'a'] })
  })

  it('holds off while the same batch creates or deletes, and does NOT advance the baseline', () => {
    // set-order installs a COMPLETE order, so it is only sendable when the client
    // can name every block the server holds. Mid-batch the sets are still moving;
    // leaving the baseline stale means the next tick retries the reorder.
    const ops = [{ type: 'create-block', blockId: 'n' }]
    const r = computeOrderOp([b('c'), b('a')], ['a', 'c'], ops)
    expect(r.op).toBeNull()
    expect(r.next).toEqual(['a', 'c'])

    const del = [{ type: 'delete-block', blockId: 'a' }]
    const r2 = computeOrderOp([b('c')], ['a', 'c'], del)
    expect(r2.op).toBeNull()
    expect(r2.next).toEqual(['a', 'c'])
  })

  it('holds off while any block is still id-less or in flight', () => {
    // A node the server has not minted an id for cannot appear in a complete
    // order, and one omitted id would make Go read the op as a mass delete.
    const pending = [{ kind: 'prose', content: 'new', token: 'tok-1' }, b('a')]
    const r = computeOrderOp(pending, ['a'], [])
    expect(r.op).toBeNull()
    expect(r.next).toEqual(['a'])
  })

  it('retries on a later tick: the stale baseline still differs, so the order goes out', () => {
    // The create tick held off (baseline stayed ['a','c']); once the ids settle
    // and the batch is quiet, the full order — including the new block — is sent.
    const r = computeOrderOp([b('c'), b('n'), b('a')], ['a', 'c'], [])
    expect(r.op).toEqual({ type: 'set-order', order: ['c', 'n', 'a'] })
    expect(r.next).toEqual(['c', 'n', 'a'])
  })
})
