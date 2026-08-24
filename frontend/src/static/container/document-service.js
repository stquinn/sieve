// @ts-check
// document-service.js — DocumentService: the sieve protocol's anti-corruption
// layer, uuid-addressed. The JS twin of Go's EditorService (live-document
// session concerns), NOT Go's DocumentService (persistence).
//
// ONE instance, constructed beside ContainerTransport in the Workspace composition
// root (constructor injection — composed over the wire owner). It is HOST data
// plane (issue #96): its callers are the workspace itself and
// container/container-binding.js, which is this same surface with a uuid bound
// once at mount. No lens reaches it — a lens holds a provider.
//
// The full document-session machinery lives here — channel lifecycle (open/close,
// fronting ContainerTransport's channel-per-uuid), load, flush, the format-blind
// raw-content family (getRawContent / setRawContent / save), export, the paste
// pipelines, focus, and the membership verbs (createBlock / deleteBlock /
// setBlockOrder).
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
// and getRawContent (enter-markdown) call ContainerTransport._awaitReply with NO channel
// guard and REJECT instead — a channel-less caller of those three needs its own catch.

import { ContractViolation } from '../contract/sieve-block.js'
import { blockOp } from './block-ops.js'
import { DocumentFrame } from '../generated/protocol.js'

// The server's paste path can legitimately outlast the wire's default 5s reply
// ceiling: smart-image acquire downloads synchronously with its own 8s HTTP
// timeout (sieve/block/processors/smart_image_processor.go). This ceiling must
// exceed that 8s or the ack outlives the awaiter — a slow paste's
// #applyPasteResult never runs, the insert anchor is never consumed/cleared
// (stray anchor paragraph), and outcome:'none' never replays the clipboard.
const PASTE_ACK_TIMEOUT_MS = 12000

/** @typedef {import('./container-transport.js').ChannelDelegate} ChannelDelegate */

export class DocumentService {
  /** @type {import('./container-transport.js').ContainerTransport} */ #blockService
  /** @type {Map<string, Set<(content: Record<string, any>) => void>>} uuid → whole-container-answer observers (see onContent) */ #contentListeners = new Map()

  /** @param {import('./container-transport.js').ContainerTransport} blockService */
  constructor(blockService) {
    if (!blockService) throw new ContractViolation('DocumentService: constructed over the ContainerTransport (composition root wiring)')
    this.#blockService = blockService
  }

