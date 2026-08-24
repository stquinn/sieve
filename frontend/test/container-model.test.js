// @ts-check
// container-model.test.js — the fold, the copies and the cue (issue #96 P1).
// ContainerModel is driven by DATA only: no socket, no service, no DOM.

import { describe, it, expect } from 'vitest'
import { ContainerModel } from '../src/static/container/container-model.js'
import { ContractViolation } from '../src/static/contract/sieve-block.js'
import { DocumentFrame } from '../src/static/generated/protocol.js'

/** A recording ContainerUpdateListener.
 *  @param {(change: any) => void} [onEach]  runs inside the cue, to read the model mid-emit
 *  @returns {{onChanged: (c: any) => void, seen: any[]}} */
function recorder(onEach) {
  /** @type {any[]} */
  const seen = []
  return {
    seen,
    onChanged: (change) => { seen.push(change); if (onEach) onEach(change) },
  }
}

/** A model seeded with three ordered blocks.
 *  @returns {ContainerModel} */
function seeded() {
  const model = new ContainerModel('doc-1')
  model.applyLoad({
    uuid: 'doc-1',
    blocks: [
      { id: 'p1', kind: 'prose', attrs: { content: 'hello' } },
      { id: 'c1', kind: 'code', attrs: { source: 'x=1' } },
      { id: 'a1', kind: 'ai-block', attrs: { question: 'Q?', status: 'PENDING' } },
    ],
  })
  return model
}

describe('ContainerModel construction', () => {
  it('requires a uuid', () => {
    expect(() => new ContainerModel('')).toThrow(ContractViolation)
  })

  it('carries kind as a data word, defaulting to note', () => {
    expect(new ContainerModel('doc-1').getKind()).toBe('note')
    expect(new ContainerModel('doc-1', 'chat').getKind()).toBe('chat')
    expect(new ContainerModel('doc-1').getUuid()).toBe('doc-1')
  })

  it('starts empty', () => {
    const model = new ContainerModel('doc-1')
    expect(model.getOrder()).toEqual([])
    expect(model.getBlock('anything')).toBeNull()
  })
})

describe('ContainerModel.applyLoad', () => {
  it('seeds order and nodes from the load answer', () => {
    const model = seeded()
    expect(model.getOrder()).toEqual(['p1', 'c1', 'a1'])
    expect(model.getBlock('c1')).toEqual({ id: 'c1', kind: 'code', attrs: { source: 'x=1', id: 'c1' } })
  })

  it('RESETS: a second load retires what it no longer names, and re-orders the rest', () => {
    const model = seeded()
    model.applyLoad({ uuid: 'doc-1', blocks: [
      { id: 'a1', kind: 'ai-block', attrs: { question: 'Q?' } },
      { id: 'p1', kind: 'prose', attrs: { content: 'hello' } },
    ] })
    expect(model.getOrder()).toEqual(['a1', 'p1'])
    expect(model.getBlock('c1')).toBeNull()
  })

  it('skips id-less blocks', () => {
    const model = new ContainerModel('doc-1')
    model.applyLoad({ blocks: [{ kind: 'prose', attrs: {} }, { id: 'p1', kind: 'prose', attrs: {} }] })
    expect(model.getOrder()).toEqual(['p1'])
  })

  it('accepts an answer that names no uuid (Go found nothing), and refuses another container\'s', () => {
    const model = new ContainerModel('doc-1')
    expect(() => model.applyLoad({ blocks: [] })).not.toThrow()
    expect(() => model.applyLoad({ uuid: 'doc-2', blocks: [] })).toThrow(ContractViolation)
  })
})

