// @ts-check
// container-model-feed.test.js — the model feed, driven by the REAL wire (issue
// #96 P4a).
//
// The point of these tests is that nothing here is a fake fold: a real
// ContainerTransport and DocumentService sit over a FakeSocket, frames arrive the way
// Go sends them, and the model is whatever the transport actually delivered. The
// two frames the editor path deliberately never sees — remove-block and
// order-changed — are the reason the feed exists, so they are the reason the rig
// is real rather than a hand-fed applyFrame loop.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { serviceRig, FakeSocket } from './helpers/service-rig.js'
import { ContainerModelFeed } from '../src/static/container/container-model-feed.js'
import { DocumentFrame } from '../src/static/generated/protocol.js'
import { ContractViolation } from '../src/static/contract/sieve-block.js'

/** The opId the rig's last request of this type left with.
 *  @param {any} sock @param {string} reqType @returns {string} */
function lastOpId(sock, reqType) {
  const sent = sock.sentOfType(reqType)
  return sent[sent.length - 1].opId
}

/** A rig with a feed already following the open document. */
function feedRig(uuid = 'doc-1') {
  const rig = serviceRig({ uuid: uuid })
  const feed = new ContainerModelFeed(rig.documentService)
  const model = feed.open(uuid)
  return Object.assign({ feed, model }, rig)
}

/** Drives a load round trip with the given raw wire blocks.
 *  @param {any} rig @param {object[]} blocks */
async function driveLoad(rig, blocks) {
  const pending = rig.documentService.load(rig.uuid)
  rig.sock.driveMessage({
    type: DocumentFrame.LOAD_CONTENT,
    opId: lastOpId(rig.sock, DocumentFrame.LOAD),
    uuid: rig.uuid,
    body: '',
    mode: 'wysiwyg',
    blocks: blocks,
  })
  await pending
}

