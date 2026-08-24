// @ts-check
// container-transport.js — the WIRE OWNER for document channels. One
// socket per open document uuid, with its pending queue, awaiters, ping/pong
// watchdog and exponential-backoff reconnect (block-channel.js). Wire frame
// shapes are FROZEN.
//
// TRANSPORT AND NOTHING ELSE (issue #96). It holds no view of what a document
// contains: the id→block cache it used to keep is gone, and with it every
// blockId-addressed verb that needed one. What a client knows about a container
// is the FOLLOWER MODEL the host keeps (container/container-model.js), fed from
// `observeFrames` below — one place, one writer, and a lens reads it through a
// provider rather than asking a socket.
//
// ONE instance, constructed in the Workspace composition root and handed down
// (idiomatic-js §5 — never window.*). Its callers are the host's own data plane:
// DocumentService, and container/container-binding.js, which is this same
// surface with a uuid bound once at mount.
//
// The per-channel DELEGATE receives what the transport does not settle itself
// and the follower model does not claim — a server error, and little else.

import { ContractViolation } from '../contract/sieve-block.js'
import { BlockChannel } from './block-channel.js'
import { WsDial } from './ws-dial.js'
import { DocumentFrame } from '../generated/protocol.js'

/**
 * @typedef {import('./block-channel.js').ChannelDelegate} ChannelDelegate
 */

/**
 * @typedef {object} ContainerTransportOptions
 * @property {(url: string, protocols?: string[]) => WebSocket} [socketFactory]
 *   — injected for tests; defaults to `new WebSocket(url, protocols)`
 * @property {(uuid: string) => string} [wsUrlFor]
 *   — injected for tests; defaults to the document-channel URL for the uuid
 */

export class ContainerTransport {
  /** @type {(url: string, protocols?: string[]) => WebSocket} */ #socketFactory
  /** @type {(uuid: string) => string} */ #wsUrlFor
  /** @type {Map<string, BlockChannel>} uuid → live channel */ #channels = new Map()
  /** @type {Map<string, Set<(msg: Record<string, any>) => void>>} uuid → raw inbound-frame observers (see observeFrames) */ #frameObservers = new Map()
  /** @type {number} monotonic opId source; per-ContainerTransport so ids never collide across channels (correlation is uuid+opId, but a global counter also survives a takeover cleanly) */ #opSeq = 0

  /** @param {ContainerTransportOptions} [options]
   *    the test seams (empty in prod) */
  constructor(options = {}) {
    this.#socketFactory = options.socketFactory || ((url, protocols) => new WebSocket(url, protocols))
    this.#wsUrlFor = options.wsUrlFor || ((uuid) => ContainerTransport.#defaultUrl(uuid))
  }

  /** Mints the next request-correlation opId (issue #49 Phase 2). Monotonic and
   *  per-service, so it is unique within any uuid AND across channels.
   *  @returns {string} */
  #mintOpId() { return 'op-' + (++this.#opSeq) }

