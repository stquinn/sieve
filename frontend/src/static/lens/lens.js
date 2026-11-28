// @ts-check
// A lens is constructed against ONE ContainerProvider and knows nothing else: no
// workspace, no transport, no backend. The provider is pre-bound to a single
// container, so a lens cannot re-target itself — remounting is a host gesture.
//
// Read-and-paint, not apply-a-delta: a cue says WHAT changed, never what the new
// value is. The lens reads the answer back through the provider.

import { ContractViolation } from '../contract/sieve-block.js'

export class Lens {
  /** @type {import('../contract/container-provider.js').ContainerProvider} */ #provider
  /** @type {HTMLElement|null} */ #host = null
  /** @type {import('../contract/selection-listener.js').SelectionListener|null} */ #selectionListener = null

  /** @param {import('../contract/container-provider.js').ContainerProvider} provider */
  constructor(provider) {
    if (new.target === Lens) {
      throw new ContractViolation('Lens is abstract — extend it, never instantiate it directly')
    }
    if (!provider || typeof provider.getOrder !== 'function' || typeof provider.subscribe !== 'function') {
      throw new ContractViolation(`${new.target.name}: construct with a ContainerProvider`)
    }
    if (this.paint === Lens.prototype.paint) {
      throw new ContractViolation(`${new.target.name} must implement paint(change)`)
    }
    this.#provider = provider
  }

  /** @returns {import('../contract/container-provider.js').ContainerProvider} */
  get provider() { return this.#provider }

  /** @returns {HTMLElement|null} */
  get host() { return this.#host }

  /** @returns {boolean} */
  get isMounted() { return this.#host !== null }

  /** The container this lens presents, asked of the provider. A lens holding its
   *  own identity — an editor, whose uuid outlives any one mount — overrides this.
   *  @returns {string} */
  get uuid() { return this.#provider.getUuid() }

  /**
   * Mounts into a host element and starts following the container. `subscribe`
   * cues with the whole container, so the bootstrap paint is the first
   * `onChanged`. That cue may arrive before this method returns — nothing may
   * run after it.
   * @param {HTMLElement} hostElement
   */
  mount(hostElement) {
    if (!hostElement || typeof hostElement.appendChild !== 'function') {
      throw new ContractViolation(`${this.constructor.name}.mount: an element is required`)
    }
    if (this.#host) {
      throw new ContractViolation(`${this.constructor.name} is already mounted — unmount first`)
    }
    this.#host = hostElement
    this.#provider.subscribe(this)
  }

  /** Stops following and empties the host element. Idempotent. */
  unmount() {
    if (!this.#host) return
    this.#provider.unsubscribe(this)
    this.#host.replaceChildren()
    this.#host = null
  }

  /**
   * The one inbound channel, origin-blind: this lens's own echo, another lens's
   * edit, an AI job and the file watcher all arrive here and look identical.
   * Delivered post-fold, so reads inside `paint` see consistent state.
   * @param {Readonly<import('../contract/container-update-listener.js').ContainerChange>} change
   */
  onChanged(change) {
    if (!this.#host) return // a cue racing an unmount has nowhere to paint
    this.paint(change)
  }

  /**
   * Brings the leaf of this container named `leaf` into view: the host's verb
   * for opening an address at its leaf. `leaf` is opaque to the host — whatever
   * the container named as the leaf to reveal — and may be asked before or after
   * the lens is presented. A lens that has no such leaf, or cannot bring one into
   * view, does nothing; this base does nothing.
   *
   * `seek`, when given, is the text the opener is looking for at the leaf, as
   * the opener handed it and uninterpreted by the host. A lens may use it to
   * choose what at the leaf to bring into view, and may ignore it.
   * @param {string} leaf
   * @param {string} [seek]
   */
  reveal(leaf, seek) {}

  /**
   * Registers the host's presence sink, or clears it with null.
   * @param {import('../contract/selection-listener.js').SelectionListener|null} listener
   */
  setSelectionListener(listener) {
    if (listener && typeof listener.onSelectionChanged !== 'function') {
      throw new ContractViolation(`${this.constructor.name}.setSelectionListener: listener must implement onSelectionChanged`)
    }
    this.#selectionListener = listener || null
  }

  /**
   * Advertises what this lens knows about its own selection/presence state. A
   * best-attempt broadcast: the base stamps `docUuid`, the subclass supplies
   * whatever else it has, and a missing field is a diminished advert, not an error.
   * @param {Partial<import('../contract/selection-listener.js').SelectionContext>} advert
   */
  advertiseSelection(advert) {
    if (!this.#selectionListener) return
    const context = Object.freeze(Object.assign({}, advert, { docUuid: this.uuid }))
    this.#selectionListener.onSelectionChanged(
      /** @type {Readonly<import('../contract/selection-listener.js').SelectionContext>} */ (/** @type {any} */ (context)))
  }

  /**
   * Repaints from the container's current state. Subclasses MUST implement it;
   * the constructor refuses one that does not.
   * @param {Readonly<import('../contract/container-update-listener.js').ContainerChange>} change
   */
  paint(change) {
    throw new ContractViolation(`${this.constructor.name} must implement paint(change)`)
  }
}
