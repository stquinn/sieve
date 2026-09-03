// @ts-check
// container-model.test.js — the fold, the copies and the cue (issue #96 P1).
// ContainerModel is driven by DATA only: no socket, no service, no DOM.

import { describe, it, expect } from 'vitest'
import { ContainerModel } from '../src/static/container/container-model.js'
import { ContractViolation } from '../src/static/contract/sieve-block.js'
import { DocumentFrame, Feature } from '../src/static/generated/protocol.js'

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
    expect(rec.seen[1].replaced).toEqual(['d1'])
  })

  // The same id on both sides is a block Go REWROTE in place — a transform, or a
  // text edit it executed on the client's behalf. It keeps its slot, and the cue
  // NAMES it replaced: the node that arrived is the whole truth for that block,
  // not a patch onto what the reader holds.
  it('keeps the slot when the id is unchanged, and still names the block replaced', () => {
    const model = seeded()
    const rec = recorder()
    model.subscribe(rec)
    model.applyFrame({
      type: DocumentFrame.REPLACE_BLOCK, oldId: 'p1', newId: 'p1', newKind: 'prose', attrs: { content: 'the cat' },
    })
    expect(model.getOrder()).toEqual(['p1', 'c1', 'a1'])
    expect(model.getBlock('p1')).toEqual({ id: 'p1', kind: 'prose', attrs: { content: 'the cat', id: 'p1' } })
    expect(rec.seen[1]).toEqual({ blockIds: ['p1'], orderChanged: false, replaced: ['p1'] })
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
    expect(rec.seen[1]).toEqual({ blockIds: ['a1'], orderChanged: false, replaced: [] })
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
    expect(rec.seen[1]).toEqual({ blockIds: ['c1'], orderChanged: true, replaced: [] })
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
    expect(rec.seen[1]).toEqual({ blockIds: [], orderChanged: true, replaced: [] })
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

describe('ContainerModel fold — text-marks', () => {
  /** @param {string} quote @param {number} [occurrence] */
  const mark = (quote, occurrence) => ({
    locator: 'content', quote: quote, occurrence: occurrence || 0,
    start: 0, end: quote.length, class: 'prose', suggestions: [],
  })

  const SPELL = Feature.SPELL_CHECK
  const OTHER = 'find'

  /** One feature's push for one block. @param {string} feature @param {string} blockId @param {any[]} marks */
  const push = (feature, blockId, marks) =>
    ({ type: DocumentFrame.TEXT_MARKS, feature: feature, blockId: blockId, marks: marks })

  /** A recorder that also hears the optional marks cue. Each cue is recorded as
   *  the triple it arrives as, so a test can assert WHOSE marks landed where.
   *  @returns {{onChanged: (c: any) => void, onMarksChanged: (f: string, id: string, m: any) => void, seen: any[], marks: any[]}} */
  const marksRecorder = () => {
    /** @type {any[]} */ const seen = []
    /** @type {any[]} */ const marks = []
    return {
      seen,
      marks,
      onChanged: (change) => { seen.push(change) },
      onMarksChanged: (feature, blockId, pushed) => { marks.push([feature, blockId, pushed]) },
    }
  }

  it('hands a block\'s mark set to the listener, and cues no container change', () => {
    const model = seeded()
    const rec = marksRecorder()
    model.subscribe(rec)
    model.applyFrame(push(SPELL, 'p1', [mark('teh')]))
    expect(rec.marks).toEqual([[SPELL, 'p1', [mark('teh')]]])
    // Marks are a reading OF the container, not a change TO it.
    expect(rec.seen).toHaveLength(1)
    expect(model.getBlock('p1')).toEqual({ id: 'p1', kind: 'prose', attrs: { content: 'hello', id: 'p1' } })
  })

  it('REPLACES the block\'s previous set rather than adding to it', () => {
    const model = seeded()
    const rec = marksRecorder()
    model.subscribe(rec)
    model.applyFrame(push(SPELL, 'p1', [mark('teh'), mark('adn')]))
    model.applyFrame(push(SPELL, 'p1', [mark('adn')]))
    expect(rec.marks[1]).toEqual([SPELL, 'p1', [mark('adn')]])
  })

  it('an empty array is the CLEAR — a corrected block loses its marks', () => {
    const model = seeded()
    const rec = marksRecorder()
    model.subscribe(rec)
    model.applyFrame(push(SPELL, 'p1', [mark('teh')]))
    model.applyFrame(push(SPELL, 'p1', []))
    expect(rec.marks[1]).toEqual([SPELL, 'p1', []])

    // …and the cleared set is not replayed to whoever subscribes next.
    const later = marksRecorder()
    model.subscribe(later)
    expect(later.marks).toEqual([])
  })

  // TWO PRODUCERS, ONE BLOCK. Each set is keyed by the feature that found it, so
  // a second producer's push neither overwrites the first's nor is cleared by it.
  it('keeps each feature\'s marks on the same block apart, clear included', () => {
    const model = seeded()
    const rec = marksRecorder()
    model.subscribe(rec)
    model.applyFrame(push(SPELL, 'p1', [mark('teh')]))
    model.applyFrame(push(OTHER, 'p1', [mark('cat')]))
    model.applyFrame(push(SPELL, 'p1', []))
    expect(rec.marks).toEqual([
      [SPELL, 'p1', [mark('teh')]],
      [OTHER, 'p1', [mark('cat')]],
      [SPELL, 'p1', []],
    ])

    // What survives is exactly the feature that was never cleared.
    const later = marksRecorder()
    model.subscribe(later)
    expect(later.marks).toEqual([[OTHER, 'p1', [mark('cat')]]])
  })

  it('replays every held set at subscribe — bootstrap, the way onChanged is', () => {
    const model = seeded()
    model.applyFrame(push(SPELL, 'p1', [mark('teh')]))
    model.applyFrame(push(OTHER, 'c1', [mark('adn')]))
    const rec = marksRecorder()
    model.subscribe(rec)
    expect(rec.marks).toEqual([[SPELL, 'p1', [mark('teh')]], [OTHER, 'c1', [mark('adn')]]])
  })

  it('keeps marks for a block the container does not hold yet — a push can outrun the load', () => {
    const model = new ContainerModel('doc-1')
    model.applyFrame(push(SPELL, 'p1', [mark('teh')]))
    model.applyLoad({ uuid: 'doc-1', blocks: [{ id: 'p1', kind: 'prose', attrs: { content: 'teh' } }] })
    const rec = marksRecorder()
    model.subscribe(rec)
    expect(rec.marks).toEqual([[SPELL, 'p1', [mark('teh')]]])
  })

  it('retires a block\'s marks with the block, on remove and on a transform\'s new identity', () => {
    const model = seeded()
    model.applyFrame(push(SPELL, 'p1', [mark('teh')]))
    model.applyFrame(push(OTHER, 'p1', [mark('cat')]))
    model.applyFrame(push(SPELL, 'c1', [mark('adn')]))
    model.applyFrame({ type: DocumentFrame.REMOVE_BLOCK, id: 'p1' })
    model.applyFrame({ type: DocumentFrame.REPLACE_BLOCK, oldId: 'c1', newId: 'c2', newKind: 'diagram', attrs: {} })
    const rec = marksRecorder()
    model.subscribe(rec)
    expect(rec.marks).toEqual([])
  })

  it('drops a blockId-less frame, and a listener that cannot draw marks is not asked to', () => {
    const model = seeded()
    const plain = recorder()
    model.subscribe(plain)
    expect(() => model.applyFrame(push(SPELL, '', [mark('teh')]))).not.toThrow()
    expect(() => model.applyFrame(push('', 'p1', [mark('teh')]))).not.toThrow()
    expect(() => model.applyFrame(push(SPELL, 'p1', [mark('teh')]))).not.toThrow()
    expect(plain.seen).toHaveLength(1)
  })

  it('isolates a listener that throws on the marks cue', () => {
    const model = seeded()
    const bad = { onChanged: () => {}, onMarksChanged: () => { throw new Error('boom') } }
    const good = marksRecorder()
    model.subscribe(bad)
    model.subscribe(good)
    expect(() => model.applyFrame(push(SPELL, 'p1', [mark('teh')]))).not.toThrow()
    expect(good.marks).toHaveLength(1)
  })

  it('hands out frozen marks it owns every byte of', () => {
    const model = seeded()
    const rec = marksRecorder()
    model.subscribe(rec)
    const sent = [mark('teh')]
    model.applyFrame(push(SPELL, 'p1', sent))
    const [, , held] = rec.marks[0]
    expect(Object.isFrozen(held)).toBe(true)
    expect(Object.isFrozen(held[0])).toBe(true)
    sent[0].quote = 'mutated'
    expect(held[0].quote).toBe('teh')
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
    expect(rec.seen).toEqual([{ blockIds: ['p1', 'c1', 'a1'], orderChanged: true, replaced: [] }])
  })

  it('cues an empty container too, so a lens has one paint path', () => {
    const rec = recorder()
    new ContainerModel('doc-1').subscribe(rec)
    expect(rec.seen).toEqual([{ blockIds: [], orderChanged: true, replaced: [] }])
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
  it('emits exactly blockIds, orderChanged and replaced, whatever the frame carried', () => {
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
      expect(Object.keys(change).sort()).toEqual(['blockIds', 'orderChanged', 'replaced'])
    }
  })
})
