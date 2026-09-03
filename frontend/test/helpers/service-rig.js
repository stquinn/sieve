// @ts-check
// service-rig.js — shared test rig for the wire-owning transport. Builds a REAL
// ContainerTransport (and optionally DocumentService) over a FakeSocket factory, so
// tests drive verbs and assert the FROZEN wire frames exactly as they leave.
// Never touches a real socket.
//
// `providerRig` builds the WHOLE host stack over that same socket — follower
// model, service, provider — so a test can hold the thing a lens is handed and
// still assert the frames its verbs produce.

import { vi } from 'vitest'
import { ContainerTransport } from '../../src/static/container/container-transport.js'
import { DocumentService } from '../../src/static/container/document-service.js'
import { ContainerModel } from '../../src/static/container/container-model.js'
import { BlockProviderAdapter } from '../../src/static/container/block-provider-adapter.js'

/** A fake WebSocket that records sends and lets tests drive open/message/close. */
export class FakeSocket {
  /** @type {FakeSocket[]} */
  static instances = []
  static reset() { FakeSocket.instances = [] }

  /** @param {string} url */
  constructor(url) {
    this.url = url
    this.readyState = 0 // CONNECTING
    /** @type {string[]} */
    this.sent = []
    this.closed = false
    this.onopen = null
    this.onmessage = null
    this.onclose = null
    this.onerror = null
    FakeSocket.instances.push(this)
  }

  /** @param {string} data */
  send(data) { this.sent.push(data) }

  close() {
    this.closed = true
    this.readyState = 3 // CLOSED
    if (this.onclose) this.onclose()
  }

  // ── test drivers ──
  driveOpen() { this.readyState = 1; if (this.onopen) this.onopen() }
  /** @param {object} obj */
  driveMessage(obj) { if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }) }
  sentTypes() { return this.sent.map((s) => JSON.parse(s).type) }
  /** @param {string} t */
  sentOfType(t) { return this.sent.map((s) => JSON.parse(s)).filter((m) => m.type === t) }
}

/**
 * A recording DocumentService: every wire verb is a spy and every ack resolves ok,
 * for a test holding the provider over it rather than the frames underneath.
 * @param {Record<string, any>} [overrides]
 */
export function stubDocumentService(overrides = {}) {
  return Object.assign({
    createBlock: vi.fn(() => Promise.resolve({ ok: true })),
    updateBlock: vi.fn(() => Promise.resolve({ ok: true })),
    deleteBlock: vi.fn(() => Promise.resolve({ ok: true })),
    setBlockOrder: vi.fn(() => Promise.resolve({ ok: true })),
    extract: vi.fn(() => Promise.resolve({ ok: true })),
    retry: vi.fn(),
    persist: vi.fn(),
    paste: vi.fn(() => Promise.resolve({ outcome: 'none' })),
    detectExtractions: vi.fn(() => Promise.resolve([])),
    getContents: vi.fn(() => Promise.resolve('# doc')),
    setContents: vi.fn(() => Promise.resolve()),
    flushContents: vi.fn(),
    replaceText: vi.fn(() => Promise.resolve('ok')),
  }, overrides)
}

/** A recording channel delegate (every host-side reaction is a spy). */
export function fakeDelegate(overrides = {}) {
  return Object.assign({ onMessage: vi.fn() }, overrides)
}

/**
 * A REAL ContainerTransport + DocumentService over FakeSockets. Optionally opens a
 * channel for `uuid` (with a recording delegate) and seeds the routing index
 * with `blocks` ([{id, kind}]). The channel's socket is driven OPEN so frames
 * leave immediately (call with {open: false} to test the pending queue).
 *
 * @param {{uuid?: string, blocks?: Array<{id: string, kind: string}>, delegate?: object, open?: boolean}} [opts]
 */
export function serviceRig(opts = {}) {
  const uuid = opts.uuid === undefined ? 'doc-1' : opts.uuid
  const service = new ContainerTransport({
    socketFactory: (url) => new FakeSocket(url),
    wsUrlFor: (u) => 'ws://test/api/ws/document/' + u,
  })
  const documentService = new DocumentService(service)
  const delegate = opts.delegate || fakeDelegate()
  let sock = null
  if (uuid) {
    service.openChannel(uuid, /** @type {any} */ (delegate))
    sock = FakeSocket.instances[FakeSocket.instances.length - 1]
    if (opts.open !== false) sock.driveOpen()
  }
  return { service, documentService, delegate, sock, uuid }
}

/**
 * The whole HOST stack for one container over a FakeSocket: a real transport, a
 * real follower model seeded with `blocks`, and the provider a lens would be
 * handed. Verbs asserted through `provider` still produce real frames on `sock`.
 *
 * @param {{uuid?: string, blocks?: Array<{id: string, kind: string, attrs?: Record<string, any>}>, open?: boolean}} [opts]
 */
export function providerRig(opts = {}) {
  const uuid = opts.uuid === undefined ? 'doc-1' : opts.uuid
  const rig = serviceRig({ uuid: uuid, open: opts.open })
  const model = new ContainerModel(uuid, 'note')
  rig.documentService.observeFrames(uuid, (frame) => model.applyFrame(frame))
  rig.documentService.onContent(uuid, (content) => model.applyLoad(/** @type {any} */ (content)))
  if (opts.blocks) {
    model.applyLoad({
      uuid: uuid,
      blocks: opts.blocks.map((b) => ({ id: b.id, kind: b.kind, attrs: b.attrs || {} })),
    })
  }
  const provider = new BlockProviderAdapter(model, rig.documentService)
  return Object.assign({}, rig, { model, provider })
}
