// @ts-check
// mount-binding.test.js — the host's half of one mount (issue #96 P4a).
//
// Two things are under test. The assembly: a binding hands out a provider whose
// verbs reach the real wire as the frames Go already accepts, so the P4b cutover
// is a re-point and not a protocol change. And the presence seam: adverts flow
// host-ward and land where the shell's existing selection plumbing can read them
// with the signature it already uses.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { serviceRig, FakeSocket, fakeDelegate } from './helpers/service-rig.js'
import { ContainerModelFeed } from '../src/static/container/container-model-feed.js'
import { MountBinding } from '../src/static/shell/mount-binding.js'
import { BlockProviderAdapter } from '../src/static/container/block-provider-adapter.js'
import { DocumentFrame } from '../src/static/generated/protocol.js'
import { ContractViolation } from '../src/static/contract/sieve-block.js'

const UUID = 'doc-1'

/** A rig whose channel this binding opened, seeded with two prose blocks. */
function mounted() {
  const rig = serviceRig({ uuid: null })
  const feed = new ContainerModelFeed(rig.documentService)
  const binding = new MountBinding(UUID, rig.documentService, feed)
  const delegate = fakeDelegate()
  binding.openChannel(/** @type {any} */ (delegate))
  const sock = FakeSocket.instances[FakeSocket.instances.length - 1]
  sock.driveOpen()
  sock.driveMessage({ type: DocumentFrame.INSERT_BLOCK, id: 'p1', kind: 'prose', attrs: { content: 'one' }, index: -1 })
  sock.driveMessage({ type: DocumentFrame.INSERT_BLOCK, id: 'p2', kind: 'prose', attrs: { content: 'two' }, index: -1 })
  sock.sent.length = 0
  return { rig, feed, binding, delegate, sock }
}

/** The last frame of a type that left the socket. @param {any} sock @param {string} type */
function lastSent(sock, type) {
  const frames = sock.sentOfType(type)
  return frames[frames.length - 1]
}

