// @ts-check
// note-editor.js — the editor type for regular notes (P2.A, P2.B).
// NoteEditor owns the WebSocket channel to the Go EditorService: open, reconnect
// (exponential backoff), ping/pong watchdog, the pre-open pending-send queue, and
// the awaited request/reply primitives. Since P2.B it also owns the document's
// input surfaces: server render-back ops (insert-block / replace-block /
// block-attrs-updated) route straight to the active surface via applyServerOp,
// and setMode performs the awaited in-place mode flip — send enter-markdown /
// enter-wysiwyg, await the markdown-content / wysiwyg-content REPLY, and only
// then swap surfaces. On timeout/error NOTHING was torn down: the editor stays
// in its current mode, fully functional (the old one-shot listener dance and
// its torn-down-limbo state are gone). Remaining messages (error, flush-ack
// side-channel) go to the injected onServerMessage for editor.js routing.
//
// The WS protocol (message shapes, reconnect policy) is FROZEN — only the
// reply-consumption point moved (awaiters instead of one-shot document events).
// Dual-use ES module: `export` for vitest imports; the class is reached in the
// app via the SieveTab.createEditor factory.

import { AbstractEditor } from './abstract-editor.js'
// The concrete surfaces are the note editor's private input surfaces; importing
// them here also assigns their window.* handles for the classic-script
// editor.js factory (no index.html change needed).
import './surfaces/wysiwyg-surface.js'
import './surfaces/markdown-surface.js'

// WebSocket.readyState OPEN, fixed at 1 by the WHATWG spec. Referenced directly so
// the class does not depend on a global `WebSocket` (absent in the test env; the
// live socket is injected via socketFactory).
const WS_OPEN = 1

// Server-op render-backs the active surface applies (backend is the document
// source of truth; the placement semantics live in the surfaces).
const SURFACE_OPS = Object.freeze(['insert-block', 'replace-block', 'block-attrs-updated'])

/**
 * @typedef {object} NoteEditorOptions
 * @property {(url: string) => WebSocket} [socketFactory] — injected for tests; defaults to `new WebSocket(url)`
 * @property {() => string}               [wsUrl]         — injected for tests; defaults to the /api/ws URL for this uuid
 * @property {(msg: object) => void}      [onServerMessage] — routing for the remaining messages (editor.js owns it)
 * @property {(mode: string) => import('./surfaces/abstract-surface.js').AbstractSurface} [surfaceFactory]
 */

export class NoteEditor extends AbstractEditor {
  /** @type {WebSocket|null} */
  #ws = null

  /** @type {string[]} JSON strings queued before the socket is OPEN */
  #pending = []

  /** @type {Record<string, {resolve: (m: object) => void, reject: (e: Error) => void}>} reply type → awaiter */
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

  /** @type {Promise<boolean>|null} the in-flight mode flip; reentrant setMode coalesces onto it */
  #modeFlip = null