  /**
   * The production document-channel URL. The uuid is a PATH segment;
   * encodeURIComponent is kept as harmless hygiene, not a safety mechanism — chi
   * routes document channels on RawPath, so an encoded handle (e.g. `prompt:x` →
   * `prompt%3Ax`) arrives at Go STILL ENCODED, never decoded back to the raw `:`.
   * It does not rescue a non-uuid handle carrying a `/` or `:`; only ident UUIDs
   * ever open a document channel in practice.
   *
   * The dev-server host rewrite is load-bearing: WebKitGTK cannot carry a
   * WebSocket upgrade over the app's custom scheme, so the wire always rides the
   * loopback listener.
   * @param {string} uuid @returns {string}
   */
  static #defaultUrl(uuid) {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
    let host = location.host
    if (/** @type {any} */ (window).__sieveDevServerPort) host = '127.0.0.1:' + /** @type {any} */ (window).__sieveDevServerPort
    return proto + '//' + host + '/api/ws/document/' + encodeURIComponent(uuid)
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
    if (!uuid) throw new ContractViolation('ContainerTransport.openChannel: uuid is required')
    if (!delegate) throw new ContractViolation('ContainerTransport.openChannel: delegate is required')
    const existing = this.#channels.get(uuid)
    if (existing) existing.close()
    this.#channels.set(uuid, new BlockChannel(
      // The channel owns the socket's LIFE; dialling it — url and credential
      // alike — is the wire owner's business, so it is bound here.
      (url) => this.#socketFactory(url, WsDial.protocols()),
      () => this.#wsUrlFor(uuid),
      delegate,
      (msg) => this.#onInbound(uuid, msg),
    ))
  }

  /**
   * Closes a document's channel (no reconnect).
   * @param {string} uuid
   */
  closeChannel(uuid) {
    const ch = this.#channels.get(uuid)
    if (!ch) return
    ch.close()
    this.#channels.delete(uuid)
  }

  /**
   * Every routed inbound frame on a document's channel, in arrival order, before
   * the delegate sees it.
   *
   * Frames an awaiter consumed never arrive here: the transport settles those and
   * returns (block-channel.js). Whole-container ANSWERS (load-content,
   * wysiwyg-content) are exactly that shape, which is why they reach a follower
   * through DocumentService.onContent instead.
   * @param {string} uuid @param {Record<string, any>} msg
   */
  #onInbound(uuid, msg) {
    const observers = this.#frameObservers.get(uuid)
    if (!observers) return
    for (const observe of observers) {
      try { observe(msg) } catch (e) { console.error('[block-service] frame observer threw', e) }
    }
  }

  /**
   * Subscribe to a document's raw inbound frames (see #onInbound). The returned
   * function unsubscribes. This is the seam the container's follower model feeds
   * from — and the only inbound seam there is, which is what makes the model the
   * single client-side account of what a container holds.
   * @param {string} uuid @param {(msg: Record<string, any>) => void} observer
   * @returns {() => void} unsubscribe
   */
  observeFrames(uuid, observer) {
    if (!uuid) throw new ContractViolation('ContainerTransport.observeFrames: uuid is required')
    if (typeof observer !== 'function') throw new ContractViolation('ContainerTransport.observeFrames: observer must be a function')
    let set = this.#frameObservers.get(uuid)
    if (!set) { set = new Set(); this.#frameObservers.set(uuid, set) }
    set.add(observer)
    return () => {
      const s = this.#frameObservers.get(uuid)
      if (s) { s.delete(observer); if (s.size === 0) this.#frameObservers.delete(uuid) }
    }
  }

  // ── Public verbs (uuid-addressed — the host's data plane ends here) ────────

  /**
   * Backend-declared extraction capability discovery: given a source kind and its
   * content entries, ask Go which (kind, actions) it can extract/transform into.
   * Frame frozen: {type:'detect-extractions', sourceKind, entries, opId} →
   * detect-extractions-result, whose offers ride an `offers` KEY (the reply is a
   * frame, not the bare array the retired endpoint answered with). No channel →
   * an empty offer list: nothing to discover is a legitimate answer, and the menu
   * this feeds already renders none. REJECTS on the 5s timeout; the facade's
   * adapter is what degrades that to an empty list for the menu.
   * @param {string} uuid @param {{sourceKind: string, entries: object[]}} payload
   * @returns {Promise<Array<{kind: string, actions: string[]}>>}
   */
  detectExtractions(uuid, payload) {
    const ch = this.#channels.get(uuid)
    if (!ch) return Promise.resolve([])
    return ch.awaitReply(this.#mintOpId(), {
      type: DocumentFrame.DETECT_EXTRACTIONS,
      sourceKind: payload.sourceKind,
      entries: payload.entries,
    }, 'detect-extractions ' + payload.sourceKind)
      .then((reply) => reply.offers || [])
  }

  /**
   * Re-run a block's backend job (kind-blind: Go knows what retry means).
   * Frame frozen: {type:'retry-block-job', uuid, id}.
   * @param {string} uuid @param {string} blockId
   */
  retry(uuid, blockId) {
    this._send(uuid, { type: DocumentFrame.RETRY_BLOCK_JOB, uuid: uuid, id: blockId })
  }

  /**
   * Frames a block extraction/transform (the lens-side prep — context stamping,
   * entry resolution — stays in the lens; the payload arrives fully prepared).
   * Frame frozen: {type:'extract', blockId, targetKind, operation, entries,
   * index} — NO uuid inside; the server resolves the document from the channel.
   * Returns the extract-ack RESULT {ok, error?} (resolves, never rejects); any
   * block it creates or replaces arrives as a container change.
   * @param {string} uuid
   * @param {{blockId?: string, targetKind: string, operation: string, entries: object[], index: number}} payload
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  extract(uuid, payload) {
    return this._awaitAck(uuid, {
      type: DocumentFrame.EXTRACT,
      blockId: payload.blockId,
      targetKind: payload.targetKind,
      operation: payload.operation,
      entries: payload.entries,
      index: payload.index,
    }, 'extract ' + payload.targetKind)
  }

  // ── Service-pair internals (@protected by convention) ──────────────────────
  // JS #private fields don't cross the class boundary, so the framing surface the
  // service pair shares is underscore-marked instead — same contract as the
  // renderers' _pushAttrs seam.
  //
  // Two callers, both inside the host's data plane: DocumentService (its uuid-
  // addressed twin) and container/container-binding.js, which is this same
  // surface with the uuid bound once at mount. Nothing above the data plane calls
  // them — a lens holds a provider, and a provider holds a binding.

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
   * Send + await a HANDSHAKE reply on a document's channel, correlated by a freshly
   * minted opId; channel-less uuids reject with the socketless error (awaits
   * resolve-or-reject, never hang). REJECTS on timeout (5s default) — setMode's
   * stay-on-failure depends on it. `timeoutMs` raises the ceiling for a caller
   * whose server-side counterpart can legitimately run long (document-service's
   * paste verbs; see its PASTE_ACK_TIMEOUT_MS).
   * @param {string} uuid @param {object} msg @param {string} [label] @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  _awaitReply(uuid, msg, label, timeoutMs) {
    const ch = this.#channels.get(uuid)
    if (!ch) return Promise.reject(new Error('editor has no live channel'))
    return ch.awaitReply(this.#mintOpId(), msg, label, timeoutMs)
  }

  /**
   * Send + await an ACK on a document's channel, correlated by a freshly minted
   * opId. Resolves the ack RESULT {ok, error?} — including on a channel-less uuid
   * ({ok:false, error:'dropped: …'}) and on timeout — and NEVER rejects, so a
   * fire-and-forget caller can ignore the promise safely. (createBlock / deleteBlock
   * route here.)
   * @param {string} uuid @param {object} msg @param {string} [label] @param {number} [timeoutMs]
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  _awaitAck(uuid, msg, label, timeoutMs) {
    const ch = this.#channels.get(uuid)
    if (!ch) return Promise.resolve({ ok: false, error: 'dropped: no live channel for ' + uuid })
    return ch.awaitAck(this.#mintOpId(), msg, label, timeoutMs)
  }
}
