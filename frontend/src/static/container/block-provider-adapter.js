// @ts-check
// BlockProviderAdapter: the host's implementation of the WRITE half of the wall,
// contract/container-provider.js's BlockContainerProvider.
//
// Three properties hold across every verb here:
//
//   NO LOCAL WRITE — not one method touches the model. Go leads, the model follows,
//     and a verb's effect reaches the lens as the echo Go sent, indistinguishable
//     from another lens's edit, an AI job or the watcher.
//   NO CORRELATION OUT — the verbs are void. A lens is later told that A change
//     happened; it never learns which change was its own.
//   POSITION FROM ORDER — anchoring is by block id, which the host resolves against
//     its own follower model. A lens never computes a document position.

import { ContractViolation } from '../contract/sieve-block.js'
import { WholeContentAdapter } from './whole-content-adapter.js'

// Go's PasteResult outcomes, as the wire spells them.
const OUTCOME_BLOCK = 'block'
const OUTCOME_CONTENT = 'content'
const OUTCOME_NONE = 'none'

// Where a kind keeps its text: `content` by default, overridden by the three
// source-bearing kinds. The facade's `flush` names neither attr, so it resolves
// here.
const CONTENT_ATTR = Object.freeze({ code: 'source', diagram: 'source', log: 'source' })

export class BlockProviderAdapter extends WholeContentAdapter {
  /** @type {import('./container-model.js').ContainerModel} */ #model

  /**
   * @param {import('./container-model.js').ContainerModel} model
   * @param {import('./container-binding.js').ContainerBinding} binding
   */
  constructor(model, binding) {
    super(model, binding)
    if (typeof binding.createBlock !== 'function' || typeof binding.setOrder !== 'function') {
      throw new ContractViolation('BlockProviderAdapter: construct with a ContainerBinding')
    }
    // The base keeps its own #private copy for the reads; this one is for the
    // verbs' position arithmetic.
    this.#model = model
  }

  /**
   * Puts a new block into the container. `attrs.id` is the block's own name when
   * the lens already drew it (a paragraph typed into existence) — Go validates
   * and adopts it; omitting it asks Go to mint one.
   * @param {string} kind @param {Record<string, any>} attrs
   * @param {string|null} [afterBlockId] anchor; omitted or unknown appends, null is the front
   */
  requestAddBlock(kind, attrs, afterBlockId) {
    if (!kind) throw new ContractViolation('requestAddBlock: kind is required')
    this.#settle(this._binding.createBlock(kind, attrs || {}, this.#slotAfter(afterBlockId)), 'requestAddBlock')
  }

  /**
   * @param {string} blockId @param {Record<string, any>} patch a DELTA, not the whole bag
   */
  requestSetBlock(blockId, patch) {
    const node = this.#model.getBlock(blockId)
    if (!node) return this.#drop('requestSetBlock', blockId)
    this.#settle(this._binding.updateBlock(blockId, node.kind, patch || {}), 'requestSetBlock')
  }

