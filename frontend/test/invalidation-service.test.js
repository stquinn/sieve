// @ts-check
// invalidation-service.test.js — the workspace channel's push tenant: every
// server-INITIATED frame becomes a page-global DOM event, and a (re)connect
// declares every topic stale.
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { WorkspaceService } from '../src/static/block/workspace-service.js'
import { InvalidationService } from '../src/static/block/invalidation-service.js'
import { ContractViolation } from '../src/static/block/sieve-block.js'

/** Every topic the contract names, in the order the resync fires them. */
const TOPICS = ['notes', 'session', 'prompts', 'library', 'intent']

class FakeWebSocket {
  /** @type {any} */ onopen = null
  /** @type {any} */ onmessage = null
  /** @type {any} */ onclose = null
  /** @type {any} */ onerror = null
  readyState = 1 // OPEN
  sent = []
  closed = false

  constructor(url) { this.url = url }

  send(data) { this.sent.push(JSON.parse(data)) }
  close() { this.closed = true; if (this.onclose) this.onclose() }
  /** Drives the socket to OPEN — the plane's connect fan-out rides this. */
  driveOpen() { if (this.onopen) this.onopen() }
  receive(msg) { if (this.onmessage) this.onmessage({ data: JSON.stringify(msg) }) }
}

describe('InvalidationService — the push tenant', () => {
  /** @type {FakeWebSocket[]} */ let sockets
  /** @type {WorkspaceService} */ let workspace
  /** @type {EventTarget} */ let target
  /** @type {Array<{name: string, detail: any}>} */ let seen

  beforeEach(() => {
    sockets = []
    workspace = new WorkspaceService({
      socketFactory: (url) => {
        const ws = new FakeWebSocket(url)
        sockets.push(ws)
        return /** @type {any} */ (ws)
      },
      wsUrl: () => 'ws://test/api/ws/workspace',
    })
    target = new EventTarget()
    seen = []
    // One listener per published name, so the assertions read the real contract
    // (a name htmx could subscribe to) rather than a wildcard nothing offers.
    for (const topic of TOPICS) {
      target.addEventListener('sieve:invalidate-' + topic,
        () => seen.push({ name: 'sieve:invalidate-' + topic, detail: null }))
    }
    target.addEventListener('sieve:jobs-changed',
      (e) => seen.push({ name: 'sieve:jobs-changed', detail: /** @type {CustomEvent} */ (e).detail }))
    target.addEventListener('sieve:container-deleted',
      (e) => seen.push({ name: 'sieve:container-deleted', detail: /** @type {CustomEvent} */ (e).detail }))
    target.addEventListener('sieve:container-saved',
      (e) => seen.push({ name: 'sieve:container-saved', detail: /** @type {CustomEvent} */ (e).detail }))
  })

  /** @returns {InvalidationService} a tenant published onto the recording target */
  const tenant = () => new InvalidationService(workspace, { target })

  it('refuses a construction without a WorkspaceService', () => {
    expect(() => new InvalidationService(/** @type {any} */ (null))).toThrow(ContractViolation)
    expect(() => new InvalidationService(/** @type {any} */ ({}))).toThrow(ContractViolation)
  })

  it('claims the four server-initiated words, and nothing else', () => {
    const t = tenant()
    expect(t.frameTypes).toEqual(['invalidate', 'jobs-changed', 'container-deleted', 'container-saved'])
    // The claim is exclusive: a second tenant on either word is refused.
    expect(() => workspace.registerTenant({ frameTypes: ['invalidate'], onFrame: () => {} }))
      .toThrow(ContractViolation)
  })

  it('re-dispatches an invalidate frame as sieve:invalidate-{topic}', () => {
    tenant()
    workspace.open()
    sockets[0].receive({ type: 'invalidate', topic: 'notes' })
    sockets[0].receive({ type: 'invalidate', topic: 'prompts' })
    expect(seen.map((e) => e.name)).toEqual(['sieve:invalidate-notes', 'sieve:invalidate-prompts'])
  })

  it('re-dispatches jobs-changed with the snapshot as its detail', () => {
    tenant()
    workspace.open()
    const active = [{ id: 'j1', label: '/file' }]
    sockets[0].receive({ type: 'jobs-changed', active, queued: [] })
    expect(seen).toHaveLength(1)
    expect(seen[0].name).toBe('sieve:jobs-changed')
    expect(seen[0].detail).toEqual({ active, queued: [] })
  })

  it('normalises a jobs snapshot with lists missing — a consumer reads a length, never null', () => {
    tenant()
    workspace.open()
    sockets[0].receive({ type: 'jobs-changed' })
    expect(seen[0].detail).toEqual({ active: [], queued: [] })
  })

  it('re-dispatches container-deleted with the uuid as its detail', () => {
    tenant()
    workspace.open()
    sockets[0].receive({ type: 'container-deleted', uuid: 'doc-a' })
    expect(seen).toEqual([{ name: 'sieve:container-deleted', detail: { uuid: 'doc-a' } }])
  })

  it('ignores a container-deleted that names no uuid — there is nothing to reconcile', () => {
    tenant()
    workspace.open()
    expect(() => sockets[0].receive({ type: 'container-deleted' })).not.toThrow()
    expect(seen).toEqual([])
  })

  it('re-dispatches container-saved with the uuid AND the version as its detail', () => {
    tenant()
    workspace.open()
    sockets[0].receive({ type: 'container-saved', uuid: 'doc-a', version: 12 })
    expect(seen).toEqual([{ name: 'sieve:container-saved', detail: { uuid: 'doc-a', version: 12 } }])
  })

  // An unversioned container (a prompt is a plain file) carries no version at
  // all. 0 is the value that tells a listener the fact cannot be ordered, so it
  // must be published rather than left undefined.
  it('publishes version 0 for a container that reports none', () => {
    tenant()
    workspace.open()
    sockets[0].receive({ type: 'container-saved', uuid: 'prompt:ask' })
    expect(seen).toEqual([{ name: 'sieve:container-saved', detail: { uuid: 'prompt:ask', version: 0 } }])
  })

  it('ignores a container-saved that names no uuid — no editor could match it', () => {
    tenant()
    workspace.open()
    expect(() => sockets[0].receive({ type: 'container-saved' })).not.toThrow()
    expect(seen).toEqual([])
  })

  it('declares EVERY topic stale when the socket connects — the blanket resync', () => {
    tenant()
    workspace.open()
    sockets[0].driveOpen()
    expect(seen.map((e) => e.name)).toEqual(TOPICS.map((t) => 'sieve:invalidate-' + t))
  })

  it('resyncs again on every RECONNECT, because that is when it missed the most', () => {
    tenant()
    workspace.open()
    sockets[0].driveOpen()
    seen.length = 0
    // A reconnect is a fresh socket reaching OPEN — the same signal, no first-time flag.
    sockets[0].driveOpen()
    expect(seen.map((e) => e.name)).toEqual(TOPICS.map((t) => 'sieve:invalidate-' + t))
  })

  it('does NOT ask for jobs on connect — the server pushes that snapshot unprompted', () => {
    tenant()
    workspace.open()
    sockets[0].driveOpen()
    expect(sockets[0].sent).toEqual([])
    expect(seen.some((e) => e.name === 'sieve:jobs-changed')).toBe(false)
  })

  it('is told about the connect exactly ONCE, though it claims two frame words', () => {
    const t = tenant()
    const spy = vi.spyOn(t, 'onConnect')
    workspace.open()
    sockets[0].driveOpen()
    expect(spy).toHaveBeenCalledTimes(1)
    spy.mockRestore()
  })

  it('publishes an unknown topic rather than swallowing it (a Go build ahead of this one)', () => {
    tenant()
    workspace.open()
    const heard = []
    target.addEventListener('sieve:invalidate-newthing', () => heard.push('newthing'))
    sockets[0].receive({ type: 'invalidate', topic: 'newthing' })
    expect(heard).toEqual(['newthing'])
  })

  it('ignores an invalidate that names no topic', () => {
    tenant()
    workspace.open()
    expect(() => sockets[0].receive({ type: 'invalidate' })).not.toThrow()
    expect(seen).toEqual([])
  })
})