describe('ContainerModel fold — insert-block', () => {
  it('splices at the frame index', () => {
    const model = seeded()
    model.applyFrame({ type: DocumentFrame.INSERT_BLOCK, id: 'i1', kind: 'smart-image', attrs: { src: 'a.png' }, index: 1 })
    expect(model.getOrder()).toEqual(['p1', 'i1', 'c1', 'a1'])
    expect(model.getBlock('i1')).toEqual({ id: 'i1', kind: 'smart-image', attrs: { src: 'a.png', id: 'i1' } })
  })

  it('appends on Go\'s append index (-1) and on an index past the end', () => {
    const model = seeded()
    model.applyFrame({ type: DocumentFrame.INSERT_BLOCK, id: 'i1', kind: 'code', attrs: {}, index: -1 })
    model.applyFrame({ type: DocumentFrame.INSERT_BLOCK, id: 'i2', kind: 'code', attrs: {}, index: 99 })
    expect(model.getOrder()).toEqual(['p1', 'c1', 'a1', 'i1', 'i2'])
  })

  it('defaults an unnamed kind to code (the WYSIWYG surface default)', () => {
    const model = new ContainerModel('doc-1')
    model.applyFrame({ type: DocumentFrame.INSERT_BLOCK, id: 'i1', attrs: {}, index: 0 })
    expect(model.getBlock('i1').kind).toBe('code')
  })

  it('re-inserting a known id refreshes the node without moving it', () => {
    const model = seeded()
    model.applyFrame({ type: DocumentFrame.INSERT_BLOCK, id: 'c1', kind: 'code', attrs: { source: 'x=2' }, index: 0 })
    expect(model.getOrder()).toEqual(['p1', 'c1', 'a1'])
    expect(model.getBlock('c1').attrs.source).toBe('x=2')
  })

  it('ignores an id-less insert', () => {
    const model = seeded()
    const rec = recorder()
    model.subscribe(rec)
    model.applyFrame({ type: DocumentFrame.INSERT_BLOCK, kind: 'code', attrs: {}, index: 0 })
    expect(model.getOrder()).toEqual(['p1', 'c1', 'a1'])
    expect(rec.seen).toHaveLength(1) // the bootstrap cue only
  })
})

describe('ContainerModel fold — replace-block', () => {
  it('takes the old block\'s slot with the new identity and drops the old node', () => {
    const model = seeded()
    model.applyFrame({ type: DocumentFrame.REPLACE_BLOCK, oldId: 'c1', newId: 'd1', newKind: 'diagram', attrs: { source: 'graph' } })
    expect(model.getOrder()).toEqual(['p1', 'd1', 'a1'])
    expect(model.getBlock('c1')).toBeNull()
    expect(model.getBlock('d1')).toEqual({ id: 'd1', kind: 'diagram', attrs: { source: 'graph', id: 'd1' } })
  })

  it('appends when the old id is not held', () => {
    const model = seeded()
    model.applyFrame({ type: DocumentFrame.REPLACE_BLOCK, oldId: 'ghost', newId: 'd1', newKind: 'diagram', attrs: {} })
    expect(model.getOrder()).toEqual(['p1', 'c1', 'a1', 'd1'])
  })

  it('reports both ids as changed', () => {
    const model = seeded()
    const rec = recorder()
    model.subscribe(rec)
    model.applyFrame({ type: DocumentFrame.REPLACE_BLOCK, oldId: 'c1', newId: 'd1', newKind: 'diagram', attrs: {} })
    expect(rec.seen[1].blockIds).toEqual(['c1', 'd1'])
    expect(rec.seen[1].orderChanged).toBe(true)
  })

  it('ignores a replace that names no new id', () => {
    const model = seeded()
    model.applyFrame({ type: DocumentFrame.REPLACE_BLOCK, oldId: 'c1', newKind: 'diagram', attrs: {} })
    expect(model.getOrder()).toEqual(['p1', 'c1', 'a1'])
  })
})

describe('ContainerModel fold — block-attrs-updated', () => {
  it('merges onto the prior attrs, keeping the kind', () => {
    const model = seeded()
    model.applyFrame({ type: DocumentFrame.BLOCK_ATTRS_UPDATED, id: 'a1', attrs: { status: 'COMPLETE', answer: 'A.' } })
    expect(model.getBlock('a1')).toEqual({
      id: 'a1', kind: 'ai-block', attrs: { question: 'Q?', status: 'COMPLETE', answer: 'A.', id: 'a1' },
    })
  })

  it('leaves order alone', () => {
    const model = seeded()
    const rec = recorder()
    model.subscribe(rec)
    model.applyFrame({ type: DocumentFrame.BLOCK_ATTRS_UPDATED, id: 'a1', attrs: { status: 'COMPLETE' } })
    expect(model.getOrder()).toEqual(['p1', 'c1', 'a1'])
    expect(rec.seen[1]).toEqual({ blockIds: ['a1'], orderChanged: false })
  })

  it('is a no-op for an id the container never held', () => {
    const model = seeded()
    const rec = recorder()
    model.subscribe(rec)
    model.applyFrame({ type: DocumentFrame.BLOCK_ATTRS_UPDATED, id: 'ghost', attrs: { status: 'COMPLETE' } })
    expect(model.getBlock('ghost')).toBeNull()
    expect(rec.seen).toHaveLength(1)
  })
})

