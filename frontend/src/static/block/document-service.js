// @ts-check
// document-service.js — DocumentService: the sieve protocol's anti-corruption
// layer, uuid-addressed half (Block Renderer Contract,
// docs/design/archive/specs/2026-07-21-block-renderer-contract.md §service pair).
//
// ONE instance, constructed beside BlockService in the Workspace composition
// root (constructor injection — composed over the wire owner) and handed down.
// Editors and the Workspace see THIS; renderers never do (they are
// blockId-scoped and see only BlockService). The JS twin of Go's EditorService
// (live-document session concerns), NOT Go's DocumentService (persistence).
//
// Issue #49 Phase 1: the full document-session machinery lives here — channel
// lifecycle (open/close, fronting BlockService's channel-per-uuid), flush, the
// format-blind raw-content family (getRawContent / setRawContent / save),
// export, and the membership verbs (createBlock / deleteBlock). Editors talk
// ONLY to DocumentService; the WS-vs-HTTP, note-vs-prompt split is internal
// routing (save: a live channel → the enter-wysiwyg handshake; channel-less →
// the HTTP save the prompt path always used). Wire frame shapes are FROZEN.

import { SieveBlock, ContractViolation } from './sieve-block.js'
import { blockOp } from './block-sync.js'

/** @typedef {import('./block-service.js').ChannelDelegate} ChannelDelegate */

export class DocumentService {
  /** @type {import('./block-service.js').BlockService} */ #blockService

  /** @param {import('./block-service.js').BlockService} blockService */
  constructor(blockService) {
    if (!blockService) throw new ContractViolation('DocumentService: constructed over the BlockService (composition root wiring)')
    this.#blockService = blockService
  }

