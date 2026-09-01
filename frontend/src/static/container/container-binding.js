// @ts-check
// ContainerBinding: the transport, pre-bound to ONE container. Every method here is
// one wire frame with the uuid already filled in, and nothing above it holds a uuid
// — possession of a provider is authorization for exactly one container.
//
// It mints NO correlations of its own: an opId settles the promise a method returns
// and goes no further, so nothing above this class ever learns one.
//
// The results are the RAW wire answers. Mapping them to the facade's vocabulary (a
// PasteDecision, an offer list) belongs to the adapter, which speaks the facade.

import { ContractViolation } from '../contract/sieve-block.js'
import { updateBlockOp } from './block-ops.js'
import { DocumentFrame } from '../generated/protocol.js'

export class ContainerBinding {
  /** @type {string} */ #uuid
  /** @type {import('./document-service.js').DocumentService} */ #documents
  /** @type {import('./container-transport.js').ContainerTransport} */ #blocks

  /**
   * @param {string} uuid
   * @param {import('./document-service.js').DocumentService} documentService
   */
  constructor(uuid, documentService) {
    if (!uuid) throw new ContractViolation('ContainerBinding: uuid is required')
    if (!documentService || !documentService.blockService) {
      throw new ContractViolation('ContainerBinding: construct over the DocumentService')
    }
    this.#uuid = uuid
    this.#documents = documentService
    this.#blocks = documentService.blockService
  }