  /** The existing-block half of the boundary (blockId-addressed verbs). */
  get blockService() { return this.#blockService }

  // ── Channel lifecycle (editors declare connect:true → open at construction) ─

  /**
   * Opens the document's live channel, registering the caller's delegate — the
   * inbound routing for what the transport does not settle itself.
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
   * Subscribe to this document's WHOLE-CONTAINER answers — the load reply and the
   * enter-wysiwyg reparse — as the raw wire shape Go sent, before it is typed into
   * SieveBlocks. The returned function unsubscribes.
   *
   * A follower model has to seed from these and cannot get them off the channel:
   * both are correlated replies, so the transport settles them on their awaiter and
   * they never reach an inbound observer. The RAW shape is what is published,
   * because typing is this service's answer to ITS callers, not a fact about the
   * container — the typing path stamps `kind` into the attrs bag and the
   * render-back path does not, and a follower must not inherit that asymmetry.
   * @param {string} uuid @param {(content: Record<string, any>) => void} listener
   * @returns {() => void} unsubscribe
   */
  onContent(uuid, listener) {
    if (!uuid) throw new ContractViolation('DocumentService.onContent: uuid is required')
    if (typeof listener !== 'function') throw new ContractViolation('DocumentService.onContent: listener must be a function')
    let set = this.#contentListeners.get(uuid)
    if (!set) { set = new Set(); this.#contentListeners.set(uuid, set) }
    set.add(listener)
    return () => {
      const s = this.#contentListeners.get(uuid)
      if (s) { s.delete(listener); if (s.size === 0) this.#contentListeners.delete(uuid) }
    }
  }

  /** Publishes one whole-container answer. A throwing listener is isolated — it
   *  must never break the load/save it rode in on.
   *  @param {string} uuid @param {Record<string, any>} content */
  #emitContent(uuid, content) {
    const set = this.#contentListeners.get(uuid)
    if (!set) return
    for (const listener of set) {
      try { listener(content) } catch (e) { console.error('[document-service] onContent listener threw', e) }
    }
  }

  /**
   * Load a document: Go's codec did the splitting server-side (JS never parses a
   * document). The BLOCKS are not returned — they go where every other statement
   * of what a container holds goes, into the follower model, via the onContent
   * publication below. What comes back is what only the HOST acts on: the mode to
   * present, the raw body a break-glass buffer mounts from, the saved scroll and
   * the version.
   *
   * Frame frozen: {type:'load', opId} → load-content, whose {body, mode, uuid,
   * scroll, version, blocks} sit at the TOP LEVEL of the frame. Both transports
   * answer that same shape (Go serves them from one assembly), so this verb reads
   * it once.
   * @param {string} uuid
   * @returns {Promise<{ body: string, meta: { mode: string }, scroll: number, version: number }>}
   *   body: the raw serialized form (markdown-mode surface seed);
   *   meta.mode: the frontmatter mode the workspace boot path reads;
   *   scroll: the session's saved scroll offset for this tab (issue #51; 0 for
   *     a never-scrolled/never-seen tab — the load-path restore floor);
   *   version: the version this content is at — the editor's baseline for the
   *     container-saved fact; 0 for a container with no version history.
   */
  load(uuid) {
    return this.#readContent(uuid)
      .then((data) => {
        this.#emitContent(uuid, data)
        return {
          body: data.body || '',
          meta: { mode: data.mode || 'wysiwyg' },
          scroll: data.scroll || 0,
          version: data.version || 0,
        }
      })
  }

  /**
   * The document's content answer, from whichever transport the document has.
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
   * @returns {Promise<unknown>} settles when Go has taken the buffer
   */
  save(uuid, raw) {
    if (this.#blockService._hasChannel(uuid)) {
      return this.#blockService._awaitReply(uuid, { type: DocumentFrame.ENTER_WYSIWYG, uuid: uuid, markdown: raw }, 'enter-wysiwyg')
        .then((reply) => {
          // Go's reparse is a whole new statement of what the container holds —
          // including ids it MINTED (a paragraph split while in markdown mode) —
          // so it goes where the load answer goes: into the follower model, via
          // the one publication every container answer uses.
          this.#emitContent(uuid, reply)
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

  // ONE FRAME, FOUR KINDS. `paste` carries a `kind` discriminant deciding what
  // the server makes of its payload — `entries` as a clipboard for smart, `slice`
  // for slice, `entries` as a uri-list for native-drop, and NOTHING AT ALL for
  // native-clipboard — because "what should the server make of this" is one
  // question with one answer shape. Reading the fields regardless of kind is how a
  // discriminated union rots into a bag of optional flags.

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

  /**
   * Tell Go a file drop LANDED at `payload.index` and to take it from the native
   * drop bucket — the OS-level catch (Wails OnFileDrop) that sees every source
   * app identically. `payload.entries` is the page's readable text, a HINT Go
   * consults only when the bucket misses (VSCode-style sources never offer a
   * file URI at any layer). Answers the same `PasteResult` union `smartPaste`
   * does; a drop neither the bucket nor the hint can answer resolves `none`.
   * @param {string} uuid @param {{entries: object[], index: number}} payload
   * @returns {Promise<{outcome?: string, kind?: string, id?: string, rawYaml?: string, html?: string, error?: string}>}
   */
  nativeDropPaste(uuid, payload) {
    return this.#blockService._awaitReply(uuid, {
      type: DocumentFrame.PASTE,
      kind: 'native-drop',
      entries: payload.entries,
      index: payload.index,
    }, 'paste native-drop', PASTE_ACK_TIMEOUT_MS)
  }

  /**
   * Ask Go to read the OS clipboard itself and make a block of whatever is on it,
   * at `payload.index`. Answers the same `PasteResult` union `smartPaste` does; a
   * clipboard holding nothing the server can use answers `none`.
   *
   * THIS FRAME CARRIES NO CLIPBOARD, AND THAT IS THE POINT. WebKitGTK hands the
   * page a paste event whose `DataTransfer` is completely empty for a screenshot
   * copied by an ordinary desktop tool — no types, no items, no files (#87) — so
   * there is nothing to forward and the emptiness IS the signal. The page keeps
   * the gesture and the caret; the server reads the clipboard.
   * @param {string} uuid @param {{index: number}} payload
   * @returns {Promise<{outcome?: string, kind?: string, id?: string, rawYaml?: string, html?: string, error?: string}>}
   */
  nativeClipboardPaste(uuid, payload) {
    return this.#blockService._awaitReply(uuid, {
      type: DocumentFrame.PASTE,
      kind: 'native-clipboard',
      index: payload.index,
    }, 'paste native-clipboard', PASTE_ACK_TIMEOUT_MS)
  }

  // ── Membership verbs (add/remove — never target an existing block's state) ──

  /**
   * MEMBERSHIP: add a block to the document (frame frozen: {type:'block-op',
   * uuid, op:{type:'create-block', …}}). The index is the CALLER's, resolved from
   * the container's own order — a fact the host holds, so nothing has to be
   * mounted for a block to be added. `opts.blockId` is the block's own name when
   * its creator already gave it one (issue #96: Go validates and adopts it; an
   * empty one asks Go to mint). -1 appends.
   *
   * Returns the block-op ack RESULT {ok, error?} (resolves, never rejects);
   * fire-and-forget callers ignore it. Channel-less uuids resolve
   * {ok:false, error:'dropped: …'}.
   * @param {string} uuid @param {string} kind @param {Record<string, any>} attrs
   * @param {undefined} [_anchorRetired] — anchors are resolved by the host before this
   * @param {{index?: number, aliases?: string[], blockId?: string}} [opts]
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  createBlock(uuid, kind, attrs, _anchorRetired, opts) {
    const index = (opts && typeof opts.index === 'number') ? opts.index : -1
    const op = blockOp('create-block', (opts && opts.blockId) || '', kind, attrs || {}, opts && opts.aliases, index)
    return this.#blockService._awaitAck(uuid, { type: DocumentFrame.BLOCK_OP, uuid: uuid, op: op }, 'create-block ' + kind)
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

  /**
   * MEMBERSHIP: install the document's top-level block ORDER (#94). `order` must
   * name every block the server holds, in the new order — Go refuses a partial
   * list, which would otherwise read as a mass delete.
   * Returns the block-op ack RESULT {ok, error?} (resolves, never rejects).
   * @param {string} uuid @param {string[]} order
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  setBlockOrder(uuid, order) {
    return this.#blockService._awaitAck(uuid, { type: DocumentFrame.BLOCK_OP, uuid: uuid, op: { type: 'set-order', order: order } }, 'set-order ' + order.length + ' blocks')
  }
}