  /**
   * Opens the WebSocket immediately (faithful to editor.js: openEditorWs runs at
   * the end of initEditor for every non-prompt uuid).
   * @param {string}           uuid
   * @param {NoteEditorOptions} [options]
   */
  constructor(uuid, options = {}) {
    super(uuid, options)
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
    if (msg.type === 'flush-ack') {
      // Dirty-clear runs for EVERY flush-ack — awaited (flushSave) or
      // side-channel (EditorService's background notifySaved).
      this.clearDirty()
      document.dispatchEvent(new CustomEvent('sieve:meta-dirty', { detail: { dirty: false } }))
      document.dispatchEvent(new CustomEvent('editor:saved', { detail: { uuid: msg.uuid } }))
    }

    // A registered awaiter CONSUMES its reply (flush-ack, markdown-content,
    // wysiwyg-content). A reply arriving after its awaiter timed out falls
    // through and is dropped below — it must never mount a stale surface.
    const awaiter = this.#awaiters[msg.type]
    if (awaiter) {
      delete this.#awaiters[msg.type]
      awaiter.resolve(msg)
      return
    }

    // Server-op render-backs land on the active surface (the placement logic —
    // tracked transactions, docPosForBlockIndex, replace-by-id — lives there).
    if (SURFACE_OPS.indexOf(msg.type) >= 0) {
      this.applyServerOp(msg)
      return
    }

    // Everything else (error, block-extracted, unawaited mode replies) goes to
    // editor.js's router.
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
   * Sends a message and resolves with the reply of an EXPLICIT type, or rejects
   * after the timeout. The generalization of wsSendAndAwait for replies that are
   * not `<type>-ack` (the mode handshake's markdown-content / wysiwyg-content).
   * @param {string} replyType
   * @param {object} msg
   * @param {string} [label] — timeout-message label (wsSendAndAwait passes the
   *   request type, preserving the historical 'ws timeout: flush' log format)
   * @returns {Promise<any>}
   */
  #awaitReply(replyType, msg, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        delete this.#awaiters[replyType]
        reject(new Error('ws timeout: ' + (label || replyType)))
      }, 5000)
      this.#awaiters[replyType] = {
        resolve: (m) => { clearTimeout(timer); resolve(m) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      }
      this.wsSend(msg)
    })
  }

  /**
   * Sends a message and resolves with the matching `<type>-ack` reply, or rejects
   * after 5s.
   * @param {string} type
   * @param {object} msg
   * @returns {Promise<object>}
   */
  wsSendAndAwait(type, msg) {
    return this.#awaitReply(type + '-ack', msg, type)
  }

  // ── Server ops ──────────────────────────────────────────────────────────────────

  /**
   * Applies a server render-back op via the active surface. Safe no-op when no
   * surface is mounted (e.g. an op racing the initial load).
   * @param {object} msg
   */
  applyServerOp(msg) {
    const s = this.surface
    if (s) s.applyServerOp(/** @type {any} */ (msg))
  }

  // ── Domain → wire enveloping (the WS contract lives HERE, never in a surface) ───

  /**
   * Envelopes block-domain ops from the surface into block-op WS messages,
   * one per op, in order (shape frozen: {type:'block-op', uuid, op}).
   * @param {object[]} ops
   */
  submitBlockOps(ops) {
    ;(ops || []).forEach((op) => this.wsSend({ type: 'block-op', uuid: this.uuid, op: op }))
  }

  /**
   * Envelopes a whole-buffer markdown update into a doc-update WS message
   * (shape frozen: {type:'doc-update', uuid, markdown}).
   * @param {string} markdown
   */
  updateText(markdown) {
    this.wsSend({ type: 'doc-update', uuid: this.uuid, markdown: markdown })
  }

  // ── Mode flip (P2.B: the awaited in-place surface swap) ─────────────────────────

  /**
   * Switches the editing mode in place with stay-on-failure semantics:
   *
   *   1. flush the current surface (pending edits reach Go's shadow first)
   *   2. send enter-markdown / enter-wysiwyg and AWAIT the markdown-content /
   *      wysiwyg-content reply (5s, the existing awaiter machinery)
   *   3. only on the reply: unmount the old surface, mount the new one with the
   *      server's payload — the mode getter flips because the surface did.
   *
   * On timeout/error the promise rejects and NOTHING was unmounted — the editor
   * stays in its current mode, fully functional. A reply arriving after the
   * timeout finds no awaiter and is dropped (never a stale mount). A reentrant
   * call while a flip is in flight coalesces onto the in-flight promise.
   * @param {string} target — 'wysiwyg' | 'markdown'
   * @returns {Promise<boolean>} whether the mode changed
   */
  setMode(target) {
    if (!this.surface || target === this.mode) return Promise.resolve(false)
    if (this.#modeFlip) return this.#modeFlip
    this.#modeFlip = this.#flipTo(target).finally(() => { this.#modeFlip = null })
    return this.#modeFlip
  }

  /**
   * @param {string} target
   * @returns {Promise<boolean>}
   */
  async #flipTo(target) {
    const old = /** @type {import('./surfaces/abstract-surface.js').AbstractSurface} */ (this.surface)
    // Flush pending edits BEFORE the handshake so Go's shadow is current
    // (wysiwyg: pending block-ops; markdown: pending doc-update).
    old.flushPending()

    let payload
    if (target === 'markdown') {
      // Go merges the shadow and replies with the authoritative markdown
      // (ContentForSave over the tree). The frontend never serialises the doc.
      const reply = await this.#awaitReply('markdown-content', { type: 'enter-markdown', uuid: this.uuid })
      payload = reply.markdown
    } else {
      // Hand the current markdown to the server, which reparses the
      // authoritative Doc and returns the blocks — the WYSIWYG surface mounts
      // from THOSE blocks (so ids from the markers survive).
      const body = old.body || ''
      const reply = await this.#awaitReply('wysiwyg-content', { type: 'enter-wysiwyg', uuid: this.uuid, markdown: body })
      payload = { body: body, blocks: reply.blocks }
    }

    // Success only — the swap is unreachable on timeout/error.
    this.presentSurface(target, /** @type {HTMLElement} */ (this._rootEl), payload)
    return true
  }

  // ── Save ────────────────────────────────────────────────────────────────────────

  /** @returns {Promise<unknown>} */
  flushSave() {
    // Flush any pending debounced edit immediately so Go has the latest content
    // (surface-owned: wysiwyg block-sync / markdown doc-update), then await the
    // flush-ack.
    const s = this.surface
    if (s) s.flushPending()
    return this.wsSendAndAwait('flush', { type: 'flush', uuid: this.uuid })
      .catch((err) => { console.warn('[editor] flush timeout, continuing:', err) })
  }

  destroy() {
    super.destroy()      // unmount the surface
    this.#closeSocket()  // then close the channel (no reconnect)
  }
}