  /**
   * Asks for a block to leave the container. Void like its siblings: the block
   * leaves this lens's view when Go's `remove-block` echo reaches the fold, which
   * is when it leaves every other lens watching the same container.
   * @param {string} blockId
   */
  requestRemoveBlock(blockId) {
    if (!this.#model.getBlock(blockId)) return this.#drop('requestRemoveBlock', blockId)
    this.#settle(this._binding.deleteBlock(blockId), 'requestRemoveBlock')
  }

  /**
   * States the container's COMPLETE child order — idempotent, so a duplicate or late
   * request lands the container in the same place, and it is the shape
   * `order-changed` echoes back. An order that is not a permutation of what this
   * container holds is DROPPED here rather than sent: Go refuses it anyway, and a
   * list missing an id is indistinguishable from a mass delete.
   * @param {ReadonlyArray<string>} order
   */
  requestSetOrder(order) {
    const want = Array.from(order || [])
    const held = this.#model.getOrder()
    if (want.length !== held.length || !want.every((id) => held.indexOf(id) >= 0)) {
      return this.#drop('requestSetOrder: not a permutation of the container', want.join(','))
    }
    if (want.every((id, i) => id === held[i])) return  // already so — nothing to say
    this.#settle(this._binding.setOrder(want), 'requestSetOrder')
  }

  /**
   * Plays back an offer `detectExtractions` produced: Go recognises the entries as
   * targetKind and applies the operation. Whether that REPLACES the source or adds
   * beside it is Go's decision from `operation`; the index is consulted only for
   * the additive case.
   * @param {string} blockId @param {string} targetKind @param {string} operation
   * @param {Array<{mimeType: string, content: string}>} entries
   */
  requestTransform(blockId, targetKind, operation, entries) {
    const at = this.#model.getOrder().indexOf(blockId)
    if (at < 0) return this.#drop('requestTransform', blockId)
    this.#settle(this._binding.extract({
      blockId: blockId,
      targetKind: targetKind,
      operation: operation,
      entries: entries || [],
      index: at + 1,
    }), 'requestTransform')
  }

  /**
   * Re-runs whatever async work the block declares. Kind-blind: what retry means for
   * a flavour is the processor's business. Void — the outcome is the block's status
   * attrs changing, which arrives as `onChanged`.
   * @param {string} blockId
   */
  requestRetry(blockId) {
    if (!this.#model.getBlock(blockId)) return this.#drop('requestRetry', blockId)
    this._binding.retry(blockId)
  }

  /**
   * Asks the container to reach disk NOW rather than on its own debounce. It is not
   * `flush`: flush hands over one block's in-flight text, this commits whatever the
   * container already holds. Void and unanswered — a save announces itself to the
   * whole workspace as `container-saved`.
   */
  requestPersist() { this._binding.persist() }

  /**
   * Asks Go what to make of a clipboard, a drop, or a gesture the page could not
   * read at all. ONE query; `payload.kind` says which of the four it is. Resolves
   * the facade's decision:
   *
   *   block   — Go created one; it arrives as a render-back, nothing to do here.
   *   content — Go composed a fragment for the caret; the caller inserts it.
   *   none    — not a Sieve concern; the caller replays the clipboard natively.
   *
   * A timeout, a declined paste and a channel-less container all resolve `none`,
   * which is the correct instruction rather than a swallowed failure: the
   * caller's local replay is still the right move.
   * @param {import('../contract/container-provider.js').PastePayload} payload
   * @param {string|null} afterBlockId
   * @returns {Promise<import('../contract/container-provider.js').PasteDecision>}
   */
  paste(payload, afterBlockId) {
    const p = /** @type {any} */ (payload) || {}
    return this._binding
      .paste({
        kind: p.kind || 'smart',
        entries: p.entries || [],
        slice: p.slice || [],
        index: this.#slotAfter(afterBlockId),
      })
      .then((result) => this.#decisionOf(result))
      .catch((e) => {
        console.warn('[block-provider] paste did not answer, replaying locally', e)
        return { outcome: OUTCOME_NONE }
      })
  }

  /**
   * Which kinds Go can turn this content into, and with which operations. An
   * empty list is a legitimate answer, so a failure degrades to one rather than
   * rejecting into a caller that has a menu open.
   * @param {string} sourceKind @param {Array<{mimeType: string, content: string}>} entries
   * @returns {Promise<Array<import('../contract/container-provider.js').ExtractionOffer>>}
   */
  detectExtractions(sourceKind, entries) {
    return this._binding
      .detectExtractions({ sourceKind: sourceKind, entries: entries || [] })
      .catch((e) => {
        console.warn('[block-provider] detectExtractions did not answer', e)
        return []
      })
  }

  /**
   * Hands the host a block's lens-owned draft text. Unprefixed because a flush
   * always lands, where a `request*` may be declined. It sends the same update-block
   * op `requestSetBlock` does; what differs is which side owns the value.
   * @param {string} blockId @param {string} text
   */
  flush(blockId, text) {
    const node = this.#model.getBlock(blockId)
    if (!node) return this.#drop('flush', blockId)
    const patch = /** @type {Record<string, any>} */ ({})
    patch[CONTENT_ATTR[node.kind] || 'content'] = text
    this.#settle(this._binding.updateBlock(blockId, node.kind, patch), 'flush')
  }

  /**
   * The container position a child anchored after `afterBlockId` takes.
   *
   *   omitted / undefined  → -1, Go's append. The caller named no anchor.
   *   null                 → 0, the front. The caller named the START of the
   *                          container, which is a real place and a different
   *                          statement from "wherever".
   *   an unknown id        → -1, append.
   * @param {string|null|undefined} afterBlockId @returns {number}
   */
  #slotAfter(afterBlockId) {
    if (afterBlockId === null) return 0
    if (!afterBlockId) return -1
    const at = this.#model.getOrder().indexOf(afterBlockId)
    return at < 0 ? -1 : at + 1
  }

  /**
   * Go's PasteResult as the facade's decision. `html` is the wire's name for the
   * composed fragment and `content` is the facade's; the rest of the union is
   * transport bookkeeping a lens has no use for.
   * @param {Record<string, any>} result
   * @returns {import('../contract/container-provider.js').PasteDecision}
   */
  #decisionOf(result) {
    const r = result || {}
    if (r.outcome === OUTCOME_BLOCK) return { outcome: OUTCOME_BLOCK }
    if (r.outcome === OUTCOME_CONTENT && r.html) return { outcome: OUTCOME_CONTENT, content: r.html }
    return { outcome: OUTCOME_NONE }
  }

  /**
   * A verb naming something this container does not hold is DROPPED with a
   * warning, never thrown: these are void, they are called mid-gesture, and a
   * throw would take the gesture down with it.
   * @param {string} verb @param {string} id
   */
  #drop(verb, id) {
    console.warn('[block-provider] ' + verb + ': unknown block id, dropped', id)
  }

  /**
   * Consumes a verb's wire ack. The facade has no onAck — effects ARE the ack — so
   * the outcome is logged and discarded rather than escaping as an unhandled
   * rejection.
   * @param {Promise<{ok: boolean, error?: string}>} ack @param {string} verb
   */
  #settle(ack, verb) {
    Promise.resolve(ack).then(
      (result) => { if (result && result.ok === false) console.warn('[block-provider] ' + verb + ' declined', result.error) },
      (e) => console.warn('[block-provider] ' + verb + ' failed', e))
  }
}