describe('ContainerModelFeed', () => {
  beforeEach(() => FakeSocket.reset())

  it('demands a DocumentService', () => {
    expect(() => new ContainerModelFeed(/** @type {any} */ (null))).toThrow(ContractViolation)
    expect(() => new ContainerModelFeed(/** @type {any} */ ({}))).toThrow(ContractViolation)
  })

  it('answers one model per container, and the same one twice', () => {
    const rig = feedRig()
    expect(rig.feed.open('doc-1')).toBe(rig.model)
    expect(rig.feed.get('doc-1')).toBe(rig.model)
    expect(rig.feed.get('other')).toBeNull()
  })

  it('seeds from the load ANSWER, which never reaches a frame observer', async () => {
    const rig = feedRig()
    await driveLoad(rig, [
      { id: 'p1', kind: 'prose', attrs: { content: 'one' } },
      { id: 'c1', kind: 'code', attrs: { source: 'x=1' } },
    ])
    expect(rig.model.getOrder()).toEqual(['p1', 'c1'])
    expect(rig.model.getBlock('c1')).toEqual({ id: 'c1', kind: 'code', attrs: { source: 'x=1', id: 'c1' } })
  })

  it('re-seeds from the enter-wysiwyg reparse, which is a whole-container answer too', async () => {
    const rig = feedRig()
    await driveLoad(rig, [{ id: 'p1', kind: 'prose', attrs: { content: 'one' } }])

    const pending = rig.documentService.save(rig.uuid, '# reparsed')
    rig.sock.driveMessage({
      type: DocumentFrame.WYSIWYG_CONTENT,
      opId: lastOpId(rig.sock, DocumentFrame.ENTER_WYSIWYG),
      uuid: rig.uuid,
      blocks: [{ id: 'p9', kind: 'prose', attrs: { content: 'reparsed' } }],
    })
    await pending

    // A whole-container answer is a RESET: p1 is not in it, so it is gone.
    expect(rig.model.getOrder()).toEqual(['p9'])
    expect(rig.model.getBlock('p1')).toBeNull()
  })

  it('folds every mutation echo the wire delivers — including the two the old editor path dropped', async () => {
    const rig = feedRig()
    await driveLoad(rig, [
      { id: 'p1', kind: 'prose', attrs: { content: 'one' } },
      { id: 'p2', kind: 'prose', attrs: { content: 'two' } },
    ])

    rig.sock.driveMessage({ type: DocumentFrame.INSERT_BLOCK, id: 'c1', kind: 'code', attrs: { source: 'x=1' }, index: 1 })
    expect(rig.model.getOrder()).toEqual(['p1', 'c1', 'p2'])

    rig.sock.driveMessage({ type: DocumentFrame.BLOCK_ATTRS_UPDATED, id: 'c1', attrs: { status: 'COMPLETE' } })
    expect(rig.model.getBlock('c1').attrs.status).toBe('COMPLETE')

    rig.sock.driveMessage({ type: DocumentFrame.REPLACE_BLOCK, oldId: 'c1', newId: 'd1', newKind: 'diagram', attrs: { source: 'A->B' } })
    expect(rig.model.getOrder()).toEqual(['p1', 'd1', 'p2'])

    rig.sock.driveMessage({ type: DocumentFrame.ORDER_CHANGED, order: ['p2', 'd1', 'p1'] })
    expect(rig.model.getOrder()).toEqual(['p2', 'd1', 'p1'])

    rig.sock.driveMessage({ type: DocumentFrame.REMOVE_BLOCK, id: 'd1' })
    expect(rig.model.getOrder()).toEqual(['p2', 'p1'])
    expect(rig.model.getBlock('d1')).toBeNull()

    // The model is the ONLY account of the container. The channel delegate has no
    // apply path at all any more — it hears what the transport does not settle and
    // the model does not claim, and that is the whole of its job.
    expect(rig.delegate.applyServerOp).toBeUndefined()
  })

  it('cues every echo the same way — an edit the host asked for is shaped like an ambient one', async () => {
    const rig = feedRig()
    await driveLoad(rig, [{ id: 'p1', kind: 'prose', attrs: { content: 'one' } }])

    /** @type {any[]} */
    const seen = []
    rig.model.subscribe({ onChanged: (change) => seen.push(change) })
    seen.length = 0 // drop the subscribe cue; what follows is the wire

    // The first echo answers a set-order this host sent; the second is a job
    // finishing on its own. The feed passes both through untranslated, and the
    // cues are indistinguishable — which is the design, not a lost signal.
    const pending = rig.documentService.setBlockOrder(rig.uuid, ['p1'])
    rig.sock.driveMessage({ type: DocumentFrame.ORDER_CHANGED, order: ['p1'] })
    rig.sock.driveMessage({ type: DocumentFrame.BLOCK_ATTRS_UPDATED, id: 'p1', attrs: { status: 'COMPLETE' } })
    rig.sock.driveMessage({ type: DocumentFrame.BLOCK_OP_ACK, opId: lastOpId(rig.sock, DocumentFrame.BLOCK_OP), ok: true })
    await pending

    expect(seen.map((c) => Object.keys(c).sort())).toEqual([
      ['blockIds', 'orderChanged'],
      ['blockIds', 'orderChanged'],
    ])
  })

  it('never mistakes a correlated REPLY for container truth', async () => {
    const rig = feedRig()
    await driveLoad(rig, [{ id: 'p1', kind: 'prose', attrs: { content: 'one' } }])
    const before = rig.model.getOrder()

    // An ack rides the same socket and carries `opId`. The transport settles it on
    // its awaiter and returns, so it never reaches the fold at all — correlation
    // begins and ends below this seam.
    rig.sock.driveMessage({ type: DocumentFrame.BLOCK_OP_ACK, opId: 'op-1', ok: true })
    rig.sock.driveMessage({ type: DocumentFrame.PONG })
    rig.sock.driveMessage({ type: DocumentFrame.ERROR, message: 'something went wrong' })

    expect(rig.model.getOrder()).toEqual(before)
  })

  it('routes per container: one document\'s echo never reaches another\'s model', async () => {
    const rig = feedRig('doc-1')
    const otherDelegate = { onMessage: vi.fn() }
    rig.service.openChannel('doc-2', /** @type {any} */ (otherDelegate))
    const otherSock = FakeSocket.instances[FakeSocket.instances.length - 1]
    otherSock.driveOpen()
    const otherModel = rig.feed.open('doc-2')

    otherSock.driveMessage({ type: DocumentFrame.INSERT_BLOCK, id: 'z1', kind: 'prose', attrs: {}, index: -1 })

    expect(otherModel.getOrder()).toEqual(['z1'])
    expect(rig.model.getOrder()).toEqual([])
  })

  it('stops following on close, and answers nothing for a container it dropped', async () => {
    const rig = feedRig()
    await driveLoad(rig, [{ id: 'p1', kind: 'prose', attrs: { content: 'one' } }])
    const model = rig.model

    rig.feed.close('doc-1')
    expect(rig.feed.get('doc-1')).toBeNull()

    rig.sock.driveMessage({ type: DocumentFrame.INSERT_BLOCK, id: 'c1', kind: 'code', attrs: {}, index: -1 })
    expect(model.getOrder()).toEqual(['p1'])

    // A second close is a no-op, and closeAll sweeps whatever is left.
    expect(() => rig.feed.close('doc-1')).not.toThrow()
    rig.feed.open('doc-1')
    rig.feed.closeAll()
    expect(rig.feed.get('doc-1')).toBeNull()
  })

  it('isolates a throwing observer from the transport', async () => {
    const rig = feedRig()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    rig.service.observeFrames('doc-1', () => { throw new Error('observer exploded') })

    expect(() => rig.sock.driveMessage({
      type: DocumentFrame.INSERT_BLOCK, id: 'c1', kind: 'code', attrs: {}, index: -1,
    })).not.toThrow()
    expect(rig.model.getOrder()).toEqual(['c1'])
    err.mockRestore()
  })
})