describe('MountBinding', () => {
  beforeEach(() => FakeSocket.reset())

  it('demands a uuid, a DocumentService and a real feed', () => {
    const rig = serviceRig({ uuid: null })
    const feed = new ContainerModelFeed(rig.documentService)
    expect(() => new MountBinding('', rig.documentService, feed)).toThrow(ContractViolation)
    expect(() => new MountBinding(UUID, /** @type {any} */ (null), feed)).toThrow(ContractViolation)
    expect(() => new MountBinding(UUID, rig.documentService, /** @type {any} */ ({}))).toThrow(ContractViolation)
  })

  it('hands out a provider bound to this container and nothing else', () => {
    const { binding } = mounted()
    expect(binding.getUuid()).toBe(UUID)
    expect(binding.provider).toBeInstanceOf(BlockProviderAdapter)
    expect(binding.provider.getUuid()).toBe(UUID)
    expect(binding.provider.getOrder()).toEqual(['p1', 'p2'])
  })

  it('opens the channel and the model together, so neither outlives the other', async () => {
    const { rig, feed, binding, sock } = mounted()
    expect(feed.get(UUID)).not.toBeNull()

    binding.close()
    expect(feed.get(UUID)).toBeNull()
    expect(sock.closed).toBe(true)
    expect(rig.service._hasChannel(UUID)).toBe(false)
  })

  // ── The verbs, as they actually leave ──────────────────────────────────────

  // TWO DOORS, ONE FRAME: the shell's answering `replaceText` and the lens's void
  // `requestReplaceText` reach the same mapping, which lives in DocumentService and
  // is pinned there (document-wire.test.js). What is under test here is that both
  // doors arrive at it, and the membership guard this end adds.
  describe('replaceText — both doors, one frame', () => {
    const mark = { blockId: 'p1', locator: 'content', quote: 'teh', occurrence: 1, grain: 'word', start: 12, end: 15 }

    it('sends the anchor as the mark carried it, with what belongs in its place', () => {
      const { binding, sock } = mounted()
      binding.replaceText(mark, 'the')
      expect(lastSent(sock, DocumentFrame.TEXT_REPLACE)).toMatchObject({
        blockId: 'p1', locator: 'content', quote: 'teh', occurrence: 1, grain: 'word', start: 12, end: 15, replacement: 'the',
      })
    })

    it('the LENS door produces the identical frame', () => {
      const { binding, sock } = mounted()
      binding.provider.requestReplaceText('p1', mark, 'the')
      expect(lastSent(sock, DocumentFrame.TEXT_REPLACE)).toMatchObject({
        blockId: 'p1', locator: 'content', quote: 'teh', occurrence: 1, grain: 'word', replacement: 'the',
      })
    })

    // Naming a block the container does not hold is the ordinary race, not a
    // breach: it answers so a caller gating on the answer is released.
    /** @type {Array<[string, Record<string, any>]>} */
    const unheld = [
      ['a block that has gone', { blockId: 'ghost' }],
      ['no block named at all', { blockId: '' }],
    ]

    for (const [name, absent] of unheld) {
      it('answers ' + name + ' without sending anything', async () => {
        const { binding, sock } = mounted()
        const outcome = await binding.replaceText(/** @type {any} */ (Object.assign({}, mark, absent)), 'the')
        expect(outcome).toBe('error')
        expect(sock.sentOfType(DocumentFrame.TEXT_REPLACE)).toEqual([])
      })
    }
  })

  it('sends requestAddBlock as a create-block op anchored on the block id, correlated', () => {
    const { binding, sock } = mounted()
    binding.provider.requestAddBlock('code', { source: 'x=1' }, 'p1')

    const frame = lastSent(sock, DocumentFrame.BLOCK_OP)
    expect(frame.uuid).toBe(UUID)
    expect(frame.op).toEqual({ type: 'create-block', blockId: '', kind: 'code', attrs: { source: 'x=1' }, afterBlockId: 'p1' })
    expect(frame.opId).toMatch(/^op-\d+$/)
  })

  // The whole point of anchoring by id: a sibling created moments ago is not in
  // this client's follower model yet, and the op that follows it must still say
  // so. An index would have read as "append" and landed at the end of the file.
  it('anchors on a block the follower model has not been told about yet', () => {
    const { binding, sock } = mounted()
    binding.provider.requestAddBlock('prose', {}, 'not-yet-echoed')

    expect(lastSent(sock, DocumentFrame.BLOCK_OP).op.afterBlockId).toBe('not-yet-echoed')
  })

  it('states the id a LENS-BORN block chose, so Go adopts rather than mints', () => {
    // A block born in a lens carries its durable UUIDv7 from the keystroke that
    // made it (issue #96). It arrives here as ordinary block data — `attrs.id` —
    // and the binding lifts it onto the op, because that is where the wire keeps
    // a block's name. Nothing correlates: the block wears the same name on both
    // sides from the first frame.
    const { binding, sock } = mounted()
    const born = '0191f0c2-2b4e-7a10-9c33-4d5e6f708192'
    binding.provider.requestAddBlock('prose', { content: 'typed', id: born }, 'p1')

    const frame = lastSent(sock, DocumentFrame.BLOCK_OP)
    expect(frame.op.blockId).toBe(born)
    expect(frame.op.attrs).toEqual({ content: 'typed', id: born })
  })

  it('sends requestSetBlock as an update-block op under the model\'s kind', () => {
    const { binding, sock } = mounted()
    binding.provider.requestSetBlock('p2', { content: 'edited' })

    const frame = lastSent(sock, DocumentFrame.BLOCK_OP)
    expect(frame.op).toEqual({ type: 'update-block', blockId: 'p2', kind: 'prose', attrs: { content: 'edited' } })
    expect(frame.opId).toMatch(/^op-\d+$/)
  })

  it('sends requestRemoveBlock as a delete-block op, and Go\'s echo is what empties the model', () => {
    const { binding, sock } = mounted()
    binding.provider.requestRemoveBlock('p1')

    const frame = lastSent(sock, DocumentFrame.BLOCK_OP)
    expect(frame.uuid).toBe(UUID)
    expect(frame.op).toEqual({ type: 'delete-block', blockId: 'p1' })
    expect(frame.opId).toMatch(/^op-\d+$/)
    // The verb changed nothing locally; the remove-block echo does.
    expect(binding.provider.getOrder()).toEqual(['p1', 'p2'])

    sock.driveMessage({ type: DocumentFrame.REMOVE_BLOCK, id: 'p1' })
    expect(binding.provider.getOrder()).toEqual(['p2'])
  })

  it('sends requestSetOrder as a set-order op carrying the complete order', () => {
    const { binding, sock } = mounted()
    binding.provider.requestSetOrder(['p2', 'p1'])

    const frame = lastSent(sock, DocumentFrame.BLOCK_OP)
    expect(frame.op).toEqual({ type: 'set-order', order: ['p2', 'p1'] })
    expect(frame.opId).toMatch(/^op-\d+$/)
  })

  it('sends requestTransform as the extract frame, uuid-less by contract', () => {
    const { binding, sock } = mounted()
    const entries = [{ mimeType: 'text/plain', content: '```go\nx := 1\n```' }]
    binding.provider.requestTransform('p1', 'code', 'transform', entries)

    const frame = lastSent(sock, DocumentFrame.EXTRACT)
    expect(frame).toEqual({
      type: DocumentFrame.EXTRACT,
      blockId: 'p1',
      targetKind: 'code',
      operation: 'transform',
      entries: entries,
      opId: frame.opId,
    })
    expect(frame.opId).toMatch(/^op-\d+$/)
  })

  it('sends flush as the same update-block op, under the kind\'s content attr', () => {
    const { binding, sock } = mounted()
    binding.provider.flush('p1', 'typed text')

    const frame = lastSent(sock, DocumentFrame.BLOCK_OP)
    expect(frame.op).toEqual({ type: 'update-block', blockId: 'p1', kind: 'prose', attrs: { content: 'typed text' } })
  })

  it('sends paste as the smart paste frame and answers Go\'s decision', async () => {
    const { binding, sock } = mounted()
    const entries = [{ mimeType: 'text/plain', content: 'https://example.com' }]
    const pending = binding.provider.paste({ entries: entries }, 'p1')

    const frame = lastSent(sock, DocumentFrame.PASTE)
    expect(frame.kind).toBe('smart')
    expect(frame.entries).toEqual(entries)
    expect(frame.afterBlockId).toBe('p1')

    sock.driveMessage({ type: DocumentFrame.PASTE_ACK, opId: frame.opId, outcome: 'content', html: '<a>T</a>' })
    expect(await pending).toEqual({ outcome: 'content', content: '<a>T</a>' })
  })

  it('sends detectExtractions as the discovery frame and answers the offers', async () => {
    const { binding, sock } = mounted()
    const pending = binding.provider.detectExtractions('prose', [{ mimeType: 'text/plain', content: 'x' }])

    const frame = lastSent(sock, DocumentFrame.DETECT_EXTRACTIONS)
    expect(frame.sourceKind).toBe('prose')

    const offers = [{ kind: 'code', actions: ['extract'] }]
    sock.driveMessage({ type: DocumentFrame.DETECT_EXTRACTIONS_RESULT, opId: frame.opId, offers: offers })
    expect(await pending).toEqual(offers)
  })

  it('addresses detectExtractions by ITS uuid, not by whichever channel is open', async () => {
    // Capability discovery is the one query whose frame carries no uuid of its
    // own — the server reads the document off the channel it arrived on. So the
    // binding's uuid, not "the open channel", has to pick that channel: with a
    // second document open the guess would be a coin toss.
    const { rig, feed, sock } = mounted()
    const other = new MountBinding('doc-2', rig.documentService, feed)
    other.openChannel(/** @type {any} */ (fakeDelegate()))
    const otherSock = FakeSocket.instances[FakeSocket.instances.length - 1]
    otherSock.driveOpen()

    const pending = other.provider.detectExtractions('code', [])
    expect(sock.sentOfType(DocumentFrame.DETECT_EXTRACTIONS)).toEqual([])

    const frame = lastSent(otherSock, DocumentFrame.DETECT_EXTRACTIONS)
    expect(frame.sourceKind).toBe('code')
    expect(otherSock.url).toContain('doc-2')
    otherSock.driveMessage({ type: DocumentFrame.DETECT_EXTRACTIONS_RESULT, opId: frame.opId, offers: [] })
    expect(await pending).toEqual([])
  })

  it('leaves the model alone until Go echoes — a verb is a request, not an apply', () => {
    const { binding, sock } = mounted()
    binding.provider.requestSetOrder(['p2', 'p1'])
    expect(binding.provider.getOrder()).toEqual(['p1', 'p2'])

    sock.driveMessage({ type: DocumentFrame.ORDER_CHANGED, order: ['p2', 'p1'] })
    expect(binding.provider.getOrder()).toEqual(['p2', 'p1'])
  })

  // ── Presence ──────────────────────────────────────────────────────────────

  it('is the SelectionListener a lens registers, and republishes what it hears', () => {
    const { binding } = mounted()
    /** @type {any[]} */ const heard = []
    const unsubscribe = binding.onSelectionAdvert((ctx) => heard.push(ctx))

    expect(binding.getSelectionContext()).toBeNull()

    const advert = Object.freeze({ docUuid: UUID, selectionType: 'block', blockId: 'p1' })
    binding.onSelectionChanged(/** @type {any} */ (advert))

    expect(heard).toEqual([advert])
    expect(binding.getSelectionContext()).toBe(advert)

    unsubscribe()
    binding.onSelectionChanged(/** @type {any} */ ({ docUuid: UUID, selectionType: 'none' }))
    expect(heard).toHaveLength(1)
    // The pull stays current even with nobody subscribed — the shell synthesizes
    // a republish from it on tab activation.
    expect(binding.getSelectionContext().selectionType).toBe('none')
  })

  it('isolates a throwing advert listener from its siblings', () => {
    const { binding } = mounted()
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    /** @type {any[]} */ const heard = []
    binding.onSelectionAdvert(() => { throw new Error('consumer exploded') })
    binding.onSelectionAdvert((ctx) => heard.push(ctx))

    binding.onSelectionChanged(/** @type {any} */ ({ docUuid: UUID }))
    expect(heard).toHaveLength(1)
    err.mockRestore()
  })

  it('refuses a non-function advert listener', () => {
    const { binding } = mounted()
    expect(() => binding.onSelectionAdvert(/** @type {any} */ (null))).toThrow(ContractViolation)
  })
})
