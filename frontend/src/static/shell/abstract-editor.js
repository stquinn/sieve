// @ts-check
// abstract-editor.js — base of the editor component hierarchy (P2.A, P2.B, P2.B.2).
// AbstractEditor is the stable identity for one open document's editing session:
// it owns the uuid (identity), dirty state, the save/destroy contract, the
// document's INPUT SURFACE (a WysiwygSurface or MarkdownSurface), and — since
// P2.B.2 — the WebSocket transport machinery. Concrete editors know the BLOCK
// PROTOCOL (domain operations) but not the transport: the WS channel is an
// AbstractEditor #private detail exposed only through domain methods.
//
// Mode and the TipTap handle are DERIVED from the mounted surface: there is no
// stored mode to fall out of sync, which is what makes the old torn-down-limbo
// mode-toggle state unrepresentable.
//
// Transport is INVISIBLE outside this class: no public or protected send
// methods exist anywhere in the hierarchy — the domain methods (applyBlockOps,
// updateText, flush, enterMarkdown, enterWysiwyg, retryBlockJob, extract) ARE
// the entire protocol surface. A concrete type that wants a live channel
// declares it at construction (`connect: true` — NoteEditor); the default is
// disconnected, so a bare editor (tests, PromptEditor) never touches the
// network. Domain methods on a disconnected editor are safe no-ops (sends) or
// immediate resolves/rejects (awaits) — callers never probe for transport.
//
// Dual-use ES module (block-position.js pattern): `export` for vitest imports;
// window.* assignment happens in editor-shell.js (which re-exports this as the
// P1 `SieveEditor` name for backward compatibility).

import { AbstractSurface } from './surfaces/abstract-surface.js'

/**
 * @typedef {import('./surfaces/abstract-surface.js').SurfaceEventMsg} SurfaceEventMsg
 */

/**
 * The editor-owned services a surface receives (threaded through the
 * surfaceFactory). All DOMAIN-shaped: no wire envelopes, no transport
 * vocabulary, no uuid-for-transport — the WS contract is owned exclusively by
 * AbstractEditor. If a dep's implementation would change when the transport
 * changes, it belongs here, not in a surface.
 * @typedef {object} EditorSurfaceServices
 * @property {(event: SurfaceEventMsg) => void} notify — outbound editor-domain events → editor registrants
 * @property {(ops: object[]) => void} applyBlockOps — block-domain ops (create/update/delete-block) → transport
 * @property {(markdown: string) => void} updateText — whole-buffer text update (markdown mode) → transport
 */

/**
 * @typedef {object} AbstractEditorOptions
 * @property {boolean} [connect]
 *   — when true, the editor opens its live channel at construction (NoteEditor
 *   declares this). Default false: no socket is ever created; domain methods
 *   are safe no-ops (sends) / immediate resolves or rejects (awaits).
 *   PromptEditor and bare/base editors simply omit it.
 * @property {(url: string) => WebSocket} [socketFactory]
 *   — injected for tests; defaults to `new WebSocket(url)`
 * @property {() => string} [wsUrl]
 *   — injected for tests; defaults to the /api/ws URL for this uuid
 * @property {(msg: object) => void} [onServerMessage]
 *   — routing for messages not consumed here (error, block-extracted, …)
 * @property {(mode: string, services: EditorSurfaceServices) => AbstractSurface} [surfaceFactory]
 *   — builds a fresh surface for a mode ('wysiwyg' | 'markdown'); injected by
 *   editor.js with the content-service dependency bag closed over. The editor
 *   passes its own domain services so surface output flows through the editor.
 */

// WebSocket.readyState OPEN, fixed at 1 by the WHATWG spec. Referenced directly
// so the class does not depend on a global `WebSocket` (absent in the test env).
const WS_OPEN = 1

// Server-op render-backs the active surface applies (backend is the document
// source of truth; the placement semantics live in the surfaces).
const SURFACE_OPS = Object.freeze(['insert-block', 'replace-block', 'block-attrs-updated'])

export class AbstractEditor {
  // ── Identity + surface state ─────────────────────────────────────────────────

  /** @type {string} */
  #uuid

  /** @type {boolean} */
  #dirty = false

  /** @type {AbstractSurface|null} */
  #surface = null

  /** @type {HTMLElement|null} the editor-owned root the surfaces mount under */
  #rootEl = null

