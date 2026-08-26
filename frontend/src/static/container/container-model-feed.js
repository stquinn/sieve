// @ts-check
// ContainerModelFeed: the host's per-uuid registry of live ContainerModels, kept in
// step with the wire. ContainerModel is a pure fold and knows nothing about where a
// frame came from; this class owns one model per open container, subscribes it to
// that container's traffic, and discards it when the container closes. Model
// lifetime IS channel lifetime — a model that outlived its socket would answer reads
// about a document nothing is following any more.
//
// TWO inbound seams, because Go answers in two shapes:
//
//   - whole-container ANSWERS (load-content, wysiwyg-content) reset the model. They
//     are correlated replies, so the transport settles them on their awaiter and
//     they never reach a frame observer — DocumentService.onContent publishes them.
//   - mutation ECHOES (insert / replace / attrs / remove / order) fold onto it, via
//     ContainerTransport.observeFrames, which sees every routed frame.

import { ContractViolation } from '../contract/sieve-block.js'
import { ContainerModel } from './container-model.js'

export class ContainerModelFeed {
  /** @type {import('./document-service.js').DocumentService} */ #documentService
  /** @type {Map<string, {model: ContainerModel, release: Array<() => void>}>} */ #open = new Map()

  /** @param {import('./document-service.js').DocumentService} documentService */
  constructor(documentService) {
    if (!documentService || typeof documentService.onContent !== 'function') {
      throw new ContractViolation('ContainerModelFeed: construct over the DocumentService')
    }
    this.#documentService = documentService
  }

  /**
   * Starts following a container and returns its model. Idempotent per uuid: a
   * second open answers the model already following, because two models for one
   * container is two answers to the same read.
   * @param {string} uuid
   * @param {string} [kind] the container's kind as a DATA word ('note' today)
   * @returns {ContainerModel}
   */
  open(uuid, kind) {
    if (!uuid) throw new ContractViolation('ContainerModelFeed.open: uuid is required')
    const already = this.#open.get(uuid)
    if (already) return already.model

    const model = new ContainerModel(uuid, kind)
    const release = [
      this.#documentService.onContent(uuid, (content) => model.applyLoad(this.#asContent(content))),
      this.#documentService.blockService.observeFrames(uuid, (frame) => model.applyFrame(frame)),
    ]
    this.#open.set(uuid, { model: model, release: release })
    return model
  }

  /** The model following this container, or null.
   *  @param {string} uuid @returns {ContainerModel|null} */
  get(uuid) {
    const entry = uuid ? this.#open.get(uuid) : undefined
    return entry ? entry.model : null
  }

  /** Stops following a container and discards its model. Idempotent.
   *  @param {string} uuid */
  close(uuid) {
    const entry = uuid ? this.#open.get(uuid) : undefined
    if (!entry) return
    for (const release of entry.release) release()
    this.#open.delete(uuid)
  }

  /** Stops following everything (workspace teardown). */
  closeAll() {
    for (const uuid of [...this.#open.keys()]) this.close(uuid)
  }

  /**
   * The load answer as the model's ContainerContent. Go answers load-content and
   * wysiwyg-content from one assembly, so both already carry `blocks`; only the uuid
   * field differs, and a shape carrying neither seeds by position alone.
   * @param {Record<string, any>} content
   * @returns {import('./container-model.js').ContainerContent}
   */
  #asContent(content) {
    const c = content || {}
    return { uuid: c.uuid, blocks: c.blocks || [] }
  }
}
