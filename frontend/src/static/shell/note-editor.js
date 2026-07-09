// @ts-check
// note-editor.js — the editor type for regular notes (P2.A).
// NoteEditor owns the WebSocket channel to the Go EditorService: open, reconnect
// (exponential backoff), ping/pong watchdog, the pre-open pending-send queue, and
// the wsSendAndAwait request/ack primitive. It also owns the WS save path
// (doc-update + flush/flush-ack) and the dirty-clear on flush-ack. Downstream
// render-back messages (insert-block etc.) are handed to an injected onServerMessage
// callback so DOM routing stays in editor.js this task (P2.B replaces it).
//
// The WS protocol and reconnect policy are FROZEN — this is faithful code motion
// of editor.js's openEditorWs/closeEditorWs/wsSend/wsSendAndAwait/flushSave.
// Dual-use ES module: `export` for vitest imports; the class is reached in the app
// via the SieveTab.createEditor factory.

import { AbstractEditor } from './abstract-editor.js'

// WebSocket.readyState OPEN, fixed at 1 by the WHATWG spec. Referenced directly so
// the class does not depend on a global `WebSocket` (absent in the test env; the
// live socket is injected via socketFactory).
const WS_OPEN = 1

/**
 * @typedef {object} NoteEditorOptions
 * @property {(url: string) => WebSocket} [socketFactory] — injected for tests; defaults to `new WebSocket(url)`
 * @property {() => string}               [wsUrl]         — injected for tests; defaults to the /api/ws URL for this uuid
 * @property {(msg: object) => void}      [onServerMessage] — DOM routing for render-back messages (editor.js owns it this task)
 */

export class NoteEditor extends AbstractEditor {
  /** @type {WebSocket|null} */
  #ws = null

  /** @type {string[]} JSON strings queued before the socket is OPEN */
  #pending = []

  /** @type {Record<string, {resolve: (m: object) => void, reject: (e: Error) => void}>} ack type → awaiter */
  #awaiters = {}

  /** @type {ReturnType<typeof setTimeout>|null} */
  #reconnectTimer = null

  /** @type {ReturnType<typeof setInterval>|null} */
  #pingInterval = null

  /** @type {number} exponential-backoff delay, doubles per attempt, cap 30s */
  #reconnectDelay = 1000

  /** @type {number} */
  #lastPong = Date.now()

  /** @type {(url: string) => WebSocket} */
  #socketFactory

  /** @type {() => string} */
  #wsUrl

  /** @type {(msg: object) => void} */
  #onServerMessage

  /**
   * Opens the WebSocket immediately (faithful to editor.js: openEditorWs runs at
   * the end of initEditor for every non-prompt uuid).
   * @param {string}           uuid
   * @param {import('./abstract-editor.js').EditorAccessors} accessors
   * @param {NoteEditorOptions} [options]
   */
  constructor(uuid, accessors, options = {}) {
    super(uuid, accessors)
    this.#socketFactory = options.socketFactory || ((url) => new WebSocket(url))
    this.#wsUrl = options.wsUrl || (() => NoteEditor.#defaultUrl(uuid))
    this.#onServerMessage = options.onServerMessage || (() => {})
    this.#open()
  }

