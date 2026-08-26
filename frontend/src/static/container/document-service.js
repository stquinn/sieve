// @ts-check
// The sieve protocol's anti-corruption layer, uuid-addressed. HOST data plane: no
// lens reaches it — a lens holds a provider.
//
// ONE TRANSPORT WITH ONE EXCEPTION. A document verb is a frame on that document's
// channel. The exception is the PROMPT pseudo-document, which never opens one, so
// its load and save are the only two verbs with an HTTP half.
//
// A channel-less uuid degrades PER VERB rather than by one uniform rule:
// setRawContent, focus and flush drop; createBlock/deleteBlock resolve {ok:false};
// export resolves null. pasteSlice, smartPaste and getRawContent REJECT instead,
// so a channel-less caller of those three needs its own catch.

import { ContractViolation } from '../contract/sieve-block.js'
import { blockOp } from './block-ops.js'
import { DocumentFrame } from '../generated/protocol.js'

// The server's paste path can outlast the wire's default 5s ceiling: smart-image
// acquire downloads synchronously with its own 8s HTTP timeout. This must exceed
// that 8s, or the ack outlives the awaiter — the insert anchor is never consumed
// and outcome:'none' never replays the clipboard.
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

  get blockService() { return this.#blockService }

  /** @param {string} uuid @param {ChannelDelegate} delegate */
  open(uuid, delegate) {
    this.#blockService.openChannel(uuid, delegate)
  }

  /** @param {string} uuid */
  close(uuid) {
    this.#blockService.closeChannel(uuid)
  }

  /**
   * Subscribe to this document's WHOLE-CONTAINER answers — the load reply and the
   * enter-wysiwyg reparse — as the raw wire shape Go sent.
   *
   * A follower model has to seed from these and cannot get them off the channel:
   * both are correlated replies, so the transport settles them on their awaiter.
   * The RAW shape is published because typing is this service's answer to ITS
   * callers, not a fact about the container — the typing path stamps `kind` into
   * the attrs bag and the render-back path does not.
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

  /** A throwing listener is isolated: it must never break the load/save it rode
   *  in on. @param {string} uuid @param {Record<string, any>} content */
  #emitContent(uuid, content) {
    const set = this.#contentListeners.get(uuid)
    if (!set) return
    for (const listener of set) {
      try { listener(content) } catch (e) { console.error('[document-service] onContent listener threw', e) }
    }
  }

  /**
   * Load a document. Go's codec did the splitting server-side; JS never parses a
   * document. The BLOCKS are not returned — they go into the follower model via
   * the onContent publication. What comes back is what only the HOST acts on.
   * @param {string} uuid
   * @returns {Promise<{ body: string, meta: { mode: string }, scroll: number, version: number }>}
   *   body: the raw serialized form (markdown-mode surface seed);
   *   meta.mode: the frontmatter mode the workspace boot path reads;
   *   scroll: the session's saved offset (0 for a never-scrolled tab);
   *   version: the baseline for the container-saved fact (0 when unversioned).
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
   * The document's content answer. The frame carries NO uuid: the channel is
   * already bound to one document, and a uuid parameter would let a client ask one
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
   * Asks Go to persist now rather than on its debounce. FIRE-AND-FORGET, and it
   * returns nothing: the save answers no request, it announces itself as
   * `container-saved`. Ordering still holds for a caller that must write before it
   * does something else on this document — frames leave on one socket and Go's
   * read loop serves them in order.
   * @param {string} uuid
   */
  flush(uuid) {
    this.#blockService._send(uuid, { type: DocumentFrame.FLUSH, uuid: uuid })
  }

  /** The document's authoritative raw serialized content, from Go. Rejects on
   *  timeout or a channel-less uuid.
   *  @param {string} uuid @returns {Promise<string>} */
  getRawContent(uuid) {
    return this.#blockService._awaitReply(uuid, { type: DocumentFrame.ENTER_MARKDOWN, uuid: uuid }, 'enter-markdown')
      .then((reply) => reply.markdown)
  }

  /** Replaces the document's whole raw buffer, fire-and-forget.
   *  @param {string} uuid @param {string} raw */
  setRawContent(uuid, raw) {
    this.#blockService._send(uuid, { type: DocumentFrame.DOC_UPDATE, uuid: uuid, markdown: raw })
  }

  /**
   * Saves the document's raw content. WITH a live channel: the enter-wysiwyg
   * handshake, resolving the server's reparsed block list. CHANNEL-LESS: the HTTP
   * save Go serves for prompts only — a prompt is fixed markdown, hence the mode
   * literal.
   * @param {string} uuid @param {string} raw
   * @returns {Promise<unknown>} settles when Go has taken the buffer
   */
  save(uuid, raw) {
    if (this.#blockService._hasChannel(uuid)) {
      return this.#blockService._awaitReply(uuid, { type: DocumentFrame.ENTER_WYSIWYG, uuid: uuid, markdown: raw }, 'enter-wysiwyg')
        .then((reply) => {
          // Go's reparse is a whole new statement of what the container holds,
          // including ids it MINTED, so it goes where the load answer goes.
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
   * The server's clean whole-document export — the Copy-as-Markdown text, never a
   * download. Resolves null when there is nothing to export.
   *
   * A CHANNEL-LESS document resolves null, and that is not a gap: a prompt IS its
   * markdown buffer, so the editor holding it already has these exact bytes.
   * @param {string} uuid @param {string} format
   * @returns {Promise<string|null>}
   */
  export(uuid, format) {
    if (!this.#blockService._hasChannel(uuid)) return Promise.resolve(null)
    return this.#blockService._awaitReply(uuid, { type: DocumentFrame.EXPORT, format: format }, 'export')
      .then((reply) => (reply.content != null ? reply.content : null))
  }

  /** The dwell ping: the user is looking at this document, which raises its focus
   *  count. Fire-and-forget and deliberately unanswered.
   *  @param {string} uuid */
  focus(uuid) {
    this.#blockService._send(uuid, { type: DocumentFrame.FOCUS })
  }

  // ONE FRAME, FOUR KINDS. `paste` carries a `kind` discriminant deciding what the
  // server makes of its payload.

  /**
   * Reconstruct a multi-block clipboard slice server-side. The ack NAMES NO BLOCK
   * — a slice created several and can single out none — so the caller has nothing
   * to read from it. Awaits at PASTE_ACK_TIMEOUT_MS, not the wire default.
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
   * Resolve a clipboard/drop payload server-side. Resolves Go's `PasteResult`, a
   * DISCRIMINATED UNION whose `outcome` is the only field the caller switches on:
   *   `block`   created server-side; it arrives over the insert-block render-back.
   *   `content` Go composed an HTML fragment for the caret; insert `html`.
   *   `none`    not a Sieve concern; replay the raw clipboard locally.
   *
   * A paste the server could not serve answers `none` with an `error`, so the
   * local replay is still right and needs no extra branch. Awaits at
   * PASTE_ACK_TIMEOUT_MS.
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
   * Tell Go a file drop LANDED and to take it from the native drop bucket — the
   * OS-level catch that sees every source app identically. `payload.entries` is
   * the page's readable text, a HINT Go consults only when the bucket misses.
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
   * Ask Go to read the OS clipboard itself and make a block of whatever is on it.
   *
   * THIS FRAME CARRIES NO CLIPBOARD, AND THAT IS THE POINT: WebKitGTK hands the
   * page a paste event whose `DataTransfer` is completely empty for a desktop-tool
   * screenshot, so there is nothing to forward and the emptiness IS the signal.
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

  /**
   * MEMBERSHIP: add a block. The index is the CALLER's, resolved from the
   * container's own order — a fact the host holds — so nothing has to be mounted
   * for a block to be added. `opts.blockId` is the block's own name when its
   * creator already gave it one; an empty one asks Go to mint. -1 appends.
   * Never rejects; a channel-less uuid resolves {ok:false}.
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

  /** MEMBERSHIP: remove a block. Never rejects.
   *  @param {string} uuid @param {string} blockId
   *  @returns {Promise<{ok: boolean, error?: string}>} */
  deleteBlock(uuid, blockId) {
    return this.#blockService._awaitAck(uuid, { type: DocumentFrame.BLOCK_OP, uuid: uuid, op: { type: 'delete-block', blockId: blockId } }, 'delete-block ' + blockId)
  }

  /** MEMBERSHIP: install the document's top-level block ORDER. `order` must name
   *  every block the server holds — Go refuses a partial list, which would read as
   *  a mass delete. Never rejects.
   *  @param {string} uuid @param {string[]} order
   *  @returns {Promise<{ok: boolean, error?: string}>} */
  setBlockOrder(uuid, order) {
    return this.#blockService._awaitAck(uuid, { type: DocumentFrame.BLOCK_OP, uuid: uuid, op: { type: 'set-order', order: order } }, 'set-order ' + order.length + ' blocks')
  }
}
