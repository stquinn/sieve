// @ts-check
// whole-content-adapter.js — WholeContentAdapter: the host's implementation of
// contract/container-provider.js's WholeContentProvider (issue #96 P4b, ruling 3
// in issue comment 1699).
//
// It sits between the read-only ProviderAdapter and the block-writing one:
//
//     ProviderAdapter        a pinned version viewer, an outline — reads only
//     WholeContentAdapter    + the container as text        ← a PROMPT gets this
//     BlockProviderAdapter   + the block verbs              ← a DOCUMENT gets this
//
// The chain is deliberate. The settled contract types the two extensions as
// siblings of the read-only minimum, and the DOCUMENT's provider is sanctioned
// to implement BOTH — so in code one of them has to be reachable from the
// other, and text-projection is the one every block-bearing container can also
// answer (its serializer already exists; that is what the fenced form IS). The
// converse is not true: a prompt has no block tree, which is why the prompt
// stops here. The cost is that this hierarchy cannot express "block verbs but
// no text projection" — a container Sieve does not have.
//
// A prompt legally never cues: nothing but its own lens ever mutates it, so its
// model stays whatever the load seeded and `onChanged` fires once, at subscribe.
// That is the contract holding, not a gap in it.

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
   * The transport this mount is bound to. `@protected` by convention (JS
   * #private fields do not reach a subclass), so BlockProviderAdapter can add
   * its verbs over the SAME binding instead of holding a second reference to it.
   * A lens never sees this: it holds the provider, and the provider is what the
   * wall hands out.
   * @protected
   * @returns {import('./container-binding.js').ContainerBinding}
   */
  get _binding() { return this.#binding }

  /**
   * The container's whole authoritative text. For a channel-bearing container
   * this is also the hand-over — Go answers with the projection and treats the
   * text as the truth until `setContents` takes it back.
   * @returns {Promise<string>}
   */
  getContents() {
    return this.#binding.getContents().catch((e) => {
      // A projection that did not arrive is not a buffer to mount: the caller
      // (a mode flip) must be able to stay where it is, so this rejects on.
      console.warn('[whole-content] getContents did not answer', e)
      throw e
    })
  }

  /**
   * Hands the whole container back; Go re-parses and the deltas arrive as
   * `onChanged`. Resolves when Go has taken it — the one whole-content member
   * that answers, because the mode flip must not unmount anything until it has.
   * @param {string} text
   * @returns {Promise<void>}
   */
  setContents(text) { return this.#binding.setContents(text || '') }

  /**
   * The in-flight whole-container handoff — keep this, do not re-parse it. Void
   * and unprefixed for the same reason `flush` is: it always lands.
   * @param {string} text
   */
  flushContents(text) { this.#binding.flushContents(text || '') }
}
