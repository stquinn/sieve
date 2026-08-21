// @ts-check
// block-channel.js — BlockChannel: one document's live wire: the socket, its
// pending queue, awaiters, timers and reconnect state.
// Transport contract: null onclose before close in teardown (a deliberate close must
// not schedule a reconnect), pending-queue replay on open, 45s pong watchdog, 15s ping
// interval, 1s→30s exponential backoff, 5s await timeout (per-call override via
// awaitReply/awaitAck's timeoutMs — see document-service.js's paste verbs), awaiter-
// consumed replies with late replies dropped.

import { DocumentFrame } from '../generated/protocol.js'

/**
 * @typedef {object} ChannelDelegate  the per-document inbound router (the live editor)
 * @property {(msg: Record<string, any>) => void} applyServerOp   server render-back ops (insert-block / replace-block / block-attrs-updated)
 * @property {(msg: Record<string, any>) => void} onMessage       everything else (error, unawaited mode replies)
 * @property {(afterBlockId?: string) => number}  resolveInsertIndex  id→index resolution for createBlock (the lens owns index math)
 * @property {() => void} [onOpen]  the socket reached OPEN — fires on the FIRST connect and on every reconnect alike, because a consumer that resyncs cannot tell the two apart and must not try
 */

// WebSocket.readyState OPEN, fixed at 1 by the WHATWG spec. Referenced directly
// so this module does not depend on a global `WebSocket` (absent in the test env).
const WS_OPEN = 1

// Server-op render-backs the active surface applies (backend is the document
// source of truth; the placement semantics live in the surfaces).
const SURFACE_OPS = Object.freeze([DocumentFrame.INSERT_BLOCK, DocumentFrame.REPLACE_BLOCK, DocumentFrame.BLOCK_ATTRS_UPDATED])

export class BlockChannel {
  /** @type {(url: string) => WebSocket} */ #socketFactory
  /** @type {() => string} */ #wsUrl
  /** @type {ChannelDelegate} */ #delegate
  /** @type {(msg: Record<string, any>) => void} routing-index maintenance hook (BlockService) */ #onIndexMsg

  /** @type {WebSocket|null} */ #ws = null
  /** @type {string[]} JSON strings queued before the socket is OPEN */ #pending = []
  /** @type {Map<string, (msg: Record<string, any>) => void>} opId → the reply settler */ #awaiters = new Map()
  /** @type {ReturnType<typeof setTimeout>|null} */ #reconnectTimer = null
  /** @type {ReturnType<typeof setInterval>|null} */ #pingInterval = null
  /** @type {number} exponential-backoff delay, doubles per attempt, cap 30s */ #reconnectDelay = 1000
  /** @type {number} */ #lastPong = Date.now()

  /**
   * @param {(url: string) => WebSocket} socketFactory
   * @param {() => string} wsUrl
   * @param {ChannelDelegate} delegate
   * @param {(msg: Record<string, any>) => void} onIndexMsg
   */
  constructor(socketFactory, wsUrl, delegate, onIndexMsg) {
    this.#socketFactory = socketFactory
    this.#wsUrl = wsUrl
    this.#delegate = delegate
    this.#onIndexMsg = onIndexMsg
    this.#open()
  }

  /** The delegate registered at open (DocumentService reads it for createBlock). */
  get delegate() { return this.#delegate }

  #open() {
    this.close()

    const ws = this.#socketFactory(this.#wsUrl())
    this.#ws = ws

    ws.onopen = () => {
      console.log('[editor] ws connected')
      this.#reconnectDelay = 1000
      this.#lastPong = Date.now()

      this.#pending.forEach((m) => ws.send(m))
      this.#pending = []

      // AFTER the replay: a queued request is older than this connection, so it
      // must not be overtaken by whatever the open hook sends.
      if (this.#delegate.onOpen) this.#delegate.onOpen()

      if (this.#pingInterval) clearInterval(this.#pingInterval)
      this.#pingInterval = setInterval(() => {
        if (Date.now() - this.#lastPong > 45000) {
          console.warn('[editor] ws: watchdog timeout, forcing reconnect')
          if (this.#ws) this.#ws.close()
          return
        }
        if (this.#ws && this.#ws.readyState === WS_OPEN) {
          this.#ws.send(JSON.stringify({ type: DocumentFrame.PING }))
        }
      }, 15000)
    }

    ws.onmessage = (event) => this.#handleMessage(event)

    ws.onclose = () => {
      if (this.#pingInterval) clearInterval(this.#pingInterval)
      console.warn('[editor] ws closed. Reconnecting in ' + this.#reconnectDelay + 'ms...')

      if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer)
      this.#reconnectTimer = setTimeout(() => {
        this.#reconnectDelay = Math.min(this.#reconnectDelay * 2, 30000)
        this.#open()
      }, this.#reconnectDelay)
    }

    ws.onerror = (err) => { console.error('[editor] ws error', err) }
  }

  close() {
    if (this.#reconnectTimer) { clearTimeout(this.#reconnectTimer); this.#reconnectTimer = null }
    if (this.#pingInterval) { clearInterval(this.#pingInterval); this.#pingInterval = null }
    if (this.#ws) {
      this.#ws.onclose = null
      this.#ws.close()
      this.#ws = null
    }
    this.#pending = []
    this.#awaiters.clear()
  }

  /** @param {{data?: string}} event */
  #handleMessage(event) {
    const msg = JSON.parse(event.data || '{}')
    if (msg.type === DocumentFrame.PONG) {
      this.#lastPong = Date.now()
      return
    }
    if (msg.opId !== undefined) {
      const settle = this.#awaiters.get(msg.opId)
      if (settle) {
        this.#awaiters.delete(msg.opId)
        settle(msg)
      }
      return
    }

    if (SURFACE_OPS.indexOf(msg.type) >= 0) {
      this.#onIndexMsg(msg)
      this.#delegate.applyServerOp(msg)
      return
    }

    this.#delegate.onMessage(msg)
  }

  send(msg) {
    const data = JSON.stringify(msg)
    if (this.#ws && this.#ws.readyState === WS_OPEN) {
      this.#ws.send(data)
    } else {
      this.#pending.push(data)
    }
  }

  /**
   * @param {string} opId @param {Record<string, any>} msg @param {string} [label]
   * @param {number} [timeoutMs] per-call ceiling; defaults to the standard 5s.
   *   A caller whose server-side counterpart can legitimately run past 5s (e.g.
   *   document-service's paste verbs — Go's paste path downloads images
   *   synchronously) must raise this, or the ack outlives the awaiter.
   */
  awaitReply(opId, msg, label, timeoutMs) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#awaiters.delete(opId)
        reject(new Error('ws timeout: ' + (label || opId)))
      }, timeoutMs || 5000)
      this.#awaiters.set(opId, (m) => { clearTimeout(timer); resolve(m) })
      this.send(Object.assign({}, msg, { opId: opId }))
    })
  }

  /**
   * @param {string} opId @param {Record<string, any>} msg @param {string} [label]
   * @param {number} [timeoutMs] per-call ceiling; defaults to the standard 5s (see awaitReply).
   */
  awaitAck(opId, msg, label, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#awaiters.delete(opId)
        resolve({ ok: false, error: 'ws timeout: ' + (label || opId) })
      }, timeoutMs || 5000)
      this.#awaiters.set(opId, (m) => { clearTimeout(timer); resolve({ ok: m.ok === true, error: m.error }) })
      this.send(Object.assign({}, msg, { opId: opId }))
    })
  }
}
