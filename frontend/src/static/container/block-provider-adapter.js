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
//   POSITION FROM ORDER — anchoring is by block id, all the way to Go, which
//     resolves it against the authoritative tree. Neither a lens nor the host
//     computes a document position: the follower model trails Go by at least a
//     round trip, so an anchor it has not seen yet is one Go can still honour.

import { ContractViolation } from '../contract/sieve-block.js'
import { WholeContentAdapter } from './whole-content-adapter.js'

// Go's PasteResult outcomes, as the wire spells them.
const OUTCOME_BLOCK = 'block'
const OUTCOME_CONTENT = 'content'
const OUTCOME_NONE = 'none'

// Go's text-replace outcome for a write that could not be run. Applied and
// stale are both silent here — the first shows up as the block changing, the
// second as the marks that follow no longer naming the run.
const REPLACE_FAILED = 'error'

// Where a kind keeps its text: `content` by default, overridden by the three
// source-bearing kinds. The facade's `flush` names neither attr, so it resolves
// against this — in every provider that implements one.
/** @type {Readonly<Record<string, string>>} */
export const CONTENT_ATTR = Object.freeze({ code: 'source', diagram: 'source', log: 'source' })

export class BlockProviderAdapter extends WholeContentAdapter {
  /** @type {import('./container-model.js').ContainerModel} */ #model

  /**
   * @param {import('./container-model.js').ContainerModel} model
   * @param {import('./document-service.js').DocumentService} documentService
   */
  constructor(model, documentService) {
    super(model, documentService)
    if (typeof documentService.createBlock !== 'function' || typeof documentService.setBlockOrder !== 'function') {
      throw new ContractViolation('BlockProviderAdapter: construct over the DocumentService')
    }
    // The base keeps its own #private copy for the reads; this one is what the
    // verbs check a named block against before speaking.
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
    this.#settle(this._documents.createBlock(this.getUuid(), kind, attrs || {}, this.#anchorOf(afterBlockId)), 'requestAddBlock')
  }

  /**
   * @param {string} blockId @param {Record<string, any>} patch a DELTA, not the whole bag
   */
  requestSetBlock(blockId, patch) {
    const node = this.#model.getBlock(blockId)
    if (!node) return this.#drop('requestSetBlock', blockId)
    this.#settle(this._documents.updateBlock(this.getUuid(), blockId, node.kind, patch || {}), 'requestSetBlock')
  }

