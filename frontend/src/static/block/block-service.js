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
// document via its blockId→{uuid, kind, block} index, seeded on document load
// (DocumentService.load → indexDocument) and maintained from the
// insert-block / replace-block / block-attrs-updated render-backs passing
// through (#mirrorFromMessage). The index is STICKY — deletes do not purge
// (undo can resurrect a block that must still route). Since issue #49 Phase 3
// the `block` slot IS the truth-mirror: the last envelope Go authored for the
// id, advanced ONLY by inbound server truth (indexDocument + #mirrorFromMessage
// — the one-writer rule), read by the sieveBlockFor seam's mirror-first lookup.
//
// The per-channel DELEGATE (registered by the editor via DocumentService.open)
// receives the inbound routing: server render-back ops → applyServerOp,
// flush-ack side effects → onFlushAck, everything else → onMessage; and
// resolveInsertIndex is the ONE sanctioned PM-resolution callback (the lens
// resolves indices, the service frames).

import { SieveBlock, ContractViolation } from './sieve-block.js'
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
 * awaiters, timers and reconnect state (moved from AbstractEditor's
 * #open/#closeSocket/#send/#awaitReply/#handleMessage — transport semantics
 * preserved: null onclose before close in teardown, pending-queue replay on
 * open, 45s pong watchdog, 15s ping interval, 1s→30s exponential backoff, 5s
 * await timeout, awaiter-consumed replies with late replies dropped). Issue #49
 * Phase 2 rebuilt the awaiter registry on client-minted opId keys (was reply-type
 * keys), splitting the timeout policy into awaitReply (rejects — handshakes) and
 * awaitAck (resolves {ok,error} — block-op / extract).
 * Module-private — BlockService is the only constructor.
 */
class BlockChannel {
  /** @type {(url: string) => WebSocket} */ #socketFactory
  /** @type {() => string} */ #wsUrl
  /** @type {ChannelDelegate} */ #delegate
  /** @type {(msg: Record<string, any>) => void} routing-index maintenance hook (BlockService) */ #onIndexMsg

