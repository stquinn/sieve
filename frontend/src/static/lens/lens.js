// @ts-check
// lens.js — Lens: the base every lens extends (issue #96, the settled Lens↔Host
// contract).
//
// A lens is constructed against ONE ContainerProvider and knows nothing else:
// no workspace, no transport, no backend, not even that a backend exists. The
// provider is pre-bound to a single container, so possession is authorization
// and a lens cannot re-target itself — remounting is a host gesture.
//
// The base is deliberately THIN: lifecycle, read-and-paint, presence. Every
// lens extends it — the outline, and (through AbstractEditor) both editors —
// so there is one lifecycle story, not one per family.
//
// Read-and-paint, not apply-a-delta: a cue says WHAT changed, never what the
// new value is. The lens reads the answer back through the provider, so there
// is no second copy of container state on the lens side to drift.

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

  // ── Accessors ──────────────────────────────────────────────────────────────

  /** The container, read-only — how a subclass reads state. It is the same
   *  object the host handed in: a lens never gets a richer one by asking.
   *  @returns {import('../contract/container-provider.js').ContainerProvider} */
  get provider() { return this.#provider }

  /** The mounted element, or null.
   *  @returns {HTMLElement|null} */
  get host() { return this.#host }

  /** @returns {boolean} */
  get isMounted() { return this.#host !== null }

  /** The container this lens presents. Asked of the PROVIDER, because that is
   *  what a lens is bound to; a lens holding its own identity (an editor, whose
   *  uuid outlives any one mount) overrides this.
   *  @returns {string} */
  get uuid() { return this.#provider.getUuid() }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Mounts into a host element and starts following the container.
   *
   * `subscribe` cues the listener with the whole container, so the bootstrap
   * paint is just the first `onChanged` — there is no separate initial-render
   * path to keep in step with the update one. The cue may arrive before this
   * method returns, which is why nothing here runs after it.
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

  /** Stops following and empties the host element — a lens owns the element it
   *  is handed, for exactly as long as it is mounted. Idempotent. */
  unmount() {
    if (!this.#host) return
    this.#provider.unsubscribe(this)
    this.#host.replaceChildren()
    this.#host = null
  }

  // ── ContainerUpdateListener ────────────────────────────────────────────────

  /**
   * The one inbound channel — origin-blind by construction: this lens's own
   * echo, another lens's edit, an AI job and the file watcher all arrive here
   * and look identical. Delivered post-fold, so reads inside `paint` see
   * consistent state.
   * @param {Readonly<import('../contract/container-update-listener.js').ContainerChange>} change
   */
  onChanged(change) {
    if (!this.#host) return // a cue racing an unmount has nowhere to paint
    this.paint(change)
  }

  // ── Presence ───────────────────────────────────────────────────────────────

  /**
   * Registers the host's presence sink, or clears it with null. Registered ON
   * the lens because the host is the consumer: it never introspects a lens's
   * DOM, so every host affordance acting on "what's selected" reads the
   * advertisement alone.
   * @param {import('../contract/selection-listener.js').SelectionListener|null} listener
   */
  setSelectionListener(listener) {
    if (listener && typeof listener.onSelectionChanged !== 'function') {
      throw new ContractViolation(`${this.constructor.name}.setSelectionListener: listener must implement onSelectionChanged`)
    }
    this.#selectionListener = listener || null
  }

  /**
   * Advertises what this lens knows about its own selection/presence state.
   *
   * The advert is a BROADCAST, best-attempt, anchored on identity: the base
   * stamps `docUuid` so a host aggregating several mounted lenses can attribute
   * every advert without side-channel knowledge, and the subclass supplies
   * whatever else it has. Identity plus any single value is already a valid
   * advert — absence of a field is a diminished advert, not an error — so the
   * partial shape is cast rather than padded with nulls the lens cannot mean.
   * @param {Partial<import('../contract/selection-listener.js').SelectionContext>} advert
   */
  advertiseSelection(advert) {
    if (!this.#selectionListener) return
    const context = Object.freeze(Object.assign({}, advert, { docUuid: this.uuid }))
    this.#selectionListener.onSelectionChanged(
      /** @type {Readonly<import('../contract/selection-listener.js').SelectionContext>} */ (/** @type {any} */ (context)))
  }

  // ── Abstract ───────────────────────────────────────────────────────────────

  /**
   * Repaints from the container's current state. Subclasses MUST implement it;
   * the constructor refuses one that does not.
   * @param {Readonly<import('../contract/container-update-listener.js').ContainerChange>} change
   */
  paint(change) {
    throw new ContractViolation(`${this.constructor.name} must implement paint(change)`)
  }
}
