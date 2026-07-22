// @ts-check
// block-service.js — BlockService: the sieve protocol's anti-corruption layer,
// existing-block half (Block Renderer Contract,
// docs/design/specs/2026-07-21-block-renderer-contract.md §service pair).
//
// ONE instance, constructed in the Workspace composition root and handed down
// (idiomatic-js §5 — never window.*). Renderers see THIS and only this: a
// renderer knows its block id, never a uuid (the document routes server-side).
//
// V1 TRANSPORT (this reconcile): verbs route to APPLIERS the active surfaces
// register — today's PM-transaction behaviour behind tomorrow's boundary. The
// full wire migration (WS/HTTP ownership out of AbstractEditor, extraction
// discovery, ack correlation) is follow-up issue (A); backend-written ops with
// acks are issue (B). Nothing in a renderer changes when those land — that is
// the point of the boundary.

import { ContractViolation } from './sieve-block.js'

/**
 * @typedef {object} BlockApplier  the per-surface effect implementor (v1)
 * @property {(blockId: string) => boolean} owns          does this surface host the block?
 * @property {(blockId: string, patch: Record<string, any>) => void} updateAttributes
 * @property {(blockId: string, text: string) => void} setContent
 * @property {(blockId: string) => void} retry
 */

export class BlockService {
  /** @type {Set<BlockApplier>} */ #appliers = new Set()

  /**
   * Register a surface's applier. Returns the unsubscribe function (the
   * standard lifecycle idiom); surfaces deregister on unmount.
   * @param {BlockApplier} applier
   * @returns {() => void}
   */
  registerApplier(applier) {
    if (!applier || typeof applier.owns !== 'function') {
      throw new ContractViolation('BlockService.registerApplier: applier must implement owns(blockId)')
    }
    this.#appliers.add(applier)
    return () => { this.#appliers.delete(applier) }
  }

  /**
   * @param {string} blockId
   * @returns {BlockApplier|null}
   */
  #applierFor(blockId) {
    for (const a of this.#appliers) {
      if (a.owns(blockId)) return a
    }
    return null
  }

  /**
   * Push an attribute patch (a change DELTA in wire vocabulary) to the block's
   * document truth. OPAQUE to this class — the keys are never interpreted here,
   * only routed: the sole author is the owning renderer's private `_pushAttrs`
   * (the one class that knows its schema), and the sole interpreter is that
   * kind's applier. No consumer ever speaks these keys (contract
   * §semantic-API doctrine / §boundary datatype rule).
   * @param {string} blockId @param {Record<string, any>} patch
   */
  updateAttributes(blockId, patch) {
    const a = this.#applierFor(blockId)
    if (a) a.updateAttributes(blockId, patch)
  }

  /**
   * Push the block's raw content outward (the outbound truth channel — the
   * editor lens's sync closure ends here, never at a socket).
   * @param {string} blockId @param {string} text
   */
  setContent(blockId, text) {
    const a = this.#applierFor(blockId)
    if (a) a.setContent(blockId, text)
  }

  /**
   * Re-run the block's backend job (kind-blind: Go knows what retry means).
   * @param {string} blockId
   */
  retry(blockId) {
    const a = this.#applierFor(blockId)
    if (a) a.retry(blockId)
  }
}
