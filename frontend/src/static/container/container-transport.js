// @ts-check
// The WIRE OWNER for document channels: one socket per open document uuid, with
// its pending queue, awaiters, ping/pong watchdog and backoff reconnect. Wire
// frame shapes are FROZEN.
//
// TRANSPORT AND NOTHING ELSE. It holds no view of what a document contains: that
// is the FOLLOWER MODEL the host keeps, fed from `observeFrames` below — one
// place, one writer, and a lens reads it through a provider rather than a socket.
//
// The per-channel DELEGATE receives what the transport does not settle itself and
// the follower model does not claim — a server error, and little else.

import { ContractViolation } from '../contract/sieve-block.js'
import { BlockChannel } from './block-channel.js'
import { WsDial } from './ws-dial.js'
import { DocumentFrame } from '../generated/protocol.js'

/**
 * @typedef {import('./block-channel.js').ChannelDelegate} ChannelDelegate
 */

// Go's text-replace outcome for a write that could not be run, as the wire
// spells it. The other two words — applied, and the anchor no longer resolves —
// are read by nobody here: both mean the container is now what Go says it is.
const TEXT_REPLACE_ERROR = 'error'

/**
 * @typedef {object} ContainerTransportOptions
 * @property {(url: string, protocols?: string[]) => WebSocket} [socketFactory]
 *   injected for tests; defaults to `new WebSocket(url, protocols)`
 * @property {(uuid: string) => string} [wsUrlFor]
 *   injected for tests; defaults to the document-channel URL for the uuid
 */

export class ContainerTransport {
  /** @type {(url: string, protocols?: string[]) => WebSocket} */ #socketFactory
  /** @type {(uuid: string) => string} */ #wsUrlFor
  /** @type {Map<string, BlockChannel>} uuid → live channel */ #channels = new Map()
  /** @type {Map<string, Set<(msg: Record<string, any>) => void>>} uuid → raw inbound-frame observers */ #frameObservers = new Map()
  /** @type {number} monotonic opId source; correlation is uuid+opId, but a global counter also survives a takeover cleanly */ #opSeq = 0

  /** @param {ContainerTransportOptions} [options] the test seams (empty in prod) */
  constructor(options = {}) {
    this.#socketFactory = options.socketFactory || ((url, protocols) => new WebSocket(url, protocols))
    this.#wsUrlFor = options.wsUrlFor || ((uuid) => ContainerTransport.#defaultUrl(uuid))
  }

  /** Mints the next request-correlation opId: monotonic and per-service, so it is
   *  unique within any uuid AND across channels. @returns {string} */
  #mintOpId() { return 'op-' + (++this.#opSeq) }

