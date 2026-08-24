// @ts-check
// container-binding.js — ContainerBinding: the transport, pre-bound to ONE
// container (issue #96 P4a).
//
// Every method here is one existing wire frame with the uuid already filled in.
// That is the whole job: the provider adapter above it must not hold a uuid,
// because possession of a provider is authorization for exactly one container
// and a uuid parameter is a way to name another one. Binding the uuid once, in
// the host's mount sequence, is what makes that structural rather than a rule.
//
// It mints NO correlations of its own — the wire owner does, inside `_awaitAck`
// / `_awaitReply` / `updateAttributes`, and they live and die there: an opId
// settles the promise these methods return and goes no further. Nothing above
// this class ever learns one, and a render-back carries none, so there is
// nothing here to thread upward.
//
// The results are the RAW wire answers. Mapping them to the facade's vocabulary
// (a PasteDecision, an offer list) belongs to the adapter, which is the thing
// that speaks the facade.

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

  // ── Mutations (each resolves the wire ack; the adapter ignores it) ──────────

  /**
   * create-block at an absolute index the CALLER resolved from container order —
   * a container's order is a fact the host already holds, so no lens and no
   * editor needs to be mounted for a block to be added.
   *
   * A block the client already drew names ITSELF: `attrs.id` is lifted to the
   * op's blockId, which is the field Go validates and adopts (issue #96). The
   * lift happens here, at the framing layer, because which wire field carries
   * identity is framing knowledge — the facade above simply says the block knows
   * its own name.
   * @param {string} kind @param {Record<string, any>} attrs @param {number} index
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  createBlock(kind, attrs, index) {
    const blockId = (attrs && typeof attrs.id === 'string') ? attrs.id : ''
    return this.#documents.createBlock(this.#uuid, kind, attrs, undefined, { index: index, blockId: blockId })
  }

  /**
   * update-block: an attrs DELTA for one block. `kind` comes from the caller (the
   * follower model knows it) rather than the transport's routing index, so a
   * container that was never loaded through the old cache path still updates.
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
   * rather than as a move-by-index because installing a whole order is idempotent
   * — a duplicate or late request lands the container in the same place — and
   * because it is the shape Go echoes back as order-changed.
   * @param {string[]} order
   * @returns {Promise<{ok: boolean, error?: string}>}
   */
  setOrder(order) {
    return this.#documents.setBlockOrder(this.#uuid, order)
  }

  /**
   * delete-block: the container drops one child. Go answers it with a
   * `remove-block` echo, which is how every follower — the lens that asked and
   * the ones that did not — learns the block is gone; this ack only reports
   * whether the request was accepted.
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
   * flush: ask Go to write the container to disk now rather than on its own
   * debounce. Fire-and-forget and deliberately unanswered — the save announces
   * itself to the whole workspace as `container-saved`.
   */
  persist() {
    this.#documents.flush(this.#uuid)
  }

  // ── Whole-container text (the break-glass projection pair) ─────────────────

  /**
   * The container's authoritative serialized form. A channel-bearing container
   * answers it with the enter-markdown handshake, which is also Go's hand-over:
   * from here it treats the text as the truth until `setContents` re-parses. A
   * channel-less one (a prompt) has no such mode to be in, so its load answer
   * IS the projection.
   * @returns {Promise<string>}
   */
  getContents() {
    if (this.#blocks._hasChannel(this.#uuid)) return this.#documents.getRawContent(this.#uuid)
    return this.#documents.load(this.#uuid).then((data) => data.body || '')
  }

  /**
   * Hands the whole container back as text. Go re-parses and resumes leading
   * from the block tree; the deltas arrive on the ordinary inbound path. The
   * channel-less half is the prompt's HTTP save, which is the same statement
   * for a container whose whole truth IS its text.
   * @param {string} text
   * @returns {Promise<void>}
   */
  setContents(text) {
    return Promise.resolve(this.#documents.save(this.#uuid, text)).then(() => undefined)
  }

  /**
   * The in-flight whole-container handoff: keep this buffer, do not re-parse it.
   * Fire-and-forget, because it always lands — it is `flush` at container scale.
   * A channel-less container has no verbatim buffer to hold, so its only way to
   * keep text is to save it.
   * @param {string} text
   */
  flushContents(text) {
    if (this.#blocks._hasChannel(this.#uuid)) { this.#documents.setRawContent(this.#uuid, text); return }
    this.#documents.save(this.#uuid, text)
  }

  /**
   * The server's clean whole-container export (ai-blocks filtered, cards and
   * clips reduced to links) — what "Copy as Markdown" puts on the clipboard,
   * never a download. A container with no channel has no server-side filter to
   * apply and no ai-blocks to filter, so its raw projection is the export.
   * @param {string} format
   * @returns {Promise<string|null>}
   */
  exportAs(format) {
    if (this.#blocks._hasChannel(this.#uuid)) return this.#documents.export(this.#uuid, format)
    return this.getContents()
  }

  // ── Queries (decisions and offers — never document content) ────────────────

  /**
   * One paste round trip, resolving Go's raw PasteResult union. The payload's
   * `kind` picks the wire verb: the four kinds are four things Go can be asked
   * to make of a gesture, not four methods.
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
