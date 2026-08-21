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
// The full document-session machinery lives here — channel lifecycle (open/close,
// fronting BlockService's channel-per-uuid), load, flush, the format-blind
// raw-content family (getRawContent / setRawContent / save), export, the paste
// pipelines, focus, and the membership verbs (createBlock / deleteBlock). Editors
// talk ONLY to DocumentService; renderers never do (they are blockId-scoped and
// see only BlockService).
//
// ONE TRANSPORT WITH ONE EXCEPTION. A document verb is a frame on that document's
// channel. The exception is the PROMPT pseudo-document, which never opens a
// channel (prompt-editor.js declares no `connect`), so its load and save are the
// only two verbs with an HTTP half — `GET /api/document/load` and
// `POST /api/document/save`, which Go serves for `prompt:` uuids and refuses with
// a 400 for anything else. Every other verb here is channel-only, and a
// channel-less uuid degrades PER VERB — there is no one uniform rule: setRawContent,
// focus and flush fire-and-forget and simply drop; createBlock/deleteBlock resolve
// their ack {ok:false}; export resolves null. pasteSlice, smartPaste
// and getRawContent (enter-markdown) call BlockService._awaitReply with NO channel
// guard and REJECT instead — a channel-less caller of those three needs its own catch.

import { SieveBlock, ContractViolation } from './sieve-block.js'
import { blockOp } from './block-sync.js'
import { DocumentFrame } from '../generated/protocol.js'

