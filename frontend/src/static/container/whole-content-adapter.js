// @ts-check
// The host's WholeContentProvider, the middle rung of three:
//
//     ProviderAdapter        reads only          ← a pinned version viewer, an outline
//     WholeContentAdapter    + container as text ← a PROMPT stops here
//     BlockProviderAdapter   + the block verbs   ← a DOCUMENT
//
// A DOCUMENT reaches the block verbs THROUGH this rung, so the hierarchy cannot
// express "block verbs but no text projection" — a container Sieve does not have.
// Verb semantics are contract/container-provider.js's.
//
// A prompt never cues: nothing but its own lens mutates it, so `onChanged` fires
// once, at subscribe.

import { ProviderAdapter } from './provider-adapter.js'
import { ContractViolation } from '../contract/sieve-block.js'

export class WholeContentAdapter extends ProviderAdapter {
  /** @type {import('./container-binding.js').ContainerBinding} */ #binding

  /**
   * @param {import('./container-model.js').ContainerModel} model
   * @param {import('./container-binding.js').ContainerBinding} binding
   */
  constructor(model, binding) {
    super(model)
    if (!binding || typeof binding.getContents !== 'function' || typeof binding.setContents !== 'function') {
      throw new ContractViolation('WholeContentAdapter: construct with a ContainerBinding')
    }
    this.#binding = binding
  }

  /**
   * The transport this mount is bound to, so BlockProviderAdapter adds its verbs
   * over the SAME binding rather than a second reference.
   * @protected
   * @returns {import('./container-binding.js').ContainerBinding}
   */
  get _binding() { return this.#binding }

  /** @returns {Promise<string>} */
  getContents() {
    return this.#binding.getContents().catch((e) => {
      // A projection that did not arrive is not a buffer to mount: reject, so the
      // mode flip stays where it is.
      console.warn('[whole-content] getContents did not answer', e)
      throw e
    })
  }

  /**
   * The one whole-content member that answers: the mode flip must not unmount
   * anything until Go has taken the buffer.
   * @param {string} text @returns {Promise<void>}
   */
  setContents(text) { return this.#binding.setContents(text || '') }

  /** @param {string} text */
  flushContents(text) { this.#binding.flushContents(text || '') }
}
