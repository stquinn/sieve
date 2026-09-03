// @ts-check
// document-wire.test.js — the document vocabulary and the channel under it, driven
// through the shared service-rig (REAL services over FakeSockets — no real wire).
//
// Every frame Sieve speaks about a document is spelled in DocumentService, so every
// frame is pinned here: the FROZEN shapes as they leave, and the reply shapes as
// they are read back. ContainerTransport holds NO view of what a document contains
// (issue #96) and no longer spells a frame either — the client's account of a
// container is the follower model (container/container-model.js), fed from
// `observeFrames`, and what is left of the transport is the channel itself.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { serviceRig, fakeDelegate, FakeSocket } from './helpers/service-rig.js'
import { ContractViolation } from '../src/static/contract/sieve-block.js'

describe('DocumentService.load — the host facts, and the container to the model', () => {
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

  it('answers only what the HOST acts on — the blocks are not in it', async () => {
    const rig = serviceRig({ uuid: 'doc-1' })
    const res = await driveLoad(rig, {
      body: 'B', mode: 'markdown', scroll: 120, version: 7,
      blocks: [{ id: 'l1', kind: 'code', attrs: { source: 'x' } }],
    })
    expect(res).toEqual({ body: 'B', meta: { mode: 'markdown' }, scroll: 120, version: 7 })
  })

  it('meta.mode defaults to wysiwyg when the wire omits it', async () => {
    const rig = serviceRig({ uuid: 'doc-1' })
    const res = await driveLoad(rig, { body: '', blocks: [] })
    expect(res.meta.mode).toBe('wysiwyg')
  })

  it('publishes the whole container answer, RAW, for the follower model to seed from', async () => {
    const rig = serviceRig({ uuid: 'doc-1' })
    /** @type {any[]} */ const seen = []
    rig.documentService.onContent('doc-1', (c) => seen.push(c))
    await driveLoad(rig, { body: 'B', mode: 'wysiwyg', blocks: [{ id: 'l1', kind: 'code', attrs: { source: 'x' } }] })
    expect(seen).toHaveLength(1)
    expect(seen[0].blocks).toEqual([{ id: 'l1', kind: 'code', attrs: { source: 'x' } }])
  })

  it('setContents publishes Go\'s REPARSE the same way — a whole new statement of the container', async () => {
    const rig = serviceRig({ uuid: 'doc-1' })
    /** @type {any[]} */ const seen = []
    rig.documentService.onContent('doc-1', (c) => seen.push(c))
    const pending = rig.documentService.setContents('doc-1', '# raw')
    rig.sock.driveMessage({
      type: 'wysiwyg-content', opId: lastOpId(rig.sock, 'enter-wysiwyg'),
      blocks: [{ id: 'r1', kind: 'prose', attrs: { content: 'raw' } }],
    })
    await pending
    expect(seen).toHaveLength(1)
    expect(seen[0].blocks).toEqual([{ id: 'r1', kind: 'prose', attrs: { content: 'raw' } }])
  })

  it('the inbound frame OBSERVER sees every routed frame, including the ones no reply settles', () => {
    const { documentService, sock } = serviceRig({ uuid: 'doc-1' })
    /** @type {string[]} */ const types = []
    documentService.observeFrames('doc-1', (msg) => types.push(msg.type))
    sock.driveMessage({ type: 'insert-block', kind: 'code', id: 'i1', attrs: {} })
    sock.driveMessage({ type: 'remove-block', id: 'i1' })
    sock.driveMessage({ type: 'order-changed', order: ['a', 'b'] })
    expect(types).toEqual(['insert-block', 'remove-block', 'order-changed'])
  })

  it('is scoped per uuid — a frame on another document never reaches this observer', () => {
    const { documentService, sock } = serviceRig({ uuid: 'doc-1' })
    documentService.open('doc-2', /** @type {any} */ (fakeDelegate()))
    const sockB = FakeSocket.instances[FakeSocket.instances.length - 1]
    sockB.driveOpen()
    /** @type {string[]} */ const types = []
    documentService.observeFrames('doc-1', (msg) => types.push(msg.type))
    sockB.driveMessage({ type: 'insert-block', kind: 'code', id: 'b1', attrs: {} })
    expect(types).toEqual([])
    sock.driveMessage({ type: 'insert-block', kind: 'code', id: 'a1', attrs: {} })
    expect(types).toEqual(['insert-block'])
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

describe('DocumentService.detectExtractions — capability discovery over the document wire', () => {
  beforeEach(() => FakeSocket.reset())

  it('sends {sourceKind, entries} and resolves the offers out of the reply KEY', async () => {
    const { documentService, sock } = serviceRig({ uuid: 'doc-1' })
    const entries = [{ kind: 'sieve/code', content: 'x=1' }]
    const offers = [{ kind: 'code', actions: ['extract'] }, { kind: 'prose', actions: ['transform'] }]
    const pending = documentService.detectExtractions('doc-1', 'log', entries)
    expect(sock.sentOfType('detect-extractions')[0]).toEqual({
      type: 'detect-extractions', sourceKind: 'log', entries, opId: lastOpId(sock, 'detect-extractions'),
    })
    sock.driveMessage({
      type: 'detect-extractions-result', opId: lastOpId(sock, 'detect-extractions'), offers,
    })
    await expect(pending).resolves.toEqual(offers)
  })

  it('resolves an EMPTY offer list with no channel — nothing to discover is an answer', async () => {
    const { documentService } = serviceRig({ uuid: null })
    await expect(documentService.detectExtractions('doc-1', 'log', [])).resolves.toEqual([])
  })
})

// ONE MAPPING FROM MARK TO FRAME, and every door takes it — the lens's void
// `requestReplaceText` and the shell's answering `MountBinding.replaceText` alike.
// A second mapping would be a second chance to send an anchor the server cannot
// resolve, so the mark's own fields and the guards that refuse an unresolvable one
// are pinned here, where the frame leaves.
describe('DocumentService.replaceText — the write the marks made possible', () => {
  beforeEach(() => FakeSocket.reset())

  const mark = {
    blockId: 'p1', locator: 'content', quote: 'teh', occurrence: 1, grain: 'word',
    start: 12, end: 15,
  }

  it('sends the anchor whole — the offsets ride as the hint they are (FROZEN)', () => {
    const { documentService, sock } = serviceRig({ uuid: 'doc-1' })
    documentService.replaceText('doc-1', /** @type {any} */ (mark), 'the')
    expect(sock.sentOfType('text-replace')[0]).toEqual(
      Object.assign({ type: 'text-replace', opId: lastOpId(sock, 'text-replace'), replacement: 'the' }, mark))
  })

  it('carries the grain the mark was counted at — the server dispatches its resolution on it', () => {
    const { documentService, sock } = serviceRig({ uuid: 'doc-1' })
    documentService.replaceText('doc-1', /** @type {any} */ (Object.assign({}, mark, { grain: 'literal' })), 'the')
    expect(sock.sentOfType('text-replace')[0].grain).toBe('literal')
  })

  it('an empty replacement is a deletion, not a missing field', () => {
    const { documentService, sock } = serviceRig({ uuid: 'doc-1' })
    documentService.replaceText('doc-1', /** @type {any} */ (mark), '')
    expect(sock.sentOfType('text-replace')[0].replacement).toBe('')
  })

  // An anchor missing its quote or its grain resolves NOWHERE, so it is a contract
  // breach rather than a race: the server would answer `stale` for text that never
  // moved.
  /** @type {Array<[string, Record<string, any>]>} */
  const refused = [
    ['no block named — nothing says where to resolve it', { blockId: '' }],
    ['no quote — there is nothing to resolve', { quote: '' }],
    ['no grain — nothing says how to count its occurrence', { grain: '' }],
  ]

  for (const [name, broken] of refused) {
    it('refuses an anchor with ' + name, () => {
      const { documentService, sock } = serviceRig({ uuid: 'doc-1' })
      expect(() => documentService.replaceText('doc-1', /** @type {any} */ (Object.assign({}, mark, broken)), 'the'))
        .toThrow(ContractViolation)
      expect(sock.sentOfType('text-replace')).toEqual([])
    })
  }

  /** @type {Array<[string, any, string]>} */
  const acks = [
    ['applied', { outcome: 'ok' }, 'ok'],
    ['the anchor no longer resolves', { outcome: 'stale' }, 'stale'],
    ['the write could not be run', { outcome: 'error', error: 'boom' }, 'error'],
    ['an answer with no outcome in it at all', {}, 'error'],
  ]

  for (const [name, ack, outcome] of acks) {
    it(`resolves the outcome word: ${name}`, async () => {
      const { documentService, sock } = serviceRig({ uuid: 'doc-1' })
      const pending = documentService.replaceText('doc-1', /** @type {any} */ (mark), 'the')
      sock.driveMessage(Object.assign({ type: 'text-replace-ack', opId: lastOpId(sock, 'text-replace') }, ack))
      await expect(pending).resolves.toBe(outcome)
    })
  }

  it('reads a container with no live channel as a write that did not happen', async () => {
    const { documentService } = serviceRig({ uuid: null })
    await expect(documentService.replaceText('doc-1', /** @type {any} */ (mark), 'the')).resolves.toBe('error')
  })
})

describe('DocumentService.paste — one frame, four kinds', () => {
  beforeEach(() => FakeSocket.reset())

  it('sends kind:slice with the slice, and the ack names no block', async () => {
    const { documentService, sock } = serviceRig({ uuid: 'doc-1' })
    // Wire shape is [][]block.ContentEntry (sieve/protocol/document_frames.go:328):
    // one ENTRY-ARRAY per copied block, each entry {mimeType, content} — the same
    // per-block view set wysiwyg-surface.js's sliceItems builds (lines 539-562).
    // NOT a flat [{kind, content}] list.
    const slice = [
      [{ mimeType: 'sieve/prose', content: 'a' }],
      [{ mimeType: 'sieve/code', content: 'b' }],
    ]
    const pending = documentService.paste('doc-1', { kind: 'slice', slice, anchor: { afterBlockId: 'b3' } })
    expect(sock.sentOfType('paste')[0]).toEqual({
      type: 'paste', kind: 'slice', slice, afterBlockId: 'b3', opId: lastOpId(sock, 'paste'),
    })
    sock.driveMessage({ type: 'paste-ack', opId: lastOpId(sock, 'paste'), outcome: 'block' })
    const res = await pending
    expect(res.outcome).toBe('block')
    expect(res.id).toBeUndefined()
  })

  it('sends kind:smart with the entries and hands the PasteResult union through untouched', async () => {
    const { documentService, sock } = serviceRig({ uuid: 'doc-1' })
    const entries = [{ mimeType: 'text/plain', content: 'https://x.test' }]
    const pending = documentService.paste('doc-1', { kind: 'smart', entries, anchor: { afterBlockId: 'b4' } })
    expect(sock.sentOfType('paste')[0]).toEqual({
      type: 'paste', kind: 'smart', entries, afterBlockId: 'b4', opId: lastOpId(sock, 'paste'),
    })
    sock.driveMessage({
      type: 'paste-ack', opId: lastOpId(sock, 'paste'),
      outcome: 'content', html: '<a href="https://x.test">X</a>',
    })
    const res = await pending
    expect(res.outcome).toBe('content')
    expect(res.html).toBe('<a href="https://x.test">X</a>')
  })

  // A kind states ONE field beside its discriminant, or none: an empty key is a
  // payload the server would try to read.
  /** @type {Array<[string, any, Record<string, any>]>} */
  const bodies = [
    ['native-drop carries the page\'s readable text as a HINT', 'native-drop', { entries: [{ mimeType: 'text/uri-list', content: 'file:///x' }] }],
    ['native-clipboard carries NOTHING — the emptiness is the signal', 'native-clipboard', {}],
  ]

  for (const [name, kind, body] of bodies) {
    it(name, () => {
      const { documentService, sock } = serviceRig({ uuid: 'doc-1' })
      documentService.paste('doc-1', Object.assign({ kind: kind, entries: body.entries || [] }))
      expect(sock.sentOfType('paste')[0]).toEqual(
        Object.assign({ type: 'paste', kind: kind, opId: lastOpId(sock, 'paste') }, body))
    })
  }

  // Go's paste path is SYNCHRONOUS and smart-image acquire downloads with an 8s
  // HTTP timeout (smart_image_processor.go:436-438) — a slow image paste's ack
  // can legitimately land after the wire's DEFAULT 5s ceiling. Both paste verbs
  // raise it to PASTE_ACK_TIMEOUT_MS (12s) so that ack is not dropped on the
  // floor: an ack arriving after the default would have fired would leave
  // #applyPasteResult never run and the insert anchor never consumed/cleared.
  it('outlives the default 5s ceiling — an ack at 8s still lands', async () => {
    vi.useFakeTimers()
    try {
      const { documentService, sock } = serviceRig({ uuid: 'doc-1' })
      const pending = documentService.paste('doc-1', { kind: 'smart', entries: [] })
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

  it('rejects only past the RAISED 12s ceiling, not the wire default', async () => {
    vi.useFakeTimers()
    try {
      const { documentService } = serviceRig({ uuid: 'doc-1' })
      const pending = documentService.paste('doc-1', { kind: 'slice', slice: [] })
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

describe('DocumentService.persist — fire-and-forget persistence (the save is a workspace fact)', () => {
  beforeEach(() => FakeSocket.reset())

  it('sends the frozen flush envelope, correlates nothing, and returns nothing', () => {
    const { documentService, sock } = serviceRig({ uuid: 'doc-1' })
    expect(documentService.persist('doc-1')).toBeUndefined()
    // No opId: the contract has no reply for this frame to be correlated to.
    expect(sock.sentOfType('flush')).toEqual([{ type: 'flush', uuid: 'doc-1' }])
  })

  it('a channel-less uuid drops it, like every other fire-and-forget verb', () => {
    const { documentService } = serviceRig({ uuid: null })
    expect(() => documentService.persist('nobody')).not.toThrow()
  })
})

// ── Membership + raw-content frames, as they leave ────────────────────────────

describe('DocumentService membership verbs — the block-op envelope (FROZEN)', () => {
  beforeEach(() => FakeSocket.reset())

  // Every membership verb rides ONE envelope, and the structured edits a NodeView
  // makes converge on the same `update-block` op prose edits ride: one wire op for
  // every block update, whatever drew it.
  it('envelopes create + update + delete, in order, each naming the document', () => {
    const { documentService, sock } = serviceRig({ uuid: 'doc-1' })
    documentService.createBlock('doc-1', 'prose', { content: 'hi' }, { afterBlockId: 'b1' })
    documentService.updateBlock('doc-1', 'co-1', 'code', { source: 'x = 1' })
    documentService.deleteBlock('doc-1', 'b9')
    expect(sock.sentOfType('block-op')).toEqual([
      { type: 'block-op', uuid: 'doc-1', opId: OPID, op: { type: 'create-block', blockId: '', kind: 'prose', attrs: { content: 'hi' }, afterBlockId: 'b1' } },
      { type: 'block-op', uuid: 'doc-1', opId: OPID, op: { type: 'update-block', blockId: 'co-1', kind: 'code', attrs: { source: 'x = 1' } } },
      { type: 'block-op', uuid: 'doc-1', opId: OPID, op: { type: 'delete-block', blockId: 'b9' } },
    ])
  })

  it('defaults a patchless update to an empty attrs bag, never a missing key', () => {
    const { documentService, sock } = serviceRig({ uuid: 'doc-1' })
    documentService.updateBlock('doc-1', 'co-2', 'code', /** @type {any} */ (undefined))
    expect(sock.sentOfType('block-op')[0].op.attrs).toEqual({})
  })

  it('carries the id its CREATOR gave the block, and lifts aliases top-level', () => {
    // A block born in a lens names itself (issue #96): the name rides in `attrs.id`
    // as ordinary block data, the op lifts it onto `blockId` because that is where
    // the wire keeps a block's name, and Go validates and adopts it.
    const { documentService, sock } = serviceRig({ uuid: 'doc-1' })
    const born = '0191f0c2-2b4e-7a10-9c33-4d5e6f708192'
    documentService.createBlock('doc-1', 'prose', { content: 'x', id: born }, { atFront: true }, { aliases: ['old-1'] })
    expect(sock.sentOfType('block-op')[0].op).toEqual({
      type: 'create-block', blockId: born,
      kind: 'prose', attrs: { content: 'x', id: born }, aliases: ['old-1'], atFront: true,
    })
  })

  // A create with no anchor states no position at all: an absent key is how the
  // wire says "append", and a 0 or -1 would be a position this client cannot know.
  it('sends no position key when no anchor is named', () => {
    const { documentService, sock } = serviceRig({ uuid: 'doc-1' })
    documentService.createBlock('doc-1', 'prose', { content: 'hi' })
    expect(sock.sentOfType('block-op')[0].op).toEqual({
      type: 'create-block', blockId: '', kind: 'prose', attrs: { content: 'hi' },
    })
  })

  it('states a COMPLETE order for set-order', () => {
    const { documentService, sock } = serviceRig({ uuid: 'doc-1' })
    documentService.setBlockOrder('doc-1', ['b2', 'b1'])
    expect(sock.sentOfType('block-op')[0].op).toEqual({ type: 'set-order', order: ['b2', 'b1'] })
  })

  it('flushContents envelopes the whole buffer as doc-update with the uuid', () => {
    const { documentService, sock } = serviceRig({ uuid: 'doc-1' })
    documentService.flushContents('doc-1', '# body')
    expect(sock.sentOfType('doc-update')).toEqual([{ type: 'doc-update', uuid: 'doc-1', markdown: '# body' }])
  })

  it('exportAs asks the server for the clean projection', async () => {
    const { documentService, sock } = serviceRig({ uuid: 'doc-1' })
    const pending = documentService.exportAs('doc-1', 'markdown')
    expect(sock.sentOfType('export')[0]).toEqual({ type: 'export', format: 'markdown', opId: lastOpId(sock, 'export') })
    sock.driveMessage({ type: 'export-content', opId: lastOpId(sock, 'export'), content: '# clean' })
    await expect(pending).resolves.toBe('# clean')
  })

  // A channel-less container has nothing to filter, so its raw projection IS the
  // export — and the projection of a prompt is its load answer, over HTTP.
  it('exportAs answers a channel-less container with its own raw projection', async () => {
    const prevFetch = global.fetch
    global.fetch = /** @type {any} */ (vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ body: '# prompt' }) })))
    try {
      const { documentService } = serviceRig({ uuid: null })
      await expect(documentService.exportAs('prompt:x', 'markdown')).resolves.toBe('# prompt')
    } finally { global.fetch = prevFetch }
  })

  it('falls back to HTTP for a CHANNEL-LESS load — the prompt pseudo-document', async () => {
    const prevFetch = global.fetch
    const fetchMock = vi.fn(() => Promise.resolve({ json: () => Promise.resolve({ body: 'p', mode: 'markdown', blocks: [] }) }))
    global.fetch = /** @type {any} */ (fetchMock)
    try {
      const { documentService, sock } = serviceRig({ uuid: 'doc-1' })
      const data = await documentService.load('prompt:x')
      expect(fetchMock).toHaveBeenCalledWith('/api/document/load?uuid=' + encodeURIComponent('prompt:x'))
      expect(data.body).toBe('p')
      expect(data.meta.mode).toBe('markdown')
      // An open sibling channel must never answer another document's load.
      expect(sock.sentTypes()).toEqual([])
    } finally { global.fetch = prevFetch }
  })
})

// ── The channel itself: queue, correlation, liveness ──────────────────────────

const OPID = expect.stringMatching(/^op-\d+$/)

describe('BlockChannel lifecycle — one socket per open container', () => {
  beforeEach(() => FakeSocket.reset())
  afterEach(() => vi.useRealTimers())

  it('dials the document channel URL for the uuid it was opened on', () => {
    const { sock } = serviceRig({ uuid: 'doc-1' })
    expect(sock.url).toContain('/api/ws/document/doc-1')
  })

  it('queues sends made before OPEN and flushes them when it opens', () => {
    const { documentService, sock } = serviceRig({ uuid: 'doc-1', open: false })
    documentService.createBlock('doc-1', 'code', {})
    expect(sock.sent).toEqual([])
    sock.driveOpen()
    expect(sock.sentTypes()).toEqual(['block-op'])
  })

  it('closeChannel closes the socket and suppresses the reconnect', () => {
    vi.useFakeTimers()
    const { service, sock } = serviceRig({ uuid: 'doc-1' })
    service.closeChannel('doc-1')
    expect(sock.closed).toBe(true)
    vi.advanceTimersByTime(60000)
    expect(FakeSocket.instances.length).toBe(1) // no reconnect socket created
  })

  it('arms exponential-backoff reconnect on an unexpected close', () => {
    vi.useFakeTimers()
    const { sock } = serviceRig({ uuid: 'doc-1' })
    sock.close() // server-initiated → onclose arms the reconnect
    expect(FakeSocket.instances.length).toBe(1)
    vi.advanceTimersByTime(1000) // first backoff = 1000ms
    expect(FakeSocket.instances.length).toBe(2)
  })

  it('the watchdog closes a socket that has not ponged inside 45s', () => {
    vi.useFakeTimers()
    const { sock } = serviceRig({ uuid: 'doc-1' })
    vi.advanceTimersByTime(61000)
    expect(sock.closed).toBe(true)
  })

  it('a pong resets the watchdog clock', () => {
    vi.useFakeTimers()
    const { sock } = serviceRig({ uuid: 'doc-1' })
    vi.advanceTimersByTime(30000)
    sock.driveMessage({ type: 'pong' })
    vi.advanceTimersByTime(30000) // 60s total, but only 30s since the pong
    expect(sock.closed).toBe(false)
  })
})

describe('opId correlation — the transport\'s own plumbing, below the wall', () => {
  beforeEach(() => FakeSocket.reset())
  afterEach(() => vi.useRealTimers())

  it('an ack echoing the minted opId resolves the verb {ok:true}', async () => {
    const { documentService, sock } = serviceRig({ uuid: 'doc-1' })
    const pending = documentService.deleteBlock('doc-1', 'b1')
    const opId = lastOpId(sock, 'block-op')
    expect(opId).toMatch(/^op-\d+$/)
    sock.driveMessage({ type: 'block-op-ack', opId: opId, ok: true })
    await expect(pending).resolves.toEqual({ ok: true })
  })

  it('an ok:false ack carries the error through the RESOLVED result', async () => {
    const { documentService, sock } = serviceRig({ uuid: 'doc-1' })
    const pending = documentService.deleteBlock('doc-1', 'b1')
    sock.driveMessage({ type: 'block-op-ack', opId: lastOpId(sock, 'block-op'), ok: false, error: 'boom' })
    await expect(pending).resolves.toEqual({ ok: false, error: 'boom' })
  })

  it('an ack TIMEOUT resolves {ok:false} — never an unhandled rejection', async () => {
    vi.useFakeTimers()
    const { documentService, sock } = serviceRig({ uuid: 'doc-1' })
    const pending = documentService.deleteBlock('doc-1', 'b1')
    const opId = lastOpId(sock, 'block-op')
    await vi.advanceTimersByTimeAsync(5000)
    const res = await pending
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/ws timeout/)
    // A LATE ack finds no awaiter and is dropped: no throw, no double-settle.
    expect(() => sock.driveMessage({ type: 'block-op-ack', opId: opId, ok: true })).not.toThrow()
  })

  it('a channel-less verb resolves {ok:false} WITHOUT sending, and never rejects', async () => {
    const { documentService } = serviceRig({ uuid: null })
    const res = await documentService.deleteBlock('ghost-doc', 'b1')
    expect(res.ok).toBe(false)
  })

  it('a HANDSHAKE timeout still REJECTS — the mode flip\'s stay-on-failure depends on it', async () => {
    vi.useFakeTimers()
    const { documentService } = serviceRig({ uuid: 'doc-1' })
    const pending = documentService.getContents('doc-1')
    const assertion = expect(pending).rejects.toThrow('ws timeout: enter-markdown')
    await vi.advanceTimersByTimeAsync(5000)
    await assertion
  })

  // THE motivating case: reply-TYPE keying could not tell two in-flight same-type
  // handshakes apart. opId keying resolves each to ITS OWN reply, in any order.
  it('two concurrent same-type handshakes on ONE channel resolve to their own opIds', async () => {
    const { documentService, sock } = serviceRig({ uuid: 'doc-1' })
    const first = documentService.load('doc-1')
    const second = documentService.load('doc-1')
    const sent = sock.sentOfType('load')
    expect(sent).toHaveLength(2)
    expect(sent[0].opId).not.toBe(sent[1].opId)
    // Reply to the SECOND request first: correlation is by opId, not arrival order.
    sock.driveMessage({ type: 'load-content', opId: sent[1].opId, body: 'second' })
    sock.driveMessage({ type: 'load-content', opId: sent[0].opId, body: 'first' })
    expect((await first).body).toBe('first')
    expect((await second).body).toBe('second')
  })

  it('a reply an awaiter consumed never reaches the channel delegate', async () => {
    const delegate = fakeDelegate()
    const { documentService, sock } = serviceRig({ uuid: 'doc-1', delegate })
    const pending = documentService.getContents('doc-1')
    sock.driveMessage({ type: 'markdown-content', opId: lastOpId(sock, 'enter-markdown'), markdown: '# hi' })
    expect(await pending).toBe('# hi')
    // What the transport does not settle — and no follower claims — is all the
    // delegate is left with.
    sock.driveMessage({ type: 'error', message: 'boom' })
    expect(delegate.onMessage).toHaveBeenCalledTimes(1)
    expect(delegate.onMessage).toHaveBeenCalledWith({ type: 'error', message: 'boom' })
  })
})
