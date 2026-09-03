// @ts-check
// The document channel's VOCABULARY: every verb Sieve speaks about a document, and
// the only place a wire frame is spelled. Every frame shape, every ack/reply
// pattern, every timeout and both HTTP halves are here; the transport underneath
// carries frames and reads none of them. HOST data plane: no lens reaches it — a
// lens holds a provider.
//
// STATELESS PER CONTAINER. The uuid is a parameter on every verb, never a field, so
// one service speaks for every open document. Its only state is the onContent
// subscription registry, which is a set of listeners keyed by uuid and not a view of
// any container.
//
// ONE TRANSPORT WITH ONE EXCEPTION. A document verb is a frame on that document's
// channel. The exception is the PROMPT pseudo-document, which never opens one, so
// its load and its save are the only two verbs with an HTTP half.
//
// A channel-less uuid degrades PER VERB rather than by one uniform rule:
// flushContents and setContents fall back to the HTTP save; getContents and exportAs
// fall back to the load answer; focus, persist, retry and setFeature drop; the
// membership verbs and extract resolve {ok:false}; detectExtractions resolves no
// offers and replaceText resolves `error`. paste REJECTS, so a channel-less caller
// of it needs its own catch.

import { ContractViolation } from '../contract/sieve-block.js'
import { DocumentFrame } from '../generated/protocol.js'

// The server's paste path can outlast the wire's default 5s ceiling: smart-image
// acquire downloads synchronously with its own 8s HTTP timeout. This must exceed
// that 8s, or the ack outlives the awaiter — the insert anchor is never consumed
// and outcome:'none' never replays the clipboard.
const PASTE_ACK_TIMEOUT_MS = 12000

// Go's text-replace outcome for a write that could not be run, as the wire spells
// it. The other two words — applied, and the anchor no longer resolves — are read
// by nobody here: both mean the container is now what Go says it is.
const TEXT_REPLACE_ERROR = 'error'

/** @typedef {import('./container-transport.js').ChannelDelegate} ChannelDelegate */

/**
 * Where a created block lands, IN WIRE SHAPE: the id of the block it follows, or
 * the front of the container. Go resolves it against the authoritative tree, so a
 * position is never computed here — the follower model this client holds is
 * always at least one round trip behind Go's. An empty anchor appends.
 * @typedef {{afterBlockId?: string, atFront?: boolean}} BlockAnchor
 */

export class DocumentService {
  /** @type {import('./container-transport.js').ContainerTransport} */ #transport
  /** @type {Map<string, Set<(content: Record<string, any>) => void>>} uuid → whole-container-answer observers (see onContent) */ #contentListeners = new Map()

  /** @param {import('./container-transport.js').ContainerTransport} transport */
  constructor(transport) {
    if (!transport) throw new ContractViolation('DocumentService: constructed over the ContainerTransport (composition root wiring)')
    this.#transport = transport
  }

  /** @param {string} uuid @param {ChannelDelegate} delegate */
  open(uuid, delegate) {
    this.#transport.openChannel(uuid, delegate)
  }

  /** @param {string} uuid */
  close(uuid) {
    this.#transport.closeChannel(uuid)
  }

  /**
   * Subscribe to a document's raw inbound frames — the mutation echoes, in arrival
   * order. It is the seam the follower model folds from.
   * @param {string} uuid @param {(msg: Record<string, any>) => void} observer
   * @returns {() => void} unsubscribe
   */
  observeFrames(uuid, observer) {
    return this.#transport.observeFrames(uuid, observer)
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
    if (this.#transport._hasChannel(uuid)) {
      return this.#transport._awaitReply(uuid, { type: DocumentFrame.LOAD }, 'load')
    }
    return fetch('/api/document/load?uuid=' + encodeURIComponent(uuid)).then((r) => r.json())
  }

  /**
   * Asks Go to write the document to disk now rather than on its debounce.
   * FIRE-AND-FORGET, and it returns nothing: the save answers no request, it
   * announces itself to the whole workspace as `container-saved`. Ordering still
   * holds for a caller that must write before it does something else on this
   * document — frames leave on one socket and Go's read loop serves them in order.
   * @param {string} uuid
   */
  persist(uuid) {
    this.#transport._send(uuid, { type: DocumentFrame.FLUSH, uuid: uuid })
  }

  /** The dwell ping: the user is looking at this document, which raises its focus
   *  count. Fire-and-forget and deliberately unanswered.
   *  @param {string} uuid */
  focus(uuid) {
    this.#transport._send(uuid, { type: DocumentFrame.FOCUS })
  }

