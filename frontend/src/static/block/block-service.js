// @ts-check
// block-service.js — BlockService: the sieve protocol's anti-corruption layer,
// existing-block half (Block Renderer Contract,
// docs/design/archive/specs/2026-07-21-block-renderer-contract.md §service pair),
// and — since issue #49 Phase 1 — the WIRE OWNER. The WebSocket machinery that
// lived in AbstractEditor (channel-per-uuid socket, pending queue, awaiters,
// ping/pong watchdog, exponential-backoff reconnect) moved HERE verbatim:
// today's behaviour behind tomorrow's boundary. Wire frame shapes are FROZEN.
//
// ONE instance, constructed in the Workspace composition root and handed down
// (idiomatic-js §5 — never window.*). Renderers see THIS and only this: a
// renderer knows its block id, never a uuid — the service routes to the owning
// document via its blockId→{uuid, kind} index, seeded on document load
// (DocumentService.load → indexDocument) and maintained from the
// insert-block / replace-block render-backs passing through. The index is
// STICKY — deletes do not purge (undo can resurrect a block that must still
// route). This is deliberate: it is the skeleton of Phase 3's truth-mirror.
//
// The per-channel DELEGATE (registered by the editor via DocumentService.open)
// receives the inbound routing: server render-back ops → applyServerOp,
// flush-ack side effects → onFlushAck, everything else → onMessage; and
// resolveInsertIndex is the ONE sanctioned PM-resolution callback (the lens
// resolves indices, the service frames).

import { ContractViolation } from './sieve-block.js'
import { updateBlockOp } from './block-sync.js'

/**
 * @typedef {object} ChannelDelegate  the per-document inbound router (the live editor)
 * @property {(msg: Record<string, any>) => void} applyServerOp   server render-back ops (insert-block / replace-block / block-attrs-updated)
 * @property {(msg: Record<string, any>) => void} onFlushAck      flush-ack side effects (dirty-clear + chrome events live editor-side)
 * @property {(msg: Record<string, any>) => void} onMessage       everything else (error, block-extracted, unawaited mode replies)
 * @property {(afterBlockId?: string) => number}  resolveInsertIndex  id→index resolution for createBlock (the lens owns index math)
 */

/**
 * @typedef {object} BlockServiceOptions
 * @property {(url: string) => WebSocket} [socketFactory]
 *   — injected for tests; defaults to `new WebSocket(url)`
 * @property {(uuid: string) => string} [wsUrlFor]
 *   — injected for tests; defaults to the /api/ws URL for the uuid
 */

// WebSocket.readyState OPEN, fixed at 1 by the WHATWG spec. Referenced directly
// so this module does not depend on a global `WebSocket` (absent in the test env).
const WS_OPEN = 1

// Server-op render-backs the active surface applies (backend is the document
// source of truth; the placement semantics live in the surfaces).
const SURFACE_OPS = Object.freeze(['insert-block', 'replace-block', 'block-attrs-updated'])

/**
 * BlockChannel — one document's live wire: the socket, its pending queue,
 * awaiters, timers and reconnect state (moved VERBATIM from AbstractEditor's
 * #open/#closeSocket/#send/#awaitReply/#handleMessage — semantics preserved:
 * null onclose before close in teardown, pending-queue replay on open, 45s
 * pong watchdog, 15s ping interval, 1s→30s exponential backoff, 5s awaitReply
 * timeout, awaiter-consumed replies with late replies dropped).
 * Module-private — BlockService is the only constructor.
 */
class BlockChannel {
  /** @type {(url: string) => WebSocket} */ #socketFactory
  /** @type {() => string} */ #wsUrl
  /** @type {ChannelDelegate} */ #delegate
  /** @type {(msg: Record<string, any>) => void} routing-index maintenance hook (BlockService) */ #onIndexMsg

  /** @type {WebSocket|null} */ #ws = null
  /** @type {string[]} JSON strings queued before the socket is OPEN */ #pending = []
  /** @type {Record<string, {resolve: (m: object) => void, reject: (e: Error) => void}>} */ #awaiters = {}
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
    // Faithful to openEditorWs: start by tearing down any prior socket + timers
    // and clearing the queues, then connect fresh.
    this.close()

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
   * Closes the socket and cancels timers WITHOUT arming a reconnect (nulls
   * onclose first, exactly like the retired closeEditorWs). Clears the pending
   * + awaiter queues.
   */
  close() {
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
      // Flush-ack side effects run for EVERY flush-ack — awaited (flushSave) or
      // side-channel (EditorService's background notifySaved). The dirty-clear
      // + chrome events live in the editor's delegate, out of the transport.
      this.#delegate.onFlushAck(msg)
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
    // The service's routing index learns the block's identity as the op passes.
    if (SURFACE_OPS.indexOf(msg.type) >= 0) {
      this.#onIndexMsg(msg)
      this.#delegate.applyServerOp(msg)
      return
    }

    // Everything else (error, block-extracted, unawaited mode replies) goes to
    // the registered message router.
    this.#delegate.onMessage(msg)
  }

