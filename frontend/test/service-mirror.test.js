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

  it('kindFor answers where envelopeFor cannot: the routing index knows every id it holds (#82)', () => {
    const { service } = serviceRig({ uuid: 'doc-1', blocks: [{ id: 'r1', kind: 'code' }] })
    service.indexDocument('doc-1', [new SieveBlock('diagram', { id: 'd1' })])
    expect(service.kindFor('r1')).toBe('code')     // routing-only: no envelope, but a kind
    expect(service.kindFor('d1')).toBe('diagram')
    expect(service.kindFor('nope')).toBe('')
    expect(service.kindFor('')).toBe('')
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

  /**
   * Asks for the document over the channel and answers with a load-content frame
   * carrying `content` at its TOP LEVEL — the embedded shape Go emits.
   * @param {{documentService: any, sock: any, uuid: string}} rig @param {any} content
   */
  function driveLoad(rig, content) {
    const pending = rig.documentService.load(rig.uuid)
    rig.sock.driveMessage(Object.assign({ type: 'load-content', opId: lastOpId(rig.sock, 'load') }, content))
    return pending
  }

  it('returns {body, blocks: SieveBlock[], meta:{mode}} — the raw key is gone, envelopes typed', async () => {
    const rig = serviceRig({ uuid: 'doc-1' })
    const res = await driveLoad(rig, { body: 'B', mode: 'markdown', blocks: [{ id: 'l1', kind: 'code', attrs: { source: 'x' } }] })
    expect(res).not.toHaveProperty('raw')
    expect(res.body).toBe('B')
    expect(res.meta.mode).toBe('markdown')
    expect(res.blocks).toHaveLength(1)
    expect(res.blocks[0]).toBeInstanceOf(SieveBlock)
    expect(res.blocks[0].id).toBe('l1')
    expect(res.blocks[0].kind).toBe('code')
    expect(res.blocks[0].payload.source).toBe('x') // flat payload = the attrs bag + id/kind
  })

  it('meta.mode defaults to wysiwyg when the wire omits it', async () => {
    const rig = serviceRig({ uuid: 'doc-1' })
    const res = await driveLoad(rig, { body: '', blocks: [] })
    expect(res.meta.mode).toBe('wysiwyg')
    expect(res.blocks).toEqual([])
  })

  it('load seeds the truth-mirror — envelopeFor returns the typed envelope', async () => {
    const rig = serviceRig({ uuid: 'doc-1' })
    await driveLoad(rig, { body: 'B', mode: 'wysiwyg', blocks: [{ id: 'l1', kind: 'code', attrs: { source: 'x' } }] })
    const env = rig.service.envelopeFor('l1')
    expect(env).toBeInstanceOf(SieveBlock)
    expect(env.kind).toBe('code')
    expect(env.payload.source).toBe('x')
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

// ── The channel razor: discovery and the paste pipelines are document-wire frames.
// These assert the FROZEN frames as they leave, and the reply shapes as they are
// read back — no fetch, no URL, no network.

/** @param {import('./helpers/service-rig.js').FakeSocket} sock @param {string} reqType */
function lastOpId(sock, reqType) {
  const sent = sock.sentOfType(reqType)
  return sent.length ? sent[sent.length - 1].opId : undefined
}

describe('BlockService.detectExtractions — capability discovery over the document wire', () => {
  beforeEach(() => FakeSocket.reset())

  it('sends {sourceKind, entries} and resolves the offers out of the reply KEY', async () => {
    const { service, sock } = serviceRig({ uuid: 'doc-1' })
    const entries = [{ kind: 'sieve/code', content: 'x=1' }]
    const offers = [{ kind: 'code', actions: ['extract'] }, { kind: 'prose', actions: ['transform'] }]
    const pending = service.detectExtractions({ sourceKind: 'log', entries })
    expect(sock.sentOfType('detect-extractions')[0]).toEqual({
      type: 'detect-extractions', sourceKind: 'log', entries, opId: lastOpId(sock, 'detect-extractions'),
    })
    sock.driveMessage({
      type: 'detect-extractions-result', opId: lastOpId(sock, 'detect-extractions'), offers,
    })
    await expect(pending).resolves.toEqual(offers)
  })

  it('resolves an EMPTY offer list with no channel — nothing to discover is an answer', async () => {
    const { service } = serviceRig({ uuid: null })
    await expect(service.detectExtractions({ sourceKind: 'log', entries: [] })).resolves.toEqual([])
  })
})

describe('DocumentService paste pipelines — one frame, two kinds', () => {
  beforeEach(() => FakeSocket.reset())

  it('pasteSlice sends kind:slice with the slice, and the ack names no block', async () => {
    const { documentService, sock } = serviceRig({ uuid: 'doc-1' })
    // Wire shape is [][]block.ContentEntry (sieve/protocol/document_frames.go:328):
    // one ENTRY-ARRAY per copied block, each entry {mimeType, content} — the same
    // per-block view set wysiwyg-surface.js's sliceItems builds (lines 539-562).
    // NOT a flat [{kind, content}] list.
    const slice = [
      [{ mimeType: 'sieve/prose', content: 'a' }],
      [{ mimeType: 'sieve/code', content: 'b' }],
    ]
    const pending = documentService.pasteSlice('doc-1', { slice, index: 3 })
    expect(sock.sentOfType('paste')[0]).toEqual({
      type: 'paste', kind: 'slice', slice, index: 3, opId: lastOpId(sock, 'paste'),
    })
    sock.driveMessage({ type: 'paste-ack', opId: lastOpId(sock, 'paste'), outcome: 'block' })
    const res = await pending
    expect(res.outcome).toBe('block')
    expect(res.id).toBeUndefined()
  })

  it('smartPaste sends kind:smart with the entries and hands the PasteResult union through untouched', async () => {
    const { documentService, sock } = serviceRig({ uuid: 'doc-1' })
    const entries = [{ mimeType: 'text/plain', content: 'https://x.test' }]
    const pending = documentService.smartPaste('doc-1', { entries, index: 4 })
    expect(sock.sentOfType('paste')[0]).toEqual({
      type: 'paste', kind: 'smart', entries, index: 4, opId: lastOpId(sock, 'paste'),
    })
    sock.driveMessage({
      type: 'paste-ack', opId: lastOpId(sock, 'paste'),
      outcome: 'content', html: '<a href="https://x.test">X</a>',
    })
    const res = await pending
    expect(res.outcome).toBe('content')
    expect(res.html).toBe('<a href="https://x.test">X</a>')
  })

  // Go's paste path is SYNCHRONOUS and smart-image acquire downloads with an 8s
  // HTTP timeout (smart_image_processor.go:436-438) — a slow image paste's ack
  // can legitimately land after the wire's DEFAULT 5s ceiling. Both paste verbs
  // raise it to PASTE_ACK_TIMEOUT_MS (12s) so that ack is not dropped on the
  // floor: an ack arriving after the default would have fired would leave
  // #applyPasteResult never run and the insert anchor never consumed/cleared.
  it('smartPaste and pasteSlice outlive the default 5s ceiling — an ack at 8s still lands', async () => {
    vi.useFakeTimers()
    try {
      const { documentService, sock } = serviceRig({ uuid: 'doc-1' })
      const pending = documentService.smartPaste('doc-1', { entries: [], index: 0 })
      let settled = false
      pending.then(() => { settled = true }, () => { settled = true })

      // Past the default 5s: an unraised ceiling would have rejected by now.
      await vi.advanceTimersByTimeAsync(5001)
      expect(settled).toBe(false)

      // An 8s-late ack (the server's image-download bound) still lands inside
      // the 12s ceiling.
      sock.driveMessage({
        type: 'paste-ack', opId: lastOpId(sock, 'paste'), outcome: 'block', kind: 'smart-image', id: 'img-1',
      })
      const res = await pending
      expect(res.outcome).toBe('block')
    } finally {
      vi.useRealTimers()
    }
  })

  it('pasteSlice rejects only past the RAISED 12s ceiling, not the wire default', async () => {
    vi.useFakeTimers()
    try {
      const { documentService } = serviceRig({ uuid: 'doc-1' })
      const pending = documentService.pasteSlice('doc-1', { slice: [], index: 0 })
      const assertion = expect(pending).rejects.toThrow('ws timeout: paste slice')
      await vi.advanceTimersByTimeAsync(12000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('DocumentService.focus — the dwell ping', () => {
  beforeEach(() => FakeSocket.reset())

  it('sends an unanswered {type:focus} and awaits nothing', () => {
    const { documentService, sock } = serviceRig({ uuid: 'doc-1' })
    expect(documentService.focus('doc-1')).toBeUndefined()
    expect(sock.sentOfType('focus')).toEqual([{ type: 'focus' }])
  })

  it('drops for a channel-less document rather than throwing', () => {
    const { documentService } = serviceRig({ uuid: null })
    expect(() => documentService.focus('prompt:x')).not.toThrow()
  })
})
