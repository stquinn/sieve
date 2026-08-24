// @ts-check
// block-provider-adapter.js — BlockProviderAdapter: the host's implementation of
// the WRITE half of the wall, contract/container-provider.js's
// BlockContainerProvider (issue #96 P4a; the P4b vocabulary of comment 1699).
//
// It EXTENDS rather than adding verbs to the read-only adapter, because the
// contract makes read-only a TYPE and not a flag: a `@v{n}`-pinned version
// viewer is handed a bare ProviderAdapter, and a pinned coordinate that could be
// handed a verb — even one it never calls — is a provider whose type stopped
// saying what it means. Its immediate base is WholeContentAdapter, so a
// DOCUMENT's provider carries both extensions (the settled contract sanctions
// exactly that, and the mode flip depends on it); see that file for why the two
// sibling extensions are a chain in code.
//
// Three properties hold across every verb here:
//
//   NO LOCAL WRITE. Not one method touches the model. Go leads, the model
//   follows, and the effect of a verb reaches the lens as the echo Go sent —
//   which is also how another lens's edit, an AI job and the watcher arrive, so
//   there is one repaint story rather than one per origin.
//
//   NO CORRELATION OUT. The verbs are void. A lens asked for a change and is
//   later told that A change happened; it re-reads and paints. It never learns
//   which change was its own, because acting on that would make the repaint
//   depend on the origin — the one distinction this facade refuses to draw.
//
//   POSITION FROM ORDER. Anchoring is by block id at the facade; the host turns
//   an id into a position by reading its own follower model. A lens never
//   computes a document position, and neither does ProseMirror on its behalf.

import { ContractViolation } from '../contract/sieve-block.js'
import { WholeContentAdapter } from './whole-content-adapter.js'

// Go's PasteResult outcomes, as the wire spells them. The facade's union is the
// same three words (contract/container-provider.js PasteDecision) minus the
// transport's identifying fields.
const OUTCOME_BLOCK = 'block'
const OUTCOME_CONTENT = 'content'
const OUTCOME_NONE = 'none'

// Where a kind keeps its text. The default content attr is `content`; the three
// source-bearing kinds override it — the same split ContainerTransport.setContent
// documents, resolved here because the facade's `flush` names neither.
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
    // The base holds its own #private copy for the reads; this one is for the
    // position arithmetic the verbs do. Both are private, so a lens reaches
    // neither. The transport is the base's `_binding` — one mount, one handle.
    this.#model = model
  }

  // ── Verbs (void — Go may decline, and the effect arrives via onChanged) ────

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
   * Asks for a block to leave the container. It is a verb of its own — not a
   * consequence of restating what the container should hold — so a lens that can
   * delete need not be able to describe the whole container to say so.
   *
   * Void like its siblings: the block leaves this lens's view when Go's
   * `remove-block` echo reaches the fold, which is also exactly when it leaves
   * every other lens watching the same container.
   * @param {string} blockId
   */
  requestRemoveBlock(blockId) {
    if (!this.#model.getBlock(blockId)) return this.#drop('requestRemoveBlock', blockId)
    this.#settle(this._binding.deleteBlock(blockId), 'requestRemoveBlock')
  }

  /**
   * States the container's COMPLETE child order. Complete rather than a move,
   * because installing a whole order is idempotent — a duplicate or late request
   * lands the container in the same place — and because it is the shape
   * `order-changed` echoes back, so one statement travels both directions.
   *
   * An order that is not a permutation of what this container holds is DROPPED
   * here rather than sent: Go refuses it anyway (a list missing an id is
   * indistinguishable from a mass delete), and refusing it at the facade keeps
   * the failure where the mistake is.
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
   * targetKind and applies the operation. Whether that REPLACES the source (a
   * transform) or adds beside it (an extract) is Go's decision from `operation` —
   * the index below is only consulted for the additive case.
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
   * Re-runs whatever async work the block declares. Kind-blind: what retry means
   * for a flavour is the processor's business, and the lens that renders the
   * "try again" affordance knows only which block it is on.
   *
   * Void like every other verb, and for the same reason — the outcome is the
   * block's own status attrs changing, which arrives as `onChanged`.
   * @param {string} blockId
   */
  requestRetry(blockId) {
    if (!this.#model.getBlock(blockId)) return this.#drop('requestRetry', blockId)
    this._binding.retry(blockId)
  }

  /**
   * Asks the container to reach disk NOW rather than on its own debounce. It is
   * not `flush`: flush hands over one block's in-flight text, this commits
   * whatever the container already holds, and a caller routinely wants one
   * without the other.
   *
   * Void, and unanswered by design: a save announces itself to the whole
   * workspace as `container-saved`, so there is nothing here to correlate.
   */
  requestPersist() { this._binding.persist() }

  // ── Queries (decisions and offers, never document content) ────────────────

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
   * which is not a swallowed failure but the correct instruction: the caller's
   * local replay is still the right move, and there is nothing the user typed
   * that goes missing.
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
   * empty list is a legitimate answer — a menu built from it simply offers
   * nothing — so a failure degrades to one rather than rejecting into a caller
   * that has a menu open.
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

  // ── In-flight text handoff ────────────────────────────────────────────────

  /**
   * Hands the host a block's lens-owned draft text. Unprefixed on purpose: a
   * flush always lands, where a `request*` may be declined. It is the same
   * update-block op `requestSetBlock` sends — the difference is which side owns
   * the value, not what the wire carries.
   * @param {string} blockId @param {string} text
   */
  flush(blockId, text) {
    const node = this.#model.getBlock(blockId)
    if (!node) return this.#drop('flush', blockId)
    const patch = /** @type {Record<string, any>} */ ({})
    patch[CONTENT_ATTR[node.kind] || 'content'] = text
    this.#settle(this._binding.updateBlock(blockId, node.kind, patch), 'flush')
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /**
   * The container position a child anchored after `afterBlockId` takes.
   *
   *   omitted / undefined  → -1, Go's append. The caller named no anchor.
   *   null                 → 0, the front. The caller named the START of the
   *                          container, which is a real place and a different
   *                          statement from "wherever".
   *   an unknown id        → -1, append. Inventing a position for a name nobody
   *                          has is how a block lands where the user did not point.
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
   * composed fragment; `content` is the facade's, and the rest of the union
   * (kind/id/rawYaml/error) is transport bookkeeping a lens has no use for.
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
   * Consumes a verb's wire ack. The facade has no onAck — effects ARE the ack —
   * so the outcome is logged and discarded here rather than surfaced, and the
   * promise never escapes to become an unhandled rejection.
   * @param {Promise<{ok: boolean, error?: string}>} ack @param {string} verb
   */
  #settle(ack, verb) {
    Promise.resolve(ack).then(
      (result) => { if (result && result.ok === false) console.warn('[block-provider] ' + verb + ' declined', result.error) },
      (e) => console.warn('[block-provider] ' + verb + ' failed', e))
  }
}