  /**
   * Sends a message on the socket, or queues it if the socket is not yet OPEN.
   * @param {object} msg
   */
  send(msg) {
    const data = JSON.stringify(msg)
    if (this.#ws && this.#ws.readyState === WS_OPEN) {
      this.#ws.send(data)
    } else {
      this.#pending.push(data)
    }
  }

  /**
   * Sends a message and resolves with the reply of an EXPLICIT reply type, or
   * rejects after 5s. (The mode-handshake replies are markdown-content /
   * wysiwyg-content — not `<type>-ack` — hence reply-type keying.)
   * @param {string} replyType
   * @param {object} msg
   * @param {string} [label]
   *   — timeout-message label
   * @returns {Promise<any>}
   */
  awaitReply(replyType, msg, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        delete this.#awaiters[replyType]
        reject(new Error('ws timeout: ' + (label || replyType)))
      }, 5000)
      this.#awaiters[replyType] = {
        resolve: (m) => { clearTimeout(timer); resolve(m) },
        reject: (e) => { clearTimeout(timer); reject(e) },
      }
      this.send(msg)
    })
  }
}

export class BlockService {
  /** @type {(url: string) => WebSocket} */ #socketFactory
  /** @type {(uuid: string) => string} */ #wsUrlFor
  /** @type {Map<string, BlockChannel>} uuid → live channel */ #channels = new Map()
  /** @type {Map<string, {uuid: string, kind: string}>} blockId → routing entry (STICKY — never purged on delete) */ #blocks = new Map()

  /** @param {BlockServiceOptions} [options]
   *    the test seams (empty in prod) */
  constructor(options = {}) {
    this.#socketFactory = options.socketFactory || ((url) => new WebSocket(url))
    this.#wsUrlFor = options.wsUrlFor || ((uuid) => BlockService.#defaultUrl(uuid))
  }

