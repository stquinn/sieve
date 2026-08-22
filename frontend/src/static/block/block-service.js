// @ts-check
// block-service.js — BlockService: the sieve protocol's anti-corruption layer,
// existing-block half (Block Renderer Contract,
// docs/design/archive/specs/2026-07-21-block-renderer-contract.md §service pair),
// and the WIRE OWNER for document channels: one socket per open document uuid,
// with its pending queue, awaiters, ping/pong watchdog and exponential-backoff
// reconnect (block-channel.js). Wire frame shapes are FROZEN.
//
// ONE instance, constructed in the Workspace composition root and handed down
// (idiomatic-js §5 — never window.*). Renderers see THIS and only this: a
// renderer knows its block id, never a uuid — the service routes to the owning
// document via its blockId→{uuid, kind, block} index, seeded on document load
// (DocumentService.load → indexDocument) and maintained from the
// insert-block / replace-block / block-attrs-updated render-backs passing
// through (#mirrorFromMessage). The index is STICKY — deletes do not purge
// (undo can resurrect a block that must still route). Since issue #49 Phase 3
// the `block` slot holds the last envelope Go authored for the id, advanced
// ONLY by inbound server truth (indexDocument + #mirrorFromMessage — the
// one-writer rule), read by the sieveBlockFor seam's mirror-first lookup.
//
// The per-channel DELEGATE (registered by the editor via DocumentService.open)
// receives the inbound routing: server render-back ops → applyServerOp,
// everything else → onMessage; and resolveInsertIndex is the ONE sanctioned
// PM-resolution callback (the lens resolves indices, the service frames).

import { SieveBlock, ContractViolation } from './sieve-block.js'
import { updateBlockOp } from './block-sync.js'
import { BlockChannel } from './block-channel.js'
import { DocumentFrame } from '../generated/protocol.js'

/**
 * @typedef {import('./block-channel.js').ChannelDelegate} ChannelDelegate
 */

/**
 * @typedef {object} BlockServiceOptions
 * @property {(url: string) => WebSocket} [socketFactory]
 *   — injected for tests; defaults to `new WebSocket(url)`
 * @property {(uuid: string) => string} [wsUrlFor]
 *   — injected for tests; defaults to the document-channel URL for the uuid
 */

export class BlockService {
  /** @type {(url: string) => WebSocket} */ #socketFactory
  /** @type {(uuid: string) => string} */ #wsUrlFor
  /** @type {Map<string, BlockChannel>} uuid → live channel */ #channels = new Map()
  /** @type {Map<string, {uuid: string, kind: string, block: SieveBlock|null}>} blockId → routing entry + the cached envelope (STICKY — never purged on delete). `block` is the last envelope Go authored for this id; null when only the routing pair is known (raw-seeded / message-learned-without-mirror). ONE-WRITER RULE: written ONLY by indexDocument + #mirrorFromMessage (inbound server truth) — no outbound verb touches it. */ #blocks = new Map()
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

  // ── Routing index + block cache (one writer: inbound server truth) ─────────

