// @ts-check
// The container a DRAFT is edited through: it lives in the page, and it dies
// with the host that made it. No wire, no persistence, nothing behind it.
//
// It is BOTH HALVES AT ONCE — the authority and the follower. Every verb applies
// to its own state and echoes `onChanged`: there is no Go behind it to lead, so
// nothing here is optimistic. A block the lens already drew keeps the UUIDv7 the
// lens minted, and this authority adopts it.
//
// WHAT IT OMITS IS PART OF THE CONTRACT. There is no `paste`, no
// `detectExtractions`, no `requestTransform` and no whole-content half. Each of
// those is server work, and each is gated at its call site by the presence of
// the method; their ABSENCE is what removes the affordances riding them, so a
// stub here would silently put every one of them back.

import { ContainerModel } from './container-model.js'
import { CONTENT_ATTR } from './block-provider-adapter.js'
import { DocumentFrame } from '../generated/protocol.js'
import { ContractViolation } from '../contract/sieve-block.js'
import { Ident } from '../ident/ident.js'

// The container's kind as a DATA word, alongside 'note' and 'prompt': what is
// being edited is a message under composition, not a document.
const DRAFT_KIND = 'draft'

/**
 * @typedef {object} DraftSeed
 * @property {string} [uuid]   the draft's name; minted here when absent
 * @property {Array<{id?: string, kind?: string, attrs?: Record<string, any>}>} [blocks]
 *   what the draft starts as, in container order
 */

export class InMemoryContainerProvider {
  /** @type {ContainerModel} the draft's whole state, and the source of every
   *  read and every cue. */
  #model

  /** @param {DraftSeed} [seed] */
  constructor(seed = {}) {
    this.#model = new ContainerModel(seed.uuid || Ident.mint(), DRAFT_KIND)
    if (seed.blocks && seed.blocks.length) this.#model.applyLoad({ blocks: seed.blocks })
  }

  // ── The read minimum ───────────────────────────────────────────────────────

  /** @returns {string} */
  getUuid() { return this.#model.getUuid() }

  /** @returns {string} */
  getKind() { return this.#model.getKind() }

  /** @returns {ReadonlyArray<string>} the child ids in container order */
  getOrder() { return this.#model.getOrder() }

  /** @param {string} id @returns {Readonly<import('./container-model.js').BlockNode>|null} */
  getBlock(id) { return this.#model.getBlock(id) }

  /** @param {import('./container-model.js').ContainerUpdateListener} listener */
  subscribe(listener) { this.#model.subscribe(listener) }

  /** @param {import('./container-model.js').ContainerUpdateListener} listener */
  unsubscribe(listener) { this.#model.unsubscribe(listener) }

  // ── The block verbs. Void, and answered only by a later cue ────────────────

  /**
   * Puts a new block into the draft. `attrs.id` is the block's own name when the
   * lens already drew it; without one a UUIDv7 is minted here, which is what an
   * authority does.
   * @param {string} kind @param {Record<string, any>} attrs
   * @param {string|null} [afterBlockId] anchor; omitted or unknown appends, null is the front
   */
  requestAddBlock(kind, attrs, afterBlockId) {
    if (!kind) throw new ContractViolation('requestAddBlock: kind is required')
    const bag = Object.assign({}, attrs)
    this.#model.applyFrame({
      type: DocumentFrame.INSERT_BLOCK,
      id: bag.id || Ident.mint(),
      kind: kind,
      attrs: bag,
      index: this.#slotAfter(afterBlockId),
    })
  }

  /** @param {string} blockId @param {Record<string, any>} patch a DELTA, not the whole bag */
  requestSetBlock(blockId, patch) {
    if (!this.#holds(blockId, 'requestSetBlock')) return
    this.#model.applyFrame({
      type: DocumentFrame.BLOCK_ATTRS_UPDATED, id: blockId, attrs: patch || {},
    })
  }

  /** @param {string} blockId */
  requestRemoveBlock(blockId) {
    if (!this.#holds(blockId, 'requestRemoveBlock')) return
    this.#model.applyFrame({ type: DocumentFrame.REMOVE_BLOCK, id: blockId })
  }

  /**
   * States the order of the named children. The list may be a SUBSEQUENCE of what
   * the draft holds — a surface can only name what it paints, and this draft also
   * holds question elements no surface draws — so the merge into the draft's full
   * order is what gets installed. An id the draft does not hold DROPS the whole
   * statement: a list naming a stranger is indistinguishable from a stale one.
   * @param {ReadonlyArray<string>} order
   */
  requestSetOrder(order) {
    const statement = this.#model.mergeOrder(order)
    if (!statement.held) {
      return this.#drop('requestSetOrder: not held by the draft', Array.from(order || []).join(','))
    }
    if (!statement.order) return
    this.#model.applyFrame({ type: DocumentFrame.ORDER_CHANGED, order: statement.order })
  }

  /**
   * Takes over one block's in-flight text. A draft has nowhere to flush TO, so
   * the text simply becomes the block's state.
   * @param {string} blockId @param {string} text
   */
  flush(blockId, text) {
    const node = this.#model.getBlock(blockId)
    if (!node) return this.#drop('flush: unknown block id', blockId)
    /** @type {Record<string, any>} */
    const patch = {}
    patch[CONTENT_ATTR[node.kind] || 'content'] = text
    this.#model.applyFrame({ type: DocumentFrame.BLOCK_ATTRS_UPDATED, id: blockId, attrs: patch })
  }

  /** A draft persists nowhere, so there is nothing to commit. */
  requestPersist() {}

  /** Nothing here runs async work on a block's behalf, so there is nothing to run again.
   *  @param {string} _blockId */
  requestRetry(_blockId) {}

  /**
   * The container position a child anchored after `afterBlockId` takes. Omitted
   * and an id the draft does not hold both APPEND; `null` is the front, which is
   * a place rather than an absence.
   * @param {string|null|undefined} afterBlockId @returns {number}
   */
  #slotAfter(afterBlockId) {
    if (afterBlockId === null) return 0
    const order = this.#model.getOrder()
    if (!afterBlockId) return order.length
    const at = order.indexOf(afterBlockId)
    return at < 0 ? order.length : at + 1
  }

  /** @param {string} blockId @param {string} verb @returns {boolean} */
  #holds(blockId, verb) {
    if (this.#model.getBlock(blockId)) return true
    this.#drop(verb + ': unknown block id', blockId)
    return false
  }

  /** A verb the draft cannot honour is dropped with a warning, never thrown:
   *  these are void and called mid-gesture.
   *  @param {string} reason @param {string} detail */
  #drop(reason, detail) {
    console.warn('[in-memory-container] ' + reason + ', dropped', detail)
  }
}