  /** @param {string} uuid @returns {string} the production /api/ws URL */
  static #defaultUrl(uuid) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    let host = location.host
    if (/** @type {any} */ (window).__sieveDevServerPort) host = '127.0.0.1:' + /** @type {any} */ (window).__sieveDevServerPort
    return proto + '//' + host + '/api/ws?uuid=' + encodeURIComponent(uuid)
  }

  // ── Channel lifecycle (DocumentService.open/close front these) ─────────────

  /**
   * Opens the live channel for a document. An existing channel for the uuid is
   * torn down first (mirrors the retired #open's closeSocket-first semantics —
   * in practice activateDocument's close-before-open ordering means this never
   * fires in the app).
   * @param {string} uuid
   * @param {ChannelDelegate} delegate
   */
  openChannel(uuid, delegate) {
    if (!uuid) throw new ContractViolation('BlockService.openChannel: uuid is required')
    if (!delegate) throw new ContractViolation('BlockService.openChannel: delegate is required')
    const existing = this.#channels.get(uuid)
    if (existing) existing.close()
    this.#channels.set(uuid, new BlockChannel(
      this.#socketFactory,
      () => this.#wsUrlFor(uuid),
      delegate,
      (msg) => this.#indexFromMessage(uuid, msg),
    ))
  }

  /**
   * Closes a document's channel (no reconnect). The routing index is KEPT —
   * sticky by design (see the header).
   * @param {string} uuid
   */
  closeChannel(uuid) {
    const ch = this.#channels.get(uuid)
    if (!ch) return
    ch.close()
    this.#channels.delete(uuid)
  }

  // ── Routing index ───────────────────────────────────────────────────────────

  /**
   * Seeds the blockId→{uuid, kind} routing index from a document's block list
   * — typed envelopes (DocumentService.load) or raw wire blocks (the
   * wysiwyg-content reply in DocumentService.save); both carry .id/.kind. The
   * 'prose' fallback mirrors the envelope constructor's kind default.
   * @param {string} uuid
   * @param {Array<{id?: string, kind?: string}>} blocks
   */
  indexDocument(uuid, blocks) {
    for (const b of blocks || []) {
      if (b && b.id) this.#blocks.set(b.id, { uuid: uuid, kind: b.kind || 'prose' })
    }
  }

  /**
   * Learns identities from insert-block / replace-block render-backs passing
   * through the channel (block-attrs-updated carries no kind — nothing to learn).
   * The 'code' fallback mirrors the wysiwyg surface's own kind default.
   * @param {string} uuid @param {Record<string, any>} msg
   */
  #indexFromMessage(uuid, msg) {
    if (msg.type === 'insert-block' && msg.id) {
      this.#blocks.set(msg.id, { uuid: uuid, kind: msg.kind || 'code' })
    } else if (msg.type === 'replace-block' && msg.newId) {
      this.#blocks.set(msg.newId, { uuid: uuid, kind: msg.newKind || 'code' })
    }
  }

  /**
   * Resolve a block id to its routing entry, or null (unknown id → the caller
   * warns + drops: fire-and-forget parity — never throw mid-edit).
   * @param {string} blockId @returns {{uuid: string, kind: string}|null}
   */
  #entryFor(blockId) {
    return (blockId && this.#blocks.get(blockId)) || null
  }

  // ── Public verbs (blockId-addressed — renderers and lenses end here) ────────

  /**
   * Push an attribute patch (a change DELTA in wire vocabulary) to the block's
   * document truth. OPAQUE to this class — the keys are never interpreted here,
   * only framed: the sole author is the owning renderer's private `_pushAttrs`
   * (the one class that knows its schema), and the sole interpreter is Go's
   * processor for the kind. No consumer ever speaks these keys (contract
   * §semantic-API doctrine / §boundary datatype rule). `opts.aliases` is lifted
   * to the op's top-level aliases field — framing knowledge, service-internal.
   * Frame frozen: {type:'block-op', uuid, op:{type:'update-block', blockId,
   * kind, attrs, aliases?}} with kind from the routing index.
   * @param {string} blockId @param {Record<string, any>} patch
   * @param {{aliases?: string[]}} [opts]
   */
  updateAttributes(blockId, patch, opts) {
    const entry = this.#entryFor(blockId)
    if (!entry) { console.warn('[block-service] updateAttributes: unknown block id, dropped', blockId); return }
    const ch = this.#channels.get(entry.uuid)
    if (!ch) return // channel-less document — no-op send (socketless parity)
    const op = updateBlockOp({ id: blockId, kind: entry.kind, attrs: patch, aliases: opts && opts.aliases })
    ch.send({ type: 'block-op', uuid: entry.uuid, op: op })
  }

  /**
   * Push the block's raw content outward (the outbound truth channel — the
   * editor lens's sync closure ends here, never at a socket). The default
   * content attr is `content`; kinds whose content attr differs (code /
   * diagram / log → `source`) override setContent in THEIR renderer subclass.
   * @param {string} blockId @param {string} text
   */
  setContent(blockId, text) {
    this.updateAttributes(blockId, { content: text })
  }

  /**
   * Re-run the block's backend job (kind-blind: Go knows what retry means).
   * Frame frozen: {type:'retry-block-job', uuid, id}.
   * @param {string} blockId
   */
  retry(blockId) {
    const entry = this.#entryFor(blockId)
    if (!entry) { console.warn('[block-service] retry: unknown block id, dropped', blockId); return }
    const ch = this.#channels.get(entry.uuid)
    if (!ch) return
    ch.send({ type: 'retry-block-job', uuid: entry.uuid, id: blockId })
  }

  /**
   * Frames a block extraction/transform (the PM-side prep — index resolution,
   * context stamping, entry resolution — stays in AbstractEditor.extract; the
   * payload arrives fully prepared). Frame frozen: {type:'extract', blockId,
   * targetKind, operation, entries, index} — NO uuid; the server resolves the
   * document from the channel. The channel is resolved via the blockId's index
   * entry, falling back to the sole open channel when the id is absent or
   * unindexed; ambiguity warns loudly and drops.
   * @param {{blockId?: string, targetKind: string, operation: string, entries: object[], index: number}} payload
   */
  extract(payload) {
    const entry = this.#entryFor(payload.blockId || '')
    let ch = entry ? this.#channels.get(entry.uuid) : null
    if (!ch) {
      if (this.#channels.size === 1) {
        ch = this.#channels.values().next().value
      } else if (this.#channels.size > 1) {
        console.warn('[block-service] extract: ambiguous channel for block', payload.blockId, '— dropped')
        return
      }
    }
    if (!ch) return // no open channel — no-op send (socketless parity)
    ch.send({
      type: 'extract',
      blockId: payload.blockId,
      targetKind: payload.targetKind,
      operation: payload.operation,
      entries: payload.entries,
      index: payload.index,
    })
  }

  // ── Service-pair internals (@protected by convention — DocumentService only) ─
  // JS #private fields don't cross the class boundary, so the DocumentService-
  // facing framing surface is underscore-marked instead — same contract as the
  // renderers' _pushAttrs seam. Nothing outside block/ calls these.

  /** @param {string} uuid @returns {boolean} whether a live channel exists */
  _hasChannel(uuid) { return this.#channels.has(uuid) }

  /**
   * Send a frame on a document's channel; channel-less uuids no-op (the
   * socketless-parity rule: sends drop, never throw).
   * @param {string} uuid @param {object} msg
   */
  _send(uuid, msg) {
    const ch = this.#channels.get(uuid)
    if (ch) ch.send(msg)
  }

  /**
   * Send + await a typed reply on a document's channel; channel-less uuids
   * reject with the socketless error (awaits resolve-or-reject, never hang).
   * @param {string} uuid @param {string} replyType @param {object} msg @param {string} [label]
   * @returns {Promise<any>}
   */
  _awaitReply(uuid, replyType, msg, label) {
    const ch = this.#channels.get(uuid)
    if (!ch) return Promise.reject(new Error('editor has no live channel'))
    return ch.awaitReply(replyType, msg, label)
  }

  /**
   * The delegate registered for a document's channel, or null (DocumentService
   * reads resolveInsertIndex off it for createBlock).
   * @param {string} uuid @returns {ChannelDelegate|null}
   */
  _delegateFor(uuid) {
    const ch = this.#channels.get(uuid)
    return ch ? ch.delegate : null
  }
}