describe('ContainerModel fold — remove-block', () => {
  it('drops the id from the order and the nodes', () => {
    const model = seeded()
    model.applyFrame({ type: DocumentFrame.REMOVE_BLOCK, id: 'c1' })
    expect(model.getOrder()).toEqual(['p1', 'a1'])
    expect(model.getBlock('c1')).toBeNull()
  })

  it('reports the removed id, with the order changed', () => {
    const model = seeded()
    const rec = recorder()
    model.subscribe(rec)
    model.applyFrame({ type: DocumentFrame.REMOVE_BLOCK, id: 'c1' })
    expect(rec.seen[1]).toEqual({ blockIds: ['c1'], orderChanged: true })
  })

  it('is a no-op for an id the container never held, and for an id-less frame', () => {
    const model = seeded()
    const rec = recorder()
    model.subscribe(rec)
    model.applyFrame({ type: DocumentFrame.REMOVE_BLOCK, id: 'ghost' })
    model.applyFrame({ type: DocumentFrame.REMOVE_BLOCK })
    expect(model.getOrder()).toEqual(['p1', 'c1', 'a1'])
    expect(rec.seen).toHaveLength(1)
  })

  it('retires the id for good — a later attrs update has nothing to merge onto', () => {
    const model = seeded()
    model.applyFrame({ type: DocumentFrame.REMOVE_BLOCK, id: 'c1' })
    model.applyFrame({ type: DocumentFrame.BLOCK_ATTRS_UPDATED, id: 'c1', attrs: { source: 'x=2' } })
    expect(model.getBlock('c1')).toBeNull()
  })
})

describe('ContainerModel fold — order-changed', () => {
  it('installs the whole new order without touching the nodes', () => {
    const model = seeded()
    model.applyFrame({ type: DocumentFrame.ORDER_CHANGED, order: ['a1', 'p1', 'c1'] })
    expect(model.getOrder()).toEqual(['a1', 'p1', 'c1'])
    expect(model.getBlock('c1')).toEqual({ id: 'c1', kind: 'code', attrs: { source: 'x=1', id: 'c1' } })
  })

  it('reports an order change naming no block — nothing arrived or left', () => {
    const model = seeded()
    const rec = recorder()
    model.subscribe(rec)
    model.applyFrame({ type: DocumentFrame.ORDER_CHANGED, order: ['a1', 'p1', 'c1'] })
    expect(rec.seen[1]).toEqual({ blockIds: [], orderChanged: true })
  })

  it('drops a name it has no node for', () => {
    const model = seeded()
    model.applyFrame({ type: DocumentFrame.ORDER_CHANGED, order: ['a1', 'ghost', 'p1', 'c1'] })
    expect(model.getOrder()).toEqual(['a1', 'p1', 'c1'])
    expect(model.getBlock('ghost')).toBeNull()
  })

  it('installs an empty order, and ignores a frame carrying no order at all', () => {
    const model = seeded()
    model.applyFrame({ type: DocumentFrame.ORDER_CHANGED, order: [] })
    expect(model.getOrder()).toEqual([])
    model.applyFrame({ type: DocumentFrame.ORDER_CHANGED })
    expect(model.getOrder()).toEqual([])
  })

  it('takes the order from the frame, not from a copy the caller keeps mutating', () => {
    const model = seeded()
    const frame = { type: DocumentFrame.ORDER_CHANGED, order: ['a1', 'p1', 'c1'] }
    model.applyFrame(frame)
    frame.order.push('p1')
    expect(model.getOrder()).toEqual(['a1', 'p1', 'c1'])
  })
})

