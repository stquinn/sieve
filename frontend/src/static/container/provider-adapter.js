// The host's ContainerProvider over a ContainerModel: the READ half only, which is
// all a read-only mount needs. Semantics are contract/container-provider.js's.

import { ContractViolation } from '../contract/sieve-block.js'

export class ProviderAdapter {
  /** @type {import('./container-model.js').ContainerModel} */ #model

  /** @param {import('./container-model.js').ContainerModel} model */
  constructor(model) {
    if (!model || typeof model.getUuid !== 'function' || typeof model.subscribe !== 'function') {
      throw new ContractViolation('ProviderAdapter: construct with a ContainerModel')
    }
    this.#model = model
  }

  /** @returns {string} */
  getUuid() { return this.#model.getUuid() }

  /** @returns {string} */
  getKind() { return this.#model.getKind() }

  /** @returns {ReadonlyArray<string>} */
  getOrder() { return this.#model.getOrder() }

  /** @param {string} id @returns {Readonly<import('./container-model.js').BlockNode>|null} */
  getBlock(id) { return this.#model.getBlock(id) }

  /** @param {import('./container-model.js').ContainerUpdateListener} listener */
  subscribe(listener) { this.#model.subscribe(listener) }

  /** @param {import('./container-model.js').ContainerUpdateListener} listener */
  unsubscribe(listener) { this.#model.unsubscribe(listener) }
}
