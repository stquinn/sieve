// @ts-check
// ink-provider-adapter.test.js — a Digital Note's provider: its pages asked for
// over the container's channel, and its ink frames as the feed's events. The
// feed's delivery itself is the base adapter's (provider-adapter.test.js).

import { describe, it, expect, beforeEach } from 'vitest'
import { serviceRig, FakeSocket } from './helpers/service-rig.js'
import { ContainerModel } from '../src/static/container/container-model.js'
import { InkProviderAdapter } from '../src/static/container/ink-provider-adapter.js'
import { ProviderAdapter } from '../src/static/container/provider-adapter.js'
import { InkFeed } from '../src/static/contract/ink-container-provider.js'
import { DocumentFrame } from '../src/static/generated/protocol.js'
import { ContractViolation } from '../src/static/contract/sieve-block.js'

const UUID = 'note-1'
const STROKE = { id: 's1', tool: 'pen', widthClass: 2, startMillis: 5, points: [{ x: 0.25, y: 0.5, pressure: 0.75, tMillis: 0, tiltX: 0, tiltY: 0, size: 0 }] }

function rig() {
  const r = serviceRig({ uuid: UUID })
  const model = new ContainerModel(UUID, 'digital-note')
  model.applyLoad({ uuid: UUID, blocks: [{ id: UUID, kind: 'digital-note', attrs: { title: 'Ideas' } }] })
  return Object.assign(r, { provider: new InkProviderAdapter(model, r.documentService) })
}

/** @param {any} sock @returns {string} */
function pageOpId(sock) {
  const sent = sock.sentOfType(DocumentFrame.INK_PAGE)
  return sent[sent.length - 1].opId
}

describe('InkProviderAdapter', () => {
  beforeEach(() => FakeSocket.reset())

  it('demands a DocumentService, and reads its block as any provider does', () => {
    const model = new ContainerModel(UUID, 'digital-note')
    expect(() => new InkProviderAdapter(model, /** @type {any} */ ({}))).toThrow(ContractViolation)
    const { provider } = rig()
    expect(provider).toBeInstanceOf(ProviderAdapter)
    expect(provider.getKind()).toBe('digital-note')
    expect(provider.getBlock(UUID)?.attrs.title).toBe('Ideas')
  })

  it('loadPage resolves the page and the seq it reflects, frozen', async () => {
    const { provider, sock } = rig()
    const page = { note: { pageAspect: 0.75 }, strokes: [STROKE] }
    const pending = provider.loadPage('p1')
    sock.driveMessage({ type: DocumentFrame.INK_PAGE_CONTENT, opId: pageOpId(sock), pageId: 'p1', seq: 4, page })
    const answer = await pending
    expect(answer).toEqual({ page, seq: 4 })
    expect(Object.isFrozen(answer.page.strokes[0].points[0])).toBe(true)
  })

  it('loadPage rejects a page the note does not have', async () => {
    const { provider, sock } = rig()
    const pending = provider.loadPage('p9')
    sock.driveMessage({ type: DocumentFrame.INK_PAGE_CONTENT, opId: pageOpId(sock), pageId: 'p9', seq: 0, page: null, error: 'no page p9' })
    await expect(pending).rejects.toThrow('no page p9')
  })

  it('turns each ink frame into its event, in order, and nothing else into one', () => {
    const { provider, sock } = rig()
    /** @type {any[]} */ const heard = []
    provider.subscribeFeed({ onFeed: (e) => heard.push(e) })
    sock.driveMessage({ type: DocumentFrame.INK_LIVE_PAGE, live: true, pageId: 'p1' })
    sock.driveMessage({
      type: DocumentFrame.INK_LIVE, records: [
        { record: 'begin', stroke: 3, tool: 'pencil', widthClass: 2, x: -0.5, y: 1.25, pressure: 0, tMillis: 0, tiltX: 0, tiltY: 0 },
        { record: 'point', stroke: 3, x: -0.25, y: 1.5, pressure: 0.5, tMillis: 16, tiltX: 10, tiltY: -10 },
        { record: 'view', stroke: 0, x: -1, y: 2, pressure: 0, tMillis: 0, tiltX: 0, tiltY: 0 },
      ],
    })
    sock.driveMessage({ type: DocumentFrame.BLOCK_ATTRS_UPDATED, id: UUID, attrs: { title: 'Ideas' } })
    sock.driveMessage({ type: DocumentFrame.INK_STROKE_ADDED, pageId: 'p1', seq: 5, stroke: STROKE })
    sock.driveMessage({ type: DocumentFrame.INK_STROKE_REMOVED, pageId: 'p1', seq: 6, strokeId: 's1' })
    sock.driveMessage({ type: DocumentFrame.INK_LIVE_PAGE, live: false })
    expect(heard).toEqual([
      { type: InkFeed.LIVE_PAGE, live: true, pageId: 'p1' },
      {
        type: InkFeed.LIVE, records: [
          { record: 'begin', stroke: 3, tool: 'pencil', widthClass: 2, x: -0.5, y: 1.25, pressure: 0, tMillis: 0, tiltX: 0, tiltY: 0 },
          { record: 'point', stroke: 3, tool: null, widthClass: 0, x: -0.25, y: 1.5, pressure: 0.5, tMillis: 16, tiltX: 10, tiltY: -10 },
          { record: 'view', stroke: 0, tool: null, widthClass: 0, x: -1, y: 2, pressure: 0, tMillis: 0, tiltX: 0, tiltY: 0 },
        ],
      },
      { type: InkFeed.STROKE_ADDED, pageId: 'p1', seq: 5, stroke: STROKE },
      { type: InkFeed.STROKE_REMOVED, pageId: 'p1', seq: 6, strokeId: 's1' },
      { type: InkFeed.LIVE_PAGE, live: false, pageId: null },
    ])
    expect(heard.every((e) => Object.isFrozen(e))).toBe(true)
    expect(Object.isFrozen(heard[1].records[1])).toBe(true)
  })

  it('stops observing the channel when the last listener leaves', () => {
    const { provider, sock } = rig()
    /** @type {any[]} */ const heard = []
    const listener = { onFeed: (/** @type {any} */ e) => heard.push(e) }
    provider.subscribeFeed(listener)
    provider.unsubscribeFeed(listener)
    sock.driveMessage({ type: DocumentFrame.INK_STROKE_REMOVED, pageId: 'p1', seq: 6, strokeId: 's1' })
    expect(heard).toEqual([])
  })
})