describe('ContainerModel fold — unclaimed frames', () => {
  it('drops frames that are not container truth, without a cue', () => {
    const model = seeded()
    const rec = recorder()
    model.subscribe(rec)
    model.applyFrame({ type: DocumentFrame.PONG })
    model.applyFrame({ type: DocumentFrame.BLOCK_OP_ACK, opId: 'op-1', ok: true })
    model.applyFrame({ type: 'invented-frame', id: 'c1' })
    model.applyFrame(/** @type {any} */ (undefined))
    expect(rec.seen).toHaveLength(1)
    expect(model.getOrder()).toEqual(['p1', 'c1', 'a1'])
  })
})

describe('ContainerModel reads are frozen copies', () => {
  it('getBlock returns a new object each call, equal but never the same', () => {
    const model = seeded()
    const a = model.getBlock('c1')
    const b = model.getBlock('c1')
    expect(a).toEqual(b)
    expect(a).not.toBe(b)
    expect(a.attrs).not.toBe(b.attrs)
  })

  it('a returned block is deeply frozen and mutating it cannot reach the model', () => {
    const model = seeded()
    const block = model.getBlock('c1')
    expect(Object.isFrozen(block)).toBe(true)
    expect(Object.isFrozen(block.attrs)).toBe(true)
    expect(() => { /** @type {any} */ (block).kind = 'diagram' }).toThrow(TypeError)
    expect(() => { /** @type {any} */ (block).attrs.source = 'mutated' }).toThrow(TypeError)
    expect(model.getBlock('c1').kind).toBe('code')
    expect(model.getBlock('c1').attrs.source).toBe('x=1')
  })

  it('getOrder returns a frozen copy that cannot be spliced into the model', () => {
    const model = seeded()
    const order = model.getOrder()
    expect(Object.isFrozen(order)).toBe(true)
    expect(() => /** @type {any} */ (order).push('nope')).toThrow(TypeError)
    expect(model.getOrder()).toEqual(['p1', 'c1', 'a1'])
  })

  it('the change cue is frozen too', () => {
    const model = seeded()
    const rec = recorder()
    model.subscribe(rec)
    expect(Object.isFrozen(rec.seen[0])).toBe(true)
    expect(Object.isFrozen(rec.seen[0].blockIds)).toBe(true)
  })
})

describe('ContainerModel owns its state', () => {
  it('copies out of the frame: mutating the frame afterwards never reaches the model', () => {
    const model = new ContainerModel('doc-1')
    const frame = { type: DocumentFrame.INSERT_BLOCK, id: 'i1', kind: 'code', attrs: { meta: { lang: 'go' } }, index: 0 }
    model.applyFrame(frame)
    frame.attrs.meta.lang = 'rust'
    expect(model.getBlock('i1').attrs.meta.lang).toBe('go')
  })

  it('leaves the caller\'s frame unfrozen — freezing an argument is not this class\'s business', () => {
    const model = new ContainerModel('doc-1')
    const content = { uuid: 'doc-1', blocks: [{ id: 'p1', kind: 'prose', attrs: { meta: { tone: 'dry' } } }] }
    model.applyLoad(content)
    expect(Object.isFrozen(content.blocks[0].attrs.meta)).toBe(false)
  })

  it('refuses an attr that could not cross a process boundary', () => {
    const model = new ContainerModel('doc-1')
    expect(() => model.applyFrame({
      type: DocumentFrame.INSERT_BLOCK, id: 'i1', kind: 'code', attrs: { render: () => 'nope' }, index: 0,
    })).toThrow()
    expect(model.getBlock('i1')).toBeNull()
  })
})