  /**
   * The document's authoritative serialized form. A channel-bearing document
   * answers with the enter-markdown handshake, which is also Go's hand-over: it
   * treats the text as the truth until `setContents` re-parses. A channel-less one
   * (a prompt) has no such mode, so its load answer IS the projection.
   *
   * REJECTS on a handshake timeout — the mode flip's stay-on-failure depends on it.
   * @param {string} uuid @returns {Promise<string>}
   */
  getContents(uuid) {
    if (!this.#transport._hasChannel(uuid)) return this.load(uuid).then((data) => data.body || '')
    return this.#transport._awaitReply(uuid, { type: DocumentFrame.ENTER_MARKDOWN, uuid: uuid }, 'enter-markdown')
      .then((reply) => reply.markdown)
  }

  /**
   * Hands the whole document back as text. WITH a live channel: the enter-wysiwyg
   * handshake, whose reparsed block list is a whole new statement of what the
   * container holds and goes where the load answer goes. CHANNEL-LESS: the HTTP
   * save Go serves for prompts only — a prompt is fixed markdown, hence the mode
   * literal.
   * @param {string} uuid @param {string} text
   * @returns {Promise<void>} settles when Go has taken the buffer
   */
  setContents(uuid, text) {
    if (this.#transport._hasChannel(uuid)) {
      return this.#transport._awaitReply(uuid, { type: DocumentFrame.ENTER_WYSIWYG, uuid: uuid, markdown: text }, 'enter-wysiwyg')
        .then((reply) => { this.#emitContent(uuid, reply) })
    }
    return fetch('/api/document/save?uuid=' + encodeURIComponent(uuid), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ body: text, mode: 'markdown' }),
    }).then(() => undefined)
  }

  /**
   * The in-flight whole-document handoff: keep this buffer, do NOT re-parse it.
   * Fire-and-forget, because it always lands — `persist` at container scale. A
   * channel-less document can only keep text by saving it.
   * @param {string} uuid @param {string} text
   */
  flushContents(uuid, text) {
    if (!this.#transport._hasChannel(uuid)) { this.setContents(uuid, text); return }
    this.#transport._send(uuid, { type: DocumentFrame.DOC_UPDATE, uuid: uuid, markdown: text })
  }

  /**
   * The server's clean whole-document export (ai-blocks filtered, cards and clips
   * reduced to links) — what "Copy as Markdown" puts on the clipboard, never a
   * download. A document with no channel has nothing to filter, so its raw
   * projection is the export.
   * @param {string} uuid @param {string} format
   * @returns {Promise<string|null>}
   */
  exportAs(uuid, format) {
    if (!this.#transport._hasChannel(uuid)) return this.getContents(uuid)
    return this.#transport._awaitReply(uuid, { type: DocumentFrame.EXPORT, format: format }, 'export')
      .then((reply) => (reply.content != null ? reply.content : null))
  }

  /**
   * One paste round trip. ONE FRAME, FOUR KINDS: `payload.kind` is the discriminant
   * deciding what the server makes of the payload, and what rides with it —
   *
   *   slice            a multi-block clipboard slice, reconstructed server-side.
   *                    The ack NAMES NO BLOCK: a slice created several and can
   *                    single out none.
   *   smart            a clipboard or drop payload, resolved server-side.
   *   native-drop      a file drop LANDED; Go takes it from the native drop bucket,
   *                    the OS-level catch that sees every source app identically.
   *                    The entries are the page's readable text, a HINT Go consults
   *                    only when the bucket misses.
   *   native-clipboard Go reads the OS clipboard itself. THE FRAME CARRIES NOTHING,
   *                    AND THAT IS THE POINT: WebKitGTK hands the page a paste event
   *                    whose DataTransfer is completely empty for a desktop-tool
   *                    screenshot, so there is nothing to forward and the emptiness
   *                    IS the signal.
   *
   * Resolves Go's `PasteResult`, a DISCRIMINATED UNION whose `outcome` is the only
   * field the caller switches on:
   *   `block`   created server-side; it arrives over the insert-block render-back.
   *   `content` Go composed an HTML fragment for the caret; insert `html`.
   *   `none`    not a Sieve concern; replay the raw clipboard locally.
   * A paste the server could not serve answers `none` with an `error`, so the local
   * replay is still right and needs no extra branch.
   *
   * Awaits at PASTE_ACK_TIMEOUT_MS, not the wire default.
   * @param {string} uuid
   * @param {{kind?: string, entries?: object[], slice?: object[][], anchor?: BlockAnchor}} payload
   * @returns {Promise<{outcome?: string, kind?: string, id?: string, rawYaml?: string, html?: string, error?: string}>}
   */
  paste(uuid, payload) {
    const kind = payload.kind || 'smart'
    const frame = Object.assign(
      { type: DocumentFrame.PASTE, kind: kind },
      this.#pasteBody(kind, payload),
      payload.anchor || {})
    return this.#transport._awaitReply(uuid, frame, 'paste ' + kind, PASTE_ACK_TIMEOUT_MS)
  }

  /** What a paste kind puts on the wire beside its discriminant. A kind states one
   *  field or none — an empty key is a payload the server would try to read.
   *  @param {string} kind
   *  @param {{entries?: object[], slice?: object[][]}} payload
   *  @returns {Record<string, any>} */
  #pasteBody(kind, payload) {
    if (kind === 'slice') return { slice: payload.slice || [] }
    if (kind === 'native-clipboard') return {}
    return { entries: payload.entries || [] }
  }

  /**
   * Backend-declared extraction capability discovery: which (kind, actions) Go can
   * extract or transform this content into. No channel means an empty offer list —
   * nothing to discover is a legitimate answer. REJECTS on the 5s timeout; the
   * provider degrades that to an empty list.
   * @param {string} uuid @param {string} sourceKind
   * @param {Array<{mimeType: string, content: string}>} entries
   * @returns {Promise<Array<{kind: string, actions: string[]}>>}
   */
  detectExtractions(uuid, sourceKind, entries) {
    if (!this.#transport._hasChannel(uuid)) return Promise.resolve([])
    return this.#transport._awaitReply(uuid, {
      type: DocumentFrame.DETECT_EXTRACTIONS,
      sourceKind: sourceKind,
      entries: entries || [],
    }, 'detect-extractions ' + sourceKind)
      .then((reply) => reply.offers || [])
  }