  /** @param {string} uuid @returns {string} */
  static #defaultUrl(uuid) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    let host = location.host
    if (window.__sieveDevServerPort) host = '127.0.0.1:' + window.__sieveDevServerPort
    return proto + '//' + host + '/api/ws?uuid=' + encodeURIComponent(uuid)
  }

  // ── WebSocket lifecycle ────────────────────────────────────────────────────────

  #open() {
    // Faithful to openEditorWs: start by tearing down any prior socket + timers
    // and clearing the queues, then connect fresh.
    this.#closeSocket()

    const ws = this.#socketFactory(this.#wsUrl())
    this.#ws = ws

    ws.onopen = () => {
      console.log('[editor] ws connected')
      this.#reconnectDelay = 1000
      this.#lastPong = Date.now()

      this.#pending.forEach((m) => ws.send(m))
      this.#pending = []

      if (this.#pingInterval) clearInterval(this.#pingInterval)
      this.#pingInterval = setInterval(() => {
        if (Date.now() - this.#lastPong > 45000) {
          console.warn('[editor] ws: watchdog timeout, forcing reconnect')
          if (this.#ws) this.#ws.close()
          return
        }
        if (this.#ws && this.#ws.readyState === WS_OPEN) {
          this.#ws.send(JSON.stringify({ type: 'ping' }))
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

  /**
   * Closes the socket and cancels timers WITHOUT arming a reconnect (nulls onclose
   * first, exactly like closeEditorWs). Clears the pending + awaiter queues.
   */
  #closeSocket() {
    if (this.#reconnectTimer) { clearTimeout(this.#reconnectTimer); this.#reconnectTimer = null }
    if (this.#pingInterval) { clearInterval(this.#pingInterval); this.#pingInterval = null }
    if (this.#ws) {
      this.#ws.onclose = null
      this.#ws.close()
      this.#ws = null
    }
    this.#pending = []
    this.#awaiters = {}
  }

  /** @param {{data?: string}} event */
  #handleMessage(event) {
    const msg = JSON.parse(event.data || '{}')
    if (msg.type === 'pong') {
      this.#lastPong = Date.now()
      return
    }

    const awaiter = this.#awaiters[msg.type]
    if (awaiter) {
      delete this.#awaiters[msg.type]
      awaiter.resolve(msg)
    }
    if (msg.type === 'flush-ack') {
      this.clearDirty()
      document.dispatchEvent(new CustomEvent('sieve:meta-dirty', { detail: { dirty: false } }))
      document.dispatchEvent(new CustomEvent('editor:saved', { detail: { uuid: msg.uuid } }))
    }
    // Render-backs (error / markdown-content / wysiwyg-content / insert-block /
    // block-attrs-updated / replace-block / block-extracted) are routed by editor.js.
    this.#onServerMessage(msg)
  }

  // ── Transport primitives ────────────────────────────────────────────────────────

  /** @param {object} msg */
  wsSend(msg) {
    const data = JSON.stringify(msg)
    if (this.#ws && this.#ws.readyState === WS_OPEN) {
      this.#ws.send(data)
    } else {
      this.#pending.push(data)
    }
  }

  /**
   * Sends a message and resolves with the matching `<type>-ack` reply, or rejects
   * after 5s.
   * @param {string} type
   * @param {object} msg
   * @returns {Promise<object>}
   */
  wsSendAndAwait(type, msg) {
    return new Promise((resolve, reject) => {
      const ackType = type + '-ack'
      const timer = setTimeout(() => {
        delete this.#awaiters[ackType]
        reject(new Error('ws timeout: ' + type))
      }, 5000)
      this.#awaiters[ackType] = {
        resolve: (m) => { clearTimeout(timer); resolve(m) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      }
      this.wsSend(msg)
    })
  }

  // ── Save ────────────────────────────────────────────────────────────────────────

  /** @returns {Promise<unknown>} */
  flushSave() {
    // Flush any pending debounced edit immediately so Go has the latest content,
    // then await the flush-ack. WYSIWYG goes through the block-sync flush;
    // markdown sends its raw textarea body directly.
    if (this.mode === 'markdown') {
      const take = this._accessors.takePendingMarkdown
      const pending = take ? take() : null
      if (pending !== null) {
        this.wsSend({ type: 'doc-update', uuid: this.uuid, markdown: pending })
      }
    } else {
      const getFlush = this._accessors.getDocSyncFlush
      const flush = getFlush ? getFlush() : null
      if (flush) flush()
    }
    return this.wsSendAndAwait('flush', { type: 'flush', uuid: this.uuid })
      .catch((err) => { console.warn('[editor] flush timeout, continuing:', err) })
  }

  destroy() { this.#closeSocket() }
}
