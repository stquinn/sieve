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
// Possession of a provider is authorization for exactly ONE container: the uuid
// every verb names is the model's, and nothing above this class holds one.
//
// A prompt never cues: nothing but its own lens mutates it, so `onChanged` fires
// once, at subscribe.

import { ProviderAdapter } from './provider-adapter.js'
import { ContractViolation } from '../contract/sieve-block.js'

export class WholeContentAdapter extends ProviderAdapter {
  /** @type {import('./document-service.js').DocumentService} */ #documents

  /**
   * @param {import('./container-model.js').ContainerModel} model
   * @param {import('./document-service.js').DocumentService} documentService
   */
  constructor(model, documentService) {
    super(model)
    if (!documentService || typeof documentService.getContents !== 'function' || typeof documentService.setContents !== 'function') {
      throw new ContractViolation('WholeContentAdapter: construct over the DocumentService')
    }
    this.#documents = documentService
  }

  /**
   * The vocabulary this mount speaks, so BlockProviderAdapter adds its verbs over
   * the SAME service rather than a second reference.
   * @protected
   * @returns {import('./document-service.js').DocumentService}
   */
  get _documents() { return this.#documents }

  /** @returns {Promise<string>} */
  getContents() {
    return this.#documents.getContents(this.getUuid()).catch((e) => {
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
  setContents(text) { return this.#documents.setContents(this.getUuid(), text || '') }

  /** @param {string} text */
  flushContents(text) { this.#documents.flushContents(this.getUuid(), text || '') }
}