  /** @type {((mode: string, services: EditorSurfaceServices) => AbstractSurface)|null} */
  #surfaceFactory

  /** @type {Array<(event: SurfaceEventMsg) => void>} surface-event registrants */
  #eventListeners = []

  // ── WS transport state (socketless editors keep these null/empty) ─────────────

  /** @type {boolean} */
  #socketless

  /** @type {WebSocket|null} */
  #ws = null

  /** @type {string[]} JSON strings queued before the socket is OPEN */
  #pending = []

  /** @type {Record<string, {resolve: (m: object) => void, reject: (e: Error) => void}>} */
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
   * @param {string}                uuid    — document uuid; the editor's fixed identity
   * @param {AbstractEditorOptions} [options]
   */
  constructor(uuid, options = {}) {
    if (!uuid) throw new Error('AbstractEditor: uuid is required')
    this.#uuid = uuid
    this.#surfaceFactory = options.surfaceFactory || null
    this.#socketless = options.connect !== true

    if (!this.#socketless) {
      this.#socketFactory = options.socketFactory || ((url) => new WebSocket(url))
      this.#wsUrl = options.wsUrl || (() => AbstractEditor.#defaultUrl(uuid))
      this.#onServerMessage = options.onServerMessage || (() => {})
      this.#open()
    } else {
      // Provide stubs so the private fields are always initialised.
      this.#socketFactory = () => { throw new Error('socketless') }
      this.#wsUrl = () => ''
      this.#onServerMessage = () => {}
    }
  }

  // ── Identity + surface accessors ─────────────────────────────────────────────

