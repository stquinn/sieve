// @ts-check
// service-mirror.test.js — issue #49 Phase 3: the SERVICE-side truth-mirror.
// BlockService.#blocks holds blockId → {uuid, kind, block: SieveBlock|null}; the
// `block` slot is the last envelope Go authored, advanced ONLY by inbound server
// truth (indexDocument + the render-back messages). DocumentService fronts the
// document-scoped onBlockUpdated stream and the typed load/save shapes. Driven
// through the shared service-rig (REAL services over FakeSockets — no real wire).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { serviceRig, fakeDelegate, FakeSocket } from './helpers/service-rig.js'
import { SieveBlock } from '../src/static/block/sieve-block.js'

describe('BlockService truth-mirror', () => {
  beforeEach(() => FakeSocket.reset())

  it('indexDocument seeds the mirror from typed envelopes; envelopeFor returns them', () => {
    const { service } = serviceRig({ uuid: 'doc-1' })
    const env = new SieveBlock('code', { id: 'c1', source: 'x=1' })
    service.indexDocument('doc-1', [env])
    expect(service.envelopeFor('c1')).toBe(env)
  })

  it('envelopeFor misses → null (unknown id, and a routing-only raw-seeded entry)', () => {
    // serviceRig seeds with raw {id, kind} maps → routing pair only, null envelope.
    const { service } = serviceRig({ uuid: 'doc-1', blocks: [{ id: 'r1', kind: 'code' }] })
    expect(service.envelopeFor('nope')).toBeNull()
    expect(service.envelopeFor('r1')).toBeNull()
  })

  it('insert-block render-back authors an envelope (the service is the anti-corruption author)', () => {
    const { service, sock } = serviceRig({ uuid: 'doc-1' })
    sock.driveMessage({ type: 'insert-block', kind: 'code', id: 'i1', attrs: { source: 'a', status: 'PENDING' } })
    const env = service.envelopeFor('i1')
    expect(env).toBeInstanceOf(SieveBlock)
    expect(env.kind).toBe('code')
    expect(env.id).toBe('i1')
    expect(env.payload.source).toBe('a')
    expect(env.status).toBe('PENDING')
  })

  it('insert-block with no kind falls back to code (wysiwyg surface default)', () => {
    const { service, sock } = serviceRig({ uuid: 'doc-1' })
    sock.driveMessage({ type: 'insert-block', id: 'i2', attrs: {} })
    expect(service.envelopeFor('i2').kind).toBe('code')
  })

  it('replace-block authors the NEW id; the OLD id entry stays for routing (sticky)', () => {
    const { service, sock } = serviceRig({ uuid: 'doc-1', blocks: [{ id: 'old', kind: 'prose' }] })
    sock.driveMessage({ type: 'replace-block', oldId: 'old', newId: 'new', newKind: 'diagram', attrs: { source: 'graph' } })
    const env = service.envelopeFor('new')
    expect(env.kind).toBe('diagram')
    expect(env.id).toBe('new')
    expect(env.payload.source).toBe('graph')
    // The old id still routes: an outbound update on it must still leave the wire.
    service.updateAttributes('old', { content: 'z' })
    expect(sock.sentOfType('block-op').map((m) => m.op.blockId)).toContain('old')
  })

  it('block-attrs-updated MERGES onto the prior payload (kind preserved, prior keys survive)', () => {
    const { service, sock } = serviceRig({ uuid: 'doc-1' })
    sock.driveMessage({ type: 'insert-block', kind: 'ai-block', id: 'a1', attrs: { question: 'Q?', status: 'PENDING' } })
    sock.driveMessage({ type: 'block-attrs-updated', id: 'a1', attrs: { status: 'COMPLETE', answer: 'A.' } })
    const env = service.envelopeFor('a1')
    expect(env.kind).toBe('ai-block')       // kind carried from the entry
    expect(env.payload.question).toBe('Q?') // prior payload survives the merge
    expect(env.payload.answer).toBe('A.')   // new key merged in
    expect(env.status).toBe('COMPLETE')     // updated field wins
  })

  it('block-attrs-updated merges onto a null prior (routing-only entry) → payload = attrs + id', () => {
    // Seed a routing-only entry (raw seed → block:null), then advance it.
    const { service, sock } = serviceRig({ uuid: 'doc-1', blocks: [{ id: 'r1', kind: 'log' }] })
    expect(service.envelopeFor('r1')).toBeNull()
    sock.driveMessage({ type: 'block-attrs-updated', id: 'r1', attrs: { status: 'COMPLETE' } })
    const env = service.envelopeFor('r1')
    expect(env).toBeInstanceOf(SieveBlock)
    expect(env.kind).toBe('log')
    expect(env.id).toBe('r1')
    expect(env.status).toBe('COMPLETE')
  })

  it('block-attrs-updated for an unknown id is a no-op (no kind to author)', () => {
    const { service, sock } = serviceRig({ uuid: 'doc-1' })
    sock.driveMessage({ type: 'block-attrs-updated', id: 'ghost', attrs: { status: 'COMPLETE' } })
    expect(service.envelopeFor('ghost')).toBeNull()
  })

  it('ONE-WRITER: outbound verbs (updateAttributes/setContent) never advance the mirror', () => {
    const { service, sock } = serviceRig({ uuid: 'doc-1' })
    sock.driveMessage({ type: 'insert-block', kind: 'code', id: 'c1', attrs: { source: 'a' } })
    const before = service.envelopeFor('c1')
    service.updateAttributes('c1', { source: 'b' })
    service.setContent('c1', 'c')
    expect(service.envelopeFor('c1')).toBe(before) // same reference — never rewritten
    expect(before.payload.source).toBe('a')        // still the server truth
  })

  it('the mirror advances BEFORE delegate.applyServerOp (the seam re-resolves the fresh envelope)', () => {
    let svc
    let seenDuringApply = 'unset'
    const delegate = fakeDelegate({
      applyServerOp: (msg) => { seenDuringApply = svc.envelopeFor(msg.id) },
    })
    const rig = serviceRig({ uuid: 'doc-1', delegate })
    svc = rig.service
    rig.sock.driveMessage({ type: 'insert-block', kind: 'code', id: 'i1', attrs: { source: 'a' } })
    // applyServerOp ran AFTER the mirror update → it already saw the authored envelope.
    expect(seenDuringApply).toBeInstanceOf(SieveBlock)
    expect(seenDuringApply.payload.source).toBe('a')
  })
})