describe('ContainerModel subscription', () => {
  it('cues a new listener with the whole container — bootstrap is the first onChanged', () => {
    const model = seeded()
    const rec = recorder()
    model.subscribe(rec)
    expect(rec.seen).toEqual([{ blockIds: ['p1', 'c1', 'a1'], orderChanged: true }])
  })

  it('cues an empty container too, so a lens has one paint path', () => {
    const rec = recorder()
    new ContainerModel('doc-1').subscribe(rec)
    expect(rec.seen).toEqual([{ blockIds: [], orderChanged: true }])
  })

  it('refuses a listener that does not implement onChanged', () => {
    const model = seeded()
    expect(() => model.subscribe(/** @type {any} */ ({}))).toThrow(ContractViolation)
    expect(() => model.subscribe(/** @type {any} */ (null))).toThrow(ContractViolation)
  })

  it('emits POST-FOLD: the handler already reads the new state', () => {
    const model = seeded()
    /** @type {any[]} */
    const readDuring = []
    const rec = recorder(() => {
      readDuring.push({ order: model.getOrder(), block: model.getBlock('i1') })
    })
    model.subscribe(rec)
    model.applyFrame({ type: DocumentFrame.INSERT_BLOCK, id: 'i1', kind: 'code', attrs: { source: 'new' }, index: 0 })
    expect(readDuring[1].order).toEqual(['i1', 'p1', 'c1', 'a1'])
    expect(readDuring[1].block.attrs.source).toBe('new')
  })

  it('fans one cue out to every listener', () => {
    const model = seeded()
    const a = recorder()
    const b = recorder()
    model.subscribe(a)
    model.subscribe(b)
    model.applyFrame({ type: DocumentFrame.BLOCK_ATTRS_UPDATED, id: 'a1', attrs: { status: 'COMPLETE' } })
    expect(a.seen).toHaveLength(2)
    expect(b.seen).toHaveLength(2)
  })

  it('unsubscribe stops the cues; unsubscribing an unknown listener is inert', () => {
    const model = seeded()
    const rec = recorder()
    model.subscribe(rec)
    model.unsubscribe(rec)
    model.unsubscribe(recorder())
    model.applyFrame({ type: DocumentFrame.BLOCK_ATTRS_UPDATED, id: 'a1', attrs: { status: 'COMPLETE' } })
    expect(rec.seen).toHaveLength(1)
  })

  it('isolates a throwing listener from its siblings and from the fold', () => {
    const model = seeded()
    const bad = { onChanged: () => { throw new Error('boom') } }
    const good = recorder()
    model.subscribe(bad)
    model.subscribe(good)
    expect(() => model.applyFrame({ type: DocumentFrame.BLOCK_ATTRS_UPDATED, id: 'a1', attrs: { status: 'COMPLETE' } })).not.toThrow()
    expect(good.seen).toHaveLength(2)
    expect(model.getBlock('a1').attrs.status).toBe('COMPLETE')
  })
})

describe('ContainerModel cue shape — origin-blind', () => {
  // The cue says WHAT changed. It never says who asked, and a stray correlation
  // reappearing on it is the whole regression this pins: a lens that could read
  // one would start treating its own effects differently from everyone else's.
  // The first frame carries a correlation field to prove the fold copies nothing
  // off a frame but ids and order.
  it('emits exactly blockIds and orderChanged, whatever the frame carried', () => {
    const model = seeded()
    const rec = recorder()
    model.subscribe(rec)
    model.applyFrame({ type: DocumentFrame.INSERT_BLOCK, id: 'i1', kind: 'code', attrs: {}, index: 0, opId: 'op-7' })
    model.applyFrame({ type: DocumentFrame.BLOCK_ATTRS_UPDATED, id: 'i1', attrs: { status: 'COMPLETE' } })
    model.applyFrame({ type: DocumentFrame.REPLACE_BLOCK, oldId: 'i1', newId: 'd1', newKind: 'diagram', attrs: {} })
    model.applyFrame({ type: DocumentFrame.ORDER_CHANGED, order: ['d1', 'p1', 'c1', 'a1'] })
    model.applyFrame({ type: DocumentFrame.REMOVE_BLOCK, id: 'd1' })
    model.applyLoad({ uuid: 'doc-1', blocks: [{ id: 'p1', kind: 'prose', attrs: {} }] })

    expect(rec.seen).toHaveLength(7) // the subscribe cue, then one per fold
    for (const change of rec.seen) {
      expect(Object.keys(change).sort()).toEqual(['blockIds', 'orderChanged'])
    }
  })
})
