// @ts-check
// mention-service.test.js — the `@`-picker's protocol peer (#74 P4).
//
// MentionService is the SECOND tenant of the session channel and the first
// non-command one: it claims `mention-result` and speaks `mention-query`. It is
// the ONLY place the picker's typeahead touches the wire (#49 — surfaces and
// providers stay transport-blind).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { MentionService } from '../src/static/block/mention-service.js'
import { CommandService } from '../src/static/block/command-service.js'
import { WorkspaceService } from '../src/static/block/workspace-service.js'
import { ContractViolation } from '../src/static/block/sieve-block.js'

class FakeWebSocket {
  /** @type {any} */ onopen = null
  /** @type {any} */ onmessage = null
  /** @type {any} */ onclose = null
  /** @type {any} */ onerror = null
  readyState = 1
  sent = []
  closed = false

  constructor(url) {
    this.url = url
    setTimeout(() => { if (this.onopen) this.onopen() }, 0)
  }

  send(data) { this.sent.push(JSON.parse(data)) }
  close() { this.closed = true; if (this.onclose) this.onclose() }
  receive(msg) { if (this.onmessage) this.onmessage({ data: JSON.stringify(msg) }) }
}

describe('MentionService — the mention tenant of the session plane', () => {
  /** @type {FakeWebSocket[]} */ let sockets
  /** @type {WorkspaceService} */ let plane

  beforeEach(() => {
    sockets = []
    plane = new WorkspaceService({
      socketFactory: (url) => {
        const ws = new FakeWebSocket(url)
        sockets.push(ws)
        return /** @type {any} */ (ws)
      },
      wsUrl: () => 'ws://test/api/ws?session=1',
    })
  })

  it('requires a WorkspaceService (the wire is never its own)', () => {
    expect(() => new MentionService(/** @type {any} */ (null))).toThrow(ContractViolation)
    expect(() => new MentionService(/** @type {any} */ ({}))).toThrow(ContractViolation)
  })

  it('claims mention-result and coexists with CommandService on ONE socket', async () => {
    const mentions = new MentionService(plane)
    // The command tenant registers the sibling word; neither registration throws.
    expect(() => new CommandService(plane, { commands: [] })).not.toThrow()
    expect(mentions.frameTypes).toEqual(['mention-result', 'mention-resolved'])

    const answer = mentions.search('auth', 5)
    await new Promise((r) => setTimeout(r, 10))
    expect(sockets.length).toBe(1)

    const frame = sockets[0].sent[0]
    expect(frame.type).toBe('mention-query')
    expect(frame.q).toBe('auth')
    expect(frame.limit).toBe(5)
    expect(typeof frame.correlationId).toBe('string')

    sockets[0].receive({
      type: 'mention-result',
      correlationId: frame.correlationId,
      candidates: [{ uri: 'container:9f2b', title: 'Auth Design', kind: 'note', detail: 'design/ · #auth' }],
    })
    const candidates = await answer
    expect(candidates).toEqual([
      { uri: 'container:9f2b', title: 'Auth Design', kind: 'note', detail: 'design/ · #auth' },
    ])
  })

  it('defaults the limit to 8 (Go floors an absent one; we send the same number)', async () => {
    const mentions = new MentionService(plane)
    mentions.search('a')
    await new Promise((r) => setTimeout(r, 10))
    expect(sockets[0].sent[0].limit).toBe(8)
  })

  it('correlates concurrent queries — a reply resolves only its own promise', async () => {
    const mentions = new MentionService(plane)
    const first = mentions.search('one')
    const second = mentions.search('two')
    await new Promise((r) => setTimeout(r, 10))

    const [f1, f2] = sockets[0].sent
    sockets[0].receive({ type: 'mention-result', correlationId: f2.correlationId, candidates: [{ uri: 'container:2', title: 'Two' }] })
    expect(await second).toEqual([{ uri: 'container:2', title: 'Two' }])

    sockets[0].receive({ type: 'mention-result', correlationId: f1.correlationId, candidates: [{ uri: 'container:1', title: 'One' }] })
    expect(await first).toEqual([{ uri: 'container:1', title: 'One' }])
  })

  it('resolves to an empty list when candidates is missing or not an array', async () => {
    const mentions = new MentionService(plane)
    const answer = mentions.search('nothing')
    await new Promise((r) => setTimeout(r, 10))
    sockets[0].receive({ type: 'mention-result', correlationId: sockets[0].sent[0].correlationId })
    expect(await answer).toEqual([])
  })

  it('drops a reply for an unknown correlation id without throwing', async () => {
    const mentions = new MentionService(plane)
    mentions.search('x')
    await new Promise((r) => setTimeout(r, 10))
    expect(() => sockets[0].receive({ type: 'mention-result', correlationId: 'c-nope', candidates: [] })).not.toThrow()
  })

  it('a typeahead never hangs the picker: an unanswered query settles empty on timeout', async () => {
    vi.useFakeTimers()
    try {
      const mentions = new MentionService(plane, { timeoutMs: 50 })
      const answer = mentions.search('slow')
      vi.advanceTimersByTime(60)
      expect(await answer).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })
})

// ── resolve: the address's OTHER question (#74) ───────────────────────────────
//
// search asks what COULD be mentioned; resolve asks what a mention MEANS. Both
// are faces of Go's ONE Router, so they are faces of its one JS peer — and the
// whole point of the verb is that JS never decodes a coordinate itself. These
// tests therefore assert the uri travels OPAQUELY and the answer arrives
// pre-digested: a uuid to open, a block id to reveal.
describe('MentionService — resolve: what does this coordinate open?', () => {
  /** @type {FakeWebSocket[]} */ let sockets
  /** @type {WorkspaceService} */ let plane

  beforeEach(() => {
    sockets = []
    plane = new WorkspaceService({
      socketFactory: (url) => {
        const ws = new FakeWebSocket(url)
        sockets.push(ws)
        return /** @type {any} */ (ws)
      },
      wsUrl: () => 'ws://test/api/ws?session=1',
    })
  })

  it('claims mention-resolved alongside mention-result — one tenant, one vocabulary', () => {
    const mentions = new MentionService(plane)
    expect(mentions.frameTypes).toEqual(['mention-result', 'mention-resolved'])
  })

  it('sends the address UNPARSED and returns what Go says it opens', async () => {
    const mentions = new MentionService(plane)
    const answer = mentions.resolve('container:9f2b')
    await new Promise((r) => setTimeout(r, 10))

    const frame = sockets[0].sent[0]
    expect(frame.type).toBe('mention-resolve')
    expect(frame.uri).toBe('container:9f2b')      // opaque: never split, never prefix-tested
    expect(typeof frame.correlationId).toBe('string')

    sockets[0].receive({
      type: 'mention-resolved',
      correlationId: frame.correlationId,
      uri: 'container:9f2b',
      found: true, uuid: '9f2b', blockId: '', kind: 'note', title: 'Auth Design',
    })
    expect(await answer).toEqual({
      uri: 'container:9f2b', found: true, uuid: '9f2b', blockId: '',
      kind: 'note', title: 'Auth Design', error: '',
    })
  })

  it('carries the block id through for an address that names one', async () => {
    const mentions = new MentionService(plane)
    const answer = mentions.resolve('block:9f2b/b7')
    await new Promise((r) => setTimeout(r, 10))
    sockets[0].receive({
      type: 'mention-resolved', correlationId: sockets[0].sent[0].correlationId,
      uri: 'block:9f2b/b7', found: true, uuid: '9f2b', blockId: 'b7', kind: 'note', title: 'Auth Design',
    })
    const target = await answer
    expect(target && target.uuid).toBe('9f2b')
    expect(target && target.blockId).toBe('b7')
  })

  it('an unresolvable address resolves to found:false with the reason Go gave', async () => {
    const mentions = new MentionService(plane)
    const answer = mentions.resolve('container:gone')
    await new Promise((r) => setTimeout(r, 10))
    sockets[0].receive({
      type: 'mention-resolved', correlationId: sockets[0].sent[0].correlationId,
      uri: 'container:gone', found: false, error: 'node: address resolves to nothing',
    })
    const target = await answer
    expect(target && target.found).toBe(false)
    expect(target && target.error).toBe('node: address resolves to nothing')
  })

  it('an empty address never reaches the wire', async () => {
    const mentions = new MentionService(plane)
    expect(await mentions.resolve('')).toBe(null)
    expect(sockets.length).toBe(0)
  })

  it('never rejects: an unanswered resolve settles null on timeout', async () => {
    vi.useFakeTimers()
    try {
      const mentions = new MentionService(plane, { timeoutMs: 50 })
      const answer = mentions.resolve('container:slow')
      vi.advanceTimersByTime(60)
      expect(await answer).toBe(null)
    } finally {
      vi.useRealTimers()
    }
  })

  it('correlates against a concurrent search — the verbs share one scheme, not one reply', async () => {
    const mentions = new MentionService(plane)
    const search = mentions.search('auth')
    const resolve = mentions.resolve('container:9f2b')
    await new Promise((r) => setTimeout(r, 10))
    const [q, r] = sockets[0].sent

    sockets[0].receive({ type: 'mention-resolved', correlationId: r.correlationId, uri: 'container:9f2b', found: true, uuid: '9f2b' })
    sockets[0].receive({ type: 'mention-result', correlationId: q.correlationId, candidates: [{ uri: 'container:1', title: 'One' }] })

    expect(await search).toEqual([{ uri: 'container:1', title: 'One' }])
    const target = await resolve
    expect(target && target.uuid).toBe('9f2b')
  })
})