describe('DocumentService.load — typed shape (raw bridge retired)', () => {
  beforeEach(() => FakeSocket.reset())

  /** @param {any} body */
  function fetchLoad(body) {
    global.fetch = vi.fn(() => /** @type {any} */ (Promise.resolve({ json: () => Promise.resolve(body) })))
  }

  it('returns {body, blocks: SieveBlock[], meta:{mode}} — the raw key is gone, envelopes typed', async () => {
    const prevFetch = global.fetch
    fetchLoad({ body: 'B', mode: 'markdown', blocks: [{ id: 'l1', kind: 'code', attrs: { source: 'x' } }] })
    try {
      const { documentService } = serviceRig({ uuid: 'doc-1' })
      const res = await documentService.load('doc-1')
      expect(res).not.toHaveProperty('raw')
      expect(res.body).toBe('B')
      expect(res.meta.mode).toBe('markdown')
      expect(res.blocks).toHaveLength(1)
      expect(res.blocks[0]).toBeInstanceOf(SieveBlock)
      expect(res.blocks[0].id).toBe('l1')
      expect(res.blocks[0].kind).toBe('code')
      expect(res.blocks[0].payload.source).toBe('x') // flat payload = the attrs bag + id/kind
    } finally { global.fetch = prevFetch }
  })

  it('meta.mode defaults to wysiwyg when the wire omits it', async () => {
    const prevFetch = global.fetch
    fetchLoad({ body: '', blocks: [] })
    try {
      const { documentService } = serviceRig({ uuid: 'doc-1' })
      const res = await documentService.load('doc-1')
      expect(res.meta.mode).toBe('wysiwyg')
      expect(res.blocks).toEqual([])
    } finally { global.fetch = prevFetch }
  })

  it('load seeds the truth-mirror — envelopeFor returns the typed envelope', async () => {
    const prevFetch = global.fetch
    fetchLoad({ body: 'B', mode: 'wysiwyg', blocks: [{ id: 'l1', kind: 'code', attrs: { source: 'x' } }] })
    try {
      const { service, documentService } = serviceRig({ uuid: 'doc-1' })
      await documentService.load('doc-1')
      const env = service.envelopeFor('l1')
      expect(env).toBeInstanceOf(SieveBlock)
      expect(env.kind).toBe('code')
      expect(env.payload.source).toBe('x')
    } finally { global.fetch = prevFetch }
  })
})

