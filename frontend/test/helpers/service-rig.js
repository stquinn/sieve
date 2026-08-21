// @ts-check
// service-rig.js — shared test rig for the wire-owning service pair (issue #49
// Phase 1). Builds a REAL BlockService (and optionally DocumentService) over a
// FakeSocket factory, so tests drive verbs and assert the FROZEN wire frames
// exactly as they leave. Never touches a real socket.

import { vi } from 'vitest'
import { BlockService } from '../../src/static/block/block-service.js'
import { DocumentService } from '../../src/static/block/document-service.js'

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

/** A recording channel delegate (every editor-side reaction is a spy). */
export function fakeDelegate(overrides = {}) {
  return Object.assign({
    applyServerOp: vi.fn(),
    onMessage: vi.fn(),
    resolveInsertIndex: vi.fn(() => -1),
  }, overrides)
}

/**
 * A REAL BlockService + DocumentService over FakeSockets. Optionally opens a
 * channel for `uuid` (with a recording delegate) and seeds the routing index
 * with `blocks` ([{id, kind}]). The channel's socket is driven OPEN so frames
 * leave immediately (call with {open: false} to test the pending queue).
 *
 * @param {{uuid?: string, blocks?: Array<{id: string, kind: string}>, delegate?: object, open?: boolean}} [opts]
 */
export function serviceRig(opts = {}) {
  const uuid = opts.uuid === undefined ? 'doc-1' : opts.uuid
  const service = new BlockService({
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
    if (opts.blocks) service.indexDocument(uuid, opts.blocks)
  }
  return { service, documentService, delegate, sock, uuid }
}
