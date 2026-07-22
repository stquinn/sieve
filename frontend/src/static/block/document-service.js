// @ts-check
// document-service.js — DocumentService: the sieve protocol's anti-corruption
// layer, uuid-addressed half (Block Renderer Contract,
// docs/design/archive/specs/2026-07-21-block-renderer-contract.md §service pair).
//
// ONE instance, constructed beside BlockService in the Workspace composition
// root (constructor injection — composed over the wire owner) and handed down.
// Editors and the Workspace see THIS; renderers never do (they are
// blockId-scoped and see only BlockService). The JS twin of Go's EditorService
// (live-document session concerns), NOT Go's DocumentService (persistence).
//
// V1 (this reconcile): `load` owns its HTTP call and types the reply's block
// list into SieveBlock envelopes (the service authors the envelope — a
// repository returns domain objects); membership verbs delegate to the
// per-document HANDLE the Workspace registers (the live editor). The full
// machinery migration out of AbstractEditor — WS ownership, extract, flush,
// the format-blind raw-content family (getRawContent/setRawContent/save),
// export — is follow-up issue (A). Callers migrate then; the boundary is here.

import { SieveBlock, ContractViolation } from './sieve-block.js'

/**
 * @typedef {object} DocumentHandle  the per-document delegate (v1: the live editor)
 * @property {(kind: string, attrs: Record<string, any>, afterBlockId?: string) => void} createBlock
 * @property {(blockId: string) => void} deleteBlock
 */

export class DocumentService {
  /** @type {import('./block-service.js').BlockService} */ #blockService
  /** @type {Map<string, DocumentHandle>} */ #handles = new Map()

  /** @param {import('./block-service.js').BlockService} blockService */
  constructor(blockService) {
    if (!blockService) throw new ContractViolation('DocumentService: constructed over the BlockService (composition root wiring)')
    this.#blockService = blockService
  }

  /** The existing-block half of the boundary (blockId-addressed verbs). */
  get blockService() { return this.#blockService }

  /**
   * Register the live handle for a document. Returns the unsubscribe function.
   * @param {string} uuid @param {DocumentHandle} handle
   * @returns {() => void}
   */
  registerDocument(uuid, handle) {
    this.#handles.set(uuid, handle)
    return () => { if (this.#handles.get(uuid) === handle) this.#handles.delete(uuid) }
  }

  /**
   * Load a document: Go's codec did the splitting server-side (JS never parses
   * a document); this verb types the wire block list into envelopes.
   * @param {string} uuid
   * @returns {Promise<{ body: string, blocks: SieveBlock[], raw: any }>}
   *   body: the raw serialized form (markdown-mode consumers);
   *   blocks: typed envelopes (block lenses); raw: the untyped wire reply —
   *   V1 BRIDGE ONLY for the surface render pipeline, retired with issue (A).
   */
  load(uuid) {
    return fetch('/api/editor/load?uuid=' + encodeURIComponent(uuid))
      .then((r) => r.json())
      .then((data) => ({
        body: data.body || '',
        blocks: (data.blocks || []).map(
          /** @param {any} b */ (b) => new SieveBlock(b.kind || 'prose', b)),
        raw: data,
      }))
  }

  /**
   * MEMBERSHIP: add a block to the document (never targets an existing block —
   * that is BlockService's half). V1 delegates to the registered handle.
   * @param {string} uuid @param {string} kind @param {Record<string, any>} attrs @param {string} [afterBlockId]
   */
  createBlock(uuid, kind, attrs, afterBlockId) {
    const h = this.#handles.get(uuid)
    if (h) h.createBlock(kind, attrs, afterBlockId)
  }

  /**
   * MEMBERSHIP: remove a block from the document. V1 delegates to the handle.
   * @param {string} uuid @param {string} blockId
   */
  deleteBlock(uuid, blockId) {
    const h = this.#handles.get(uuid)
    if (h) h.deleteBlock(blockId)
  }
}