  /**
   * Seeds the blockId→{uuid, kind, block} index + block cache from a document's
   * block list. The cache stores the typed envelope itself (DocumentService.load
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
   * Advances the cached envelope from a server render-back passing through the
   * channel — the SERVICE authors the envelope from the wire message (the
   * anti-corruption boundary). Runs BEFORE delegate.applyServerOp so the seam's
   * NodeView.update re-resolves the refreshed envelope. block-attrs-updated MERGES
   * onto the prior payload and notifies onBlockUpdated listeners; insert/replace
   * author fresh envelopes. The 'code' fallback mirrors the wysiwyg surface's own
   * kind default. ONE-WRITER RULE: this + indexDocument are the ONLY mirror writers.
   * @param {string} uuid @param {Record<string, any>} msg
   */
  #mirrorFromMessage(uuid, msg) {
    if (msg.type === DocumentFrame.INSERT_BLOCK && msg.id) {
      const kind = msg.kind || 'code'
      const block = new SieveBlock(kind, Object.assign({}, msg.attrs, { id: msg.id }))
      this.#blocks.set(msg.id, { uuid: uuid, kind: kind, block: block })
    } else if (msg.type === DocumentFrame.REPLACE_BLOCK && msg.newId) {
      const kind = msg.newKind || 'code'
      const block = new SieveBlock(kind, Object.assign({}, msg.attrs, { id: msg.newId }))
      // The old id entry stays for routing (undo can resurrect it); the new id
      // becomes the mirror's authoritative envelope for the replacement.
      this.#blocks.set(msg.newId, { uuid: uuid, kind: kind, block: block })
    } else if (msg.type === DocumentFrame.BLOCK_ATTRS_UPDATED && msg.id) {
      const entry = this.#blocks.get(msg.id)
      if (!entry) return // unknown id → nothing to merge onto (no kind to author)
      const prior = entry.block ? entry.block.payload : {}
      const block = new SieveBlock(entry.kind, Object.assign({}, prior, msg.attrs, { id: msg.id }))
      this.#blocks.set(msg.id, { uuid: entry.uuid, kind: entry.kind, block: block })
      this.#emitBlockUpdated(entry.uuid, block)
    }
  }

  /**
   * The current cached envelope for a block id, or null (unknown id / a
   * routing-only entry that never received server truth). Consumers: the
   * sieveBlockFor seam's mirror-first lookup.
   * @param {string} blockId @returns {SieveBlock|null}
   */
  envelopeFor(blockId) {
    const entry = blockId && this.#blocks.get(blockId)
    return (entry && entry.block) || null
  }

  /**
   * The indexed kind for a block id, or '' (unknown id). The routing index knows
   * a kind for every id it holds — including one seeded raw, whose envelope slot
   * is still null — so this answers where `envelopeFor` cannot.
   * @param {string} blockId @returns {string}
   */
  kindFor(blockId) {
    const entry = blockId && this.#blocks.get(blockId)
    return (entry && entry.kind) || ''
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
    return ch.awaitAck(this.#mintOpId(), { type: DocumentFrame.BLOCK_OP, uuid: entry.uuid, op: op }, 'update-block ' + blockId)
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
   * block's content), which is why it lives here rather than on DocumentService,
   * and why it rides the SAME channel resolution `extract` uses: discovery and the
   * playback of what it discovered must reach the same document.
   *
   * Frame frozen: {type:'detect-extractions', sourceKind, entries, opId} →
   * detect-extractions-result, whose offers ride an `offers` KEY (the reply is a
   * frame, not the bare array the retired endpoint answered with). No channel →
   * an empty offer list: nothing to discover is a legitimate answer, and the menu
   * this feeds already renders none. REJECTS on the 5s timeout — the sole caller
   * (sieve-block-extension.js) has NO catch today, so that rejection is currently
   * unhandled there, parity with the old uncaught fetch it replaced; T7 may add one.
   * @param {{sourceKind: string, entries: object[], blockId?: string}} payload
   * @returns {Promise<Array<{kind: string, actions: string[]}>>}
   */
  detectExtractions(payload) {
    const ch = this.#channelForBlock(payload.blockId || '', 'detect-extractions')
    if (!ch) return Promise.resolve([])
    return ch.awaitReply(this.#mintOpId(), {
      type: DocumentFrame.DETECT_EXTRACTIONS,
      sourceKind: payload.sourceKind,
      entries: payload.entries,
    }, 'detect-extractions ' + payload.sourceKind)
      .then((reply) => reply.offers || [])
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
    ch.send({ type: DocumentFrame.RETRY_BLOCK_JOB, uuid: entry.uuid, id: blockId })
  }

  /**
   * The document channel a blockId-addressed frame belongs on. An indexed id names
   * its own document; an absent or unknown id falls back to the sole open channel,
   * which is unambiguous exactly while ONE document is open. Two open channels and
   * no id is a guess about which document to mutate — it warns and drops instead.
   * @param {string} blockId @param {string} label  the verb, for the warning
   * @returns {BlockChannel|null}
   */
  #channelForBlock(blockId, label) {
    const entry = this.#entryFor(blockId)
    const owned = entry ? this.#channels.get(entry.uuid) : null
    if (owned) return owned
    if (this.#channels.size === 1) return this.#channels.values().next().value || null
    if (this.#channels.size > 1) {
      console.warn('[block-service] ' + label + ': ambiguous channel for block', blockId, '— dropped')
    }
    return null
  }

  /**
   * Frames a block extraction/transform (the PM-side prep — index resolution,
   * context stamping, entry resolution — stays in AbstractEditor.extract; the
   * payload arrives fully prepared). Frame frozen: {type:'extract', blockId,
   * targetKind, operation, entries, index} — NO uuid; the server resolves the
   * document from the channel. Returns the extract-ack RESULT {ok, error?}
   * (resolves, never rejects); any block it creates arrives separately as an
   * insert-block/replace-block render-back, which is the authoritative render
   * signal. Drops resolve {ok:false, error}.
   * @param {{blockId?: string, targetKind: string, operation: string, entries: object[], index: number}} payload
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  extract(payload) {
    const ch = this.#channelForBlock(payload.blockId || '', 'extract')
    if (!ch) return Promise.resolve({ ok: false, error: 'dropped: no unambiguous channel' })
    return ch.awaitAck(this.#mintOpId(), {
      type: DocumentFrame.EXTRACT,
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