  /**
   * Asks for a block to leave the container. Void like its siblings: the block
   * leaves this lens's view when Go's `remove-block` echo reaches the fold, which
   * is when it leaves every other lens watching the same container.
   * @param {string} blockId
   */
  requestRemoveBlock(blockId) {
    if (!this.#model.getBlock(blockId)) return this.#drop('requestRemoveBlock', blockId)
    this.#settle(this._documents.deleteBlock(this.getUuid(), blockId), 'requestRemoveBlock')
  }

  /**
   * States the relative order of the named children. The list may be a SUBSEQUENCE
   * of what the container holds — a surface can only name what it paints, and a
   * container also holds children no surface draws — so it is merged into the
   * follower's full order and the COMPLETE permutation is what goes to Go. Go
   * refuses anything that is not a permutation of the authority, and a refused
   * statement is simply re-derived on the next quiet tick.
   *
   * THIS VERB CONSULTS THE MODEL, and it is the one that should. Its siblings
   * anchor by id precisely so that Go, not the follower, decides a position; an
   * order statement is not a position but a claim about relative order, and the
   * follower's own order is the only thing the unnamed children's places can come
   * from.
   * @param {ReadonlyArray<string>} order
   */
  requestSetOrder(order) {
    const statement = this.#model.mergeOrder(order)
    if (!statement.held) {
      return this.#drop('requestSetOrder: names a block the container does not hold', Array.from(order || []).join(','))
    }
    if (!statement.order) return  // nothing to say — an empty statement, or already so
    this.#settle(this._documents.setBlockOrder(this.getUuid(), statement.order), 'requestSetOrder')
  }

  /**
   * Plays back an offer `detectExtractions` produced: Go recognises the entries as
   * targetKind and applies the operation. Whether that REPLACES the source or adds
   * beside it is Go's decision from `operation`, and so is where an additive result
   * lands — after the source block it names.
   * @param {string} blockId @param {string} targetKind @param {string} operation
   * @param {Array<{mimeType: string, content: string}>} entries
   */
  requestTransform(blockId, targetKind, operation, entries) {
    if (!this.#model.getBlock(blockId)) return this.#drop('requestTransform', blockId)
    this.#settle(this._documents.extract(this.getUuid(), blockId, targetKind, operation, entries || []), 'requestTransform')
  }

  /**
   * Re-runs whatever async work the block declares. Kind-blind: what retry means for
   * a flavour is the processor's business. Void — the outcome is the block's status
   * attrs changing, which arrives as `onChanged`.
   * @param {string} blockId
   */
  requestRetry(blockId) {
    if (!this.#model.getBlock(blockId)) return this.#drop('requestRetry', blockId)
    this._documents.retry(this.getUuid(), blockId)
  }

  /**
   * Writes what belongs in a marked run's place. The anchor is the mark exactly
   * as the host handed it over, its grain included — Go resolves it at that
   * grain in the block's current text — so a run the user has since typed over
   * is left alone rather than overwritten at stale offsets.
   *
   * Void like its siblings, and SILENT on a run that no longer resolves: the
   * correction either arrives as the block's own change or does not, and the
   * marks that follow are what say which.
   * @param {string} blockId
   * @param {Readonly<import('../contract/container-update-listener.js').SieveTextMark>} anchor
   * @param {string} replacement
   */
  requestReplaceText(blockId, anchor, replacement) {
    if (!this.#model.getBlock(blockId)) return this.#drop('requestReplaceText', blockId)
    Promise.resolve(this._documents.replaceText(this.getUuid(), Object.assign({}, anchor, { blockId: blockId }), replacement)).then(
      (outcome) => { if (outcome === REPLACE_FAILED) console.warn('[block-provider] requestReplaceText failed', blockId, anchor && anchor.quote) },
      (e) => console.warn('[block-provider] requestReplaceText failed', e))
  }

  /**
   * Asks the container to reach disk NOW rather than on its own debounce. It is not
   * `flush`: flush hands over one block's in-flight text, this commits whatever the
   * container already holds. Void and unanswered — a save announces itself to the
   * whole workspace as `container-saved`.
   */
  requestPersist() { this._documents.persist(this.getUuid()) }

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
    return this._documents
      .paste(this.getUuid(), {
        kind: p.kind || 'smart',
        entries: p.entries || [],
        slice: p.slice || [],
        anchor: this.#anchorOf(afterBlockId),
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
    return this._documents
      .detectExtractions(this.getUuid(), sourceKind, entries || [])
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
    this.#settle(this._documents.updateBlock(this.getUuid(), blockId, node.kind, patch), 'flush')
  }

  /**
   * The facade's anchor argument in the shape the wire states it. It is a
   * translation and NOT a lookup — an id this client has not seen yet still
   * travels, because Go is the one that resolves it.
   *
   *   omitted / undefined / ''  → the empty anchor, Go's append. No anchor named.
   *   null                      → the front. The caller named the START of the
   *                               container, which is a real place and a different
   *                               statement from "wherever".
   *   an id                     → after that block; Go appends if it is gone.
   * @param {string|null|undefined} afterBlockId
   * @returns {import('./document-service.js').BlockAnchor}
   */
  #anchorOf(afterBlockId) {
    if (afterBlockId === null) return { atFront: true }
    if (!afterBlockId) return {}
    return { afterBlockId: afterBlockId }
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
