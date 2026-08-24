// @ts-check
// provider-adapter.js — ProviderAdapter: the host's implementation of the base
// ContainerProvider (contract/container-provider.js) over a ContainerModel.
//
// The class exists for one property: the model is a #private field, so a lens
// holding a provider has no expression that reaches past the read surface —
// no `provider.model`, no prototype walk, no accidental fold from the wrong
// side of the wall. The import-graph tripwire keeps the model out of a lens's
// module graph; this keeps it out of its object graph.
//
// This is the READ half only. Verbs and queries (BlockContainerProvider) need
// the transport binding and land with it; a read-only mount — a `@v{n}`-pinned
// version viewer, an OutlineLens — is complete with exactly this, which is why
// read-only is a TYPE rather than a flag on a richer provider.
//
// The reads stay sync across a future IPC bridge without changing shape: the
// bridge's lens side holds its own ContainerModel replica and this same adapter
// wraps it (followers chain — only Go leads). Serialization discipline lives at
// the subscribe stream; plain frozen copies at the reads.

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

  /** The container's kind as a DATA word — affordances read it, nothing subclasses on it.
   *  @returns {string} */
  getKind() { return this.#model.getKind() }

  /** @returns {ReadonlyArray<string>} */
  getOrder() { return this.#model.getOrder() }

  /** @param {string} id @returns {Readonly<import('./container-model.js').BlockNode>|null} */
  getBlock(id) { return this.#model.getBlock(id) }

  /** Registers the listener and cues it with the whole container immediately —
   *  bootstrap IS the first onChanged, so a lens has one read-and-paint path.
   *  @param {import('./container-model.js').ContainerUpdateListener} listener */
  subscribe(listener) { this.#model.subscribe(listener) }

  /** @param {import('./container-model.js').ContainerUpdateListener} listener */
  unsubscribe(listener) { this.#model.unsubscribe(listener) }
}