  /** The existing-block half of the boundary (blockId-addressed verbs). */
  get blockService() { return this.#blockService }

  // ── Channel lifecycle (editors declare connect:true → open at construction) ─

  /**
   * Opens the document's live channel, registering the editor's delegate
   * (inbound routing + the resolveInsertIndex callback).
   * @param {string} uuid @param {ChannelDelegate} delegate
   */
  open(uuid, delegate) {
    this.#blockService.openChannel(uuid, delegate)
  }

  /** Closes the document's live channel (no reconnect). @param {string} uuid */
  close(uuid) {
    this.#blockService.closeChannel(uuid)
  }

  /**
   * Load a document: Go's codec did the splitting server-side (JS never parses
   * a document); this verb types the wire block list into envelopes and seeds
   * the BlockService's blockId→{uuid, kind} routing index.
   * @param {string} uuid
   * @returns {Promise<{ body: string, blocks: SieveBlock[], raw: any }>}
   *   body: the raw serialized form (markdown-mode consumers);
   *   blocks: typed envelopes (block lenses); raw: the untyped wire reply —
   *   V1 BRIDGE ONLY for the surface render pipeline, retired with Phase 3.
   */
  load(uuid) {
    return fetch('/api/editor/load?uuid=' + encodeURIComponent(uuid))
      .then((r) => r.json())
      .then((data) => {
        const blocks = (data.blocks || []).map(
          /** @param {any} b */ (b) => new SieveBlock(b.kind || 'prose', b))
        this.#blockService.indexDocument(uuid, blocks)
        return { body: data.body || '', blocks: blocks, raw: data }
      })
  }

  // ── Save / raw-content family (format-blind — raw is whatever Go serialises) ─

  /**
   * Flushes the document to Go's shadow and awaits the flush-ack (frame frozen:
   * {type:'flush', uuid}). A channel-less uuid resolves {} immediately (the
   * socketless-parity rule — callers never probe for transport).
   * @param {string} uuid @returns {Promise<object>}
   */
  flush(uuid) {
    if (!this.#blockService._hasChannel(uuid)) return Promise.resolve({})
    return this.#blockService._awaitReply(uuid, 'flush-ack', { type: 'flush', uuid: uuid }, 'flush')
  }

  /**
   * The document's authoritative raw serialized content, from Go (frame frozen:
   * {type:'enter-markdown', uuid} → markdown-content). Rejects on timeout or a
   * channel-less uuid.
   * @param {string} uuid @returns {Promise<string>}
   */
  getRawContent(uuid) {
    return this.#blockService._awaitReply(uuid, 'markdown-content', { type: 'enter-markdown', uuid: uuid })
      .then((reply) => reply.markdown)
  }

  /**
   * Replaces the document's whole raw buffer, fire-and-forget (frame frozen:
   * {type:'doc-update', uuid, markdown}). Channel-less uuids no-op.
   * @param {string} uuid @param {string} raw
   */
  setRawContent(uuid, raw) {
    this.#blockService._send(uuid, { type: 'doc-update', uuid: uuid, markdown: raw })
  }

  /**
   * Saves the document's raw content. WITH a live channel: the enter-wysiwyg
   * handshake (frame frozen: {type:'enter-wysiwyg', uuid, markdown}), resolving
   * the server's reparsed block list. CHANNEL-LESS (prompt docs): the HTTP POST
   * /api/editor/save the prompt path always used (moved verbatim from
   * prompt-editor.js — a prompt is fixed markdown, hence the mode literal).
   * @param {string} uuid @param {string} raw
   * @returns {Promise<any>} the reparsed block list (channel) / the fetch response (HTTP)
   */
  save(uuid, raw) {
    if (this.#blockService._hasChannel(uuid)) {
      return this.#blockService._awaitReply(uuid, 'wysiwyg-content', { type: 'enter-wysiwyg', uuid: uuid, markdown: raw })
        .then((reply) => {
          // Go's reparse can MINT ids (e.g. a paragraph split while in
          // markdown mode) — feed them to the routing index so the observer's
          // first update to such a block routes instead of dropping.
          // (indexDocument reads .id/.kind — the raw wire blocks carry both.)
          this.#blockService.indexDocument(uuid, reply.blocks || [])
          return reply.blocks
        })
    }
    return fetch('/api/editor/save?uuid=' + encodeURIComponent(uuid), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: raw, mode: 'markdown' }),
    })
  }

  /**
   * The server's clean whole-document export (ai-blocks filtered, cards/clips
   * reduced to links). Resolves the export text, or null on a non-OK response
   * — clipboard handling stays editor-side.
   * @param {string} uuid @param {string} format
   * @returns {Promise<string|null>}
   */
  export(uuid, format) {
    return fetch('/api/editor/export?uuid=' + encodeURIComponent(uuid) + '&format=' + format)
      .then((resp) => (resp.ok ? resp.text() : null))
  }

  // ── Membership verbs (add/remove — never target an existing block's state) ──

  /**
   * MEMBERSHIP: add a block to the document (frame frozen: {type:'block-op',
   * uuid, op:{type:'create-block', …}}). Two framing paths, one wire shape
   * family:
   *
   * - DEFAULT (dialogs / createBlock callers): the index is resolved through
   *   the open delegate's resolveInsertIndex(afterBlockId) — the ONE sanctioned
   *   PM-resolution callback (the lens resolves indices, the service frames).
   *   Channel-less / delegate-less uuids drop (socketless parity). The op
   *   carries NO blockId key — identical to the retired editor createBlock.
   *
   * - EXPLICIT INDEX (opts.index — the wysiwyg observer's prose creates, which
   *   already computed document order): resolveInsertIndex is BYPASSED and the
   *   op reproduces proseOp's exact shape — blockId ('' while the create rides
   *   its transient correlation token), aliases lifted top-level, token last.
   *
   * @param {string} uuid @param {string} kind @param {Record<string, any>} attrs
   * @param {string} [afterBlockId]
   *   — a stable block-id anchor, never an index
   * @param {{index?: number, token?: string, aliases?: string[], blockId?: string}} [opts]
   */
  createBlock(uuid, kind, attrs, afterBlockId, opts) {
    attrs = attrs || {}
    if (opts && typeof opts.index === 'number') {
      const op = /** @type {Record<string, any>} */ (blockOp('create-block', opts.blockId || '', kind, attrs, opts.aliases, opts.index))
      if (opts.token) op.token = opts.token
      this.#blockService._send(uuid, { type: 'block-op', uuid: uuid, op: op })
      return
    }
    const delegate = this.#blockService._delegateFor(uuid)
    if (!delegate) return // channel-less (prompt / bare) — no-op, socketless parity
    const idx = delegate.resolveInsertIndex(afterBlockId)
    this.#blockService._send(uuid, { type: 'block-op', uuid: uuid, op: { type: 'create-block', kind: kind, attrs: attrs, index: idx } })
  }

  /**
   * MEMBERSHIP: remove a block from the document (frame frozen: op
   * {type:'delete-block', blockId} — kind-agnostic, like the observer's).
   * @param {string} uuid @param {string} blockId
   */
  deleteBlock(uuid, blockId) {
    this.#blockService._send(uuid, { type: 'block-op', uuid: uuid, op: { type: 'delete-block', blockId: blockId } })
  }
}