  /** @returns {string} */
  getUuid() { return this.#uuid }

  /**
   * create-block at an absolute index the CALLER resolved from container order — a
   * container's order is a fact the host already holds, so no lens need be mounted
   * for a block to be added.
   *
   * A block the client already drew names ITSELF: `attrs.id` is lifted to the op's
   * blockId, which is the field Go validates and adopts. The lift happens here,
   * because which wire field carries identity is framing knowledge.
   * @param {string} kind @param {Record<string, any>} attrs @param {number} index
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  createBlock(kind, attrs, index) {
    const blockId = (attrs && typeof attrs.id === 'string') ? attrs.id : ''
    return this.#documents.createBlock(this.#uuid, kind, attrs, undefined, { index: index, blockId: blockId })
  }

  /**
   * update-block: an attrs DELTA for one block. `kind` comes from the caller (the
   * follower model knows it), not from the transport's routing index.
   * @param {string} blockId @param {string} kind @param {Record<string, any>} patch
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  updateBlock(blockId, kind, patch) {
    const op = updateBlockOp({ id: blockId, kind: kind, attrs: patch })
    return this.#blocks._awaitAck(
      this.#uuid, { type: DocumentFrame.BLOCK_OP, uuid: this.#uuid, op: op }, 'update-block ' + blockId)
  }

  /**
   * set-order: the container's COMPLETE child order. Reorder is expressed this way
   * rather than as a move-by-index because installing a whole order is idempotent —
   * a duplicate or late request lands the container in the same place — and because
   * it is the shape Go echoes back as order-changed.
   * @param {string[]} order
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  setOrder(order) {
    return this.#documents.setBlockOrder(this.#uuid, order)
  }

  /**
   * delete-block: the container drops one child. Go answers it with a `remove-block`
   * echo, which is how every follower learns the block is gone; this ack only
   * reports whether the request was accepted.
   * @param {string} blockId
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  deleteBlock(blockId) {
    return this.#documents.deleteBlock(this.#uuid, blockId)
  }

  /**
   * extract/transform: Go recognises the entries as targetKind and applies
   * `operation`. The created or replaced block arrives as its own render-back —
   * this ack only reports whether the operation was accepted.
   * @param {{blockId: string, targetKind: string, operation: string, entries: object[], index: number}} payload
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  extract(payload) {
    return this.#blocks.extract(this.#uuid, payload)
  }

  /**
   * retry-block-job: re-run whatever async work the block declares. Kind-blind —
   * Go knows what retry means for each flavour. Fire-and-forget: the outcome
   * arrives as the block's own status attrs changing.
   * @param {string} blockId
   */
  retry(blockId) {
    this.#blocks.retry(this.#uuid, blockId)
  }

  /**
   * text-replace: one anchored run of a block's text. The anchor is resolved
   * against the block's CURRENT text server-side, so the offsets travel as the
   * hint they are. The corrected block arrives as its own render-back.
   * @param {{blockId: string, locator: string, quote: string, occurrence: number, start: number, end: number, replacement: string}} payload
   * @returns {Promise<string>} the ack's outcome word
   */
  replaceText(payload) {
    return this.#blocks.replaceText(this.#uuid, payload)
  }

  /**
   * flush: ask Go to write the container to disk now rather than on its own
   * debounce. Fire-and-forget and deliberately unanswered — the save announces
   * itself to the whole workspace as `container-saved`.
   */
  persist() {
    this.#documents.flush(this.#uuid)
  }

  /**
   * The container's authoritative serialized form. A channel-bearing container
   * answers with the enter-markdown handshake, which is also Go's hand-over: it
   * treats the text as the truth until `setContents` re-parses. A channel-less one
   * (a prompt) has no such mode, so its load answer IS the projection.
   * @returns {Promise<string>}
   */
  getContents() {
    if (this.#blocks._hasChannel(this.#uuid)) return this.#documents.getRawContent(this.#uuid)
    return this.#documents.load(this.#uuid).then((data) => data.body || '')
  }

  /**
   * Hands the whole container back as text. Go re-parses and resumes leading from
   * the block tree; the deltas arrive on the ordinary inbound path. The channel-less
   * half is the prompt's HTTP save.
   * @param {string} text
   * @returns {Promise<void>}
   */
  setContents(text) {
    return Promise.resolve(this.#documents.save(this.#uuid, text)).then(() => undefined)
  }

  /**
   * The in-flight whole-container handoff: keep this buffer, do not re-parse it.
   * Fire-and-forget, because it always lands — `flush` at container scale. A
   * channel-less container can only keep text by saving it.
   * @param {string} text
   */
  flushContents(text) {
    if (this.#blocks._hasChannel(this.#uuid)) { this.#documents.setRawContent(this.#uuid, text); return }
    this.#documents.save(this.#uuid, text)
  }

  /**
   * The server's clean whole-container export (ai-blocks filtered, cards and clips
   * reduced to links) — what "Copy as Markdown" puts on the clipboard, never a
   * download. A container with no channel has nothing to filter, so its raw
   * projection is the export.
   * @param {string} format
   * @returns {Promise<string|null>}
   */
  exportAs(format) {
    if (this.#blocks._hasChannel(this.#uuid)) return this.#documents.export(this.#uuid, format)
    return this.getContents()
  }

  /**
   * One paste round trip, resolving Go's raw PasteResult union. The payload's `kind`
   * picks the wire verb.
   * @param {{kind?: string, entries?: object[], slice?: object[][], index: number}} payload
   * @returns {Promise<Record<string, any>>}
   */
  paste(payload) {
    const index = payload.index
    switch (payload.kind) {
      case 'slice':
        return this.#documents.pasteSlice(this.#uuid, { slice: payload.slice || [], index: index })
      case 'native-drop':
        return this.#documents.nativeDropPaste(this.#uuid, { entries: payload.entries || [], index: index })
      case 'native-clipboard':
        return this.#documents.nativeClipboardPaste(this.#uuid, { index: index })
      default:
        return this.#documents.smartPaste(this.#uuid, { entries: payload.entries || [], index: index })
    }
  }

  /**
   * Backend-declared extraction capability discovery, on THIS container's channel.
   * @param {{sourceKind: string, entries: object[]}} payload
   * @returns {Promise<Array<{kind: string, actions: string[]}>>}
   */
  detectExtractions(payload) {
    return this.#blocks.detectExtractions(this.#uuid, payload)
  }
}