  /**
   * The production document-channel URL. encodeURIComponent is hygiene, not a
   * safety mechanism — chi routes document channels on RawPath, so an encoded
   * handle arrives at Go STILL ENCODED.
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

  /** Opens the live channel for a document, tearing down any existing one first.
   *  @param {string} uuid @param {ChannelDelegate} delegate */
  openChannel(uuid, delegate) {
    if (!uuid) throw new ContractViolation('ContainerTransport.openChannel: uuid is required')
    if (!delegate) throw new ContractViolation('ContainerTransport.openChannel: delegate is required')
    const existing = this.#channels.get(uuid)
    if (existing) existing.close()
    this.#channels.set(uuid, new BlockChannel(
      // Dialling the socket — url and credential alike — is the wire owner's
      // business, so it is bound here.
      (url) => this.#socketFactory(url, WsDial.protocols()),
      () => this.#wsUrlFor(uuid),
      delegate,
      (msg) => this.#onInbound(uuid, msg),
    ))
  }

  /** @param {string} uuid */
  closeChannel(uuid) {
    const ch = this.#channels.get(uuid)
    if (!ch) return
    ch.close()
    this.#channels.delete(uuid)
  }

  /**
   * Every routed inbound frame on a document's channel, in arrival order, before
   * the delegate sees it. Frames an awaiter consumed never arrive here, which is
   * why whole-container ANSWERS reach a follower through DocumentService.onContent
   * instead.
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
   * Subscribe to a document's raw inbound frames — the seam the follower model
   * feeds from, and the only inbound seam there is, which is what makes the model
   * the single client-side account of what a container holds.
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

  /**
   * Backend-declared extraction capability discovery: which (kind, actions) Go can
   * extract or transform this content into. No channel means an empty offer list —
   * nothing to discover is a legitimate answer. REJECTS on the 5s timeout; the
   * facade's adapter degrades that to an empty list.
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

  /** Re-run a block's backend job; kind-blind, because Go knows what retry means.
   *  @param {string} uuid @param {string} blockId */
  retry(uuid, blockId) {
    this._send(uuid, { type: DocumentFrame.RETRY_BLOCK_JOB, uuid: uuid, id: blockId })
  }

  /**
   * Frames a block extraction/transform; the lens-side prep stays in the lens.
   * The frame carries NO uuid — the server resolves the document from the channel.
   * Never rejects; any block it creates or replaces arrives as a container change.
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

  /**
   * Frames a text-replace: one anchored run of a block's text, written by Go.
   * The applied edit arrives as the block's own render-back BEFORE this settles,
   * so what settles here is only which of the three things happened.
   *
   * Never rejects. A channel-less container, a timeout and a malformed answer
   * all read as `error`, which is the truthful reading of "the write did not
   * happen and nothing says it did".
   * @param {string} uuid
   * @param {{blockId: string, locator: string, quote: string, occurrence: number, start: number, end: number, replacement: string}} payload
   * @returns {Promise<string>} the ack's outcome word
   */
  replaceText(uuid, payload) {
    return this._awaitReply(uuid, {
      type: DocumentFrame.TEXT_REPLACE,
      blockId: payload.blockId,
      locator: payload.locator,
      quote: payload.quote,
      occurrence: payload.occurrence,
      start: payload.start,
      end: payload.end,
      replacement: payload.replacement,
    }, 'text-replace ' + payload.blockId)
      .then((reply) => String((reply && reply.outcome) || TEXT_REPLACE_ERROR))
      .catch(() => TEXT_REPLACE_ERROR)
  }

  // JS #private fields do not cross the class boundary, so the framing surface the
  // service pair shares is underscore-marked instead. Its only callers are inside
  // the host's data plane — a lens holds a provider, and a provider holds a
  // binding.

  /** @param {string} uuid @returns {boolean} whether a live channel exists */
  _hasChannel(uuid) { return this.#channels.has(uuid) }

  /** Send a frame on a document's channel; channel-less uuids no-op, because sends
   *  drop rather than throw. @param {string} uuid @param {object} msg */
  _send(uuid, msg) {
    const ch = this.#channels.get(uuid)
    if (ch) ch.send(msg)
  }

  /**
   * Send and await a HANDSHAKE reply. A channel-less uuid rejects, so an await
   * always settles. REJECTS on timeout (5s default) — setMode's stay-on-failure
   * depends on it. `timeoutMs` raises the ceiling for a caller whose server-side
   * counterpart can legitimately run long.
   * @param {string} uuid @param {object} msg @param {string} [label] @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  _awaitReply(uuid, msg, label, timeoutMs) {
    const ch = this.#channels.get(uuid)
    if (!ch) return Promise.reject(new Error('editor has no live channel'))
    return ch.awaitReply(this.#mintOpId(), msg, label, timeoutMs)
  }

  /**
   * Send and await an ACK. Resolves the ack RESULT — including on a channel-less
   * uuid and on timeout — and NEVER rejects, so a fire-and-forget caller can
   * ignore the promise safely.
   * @param {string} uuid @param {object} msg @param {string} [label] @param {number} [timeoutMs]
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  _awaitAck(uuid, msg, label, timeoutMs) {
    const ch = this.#channels.get(uuid)
    if (!ch) return Promise.resolve({ ok: false, error: 'dropped: no live channel for ' + uuid })
    return ch.awaitAck(this.#mintOpId(), msg, label, timeoutMs)
  }
}