describe('DocumentService.onBlockUpdated — document-scoped render-back stream', () => {
  beforeEach(() => FakeSocket.reset())

  it('fires with the refreshed envelope AFTER a block-attrs-updated mirror advance; unsubscribe stops it', () => {
    const { service, documentService, sock } = serviceRig({ uuid: 'doc-1' })
    sock.driveMessage({ type: 'insert-block', kind: 'ai-block', id: 'a1', attrs: { status: 'PENDING' } })
    const seen = []
    const off = documentService.onBlockUpdated('doc-1', (b) => seen.push(b))
    sock.driveMessage({ type: 'block-attrs-updated', id: 'a1', attrs: { status: 'COMPLETE' } })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toBeInstanceOf(SieveBlock)
    expect(seen[0].status).toBe('COMPLETE')
    expect(seen[0]).toBe(service.envelopeFor('a1')) // the mirror's current envelope
    off()
    sock.driveMessage({ type: 'block-attrs-updated', id: 'a1', attrs: { status: 'ERROR' } })
    expect(seen).toHaveLength(1) // unsubscribed — no further notifications
  })

  it('does NOT fire for insert-block / replace-block (only block-attrs-updated)', () => {
    const { documentService, sock } = serviceRig({ uuid: 'doc-1' })
    const seen = []
    documentService.onBlockUpdated('doc-1', (b) => seen.push(b))
    sock.driveMessage({ type: 'insert-block', kind: 'code', id: 'i1', attrs: {} })
    sock.driveMessage({ type: 'replace-block', oldId: 'i1', newId: 'i2', newKind: 'code', attrs: {} })
    expect(seen).toHaveLength(0)
  })

  it('is scoped per uuid — a render-back on another document never fires this listener', () => {
    const { service, documentService, sock } = serviceRig({ uuid: 'doc-1' })
    // Open a second document channel + seed a block on it.
    service.openChannel('doc-2', /** @type {any} */ (fakeDelegate()))
    const sockB = FakeSocket.instances[FakeSocket.instances.length - 1]
    sockB.driveOpen()
    sockB.driveMessage({ type: 'insert-block', kind: 'code', id: 'b1', attrs: {} })
    // doc-1's listener must not see doc-2's block-attrs-updated.
    const seen = []
    documentService.onBlockUpdated('doc-1', (b) => seen.push(b))
    sockB.driveMessage({ type: 'block-attrs-updated', id: 'b1', attrs: { status: 'COMPLETE' } })
    expect(seen).toHaveLength(0)
    // Sanity: a doc-1 advance DOES fire it.
    sock.driveMessage({ type: 'insert-block', kind: 'code', id: 'a1', attrs: {} })
    sock.driveMessage({ type: 'block-attrs-updated', id: 'a1', attrs: { status: 'COMPLETE' } })
    expect(seen).toHaveLength(1)
  })
})