  /**
   * MEMBERSHIP: add a block. `anchor` names the block the new one follows and Go
   * resolves it against the authoritative tree; an empty anchor appends.
   *
   * A block its creator already named carries that name in `attrs.id`, and it is
   * lifted onto the op's `blockId` — the field Go validates and adopts — because
   * which wire field carries identity is framing knowledge. An unnamed block asks
   * Go to mint.
   * Never rejects; a channel-less uuid resolves {ok:false}.
   * @param {string} uuid @param {string} kind @param {Record<string, any>} attrs
   * @param {BlockAnchor} [anchor]
   * @param {{aliases?: string[]}} [opts]
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  createBlock(uuid, kind, attrs, anchor, opts) {
    const blockId = (attrs && typeof attrs.id === 'string') ? attrs.id : ''
    const op = this.#blockOp('create-block', blockId, kind, attrs || {}, opts && opts.aliases)
    Object.assign(op, anchor || {})
    return this.#awaitBlockOp(uuid, op, 'create-block ' + kind)
  }

  /** MEMBERSHIP: an attrs DELTA for one block. `kind` comes from the caller — the
   *  follower model knows it — never from the transport. Never rejects.
   *  @param {string} uuid @param {string} blockId @param {string} kind
   *  @param {Record<string, any>} patch
   *  @returns {Promise<{ok: boolean, error?: string}>} */
  updateBlock(uuid, blockId, kind, patch) {
    return this.#awaitBlockOp(uuid, this.#blockOp('update-block', blockId, kind, patch), 'update-block ' + blockId)
  }

  /** MEMBERSHIP: remove a block. Go answers with a `remove-block` echo, which is how
   *  every follower learns the block is gone; the ack only reports whether the
   *  request was accepted. Never rejects.
   *  @param {string} uuid @param {string} blockId
   *  @returns {Promise<{ok: boolean, error?: string}>} */
  deleteBlock(uuid, blockId) {
    return this.#awaitBlockOp(uuid, { type: 'delete-block', blockId: blockId }, 'delete-block ' + blockId)
  }

  /**
   * MEMBERSHIP: install the document's COMPLETE top-level block order. `order` must
   * name every block the server holds — Go refuses a partial list, which would read
   * as a mass delete.
   *
   * Reorder is expressed this way rather than as a move-by-index because installing
   * a whole order is idempotent — a duplicate or late request lands the container in
   * the same place — and because it is the shape Go echoes back as order-changed.
   * Never rejects.
   * @param {string} uuid @param {string[]} order
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  setBlockOrder(uuid, order) {
    return this.#awaitBlockOp(uuid, { type: 'set-order', order: order }, 'set-order ' + order.length + ' blocks')
  }

  /**
   * A block extraction/transform: Go recognises the entries as `targetKind` and
   * applies `operation`. The frame carries NO uuid — the server resolves the
   * document from the channel — and NO position: an extraction lands after its
   * source block, a transform keeps the source's own slot, and both are Go's to
   * resolve. Never rejects; the created or replaced block arrives as its own
   * render-back.
   * @param {string} uuid @param {string} blockId @param {string} targetKind
   * @param {string} operation @param {Array<{mimeType: string, content: string}>} entries
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  extract(uuid, blockId, targetKind, operation, entries) {
    return this.#transport._awaitAck(uuid, {
      type: DocumentFrame.EXTRACT,
      blockId: blockId,
      targetKind: targetKind,
      operation: operation,
      entries: entries || [],
    }, 'extract ' + targetKind)
  }

  /** Re-run a block's backend job; kind-blind, because Go knows what retry means.
   *  Fire-and-forget: the outcome arrives as the block's own status attrs changing.
   *  @param {string} uuid @param {string} blockId */
  retry(uuid, blockId) {
    this.#transport._send(uuid, { type: DocumentFrame.RETRY_BLOCK_JOB, uuid: uuid, id: blockId })
  }