// The server's paste path can legitimately outlast the wire's default 5s reply
// ceiling: smart-image acquire downloads synchronously with its own 8s HTTP
// timeout (sieve/block/processors/smart_image_processor.go). This ceiling must
// exceed that 8s or the ack outlives the awaiter — a slow paste's
// #applyPasteResult never runs, the insert anchor is never consumed/cleared
// (stray anchor paragraph), and outcome:'none' never replays the clipboard.
const PASTE_ACK_TIMEOUT_MS = 12000

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
   * Subscribe to a document's block-attrs-updated render-backs. The listener
   * fires AFTER the truth-mirror advance with the refreshed typed SieveBlock; the
   * returned function unsubscribes. Document-scoped per the contract — renderers
   * never subscribe (inbound stays update(block) via the lens).
   * @param {string} uuid @param {(block: SieveBlock) => void} listener
   * @returns {() => void} unsubscribe
   */
  onBlockUpdated(uuid, listener) {
    return this.#blockService._onBlockUpdated(uuid, listener)
  }

  /**
   * Load a document: Go's codec did the splitting server-side (JS never parses
   * a document); this verb types the wire block list into envelopes, seeds the
   * BlockService's truth-mirror (indexDocument), and returns the TYPED shape only.
   * The surface render pipeline consumes the envelopes; payload is the sanctioned
   * wire costume for PM node materialization.
   *
   * Frame frozen: {type:'load', opId} → load-content, whose {body, mode, uuid,
   * scroll, version, blocks} sit at the TOP LEVEL of the frame. Both transports
   * answer that same shape (Go serves them from one assembly), so this verb reads
   * it once.
   * @param {string} uuid
   * @returns {Promise<{ body: string, blocks: SieveBlock[], meta: { mode: string }, scroll: number, version: number }>}
   *   body: the raw serialized form (markdown-mode surface seed);
   *   blocks: typed envelopes (block lenses + the render pipeline);
   *   meta.mode: the frontmatter mode the workspace boot path reads;
   *   scroll: the session's saved scroll offset for this tab (issue #51; 0 for
   *     a never-scrolled/never-seen tab — the load-path restore floor);
   *   version: the version this content is at — the editor's baseline for the
   *     container-saved fact; 0 for a container with no version history.
   */
  load(uuid) {
    return this.#readContent(uuid)
      .then((data) => {
        const blocks = this.#toEnvelopes(data.blocks)
        this.#blockService.indexDocument(uuid, blocks)
        return {
          body: data.body || '',
          blocks: blocks,
          meta: { mode: data.mode || 'wysiwyg' },
          scroll: data.scroll || 0,
          version: data.version || 0,
        }
      })
  }

  /**
   * The document's content envelope, from whichever transport the document has.
   * The frame carries NO uuid: the channel is already bound to one document, and
   * re-importing the retired endpoint's parameter would let a client ask one
   * document's socket for another's content.
   * @param {string} uuid
   * @returns {Promise<{body?: string, mode?: string, scroll?: number, version?: number, blocks?: object[]}>}
   */
  #readContent(uuid) {
    if (this.#blockService._hasChannel(uuid)) {
      return this.#blockService._awaitReply(uuid, { type: DocumentFrame.LOAD }, 'load')
    }
    return fetch('/api/document/load?uuid=' + encodeURIComponent(uuid)).then((r) => r.json())
  }

  /**
   * Types a raw wire block list ({id, kind, attrs}) into SieveBlock envelopes.
   * The payload is FLATTENED to the properties bag (the attrs map + id + kind),
   * matching the message-authored envelopes (BlockService.#mirrorFromMessage) and
   * the PM-resurrect envelopes (SieveBlock.from(node)) — one uniform in-memory
   * form the mirror and the renderers both read. The 'prose' fallback mirrors the
   * envelope constructor's kind default.
   * @param {Array<{id?: string, kind?: string, attrs?: Record<string, any>}>} [rawBlocks]
   * @returns {SieveBlock[]}
   */
  #toEnvelopes(rawBlocks) {
    return (rawBlocks || []).map(
      /** @param {any} b */ (b) => new SieveBlock(
        b.kind || 'prose',
        Object.assign({}, b.attrs, { id: b.id, kind: b.kind })))
  }

  // ── Save / raw-content family (format-blind — raw is whatever Go serialises) ─

  /**
   * Asks Go to persist the document now rather than on its debounce (frame
   * frozen: {type:'flush', uuid}). FIRE-AND-FORGET, and it returns nothing: the
   * save answers no request — it announces itself to the whole workspace as
   * `container-saved`, which the editor reacts to wherever the save came from.
   * Awaiting it here would be awaiting a reply the contract no longer has.
   *
   * Ordering still holds for a caller that must write before it does something
   * else on this document: frames leave on one socket and Go's read loop serves
   * them in order, so a verb sent after this one runs after this one.
   * Channel-less uuids drop it.
   * @param {string} uuid
   */
  flush(uuid) {
    this.#blockService._send(uuid, { type: DocumentFrame.FLUSH, uuid: uuid })
  }

  /**
   * The document's authoritative raw serialized content, from Go (frame frozen:
   * {type:'enter-markdown', uuid} → markdown-content). Rejects on timeout or a
   * channel-less uuid.
   * @param {string} uuid @returns {Promise<string>}
   */
  getRawContent(uuid) {
    return this.#blockService._awaitReply(uuid, { type: DocumentFrame.ENTER_MARKDOWN, uuid: uuid }, 'enter-markdown')
      .then((reply) => reply.markdown)
  }

  /**
   * Replaces the document's whole raw buffer, fire-and-forget (frame frozen:
   * {type:'doc-update', uuid, markdown}). Channel-less uuids no-op.
   * @param {string} uuid @param {string} raw
   */
  setRawContent(uuid, raw) {
    this.#blockService._send(uuid, { type: DocumentFrame.DOC_UPDATE, uuid: uuid, markdown: raw })
  }

  /**
   * Saves the document's raw content. WITH a live channel: the enter-wysiwyg
   * handshake (frame frozen: {type:'enter-wysiwyg', uuid, markdown}), resolving
   * the server's reparsed block list. CHANNEL-LESS (prompt docs): POST
   * /api/document/save, which Go serves for prompts only — a prompt is fixed
   * markdown, hence the mode literal.
   * @param {string} uuid @param {string} raw
   * @returns {Promise<SieveBlock[]|Response>} the reparsed TYPED envelopes (channel) / the fetch response (HTTP)
   */
  save(uuid, raw) {
    if (this.#blockService._hasChannel(uuid)) {
      return this.#blockService._awaitReply(uuid, { type: DocumentFrame.ENTER_WYSIWYG, uuid: uuid, markdown: raw }, 'enter-wysiwyg')
        .then((reply) => {
          // Type the raw wysiwyg-content reply into envelopes FIRST (the
          // anti-corruption boundary — the untyped wire block map never escapes
          // this service). Go's reparse can MINT ids (e.g. a paragraph split
          // while in markdown mode); seeding the truth-mirror here means the
          // observer's first update to such a block routes instead of dropping.
          // The surface mounts from THESE envelopes (#flipTo → presentSurface).
          const blocks = this.#toEnvelopes(reply.blocks)
          this.#blockService.indexDocument(uuid, blocks)
          return blocks
        })
    }
    return fetch('/api/document/save?uuid=' + encodeURIComponent(uuid), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: raw, mode: 'markdown' }),
    })
  }

  /**
   * The server's clean whole-document export (ai-blocks filtered, cards/clips
   * reduced to links) — the Copy-as-Markdown text, never a download. Frame
   * frozen: {type:'export', format, opId} → export-content, resolving `content`.
   * Resolves null when there is nothing the server can export.
   *
   * A CHANNEL-LESS document resolves null, and that is not a gap: a prompt IS its
   * markdown buffer, so the editor holding it already has the exact bytes this
   * would return, and asking a server to echo them back would be the round trip
   * pretending to be a contract. The prompt editor exports from its own buffer.
   * @param {string} uuid @param {string} format
   * @returns {Promise<string|null>}
   */
  export(uuid, format) {
    if (!this.#blockService._hasChannel(uuid)) return Promise.resolve(null)
    return this.#blockService._awaitReply(uuid, { type: DocumentFrame.EXPORT, format: format }, 'export')
      .then((reply) => (reply.content != null ? reply.content : null))
  }

  /**
   * The dwell ping: the user is looking at this document, which raises its focus
   * count. Frame frozen: {type:'focus'} — fire-and-forget and deliberately
   * unanswered, so nothing here awaits. Channel-less uuids drop.
   * @param {string} uuid
   */
  focus(uuid) {
    this.#blockService._send(uuid, { type: DocumentFrame.FOCUS })
  }

  // ── Paste pipelines (document-addressed — create blocks in a doc) ────────────

  // ONE FRAME, TWO KINDS. `paste` carries a `kind` discriminant deciding which of
  // its payload fields is meaningful — `entries` for smart, `slice` for slice —
  // because "what should the server make of this clipboard" is one question with
  // one answer shape. Reading both fields regardless is how a discriminated union
  // rots into a bag of optional flags.

  /**
   * Reconstruct a multi-block clipboard slice server-side: Go runs FirstPasteMatch
   * per item, minting a block at index+i with a fresh backend id; each created
   * block render-backs via insert-block, which stays the authoritative render
   * signal. The ack therefore NAMES NO BLOCK — a slice created several and can
   * single out none — so the caller has nothing to read from it; the surface owns
   * the caret/index prep and its own error log. PM-blind: `payload.slice` is
   * already plain JSON off the clipboard. Awaits at PASTE_ACK_TIMEOUT_MS (12s),
   * not the wire default — see that constant's comment.
   * @param {string} uuid @param {{slice: object[], index: number}} payload
   * @returns {Promise<{outcome?: string, error?: string}>}
   */
  pasteSlice(uuid, payload) {
    return this.#blockService._awaitReply(uuid, {
      type: DocumentFrame.PASTE,
      kind: 'slice',
      slice: payload.slice,
      index: payload.index,
    }, 'paste slice', PASTE_ACK_TIMEOUT_MS)
  }

  /**
   * Resolve a clipboard/drop payload server-side: Go runs the smart-paste pipeline
   * (web-clip / smart-image / smart-card) at `payload.index`, render-backing a
   * matched block via insert-block.
   *
   * Resolves Go's `block.PasteResult` — a DISCRIMINATED UNION, not a flag bag
   * (#67). `outcome` is always present and is the only field the caller switches on:
   *   `block`   a block was created; it arrives over the insert-block render-back,
   *             and {kind,id,rawYaml} merely identify it.
   *   `content` Go composed an HTML fragment for the caret (a link whose title it
   *             fetched). No block, no render-back — the caller inserts `html`.
   *   `none`    not a Sieve concern; the caller replays the raw clipboard locally.
   *
   * A paste the server could not serve answers `none` with an `error`, so the
   * caller's local replay is still the right move and no branch is needed for it.
   *
   * The surface keeps the clipboard reading, the anchor peek/consume, and the local
   * replay; only the wire lives here. PM-blind: `entries` are already
   * {mimeType, content} plain data. Awaits at PASTE_ACK_TIMEOUT_MS (12s), not the
   * wire default — see that constant's comment.
   * @param {string} uuid @param {{entries: object[], index: number}} payload
   * @returns {Promise<{outcome?: string, kind?: string, id?: string, rawYaml?: string, html?: string, error?: string}>}
   */
  smartPaste(uuid, payload) {
    return this.#blockService._awaitReply(uuid, {
      type: DocumentFrame.PASTE,
      kind: 'smart',
      entries: payload.entries,
      index: payload.index,
    }, 'paste smart', PASTE_ACK_TIMEOUT_MS)
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
   * Returns the block-op ack RESULT {ok, error?} (resolves, never rejects);
   * fire-and-forget callers ignore it. Channel-less / delegate-less uuids resolve
   * {ok:false, error:'dropped: …'} (socketless parity).
   * @param {string} uuid @param {string} kind @param {Record<string, any>} attrs
   * @param {string} [afterBlockId]
   *   — a stable block-id anchor, never an index
   * @param {{index?: number, token?: string, aliases?: string[], blockId?: string}} [opts]
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  createBlock(uuid, kind, attrs, afterBlockId, opts) {
    attrs = attrs || {}
    if (opts && typeof opts.index === 'number') {
      const op = /** @type {Record<string, any>} */ (blockOp('create-block', opts.blockId || '', kind, attrs, opts.aliases, opts.index))
      if (opts.token) op.token = opts.token
      return this.#blockService._awaitAck(uuid, { type: DocumentFrame.BLOCK_OP, uuid: uuid, op: op }, 'create-block ' + kind)
    }
    const delegate = this.#blockService._delegateFor(uuid)
    if (!delegate) return Promise.resolve({ ok: false, error: 'dropped: no live channel for ' + uuid }) // channel-less (prompt / bare)
    const idx = delegate.resolveInsertIndex(afterBlockId)
    return this.#blockService._awaitAck(uuid, { type: DocumentFrame.BLOCK_OP, uuid: uuid, op: { type: 'create-block', kind: kind, attrs: attrs, index: idx } }, 'create-block ' + kind)
  }

  /**
   * MEMBERSHIP: remove a block from the document (frame frozen: op
   * {type:'delete-block', blockId} — kind-agnostic, like the observer's).
   * Returns the block-op ack RESULT {ok, error?} (resolves, never rejects).
   * @param {string} uuid @param {string} blockId
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  deleteBlock(uuid, blockId) {
    return this.#blockService._awaitAck(uuid, { type: DocumentFrame.BLOCK_OP, uuid: uuid, op: { type: 'delete-block', blockId: blockId } }, 'delete-block ' + blockId)
  }
}