  /** @returns {string} The document uuid this editor session is for. */
  get uuid() { return this.#uuid }

  /** @returns {AbstractSurface|null} The mounted input surface, or null. */
  get surface() { return this.#surface }

  /**
   * Current editing mode — DERIVED from the mounted surface; the subclass
   * default applies before any surface mounts.
   * @returns {string} 'wysiwyg' | 'markdown'
   */
  get mode() { return this.#surface ? this.#surface.mode : this._defaultMode }

  /**
   * The pre-mount default mode. PromptEditor overrides to 'markdown' (fixed).
   * @protected
   * @returns {string}
   */
  get _defaultMode() { return 'wysiwyg' }

  /** @returns {unknown|null} The live TipTap instance, or null (markdown / unmounted). */
  get tiptap() { return this.#surface ? this.#surface.tiptap : null }

  /** @returns {boolean} Whether the document has unsaved changes. */
  get isDirty() { return this.#dirty }

  /**
   * The editor-owned root element, for subclasses (setMode remounts into it).
   * @protected
   * @returns {HTMLElement|null}
   */
  get _rootEl() { return this.#rootEl }

  /** Marks the document dirty (unsaved changes present). */
  markDirty() { this.#dirty = true }

  /** Clears the dirty flag (called when a save is acknowledged). */
  clearDirty() { this.#dirty = false }

  // ── Surface events ───────────────────────────────────────────────────────────

  /**
   * Registers a listener for the surface's editor-domain events
   * (doc-changed / selection-changed / transaction / focus-changed — see
   * SurfaceEvent). The editor forwards every event its mounted surface reports.
   * This is the seed of the P3 SelectionModel stream; today its one production
   * registrant is editor.js's transitional legacy-chrome fan-out.
   * @param {(event: SurfaceEventMsg) => void} fn
   * @returns {() => void} unsubscribe
   */
  onEvent(fn) {
    this.#eventListeners.push(fn)
    return () => {
      this.#eventListeners = this.#eventListeners.filter((l) => l !== fn)
    }
  }

  /** @param {SurfaceEventMsg} event */
  #emitEvent(event) {
    for (const fn of this.#eventListeners) {
      try { fn(event) } catch (e) { console.error('[editor] surface-event listener threw', e) }
    }
  }

  // ── Surface lifecycle ────────────────────────────────────────────────────────

  /**
   * Presents the input surface for a mode: unmounts the current surface (if
   * any), creates a fresh one via the factory, and mounts it on the root. The
   * ONE place surfaces are swapped — initEditor's initial mount and setMode's
   * in-place flip both land here.
   * @param {string}      mode    — 'wysiwyg' | 'markdown'
   * @param {HTMLElement} rootEl  — the editor's root (today: #tiptap-mount)
   * @param {unknown}     content — surface seed (markdown string, or {body, blocks})
   * @returns {AbstractSurface} the mounted surface
   */
  presentSurface(mode, rootEl, content) {
    if (!this.#surfaceFactory) throw new Error('AbstractEditor: no surfaceFactory injected')
    if (this.#surface) this.#surface.unmount()
    this.#rootEl = rootEl
    const next = this.#surfaceFactory(mode, {
      notify: (event) => this.#emitEvent(event),
      applyBlockOps: (ops) => this.applyBlockOps(ops),
      updateText: (markdown) => this.updateText(markdown),
    })
    if (!(next instanceof AbstractSurface)) throw new Error('AbstractEditor: surfaceFactory must return an AbstractSurface')
    next.mount(rootEl, content)
    this.#surface = next
    return next
  }

  // ── WebSocket lifecycle ───────────────────────────────────────────────────────

  /** @param {string} uuid @returns {string} */
  static #defaultUrl(uuid) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    let host = location.host
    if (window.__sieveDevServerPort) host = '127.0.0.1:' + window.__sieveDevServerPort
    return proto + '//' + host + '/api/ws?uuid=' + encodeURIComponent(uuid)
  }

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
    // the registered message router.
    this.#onServerMessage(msg)
  }

  // ── Transport primitives (#private — invisible to subclasses and callers) ─────

  /**
   * Sends a message on the socket, or queues it if the socket is not yet OPEN.
   * Disconnected editors: silently no-ops (there is no socket to send on).
   * @param {object} msg
   */
  #send(msg) {
    if (this.#socketless) return
    const data = JSON.stringify(msg)
    if (this.#ws && this.#ws.readyState === WS_OPEN) {
      this.#ws.send(data)
    } else {
      this.#pending.push(data)
    }
  }

  /**
   * Sends a message and resolves with the reply of an EXPLICIT reply type, or
   * rejects after 5s. Disconnected editors reject immediately with a clear
   * error. (The mode-handshake replies are markdown-content / wysiwyg-content —
   * not `<type>-ack` — hence reply-type keying.)
   * @param {string} replyType
   * @param {object} msg
   * @param {string} [label] — timeout-message label
   * @returns {Promise<any>}
   */
  #awaitReply(replyType, msg, label) {
    if (this.#socketless) return Promise.reject(new Error('editor has no live channel'))
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        delete this.#awaiters[replyType]
        reject(new Error('ws timeout: ' + (label || replyType)))
      }, 5000)
      this.#awaiters[replyType] = {
        resolve: (m) => { clearTimeout(timer); resolve(m) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      }
      this.#send(msg)
    })
  }

  // ── Domain methods (the block protocol — transport-agnostic public API) ────────

  /**
   * Envelopes block-domain ops into block-op WS messages, one per op, in order
   * (shape frozen: {type:'block-op', uuid, op}). Socketless editors: no-op.
   * @param {object[]} ops
   */
  applyBlockOps(ops) {
    ;(ops || []).forEach((op) => this.#send({ type: 'block-op', uuid: this.uuid, op: op }))
  }

  /**
   * Envelopes a whole-buffer markdown update into a doc-update WS message
   * (shape frozen: {type:'doc-update', uuid, markdown}). Socketless editors: no-op.
   * @param {string} markdown
   */
  updateText(markdown) {
    this.#send({ type: 'doc-update', uuid: this.uuid, markdown: markdown })
  }

  /**
   * Requests a re-run of a block's backend job (shape frozen:
   * {type:'retry-block-job', uuid, id}). Disconnected editors: no-op.
   * @param {string} blockId
   */
  retryBlockJob(blockId) {
    this.#send({ type: 'retry-block-job', uuid: this.uuid, id: blockId })
  }

  /**
   * Requests a block extraction/transform (shape frozen: {type:'extract',
   * blockId, targetKind, operation, entries, index} — the extract message
   * carries no uuid; the server resolves the document from the channel).
   * Disconnected editors: no-op.
   * @param {{blockId: string, targetKind: string, operation: string, entries: object[], index?: number}} payload
   */
  extract(payload) {
    this.#send(Object.assign({ type: 'extract' }, payload))
  }

  /**
   * Flushes any pending surface edits then awaits the server's flush-ack,
   * ensuring Go's shadow is current before the caller proceeds. Socketless
   * editors resolve immediately (no WS to flush).
   * @returns {Promise<object>}
   */
  flush() {
    if (this.#socketless) return Promise.resolve({})
    return this.#awaitReply('flush-ack', { type: 'flush', uuid: this.uuid }, 'flush')
  }

  /**
   * Sends enter-markdown and awaits the markdown-content reply from Go
   * (the authoritative markdown serialised from the block tree). Rejects on
   * timeout or if the editor is socketless.
   * @returns {Promise<string>} the authoritative markdown payload
   */
  enterMarkdown() {
    return this.#awaitReply('markdown-content', { type: 'enter-markdown', uuid: this.uuid })
      .then((reply) => reply.markdown)
  }

  /**
   * Sends enter-wysiwyg (carrying the current markdown body) and awaits the
   * wysiwyg-content reply (the server's reparsed block list). Rejects on
   * timeout or if the editor is socketless.
   * @param {string} markdown — the surface's current body, sent to Go for reparsing
   * @returns {Promise<object[]>} the server's reparsed block list
   */
  enterWysiwyg(markdown) {
    return this.#awaitReply('wysiwyg-content', { type: 'enter-wysiwyg', uuid: this.uuid, markdown: markdown })
      .then((reply) => reply.blocks)
  }

  /**
   * Applies a server render-back op via the active surface. Safe no-op when no
   * surface is mounted (e.g. an op racing the initial load).
   * @param {object} msg
   */
  applyServerOp(msg) {
    const s = this.#surface
    if (s) s.applyServerOp(/** @type {any} */ (msg))
  }

  // ── Mode flip (P2.B: the awaited in-place surface swap) ──────────────────────

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
   * Socketless editors (PromptEditor): base no-op resolving false (mode is fixed).
   * @param {string} target — 'wysiwyg' | 'markdown'
   * @returns {Promise<boolean>} whether the mode changed
   */
  setMode(target) {
    if (this.#socketless) return Promise.resolve(false)
    if (!this.#surface || target === this.mode) return Promise.resolve(false)
    if (this.#modeFlip) return this.#modeFlip
    this.#modeFlip = this.#flipTo(target).finally(() => { this.#modeFlip = null })
    return this.#modeFlip
  }

  /**
   * @param {string} target
   * @returns {Promise<boolean>}
   */
  async #flipTo(target) {
    const old = /** @type {import('./surfaces/abstract-surface.js').AbstractSurface} */ (this.#surface)
    // Flush pending edits BEFORE the handshake so Go's shadow is current
    // (wysiwyg: pending block-ops; markdown: pending doc-update).
    old.flushPending()

    let payload
    if (target === 'markdown') {
      // Go merges the shadow and replies with the authoritative markdown
      // (ContentForSave over the tree). The frontend never serialises the doc.
      const markdown = await this.enterMarkdown()
      payload = markdown
    } else {
      // Hand the current markdown to the server, which reparses the
      // authoritative Doc and returns the blocks — the WYSIWYG surface mounts
      // from THOSE blocks (so ids from the markers survive).
      const body = old.body || ''
      const blocks = await this.enterWysiwyg(body)
      payload = { body: body, blocks: blocks }
    }

    // Success only — the swap is unreachable on timeout/error.
    this.presentSurface(target, /** @type {HTMLElement} */ (this.#rootEl), payload)
    return true
  }

  // ── Save ─────────────────────────────────────────────────────────────────────

  /**
   * Flushes any pending debounced edit immediately so Go has the latest content
   * (surface-owned: wysiwyg block-sync / markdown doc-update), then awaits the
   * flush-ack. PromptEditor overrides this with an HTTP POST instead.
   * @returns {Promise<unknown>}
   */
  flushSave() {
    const s = this.#surface
    if (s) s.flushPending()
    return this.flush()
      .catch((err) => { console.warn('[editor] flush timeout, continuing:', err) })
  }

  // ── Teardown ─────────────────────────────────────────────────────────────────

  /**
   * Tears the editor session down: unmounts the surface and closes the WS
   * channel (no reconnect). Subclasses that extend destroy() must call
   * super.destroy().
   */
  destroy() {
    if (this.#surface) {
      this.#surface.unmount()
      this.#surface = null
    }
    this.#rootEl = null
    if (!this.#socketless) this.#closeSocket()
  }
}