  /**
   * A text-replace: one anchored run of a block's text, written by Go. The anchor is
   * resolved at its own grain against the block's CURRENT text server-side, so the
   * offsets travel as the hint they are. The corrected block arrives as its own
   * render-back BEFORE this settles, so what settles here is only which of the three
   * things happened.
   *
   * It takes the MARK, and it is the ONE place a mark becomes the frame's eight
   * fields — a second mapping is a second chance to send an anchor the server cannot
   * resolve. The quote and the grain are demanded for that reason: an anchor missing
   * either resolves nowhere, and the server would answer `stale` for text that never
   * moved.
   *
   * Never rejects. A channel-less document, a timeout and a malformed answer all
   * read as `error`, which is the truthful reading of "the write did not happen and
   * nothing says it did".
   * @param {string} uuid
   * @param {Readonly<import('../contract/container-update-listener.js').SieveTextMark> & {blockId?: string}} mark
   * @param {string} replacement
   * @returns {Promise<string>} the ack's outcome word
   */
  replaceText(uuid, mark, replacement) {
    if (!mark || !mark.blockId) throw new ContractViolation('replaceText: the anchor must name the block it is in')
    if (!mark.quote) throw new ContractViolation('replaceText: the anchor must carry the quote it names')
    if (!mark.grain) throw new ContractViolation('replaceText: the anchor must carry the grain its occurrence is counted at')
    return this.#transport._awaitReply(uuid, {
      type: DocumentFrame.TEXT_REPLACE,
      blockId: mark.blockId,
      locator: mark.locator || '',
      quote: mark.quote,
      occurrence: mark.occurrence || 0,
      grain: mark.grain,
      start: mark.start || 0,
      end: mark.end || 0,
      replacement: String(replacement == null ? '' : replacement),
    }, 'text-replace ' + mark.blockId)
      .then((reply) => String((reply && reply.outcome) || TEXT_REPLACE_ERROR))
      .catch(() => TEXT_REPLACE_ERROR)
  }

  /**
   * A text-service producer switched on or off for THIS document, with whatever it
   * is to work with.
   *
   * THE CHANNEL IS THE SCOPE. Arriving on one document's own wire is what makes the
   * switch that document's alone, so a feature enabled through this dies when the
   * document closes and no other document hears it.
   *
   * Unanswered and fire-and-forget. What a switched-on feature produces arrives as
   * the marks it pushes, and a channel that has gone away has switched everything
   * off by closing — which is why nothing here waits to be told the switch landed.
   * @param {string} uuid @param {string} feature @param {boolean} enabled
   * @param {Record<string, any>} [parameters]
   */
  setFeature(uuid, feature, enabled, parameters) {
    this.#transport._send(uuid, {
      type: DocumentFrame.FEATURE_CONTROL,
      feature: feature,
      enabled: enabled,
      parameters: parameters || {},
    })
  }

  /**
   * The block-op envelope. Every membership verb rides it, and the document is named
   * on the envelope rather than in the op.
   * @param {string} uuid @param {Record<string, any>} op @param {string} label
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  #awaitBlockOp(uuid, op, label) {
    return this.#transport._awaitAck(uuid, { type: DocumentFrame.BLOCK_OP, uuid: uuid, op: op }, label)
  }

  /** A block op in wire shape. Every kind's payload rides in `attrs` — there is no
   *  kind-special-cased top-level field on the wire.
   *  @param {string} type @param {string} blockId @param {string} kind
   *  @param {Record<string, any>} [attrs] @param {string[]} [aliases]
   *  @returns {Record<string, any>} */
  #blockOp(type, blockId, kind, attrs, aliases) {
    const op = /** @type {Record<string, any>} */ ({ type: type, blockId: blockId, kind: kind, attrs: attrs || {} })
    if (aliases && aliases.length) op.aliases = aliases
    return op
  }
}