  /** @type {WebSocket|null} */ #ws = null
  /** @type {string[]} JSON strings queued before the socket is OPEN */ #pending = []
  /** @type {Map<string, (msg: Record<string, any>) => void>} opId → the reply settler (issue #49 Phase 2: correlation is by client-minted opId, never reply-type) */ #awaiters = new Map()
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
    // Clear the awaiter registry but leave the per-awaiter timers running: a flip
    // in flight when the socket closes still rejects/resolves at 5s (the
    // destroy-mid-flight semantics), it never hangs.
    this.#awaiters.clear()
  }

  /** @param {{data?: string}} event */
  #handleMessage(event) {
    const msg = JSON.parse(event.data || '{}')
    if (msg.type === 'pong') {
      this.#lastPong = Date.now()
      return
    }
    if (msg.type === 'flush-ack') {
      // Flush-ack side effects run for EVERY flush-ack — request-correlated
      // (carries opId) or the unsolicited background notifySaved (no opId). The
      // dirty-clear + chrome events live in the editor's delegate, out of the
      // transport.
      this.#delegate.onFlushAck(msg)
    }

    // opId correlation (issue #49 Phase 2): a reply carrying a live opId awaiter
    // is CONSUMED by it — the request/reply pairing is by client-minted opId, so
    // two concurrent same-type handshakes never cross-resolve. A reply whose
    // awaiter already timed out is DROPPED here: the flush-ack side effect above
    // already ran, and block-op-ack / extract-ack have none. It must never mount
    // a stale surface. Unsolicited replies (no opId) route below exactly as today.
    if (msg.opId !== undefined) {
      const settle = this.#awaiters.get(msg.opId)
      if (settle) {
        this.#awaiters.delete(msg.opId)
        settle(msg)
      }
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

    // Everything else (error, block-extracted, unawaited flush-ack) goes to the
    // registered message router.
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
   * Sends a message under the given client-minted opId and resolves with the
   * reply that ECHOES it, or REJECTS after 5s. The HANDSHAKE semantic: flush →
   * flush-ack, enter-markdown → markdown-content, enter-wysiwyg → wysiwyg-content.
   * setMode's stay-on-failure depends on the rejection. The opId is stamped onto
   * the outgoing frame here (wire-additive — Go echoes it back).
   * @param {string} opId @param {object} msg @param {string} [label]
   *   — timeout-message label
   * @returns {Promise<any>}
   */
  awaitReply(opId, msg, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#awaiters.delete(opId)
        reject(new Error('ws timeout: ' + (label || opId)))
      }, 5000)
      this.#awaiters.set(opId, (m) => { clearTimeout(timer); resolve(m) })
      this.send(Object.assign({}, msg, { opId: opId }))
    })
  }

  /**
   * Sends a message under the given client-minted opId and resolves the ACK
   * RESULT — {ok, error?} from the echoing `*-ack` reply, or {ok:false,
   * error:'ws timeout: …'} after 5s. It NEVER rejects: block-op / extract acks
   * are fire-and-forget for most callers (the wysiwyg observer's op batch), so an
   * ignored promise must never surface an unhandled rejection.
   * @param {string} opId @param {object} msg @param {string} [label]
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  awaitAck(opId, msg, label) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#awaiters.delete(opId)
        resolve({ ok: false, error: 'ws timeout: ' + (label || opId) })
      }, 5000)
      this.#awaiters.set(opId, (m) => { clearTimeout(timer); resolve({ ok: m.ok === true, error: m.error }) })
      this.send(Object.assign({}, msg, { opId: opId }))
    })
  }
}

export class BlockService {
  /** @type {(url: string) => WebSocket} */ #socketFactory
  /** @type {(uuid: string) => string} */ #wsUrlFor
  /** @type {Map<string, BlockChannel>} uuid → live channel */ #channels = new Map()
  /** @type {Map<string, {uuid: string, kind: string, block: SieveBlock|null}>} blockId → routing entry + the TRUTH-MIRROR envelope (STICKY — never purged on delete). `block` is the last envelope Go authored for this id; null when only the routing pair is known (raw-seeded / message-learned-without-mirror). ONE-WRITER RULE: written ONLY by indexDocument + #mirrorFromMessage (inbound server truth) — no outbound verb touches it. */ #blocks = new Map()
  /** @type {Map<string, Set<(block: SieveBlock) => void>>} uuid → onBlockUpdated listeners (document-scoped; fired after a block-attrs-updated mirror advance) */ #blockUpdateListeners = new Map()
  /** @type {number} monotonic opId source; per-BlockService so ids never collide across channels (correlation is uuid+opId, but a global counter also survives a takeover cleanly) */ #opSeq = 0

  /** @param {BlockServiceOptions} [options]
   *    the test seams (empty in prod) */
  constructor(options = {}) {
    this.#socketFactory = options.socketFactory || ((url) => new WebSocket(url))
    this.#wsUrlFor = options.wsUrlFor || ((uuid) => BlockService.#defaultUrl(uuid))
  }

  /** Mints the next request-correlation opId (issue #49 Phase 2). Monotonic and
   *  per-service, so it is unique within any uuid AND across channels.
   *  @returns {string} */
  #mintOpId() { return 'op-' + (++this.#opSeq) }

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
      (msg) => this.#mirrorFromMessage(uuid, msg),
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

  // ── Routing index + truth-mirror (one writer: inbound server truth) ─────────

  /**
   * Seeds the blockId→{uuid, kind, block} index + TRUTH-MIRROR from a document's
   * block list. The mirror stores the typed envelope itself (DocumentService.load
   * and .save hand SieveBlock[] through, already typed); a raw wire map (legacy
   * test seeding) records the routing pair with a null envelope — the next server
   * truth re-seeds it. Both carry .id/.kind (SieveBlock via getters); the 'prose'
   * fallback mirrors the envelope constructor's kind default.
   * @param {string} uuid
   * @param {Array<SieveBlock|{id?: string, kind?: string}>} blocks
   */
  indexDocument(uuid, blocks) {
    for (const b of blocks || []) {
      if (!b || !b.id) continue
      this.#blocks.set(b.id, {
        uuid: uuid,
        kind: b.kind || 'prose',
        block: b instanceof SieveBlock ? b : null,
      })
    }
  }

  /**
   * Advances the truth-mirror from a server render-back passing through the
   * channel — the SERVICE authors the envelope from the wire message (the
   * anti-corruption boundary). Runs BEFORE delegate.applyServerOp so the seam's
   * NodeView.update re-resolves the refreshed envelope. block-attrs-updated MERGES
   * onto the prior payload and notifies onBlockUpdated listeners; insert/replace
   * author fresh envelopes. The 'code' fallback mirrors the wysiwyg surface's own
   * kind default. ONE-WRITER RULE: this + indexDocument are the ONLY mirror writers.
   * @param {string} uuid @param {Record<string, any>} msg
   */
  #mirrorFromMessage(uuid, msg) {
    if (msg.type === 'insert-block' && msg.id) {
      const kind = msg.kind || 'code'
      const block = new SieveBlock(kind, Object.assign({}, msg.attrs, { id: msg.id }))
      this.#blocks.set(msg.id, { uuid: uuid, kind: kind, block: block })
    } else if (msg.type === 'replace-block' && msg.newId) {
      const kind = msg.newKind || 'code'
      const block = new SieveBlock(kind, Object.assign({}, msg.attrs, { id: msg.newId }))
      // The old id entry stays for routing (undo can resurrect it); the new id
      // becomes the mirror's authoritative envelope for the replacement.
      this.#blocks.set(msg.newId, { uuid: uuid, kind: kind, block: block })
    } else if (msg.type === 'block-attrs-updated' && msg.id) {
      const entry = this.#blocks.get(msg.id)
      if (!entry) return // unknown id → nothing to merge onto (no kind to author)
      const prior = entry.block ? entry.block.payload : {}
      const block = new SieveBlock(entry.kind, Object.assign({}, prior, msg.attrs, { id: msg.id }))
      this.#blocks.set(msg.id, { uuid: entry.uuid, kind: entry.kind, block: block })
      this.#emitBlockUpdated(entry.uuid, block)
    }
  }

  /**
   * The current truth-mirror envelope for a block id, or null (unknown id / a
   * routing-only entry that never received server truth). Consumers: the
   * sieveBlockFor seam's mirror-first lookup.
   * @param {string} blockId @returns {SieveBlock|null}
   */
  envelopeFor(blockId) {
    const entry = blockId && this.#blocks.get(blockId)
    return (entry && entry.block) || null
  }

  /**
   * Resolve a block id to its routing entry, or null (unknown id → the caller
   * warns + drops: fire-and-forget parity — never throw mid-edit).
   * @param {string} blockId @returns {{uuid: string, kind: string, block: SieveBlock|null}|null}
   */
  #entryFor(blockId) {
    return (blockId && this.#blocks.get(blockId)) || null
  }

  /**
   * Notifies a document's onBlockUpdated listeners with the refreshed envelope.
   * A throwing listener is isolated — it never breaks the mirror advance or the
   * sibling listeners.
   * @param {string} uuid @param {SieveBlock} block
   */
  #emitBlockUpdated(uuid, block) {
    const set = this.#blockUpdateListeners.get(uuid)
    if (!set) return
    for (const listener of set) {
      try { listener(block) } catch (e) { console.error('[block-service] onBlockUpdated listener threw', e) }
    }
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
   * Frame frozen (opId added wire-additive on the outer envelope): {type:'block-op',
   * uuid, op:{type:'update-block', blockId, kind, attrs, aliases?}, opId} with kind
   * from the routing index. Returns the ack RESULT {ok, error?} (resolves, never
   * rejects); fire-and-forget callers ignore it — the promise never surfaces an
   * unhandled rejection. Unknown-id / channel-less drops resolve {ok:false, error}.
   * @param {string} blockId @param {Record<string, any>} patch
   * @param {{aliases?: string[]}} [opts]
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  updateAttributes(blockId, patch, opts) {
    const entry = this.#entryFor(blockId)
    if (!entry) {
      console.warn('[block-service] updateAttributes: unknown block id, dropped', blockId)
      return Promise.resolve({ ok: false, error: 'dropped: unknown block id ' + blockId })
    }
    const ch = this.#channels.get(entry.uuid)
    if (!ch) return Promise.resolve({ ok: false, error: 'dropped: no live channel for ' + entry.uuid })
    const op = updateBlockOp({ id: blockId, kind: entry.kind, attrs: patch, aliases: opts && opts.aliases })
    return ch.awaitAck(this.#mintOpId(), { type: 'block-op', uuid: entry.uuid, op: op }, 'update-block ' + blockId)
  }

  /**
   * Push the block's raw content outward (the outbound truth channel — the
   * editor lens's sync closure ends here, never at a socket). The default
   * content attr is `content`; kinds whose content attr differs (code /
   * diagram / log → `source`) override setContent in THEIR renderer subclass.
   * Returns updateAttributes' ack RESULT {ok, error?}.
   * @param {string} blockId @param {string} text
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  setContent(blockId, text) {
    return this.updateAttributes(blockId, { content: text })
  }

  /**
   * Backend-declared extraction capability discovery: given a source kind and its
   * content entries, ask Go which (kind, actions) it can extract/transform into.
   * Blockid-adjacent (the existing-block half of the boundary — capabilities OF a
   * block's content). The wire (POST /api/detect-extractions) is UNCHANGED; only
   * the boundary moves — consumers stop speaking fetch/URLs. Resolves the offers
   * array Go returns ([{kind, actions}]); the caller assembles the menu and owns
   * its own catch (error parity — the caller's swallow stays where it was).
   * @param {{sourceKind: string, entries: object[]}} payload
   * @returns {Promise<Array<{kind: string, actions: string[]}>>}
   */
  detectExtractions(payload) {
    return fetch('/api/detect-extractions', {
      method: 'POST',
      body: JSON.stringify({ sourceKind: payload.sourceKind, entries: payload.entries }),
      headers: { 'Content-Type': 'application/json' },
    }).then(function (res) { return res.json() })
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
   * unindexed; ambiguity warns loudly and drops. Returns the extract-ack RESULT
   * {ok, error?} (resolves, never rejects); the additive block-extracted hint
   * still arrives separately on onMessage. Drops resolve {ok:false, error}.
   * @param {{blockId?: string, targetKind: string, operation: string, entries: object[], index: number}} payload
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  extract(payload) {
    const entry = this.#entryFor(payload.blockId || '')
    let ch = entry ? this.#channels.get(entry.uuid) : null
    if (!ch) {
      if (this.#channels.size === 1) {
        ch = this.#channels.values().next().value
      } else if (this.#channels.size > 1) {
        console.warn('[block-service] extract: ambiguous channel for block', payload.blockId, '— dropped')
        return Promise.resolve({ ok: false, error: 'dropped: ambiguous channel' })
      }
    }
    if (!ch) return Promise.resolve({ ok: false, error: 'dropped: no open channel' })
    return ch.awaitAck(this.#mintOpId(), {
      type: 'extract',
      blockId: payload.blockId,
      targetKind: payload.targetKind,
      operation: payload.operation,
      entries: payload.entries,
      index: payload.index,
    }, 'extract ' + payload.targetKind)
  }

  // ── Service-pair internals (@protected by convention — DocumentService only) ─
  // JS #private fields don't cross the class boundary, so the DocumentService-
  // facing framing surface is underscore-marked instead — same contract as the
  // renderers' _pushAttrs seam. Nothing outside block/ calls these.

  /** @param {string} uuid @returns {boolean} whether a live channel exists */
  _hasChannel(uuid) { return this.#channels.has(uuid) }

  /**
   * Subscribe to a document's block-attrs-updated mirror advances (DocumentService
   * fronts this as onBlockUpdated). The listener fires AFTER the mirror update with
   * the refreshed typed envelope; the returned function unsubscribes. Document-scoped
   * per the contract — renderers never subscribe (inbound stays update(block) via
   * the lens).
   * @param {string} uuid @param {(block: SieveBlock) => void} listener
   * @returns {() => void} unsubscribe
   */
  _onBlockUpdated(uuid, listener) {
    let set = this.#blockUpdateListeners.get(uuid)
    if (!set) { set = new Set(); this.#blockUpdateListeners.set(uuid, set) }
    set.add(listener)
    return () => {
      const s = this.#blockUpdateListeners.get(uuid)
      if (s) { s.delete(listener); if (s.size === 0) this.#blockUpdateListeners.delete(uuid) }
    }
  }

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
   * Send + await a HANDSHAKE reply on a document's channel, correlated by a freshly
   * minted opId; channel-less uuids reject with the socketless error (awaits
   * resolve-or-reject, never hang). REJECTS on 5s timeout — setMode's
   * stay-on-failure depends on it.
   * @param {string} uuid @param {object} msg @param {string} [label]
   * @returns {Promise<any>}
   */
  _awaitReply(uuid, msg, label) {
    const ch = this.#channels.get(uuid)
    if (!ch) return Promise.reject(new Error('editor has no live channel'))
    return ch.awaitReply(this.#mintOpId(), msg, label)
  }

  /**
   * Send + await an ACK on a document's channel, correlated by a freshly minted
   * opId. Resolves the ack RESULT {ok, error?} — including on a channel-less uuid
   * ({ok:false, error:'dropped: …'}) and on timeout — and NEVER rejects, so a
   * fire-and-forget caller can ignore the promise safely. (createBlock / deleteBlock
   * route here.)
   * @param {string} uuid @param {object} msg @param {string} [label]
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  _awaitAck(uuid, msg, label) {
    const ch = this.#channels.get(uuid)
    if (!ch) return Promise.resolve({ ok: false, error: 'dropped: no live channel for ' + uuid })
    return ch.awaitAck(this.#mintOpId(), msg, label)
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
