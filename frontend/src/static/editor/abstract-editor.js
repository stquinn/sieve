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
import { EditorMode } from './editor-mode.js'
import { SelectionModel } from './selection-model.js'
import { blockInsertPos } from '../ai/ai-target.js'
import { blockIndexForInsert, emptyParagraphAnchor, blockIndexAfter } from '../base/block-position.js'
import { buildAiContext, applyTargetHighlight } from './extensions.js'
import { resolveEntriesForKind } from '../block/sieve-block-extension.js'

/**
 * @typedef {import('./surfaces/abstract-surface.js').SurfaceEventMsg} SurfaceEventMsg
 * @typedef {import('./editor-mode.js').EditorModeValue} EditorModeValue
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

  /** @type {Array<(event: SurfaceEventMsg) => void>} surface-event registrants */
  #eventListeners = []

  /**
   * The editor-private authority on selection/caret/context OUTSIDE the surface
   * (P3.A). Fed from the surface events (selection-changed / transaction /
   * focus-changed) via #feedSelectionModel; pulled through getSelectionContext.
   * The push up to Tab/Workspace is P3.B — the model emits to its own onUpdate
   * registry only for now.
   * @type {SelectionModel}
   */
  #selectionModel

  // ── WS transport state (socketless editors keep these null/empty) ─────────────

  /** @type {boolean} */
  /** @type {object|null} the BlockService singleton, handed down from the
   * Workspace composition root (contract §service pair); surfaces stamp it on
   * their pane for the NodeView ctx. */
  #blockService = null
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

  // ── Editor-bound command state (P2.C) ─────────────────────────────────────────

  /** @type {boolean} AI-block visibility for THIS editor (mirrored as a CSS class on the root) */
  #showAiBlocks = true

  /**
   * Where the next inserted Sieve block goes (P4.A, moved off editor.js's IIFE).
   * A number = insert at that doc point (additive). A {from,to} object = replace
   * that range (in-place conversion of a native code block). Every block-creating
   * operation sets this fresh, so a stale value can never leak into a later insert.
   * @type {number|{from:number,to:number}|null}
   */
  #insertPos = null

  /**
   * Save-suppression flag while a whole-doc reload (softReload) is mid-flight
   * (P4.A, formerly editor.js's aiReloadInProgress). A save during the reload
   * would race the re-render, so PromptEditor.flushSave checks isSaveSuppressed().
   * @type {boolean}
   */
  #reloadInProgress = false

  /**
   * @param {string}                uuid    — document uuid; the editor's fixed identity
   * @param {AbstractEditorOptions} [options]
   */
  constructor(uuid, options = {}) {
    if (!uuid) throw new Error('AbstractEditor: uuid is required')
    this.#uuid = uuid
    this.#selectionModel = new SelectionModel(uuid)
    // P3.B: bridge the SelectionModel's own push onto the editor's ONE onEvent
    // stream so the Tab/Workspace republish (and editor.js's legacy fan-out, which
    // ignores the new type) receive selection updates through the same channel the
    // spec prescribes. SurfaceEventMsg is {type}-minimum, so the extra `context`
    // field is fine; the model already fires only on a meaningful change.
    this.#selectionModel.onUpdate((ctx) => this.#emitEvent({ type: 'selection-update', context: ctx }))
    this.#blockService = options.blockService || null
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

  /** The BlockService singleton (null in tests/legacy constructions). */
  get blockService() { return this.#blockService }

  /** @returns {AbstractSurface|null} The mounted input surface, or null. */
  get surface() { return this.#surface }

  /**
   * Current editing mode — DERIVED from the mounted surface; the subclass
   * default applies before any surface mounts.
   * @returns {EditorModeValue}
   */
  get mode() { return this.#surface ? /** @type {EditorModeValue} */ (this.#surface.mode) : this._defaultMode }

  /**
   * The pre-mount default mode. PromptEditor overrides to EditorMode.MARKDOWN (fixed).
   * @protected
   * @returns {EditorModeValue}
   */
  get _defaultMode() { return EditorMode.WYSIWYG }

  /** @returns {unknown|null} The live TipTap instance, or null (markdown / unmounted). */
  get editorPane() { return this.#surface ? this.#surface.editorPane : null }

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
   * Registers a listener for the editor-domain event stream: the mounted
   * surface's events (doc-changed / selection-changed / transaction /
   * focus-changed — see SurfaceEvent) plus the editor's OWN producer events
   * (mode-changed / mode-change-failed, emitted by the setMode flip path —
   * P2.C). This is the seed of the P3 SelectionModel stream; today its one
   * production registrant is editor.js's transitional legacy-chrome fan-out.
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

  /**
   * The Editor's SurfaceListener handler — the mounted surface FIRES its events
   * (doc-changed / selection-changed / transaction / focus-changed) here and the
   * Editor HANDLES them. P3.A: feed the SelectionModel from the event FIRST (so an
   * onEvent handler that pulls getSelectionContext() sees the fresh context), then
   * emit on the editor stream. P4.D: a doc-changed also produces a `stats` event
   * (the retired editor.js dispatchStats — now editor-owned) and marks the document
   * dirty. The retired legacyChromeFanout dispatched sieve:meta-dirty{dirty:true} on
   * doc-changed; the flush-ack (#handleMessage) dispatches the {dirty:false}
   * counterpart + clearDirty(). Consumers: StatusBar #onDirty (the meta-dirty-dot +
   * status-bar save slot). doc-changed does NOT fire on initial content load, so a
   * freshly loaded document stays green until the first real edit.
   * @param {SurfaceEventMsg} event
   */
  onSurfaceEvent(event) {
    this.#feedSelectionModel(event)
    this.#emitEvent(event)
    if (event && event.type === 'doc-changed') {
      this.#emitStats()
      this.markDirty()
      document.dispatchEvent(new CustomEvent('sieve:meta-dirty', { detail: { dirty: true } }))
    }
  }

  // ── Selection context (P3.A: the SelectionModel pull + subscribe) ─────────────

  /**
   * The current frozen SelectionContext — the pull path for actions that need
   * the caret/selection/block context (AI target, chrome glow, …) WITHOUT
   * reaching into PM or the DOM. Delegates to the editor-private SelectionModel,
   * fed from the surface events.
   * @returns {import('./selection-model.js').SelectionContext}
   */
  getSelectionContext() { return this.#selectionModel.getContext() }

  /**
   * Subscribes to the SelectionModel's `selection-update` (fired on meaningful
   * change only; the frozen context is the payload). A passthrough to the
   * model's own registry — the Tab/Workspace republish of this stream is P3.B;
   * in P3.A only the editor's own tests/consumers subscribe here.
   * @param {(ctx: import('./selection-model.js').SelectionContext) => void} fn
   * @returns {() => void} unsubscribe
   */
  onSelectionUpdate(fn) { return this.#selectionModel.onUpdate(fn) }

  /**
   * Interposes on a surface event to feed the SelectionModel: on a selection /
   * transaction / focus event, pull the surface's raw descriptor and ingest it;
   * on focus, also derive + set the focus zone (minimal for P3.A: 'block-inner'
   * when focus sits in an inner form control, else the surface's editing zone).
   * The ONE place the model is fed. Called BEFORE the legacy #emitEvent fan-out
   * so a subscriber reading getSelectionContext() in an onEvent handler sees the
   * fresh context.
   * @param {SurfaceEventMsg} event
   */
  #feedSelectionModel(event) {
    const s = this.#surface
    if (!s) return
    const t = event && event.type
    if (t === 'selection-changed' || t === 'transaction' || t === 'focus-changed') {
      const raw = s.feedSelection()
      if (raw) this.#selectionModel.ingest(raw)
    }
    if (t === 'focus-changed') {
      this.#selectionModel.setFocusZone(this.#deriveFocusZone())
    }
  }

  /**
   * Derives the focus zone from the live DOM focus + the mounted surface
   * (minimal for P3.A; refined for the Ask panel in P3.D and snapshot/restore in
   * P3.E). 'block-inner' when the active element is an inner form control inside
   * a sieve block; 'markdown' for the markdown surface; else 'editor'.
   * @returns {import('./selection-model.js').SelectionContext['focusZone']}
   */
  #deriveFocusZone() {
    if (this.mode === EditorMode.MARKDOWN) return 'markdown'
    const active = (typeof document !== 'undefined') ? document.activeElement : null
    if (active && typeof active.closest === 'function' && active.closest('.sieve-block__edit')) {
      return 'block-inner'
    }
    return 'editor'
  }

  // ── Surface lifecycle ────────────────────────────────────────────────────────

  /**
   * Builds the input surface for a mode. ABSTRACT: the surface repertoire (which
   * surface classes this editor can present) is TYPE-DEFINING knowledge that
   * lives on the concrete editor types, alongside the channel declaration —
   * nothing outside the editor decides or constructs what lives under its root.
   * The concrete type hands the surface THIS editor (`host`) — the surface calls
   * the editor's public API directly (onSurfaceEvent / applyBlockOps / updateText /
   * takeInsertPos / insertIndexForBlock / flushSave / softReload). No services bag.
   * @protected
   * @param {EditorModeValue} mode
   * @returns {AbstractSurface}
   */
  _createSurface(mode) {
    throw new Error('AbstractEditor: _createSurface must be implemented by the concrete editor type')
  }

  /**
   * Presents the input surface for a mode: unmounts the current surface (if
   * any), asks the concrete type to build a fresh one (`_createSurface`), and
   * mounts it on the root. The ONE place surfaces are swapped — initEditor's
   * initial mount and setMode's in-place flip both land here.
   * @param {EditorModeValue} mode
   * @param {HTMLElement} rootEl  — the editor's root (today: #tiptap-mount)
   * @param {unknown}     content — surface seed (markdown string, or {body, blocks})
   * @returns {AbstractSurface} the mounted surface
   */
  presentSurface(mode, rootEl, content) {
    if (this.#surface) this.#surface.unmount()
    this.#rootEl = rootEl
    const next = this._createSurface(mode)
    if (!(next instanceof AbstractSurface)) throw new Error('AbstractEditor: _createSurface must return an AbstractSurface')
    // A mount root can arrive pre-classed by a PREVIOUS editor's toggle — sync
    // the class to THIS editor's state so DOM and #showAiBlocks never desync.
    rootEl.classList.toggle('hide-ai-blocks', !this.#showAiBlocks)
    next.mount(rootEl, content)
    this.#surface = next
    // Seed the document stats for the new surface (initial present + mode flip);
    // doc-changed emits them thereafter. The retired editor.js dispatchStats seed.
    this.#emitStats()
    return next
  }

  /**
   * Emits a `stats` event on the editor stream: chars + lines from the active
   * surface's plain-text view and the top-level block count. Folds editor.js's
   * dispatchStats + getMarkdown (P4.D). The StatusBar consumer paints
   * chars/lines and the --line-digits gutter width; unsaved/saved paint rides
   * sieve:meta-dirty.
   */
  #emitStats() { this.#emitEvent({ type: 'stats', ...this.stats() }) }

  /**
   * The current document stats — DELEGATED to the active surface (which owns the
   * TipTap/buffer read; no AbstractEditor.editorPane reach here — the epic's
   * TipTap-only-in-surface discipline). A PULL seam: a consumer that points at this
   * editor AFTER the initial-present seed already emitted (the StatusBar on cold
   * boot) reads the current value instead of waiting for the next doc-changed emit.
   * #emitStats pushes exactly this shape on the `stats` event.
   * @returns {{ chars: number, lines: number, blockCount: number }}
   */
  stats() {
    return this.#surface ? this.#surface.stats() : { chars: 0, lines: 0, blockCount: 0 }
  }

  // ── Document search (D-3: SearchOverlay drives these; surface owns TipTap) ─────
  //
  // The search overlay reaches the active editor's search verbs (never a surface
  // #private or `.editorPane`); each DELEGATES to the mounted surface, mirroring
  // stats(). The Search extension + its match storage live on WysiwygSurface's
  // OWN #editor — so search stays surface-private, like every other TipTap read.
  // A surface with no search returns false; the overlay treats that as "no matches".

  /**
   * Set the search term; returns the surface's current match stats (or false).
   * @param {string} term
   * @returns {{current:number,total:number}|false}
   */
  searchTerm(term) { return this.#surface ? this.#surface.searchTerm(term) : false }

  /**
   * Advance to the next match; returns the current match stats (or false).
   * @returns {{current:number,total:number}|false}
   */
  searchNext() { return this.#surface ? this.#surface.searchNext() : false }

  /**
   * Step to the previous match; returns the current match stats (or false).
   * @returns {{current:number,total:number}|false}
   */
  searchPrev() { return this.#surface ? this.#surface.searchPrev() : false }

  /**
   * Clear the active search and return focus to the editing view.
   * @returns {false}
   */
  clearSearch() { return this.#surface ? this.#surface.clearSearch() : false }

  /**
   * Copies the active document's clean markdown export to the clipboard (moved
   * verbatim from editor.js copyDocumentAsMarkdown — the File › Export › Clipboard
   * (Markdown) menu path). Fetches the server's whole-doc export (ai-blocks
   * filtered, cards/clips reduced to links). A native menu click carries no DOM
   * gesture + steals focus, so WebKit rejects navigator.clipboard — the Wails
   * native pasteboard (runtime.ClipboardSetText) is primary; the browser API is the
   * non-Wails dev fallback. No toast system → feedback is the OS clipboard.
   */
  copyAsMarkdown() {
    if (!this.#uuid) return
    fetch('/api/editor/export?uuid=' + encodeURIComponent(this.#uuid) + '&format=markdown')
      .then((resp) => (resp.ok ? resp.text() : null))
      .then((md) => {
        if (md == null) return
        const rt = /** @type {any} */ (window).runtime
        if (rt && rt.ClipboardSetText) return rt.ClipboardSetText(md)
        return navigator.clipboard.writeText(md)
      })
      .catch((err) => { console.warn('export-markdown copy failed', err) })
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
   * Retries a block: the ONE op that folds the local optimistic reset with the
   * backend re-dispatch (P4.F Brief C — a NodeView never does setNodeMarkup itself;
   * it calls ctx.retry() → here). Resets the block node to PENDING (fresh createdAt,
   * clearing content/error/title/completedAt/response when present) as a TRACKED PM
   * transaction, then asks the server to re-run its job (retryBlockJob). No-op when
   * no live pane (markdown mode); retryBlockJob still fires so a mode-agnostic retry
   * reaches the backend. Behaviour-identical to the retired block-retry event handler.
   * @param {string} blockId
   */
  retryBlock(blockId) {
    const ed = /** @type {any} */ (this.editorPane)
    if (ed) {
      const now = new Date().toISOString()
      let pos = -1
      let cur = null
      ed.state.doc.descendants((node, p) => {
        if (pos >= 0) return false
        if (node.type.name.startsWith('sieve-') && node.attrs.id === blockId) {
          pos = p; cur = node; return false
        }
      })
      if (cur) {
        const clean = Object.assign({}, cur.attrs, { status: 'PENDING', createdAt: now })
        if ('content' in clean) clean.content = null
        if ('error' in clean) clean.error = null
        if ('title' in clean) clean.title = null
        if ('completedAt' in clean) clean.completedAt = null
        if ('response' in clean) clean.response = null
        ed.view.dispatch(ed.state.tr.setNodeMarkup(pos, null, clean))
      }
    }
    this.retryBlockJob(blockId)
  }

  /**
   * Requests a block extraction/transform. ABSORBS the prep the retired extract event
   * handler did (P4.F Brief C): clears any stale insert position (additive ops land
   * via insert-block at the op's own index), stamps the caller context onto the first
   * entry, resolves the target block index from `blockId` (top-level-only scan; skipped
   * for transform / undo-smart-paste, which mutate in place), and resolves the entries
   * for the target kind (sync or async) before sending. The wire shape is frozen:
   * {type:'extract', blockId, targetKind, operation, entries, index} — no uuid; the
   * server resolves the document from the channel. Disconnected editors: no-op send.
   * @param {{blockId: string, targetKind: string, operation: string, sourceNode?: object, entries: object[], context?: object}} payload
   * @returns {Promise<void>}
   */
  extract({ blockId, targetKind, operation, sourceNode, entries, context }) {
    entries = entries || []
    this.clearInsertPos()
    if (entries.length > 0 && context && Object.keys(context).length > 0) {
      entries[0].context = context
    }
    let index = -1
    if (operation !== 'transform' && operation !== 'undo-smart-paste' && blockId && this.editorPane) {
      // Top-level-only scan (blockIndexAfter) — descendants() could match a nested
      // node's id and compute an index relative to that nested position.
      index = blockIndexAfter(/** @type {any} */ (this.editorPane).state.doc, blockId)
    }
    const res = resolveEntriesForKind ? resolveEntriesForKind(targetKind, sourceNode, entries) : entries
    return Promise.resolve(res).then((resolved) => {
      this.#send({ type: 'extract', blockId: blockId, targetKind: targetKind, operation: operation, entries: resolved, index: index })
    })
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

  /**
   * Restores focus/selection from a SelectionContext coordinate — the WRITE side of
   * getSelectionContext (P3.E). Delegates straight to the #private surface, which
   * owns the PM/DOM (TipTap lives ONLY in the surface — no `tiptap` read here).
   * Safe no-op when no surface is mounted.
   * @param {import('./selection-model.js').SelectionContext} ctx
   */
  applyPosition(ctx) {
    if (this.#surface) this.#surface.applyPosition(ctx)
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
   * A value not in EditorMode resolves false (the no-op family) and sends nothing.
   *
   * The EDITOR is the producer of the mode events wherever the flip happens
   * (P2.C): exactly ONE {type:'mode-changed', mode} is emitted per ACTUAL flip
   * — however many callers coalesced onto it — and ONE
   * {type:'mode-change-failed', mode, error} per failed flip. The handlers are
   * attached here, where the flip is created, so a caller that ignores the
   * promise (the native menu) never produces an unhandled rejection. No-op
   * paths emit nothing.
   * @param {EditorModeValue} target
   * @returns {Promise<boolean>} whether the mode changed
   */
  setMode(target) {
    if (target !== EditorMode.WYSIWYG && target !== EditorMode.MARKDOWN) return Promise.resolve(false)
    if (this.#socketless) return Promise.resolve(false)
    if (!this.#surface || target === this.mode) return Promise.resolve(false)
    if (this.#modeFlip) return this.#modeFlip
    this.#modeFlip = this.#flipTo(target).finally(() => { this.#modeFlip = null })
    this.#modeFlip.then(
      (changed) => { if (changed) this.#emitEvent({ type: 'mode-changed', mode: this.mode }) },
      (err) => { this.#emitEvent({ type: 'mode-change-failed', mode: this.mode, error: err }) },
    )
    return this.#modeFlip
  }

  /**
   * BINARY-FLIP SUGAR over setMode: derives the target from the current mode
   * (EditorMode.WYSIWYG ⇄ EditorMode.MARKDOWN) and returns setMode's own
   * promise. setMode(mode) is the N-mode primitive — a future third mode adds
   * explicit setMode call sites; it does not grow this method. All flip
   * mechanics, coalescing, and the mode-changed / mode-change-failed producer
   * emissions live in setMode; no state or chrome lives here. Fixed-mode
   * editors (PromptEditor) resolve false polymorphically.
   * @returns {Promise<boolean>} whether the mode changed
   */
  toggleMode() {
    const target = this.mode === EditorMode.MARKDOWN ? EditorMode.WYSIWYG : EditorMode.MARKDOWN
    return this.setMode(target)
  }

  /**
   * @param {EditorModeValue} target
   * @returns {Promise<boolean>}
   */
  async #flipTo(target) {
    const old = /** @type {import('./surfaces/abstract-surface.js').AbstractSurface} */ (this.#surface)
    // Flush pending edits BEFORE the handshake so Go's shadow is current
    // (wysiwyg: pending block-ops; markdown: pending doc-update).
    old.flushPending()

    let payload
    if (target === EditorMode.MARKDOWN) {
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

  // ── Editor-bound commands (P2.C: the component API the menu/toolbar calls) ────

  /**
   * Toggles AI-block visibility for THIS editor: flips #showAiBlocks and
   * mirrors it as the `hide-ai-blocks` class on the editor-owned root element
   * (editor.css does the hiding). Editor-scoped state — no app chrome here.
   * @returns {boolean} whether AI blocks are now shown
   */
  toggleAiBlocks() {
    this.#showAiBlocks = !this.#showAiBlocks
    if (this.#rootEl) this.#rootEl.classList.toggle('hide-ai-blocks', !this.#showAiBlocks)
    return this.#showAiBlocks
  }

  /**
   * The ONE self-sufficient, block-index-native create path (P4.F): applies a
   * `create-block` block-op for `kind`+`attrs`. The editor is the SOLE owner of the
   * index math — callers pass a stable block ID anchor (or nothing), NEVER a
   * document-model position. When `afterBlockId` is OMITTED, the editor DERIVES the
   * index from the current caret (insertIndexForBlock — the caret's top-level block
   * index, +1, with the empty-paragraph consume applied at commit). When
   * `afterBlockId` is PROVIDED, the editor resolves it to the index immediately AFTER
   * that block (#indexAfterBlock; a stale/missing id appends). Markdown mode has no
   * tiptap, so insertIndexForBlock() returns -1 and the op carries index:-1 (append) —
   * dialogs insert in markdown this way. There is no block-path inline creation, so
   * every insert is block-index-native.
   * @param {string} kind
   * @param {object} [attrs]
   * @param {string} [afterBlockId] — insert after the top-level block with this id
   *   (append if stale/missing); omit to insert at the caret. A stable block id, never
   *   a position — the editor owns all index math.
   */
  createBlock(kind, attrs, afterBlockId) {
    attrs = attrs || {}
    // diagram default: an empty (source-less) diagram opens straight into edit mode.
    if (kind === 'diagram' && !attrs.source) attrs.mode = 'edit'
    const idx = (afterBlockId != null) ? this.#indexAfterBlock(afterBlockId) : this.insertIndexForBlock()
    this.applyBlockOps([{ type: 'create-block', kind: kind, attrs: attrs, index: idx }])
  }

  /**
   * Resolves a stable block id to the top-level block index immediately AFTER it —
   * the editor-internal id→index step for `createBlock`'s anchor. Markdown / no doc →
   * -1 (append); a stale/missing id → doc end (append). Keeps all position math inside
   * the editor so callers never touch the document model.
   * @param {string} blockId
   * @returns {number}
   */
  #indexAfterBlock(blockId) {
    const ed = this.editorPane
    if (!ed) return -1                                   // markdown / no doc → append
    const i = blockIndexAfter(ed.state.doc, blockId)     // block-position.js import
    return i >= 0 ? i : ed.state.doc.childCount          // stale / missing id → append
  }

  /**
   * Stashes the caret's NON-consuming block index for an async insert that will
   * outlive the current caret (P4.F, folds in the old pre-file-dialog capture
   * handler). The toolbar image insert opens a file dialog which blurs the editor
   * and loses the caret, so the resolved index is captured pre-dialog; the
   * cross-file upload handler reads window.__sieveCapturedInsertIndex and sends it
   * to smart-paste (without it a dropped/uploaded image would append to the doc
   * end). Uses blockIndexForInsert (NON-consuming) — capture must never eat the
   * caret's empty paragraph (a cancelled upload must leave the blank line). No-op
   * in markdown mode (no tiptap → nothing to anchor).
   */
  captureImageInsert() {
    if (this.editorPane) window.__sieveCapturedInsertIndex = this.blockIndexForInsert(this.captureInsertPos())
  }

  // ── AI job seam (P4.B/P4.E-D5: the single doc-mutation for ask + explain) ─────
  //
  // askAi is the ONE business-logic seam every AI entry point ends up at (the Ask
  // panel's send, the explain entry points). D-5: it is a PURE OPERATOR over the
  // SelectionContext the caller passes in — the context the panel LAST RENDERED
  // (the label the user saw). It NEVER re-reads the editor's live selection/target
  // on write; a live re-read would race the label (panel shows target C1, editor
  // acts on drifted C2). Everything — the answer's ref, the == highlight, and the
  // block index it lands at — derives from that passed context. Ask and explain
  // differ only by type (+ whether a question exists) and the markdown-explain
  // abort. Owns the doc mutation AND the target highlight/focus/cursor (the former
  // explain target-prep step folded in — it is one operation, not a caller pre-step).

  /**
   * The SINGLE AI-job seam. Pure over `context` (the SelectionContext the panel
   * rendered): builds the ai-block ref (Go walks the chain), applies the == target
   * highlight to `context.target.range` (the words the label named — NOT the live
   * selection), anchors the block insert AFTER the target's top-level block, flushes
   * the pending sync so Go's shadow is current, creates the ai-block, and collapses
   * the caret to the target end. EXPLAIN with no inline target (markdown) is a no-op
   * (the former target-prep abort); ASK still works in markdown.
   * @param {{ type: 'ask'|'explain', question?: string, context?: import('./selection-model.js').SelectionContext }} job
   * @returns {Promise<void>}
   */
  askAi({ type, question, context }) {
    // EXPLAIN needs an inline target; markdown mode has none → nothing to explain.
    if (type === 'explain' && this.mode === EditorMode.MARKDOWN) return Promise.resolve()
    const ctx = context || this.getSelectionContext()
    const aiCtx = buildAiContext(ctx)
    const ref = (aiCtx && aiCtx.blockRef) || 'doc'
    const blockType = type === 'explain' ? 'EXPLAIN' : 'ASK'
    const target = ctx && ctx.target
    const ed = /** @type {any} */ (this.editorPane)
    // Anchor the AI block AFTER the target's LAST block, using the context's block ids
    // (what the panel resolved) — NOT the live selection. This is a PURE context read
    // (no `ed` needed): createBlock owns the id→index resolution, so the anchor is
    // immune to a caret that drifted after the label rendered AND to NodeSelection
    // boundary ambiguity (an ai-block follow-up). A miss/no-anchor appends. Markdown
    // has no block ids → anchorId undefined → createBlock caret-derives (-1 append).
    const ids = (ctx.blockIds && ctx.blockIds.length) ? ctx.blockIds : (ctx.blockId ? [ctx.blockId] : [])
    const anchorId = ids[ids.length - 1]
    if (ed) {
      // Highlight the TARGET the panel showed (context.target.range) — protocol-
      // significant (the == mark tells Go which words the answer is about). Only a
      // ranged wysiwyg selection marks; a block/document target carries no == extent.
      if (target && target.kind === 'selection' && this.mode !== EditorMode.MARKDOWN && target.range) {
        applyTargetHighlight(ed, target.range)
      }
      ed.commands.focus()
    }
    const done = this.flushSave()
      .then(() => { this.createBlock('ai-block', { type: blockType, ref: ref, question: question || '' }, anchorId) })
      .catch((err) => { console.error('[editor] askAi flush error:', err) })
    // Editor owns its cursor: collapse focus to the target end (right where the
    // answer lands) — the former Ask-panel post-send hop, folded into the seam.
    if (ed && ed.view) {
      try { ed.commands.setTextSelection(ed.state.selection.to) } catch (e) { /* best-effort */ }
    }
    return done
  }

  // ── Insert position (P4.A: moved off editor.js's IIFE) ────────────────────────
  //
  // The insert-position math is EDITOR-scoped shared state: it is read by BOTH
  // surfaces (applyServerOp numeric fallback) AND the create paths (createBlock,
  // dialogs, askAi, extract), which reach a PUBLIC method on the live editor —
  // never a surface #private (the classic/module boundary). So it lives here as
  // public methods (D-1). The position helpers are ES imports from their owning
  // modules (ai/ai-target.js, base/block-position.js) — the shared TipTap bus is retired.

  /**
   * Stashes where the next inserted block goes (a doc pos, a {from,to} range, or
   * null). Fresh per creation path — a stale value can never leak into a later
   * insert.
   * @param {number|{from:number,to:number}|null} v
   */
  setInsertPos(v) { this.#insertPos = v }

  /** Clears the captured insert position. */
  clearInsertPos() { this.#insertPos = null }

  /**
   * Read-and-clear the captured insert position: a numeric pos feeds the
   * numeric-fallback insert (applyServerOp); any other shape just clears (fresh
   * capture per operation). The surface calls this via its takeInsertPos dep.
   * @returns {number|null}
   */
  takeInsertPos() {
    const p = (typeof this.#insertPos === 'number') ? this.#insertPos : null
    this.#insertPos = null
    return p
  }

  /**
   * captureInsertPos resolves WHERE the next inserted block goes, the single way
   * every additive creation path stamps the insert position (D-r.7). Delegates to
   * the shared blockInsertPos helper so block answers always land after the top-
   * level block (never at the caret — there is no block-path inline creation, so
   * the old isInline branch is gone). (In-place conversion / explicit-position
   * pastes set the insert position directly with their own {from,to}.)
   * @returns {number|null}
   */
  captureInsertPos() {
    const ed = /** @type {any} */ (this.editorPane)
    return ed ? blockInsertPos(ed.state) : null
  }

  /**
   * blockIndexForInsert maps a captured insert position (a PM doc position, or
   * null for "append") to the top-level BLOCK index Go's create-block op inserts
   * at — the number of top-level nodes that end at or before the position.
   * Delegates to the tested blockIndexForInsert import (base/block-position.js).
   * @param {number|null} pos
   * @returns {number}
   */
  blockIndexForInsert(pos) {
    const ed = /** @type {any} */ (this.editorPane)
    if (!ed) return -1
    return blockIndexForInsert(ed.state.doc, pos)
  }

  /**
   * commitInsertIndex — maps a captured insert position to the index Go creates
   * at, applying the empty-paragraph placement rule AT COMMIT TIME (never at
   * capture: a cancelled dialog must not eat the blank line). If the anchor is a
   * bare empty paragraph, delete it as an ordinary tracked prose edit (the
   * block-sync emits the same delete-block op a backspace would), flush the sync
   * so Go's shadow applies the delete BEFORE the create arrives on the same
   * socket, and return the anchor's own index — the new block takes its place.
   *
   * UNDO SANCTITY: the empty-paragraph delete is a PLAIN TRACKED prose edit —
   * NEVER addToHistory:false, never a softReload. Do not touch its tracked-ness.
   * @param {number|null} pos
   * @returns {number}
   */
  commitInsertIndex(pos) {
    const ed = /** @type {any} */ (this.editorPane)
    if (!ed) return -1
    const anchor = emptyParagraphAnchor(ed.state.doc, pos)
    if (!anchor) return this.blockIndexForInsert(pos)
    // Sole-block doc: keep the paragraph (deleting the doc's only child is
    // schema-invalid) — it simply becomes the paragraph after the new block.
    if (ed.state.doc.childCount > 1) {
      ed.view.dispatch(ed.state.tr.delete(anchor.from, anchor.to))
      if (this.#surface) this.#surface.flushPending()
    }
    return anchor.index
  }

  /**
   * insertIndexForBlock — the caret-derived block-insert index: capture at the caret
   * as a BLOCK and commit (with the empty-paragraph consume). The default index for
   * createBlock and the surface's paste/drop; exists so callers never touch the
   * capture+commit composition directly.
   * @returns {number}
   */
  insertIndexForBlock() { return this.commitInsertIndex(this.captureInsertPos()) }

  /**
   * insertIndexForBlockAt(pos) — commit an EXPLICIT position (a drop coordinate).
   * Identical to the old commitInsertIndex(insertPos) inline call.
   * @param {number} pos
   * @returns {number}
   */
  insertIndexForBlockAt(pos) { return this.commitInsertIndex(pos) }

  // ── Deferred empty-paragraph consume (issue #33: the SMART-PASTE / DROP path) ──
  //
  // commitInsertIndex above eats the empty-paragraph anchor EAGERLY — right for the
  // dialog / createBlock path, whose call point IS the confirmation. But smart-paste
  // commits BEFORE it knows the server matched a block: when Go reports no match
  // (plain external text claims no processor), the eager delete has already remapped
  // the orphaned caret into the adjacent code:true block, so the no-match fallback's
  // insertContent() prepends the text INSIDE that block. Split the composition: peek
  // the index without touching the doc, send it to Go, and consume the anchor ONLY
  // once matched:true — on no-match/error the blank line (and the caret) stay put and
  // the fallback pastes there, exactly like a native paste.

  /**
   * peekInsertIndex — the SIDE-EFFECT-FREE half of the empty-paragraph placement
   * rule. Returns the block index Go should create at, plus an anchor HANDLE
   * ({id, token}) to consume LATER once the server confirms a match — or a null
   * anchor when there is no empty-paragraph anchor (or the doc's sole child, which
   * commitInsertIndex also keeps: deleting the only child is schema-invalid). Unlike
   * commitInsertIndex it dispatches NOTHING.
   * @param {number|null} pos
   * @returns {{ index: number, anchor: {id: string, token: string}|null }}
   */
  peekInsertIndex(pos) {
    const ed = /** @type {any} */ (this.editorPane)
    if (!ed) return { index: -1, anchor: null }
    const anchor = emptyParagraphAnchor(ed.state.doc, pos)
    if (!anchor) return { index: this.blockIndexForInsert(pos), anchor: null }
    if (ed.state.doc.childCount <= 1) return { index: anchor.index, anchor: null }
    const node = ed.state.doc.child(anchor.index)
    const attrs = (node && node.attrs) || {}
    return { index: anchor.index, anchor: { id: attrs.id || '', token: attrs.token || '' } }
  }

  /**
   * peekInsertIndexForBlock — the caret-derived peek (smart-paste). The non-consuming
   * mirror of insertIndexForBlock: capture at the caret as a BLOCK and peek.
   * @returns {{ index: number, anchor: {id: string, token: string}|null }}
   */
  peekInsertIndexForBlock() { return this.peekInsertIndex(this.captureInsertPos()) }

  /**
   * peekInsertIndexAt(pos) — peek an EXPLICIT position (a drop coordinate). The
   * non-consuming mirror of insertIndexForBlockAt.
   * @param {number} pos
   * @returns {{ index: number, anchor: {id: string, token: string}|null }}
   */
  peekInsertIndexAt(pos) { return this.peekInsertIndex(pos) }

  /**
   * consumeInsertAnchor — the DEFERRED second half: once the server has CONFIRMED
   * the block-insert (matched:true), delete the empty-paragraph anchor as an
   * ordinary TRACKED prose edit (block-sync emits the same delete-block op a
   * backspace would) and flush so Go's shadow drops it. The anchor is located BY
   * IDENTITY (durable id, or the pre-ack transient token) — NEVER by a captured
   * position: the insert-block render-back can arrive first and shift positions.
   * No-op when the anchor is absent (the no-match / error path never calls this),
   * not found, the doc's sole child, or no longer empty (the user typed into it
   * before the ack — never destroy content).
   *
   * UNDO SANCTITY: a PLAIN TRACKED delete — never addToHistory:false, never a
   * softReload (mirrors commitInsertIndex's guard).
   * @param {{id: string, token: string}|null} anchor
   */
  consumeInsertAnchor(anchor) {
    if (!anchor || (!anchor.id && !anchor.token)) return
    const ed = /** @type {any} */ (this.editorPane)
    if (!ed || ed.state.doc.childCount <= 1) return
    let pos = -1
    let node = null
    ed.state.doc.forEach((child, offset) => {
      if (pos >= 0) return
      const a = (child && child.attrs) || {}
      if ((anchor.id && a.id === anchor.id) || (anchor.token && a.token === anchor.token)) {
        pos = offset
        node = child
      }
    })
    if (pos < 0 || !node) return
    // Guard: only ever consume a still-empty paragraph. If the user typed into the
    // blank line between the paste and the ack, leave it — a stray blank line is
    // benign; losing typed content is not.
    if ((/** @type {any} */ (node).textContent || '').trim() !== '') return
    ed.view.dispatch(ed.state.tr.delete(pos, pos + (/** @type {any} */ (node).nodeSize)))
    if (this.#surface) this.#surface.flushPending()
  }

  // ── Whole-document reload (P4.A: moved off editor.js's softReloadContent) ──────

  /**
   * @returns {boolean} whether a save should be suppressed (a whole-doc reload is
   * mid-flight; a save now would race the re-render).
   */
  isSaveSuppressed() { return this.#reloadInProgress }

  /**
   * softReload fetches the latest body from disk and re-renders the surface,
   * preserving the caret. ONLY for genuine doc LOADS (AI whole-doc resolve /
   * restore / extract re-render) — NEVER for an operation render-back
   * (renderBlocksIntoEditor's addToHistory:false wipes undo history by design;
   * CLAUDE.md). The pull/restore of the focus coordinate is surface-polymorphic.
   *
   * D-2: the window.sieveWorkspace.getSelectionContext()/setPosition() calls are
   * kept VERBATIM (pure motion) — they resolve to the active editor = this at call
   * time; not swapped to this.getSelectionContext()/applyPosition() in P4.A.
   * @returns {Promise<void>}
   */
  async softReload() {
    const mode = this.mode
    if (mode !== 'wysiwyg' && mode !== 'markdown') return
    if (mode === 'wysiwyg' && !this.editorPane) return
    this.#reloadInProgress = true
    // Pull the focus coordinate before the async fetch so caret is preserved
    // across the re-render (TRANSFORM, paste, extract, AI block resolve).
    const fctx = window.sieveWorkspace.getSelectionContext()
    try {
      const r = await fetch('/api/editor/load?uuid=' + encodeURIComponent(this.uuid))
      const data = await r.json()
      const body = data.body || ''
      const surface = this.#surface
      if (mode === 'wysiwyg' && this.editorPane && surface) {
        // Wysiwyg renders the backend's AUTHORITATIVE block list (markdown is NOT
        // a wysiwyg render input — a flat re-parse invents ids). reloadFromBlocks
        // wraps a multi-node prose block into ONE container carrying its id.
        surface.reloadFromBlocks(data.blocks || [], { allowEmpty: true })
        this.#reloadInProgress = false
        window.sieveWorkspace.setPosition(fctx)
      } else if (mode === 'markdown' && surface) {
        surface.replaceBody(body)
        this.#reloadInProgress = false
      } else {
        this.#reloadInProgress = false
      }
    } catch (err) {
      this.#reloadInProgress = false
      console.error('[editor] softReload failed', err)
    }
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
