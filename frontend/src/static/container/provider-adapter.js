// @ts-check
// The host's ContainerProvider over a ContainerModel: the READ half and the
// container's feed, which is all a read-only mount needs. Semantics are
// contract/container-provider.js's and contract/container-feed-listener.js's.

import { ContractViolation } from '../contract/sieve-block.js'

/** @typedef {import('../contract/container-feed-listener.js').ContainerFeedListener} ContainerFeedListener */
/** @typedef {import('../contract/container-feed-listener.js').ContainerFeedEvent} ContainerFeedEvent */

export class ProviderAdapter {
  /** @type {import('./container-model.js').ContainerModel} */ #model
  /** @type {Set<ContainerFeedListener>} in subscription order */ #feedListeners = new Set()
  /** @type {(() => void)|null} stops the feed's source; null while nobody listens */ #stopFeed = null

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

  /** @returns {string} */
  getName() { return this.#model.getName() }

  /** @returns {ReadonlyArray<string>} */
  getOrder() { return this.#model.getOrder() }

  /** @param {string} id @returns {Readonly<import('./container-model.js').BlockNode>|null} */
  getBlock(id) { return this.#model.getBlock(id) }

  /** @param {import('./container-model.js').ContainerUpdateListener} listener */
  subscribe(listener) { this.#model.subscribe(listener) }

  /** @param {import('./container-model.js').ContainerUpdateListener} listener */
  unsubscribe(listener) { this.#model.unsubscribe(listener) }

  /**
   * The feed's source starts with the first listener and stops with the last,
   * so a container nobody hears costs nothing.
   * @param {ContainerFeedListener} listener
   */
  subscribeFeed(listener) {
    if (!listener || typeof listener.onFeed !== 'function') {
      throw new ContractViolation('subscribeFeed: the listener must implement onFeed')
    }
    this.#feedListeners.add(listener)
    if (!this.#stopFeed) this.#stopFeed = this._startFeed((event) => this.#deliver(event))
  }

  /** @param {ContainerFeedListener} listener */
  unsubscribeFeed(listener) {
    this.#feedListeners.delete(listener)
    if (this.#feedListeners.size === 0 && this.#stopFeed) {
      this.#stopFeed()
      this.#stopFeed = null
    }
  }

  /**
   * Starts this container's feed: `deliver` is called with each event, in
   * order. The kind's adapter decides which of its container's traffic becomes
   * an event and what the event is; this container has none.
   * @protected
   * @param {(event: Record<string, any>) => void} deliver
   * @returns {(() => void)|null} what stops it; null for a container with no feed
   */
  _startFeed(deliver) { return null }

  /**
   * A frozen copy of a value of plain data, frozen all the way down.
   * @protected
   * @template T
   * @param {T} value @returns {Readonly<T>}
   */
  static _frozen(value) {
    return ProviderAdapter.#freeze(structuredClone(value))
  }

  /**
   * A value of plain data frozen where it is, all the way down. Only for a value
   * nothing else holds: whoever else held it would find it frozen.
   * @protected
   * @template T
   * @param {T} value @returns {Readonly<T>}
   */
  static _frozenInPlace(value) {
    return ProviderAdapter.#freeze(value)
  }

  /** A throwing listener is isolated: the others still hear the event.
   *  @param {Record<string, any>} event */
  #deliver(event) {
    const frozen = /** @type {ContainerFeedEvent} */ (ProviderAdapter._frozen(event))
    for (const listener of [...this.#feedListeners]) {
      try { listener.onFeed(frozen) } catch (e) { console.error('[provider-adapter] feed listener threw', e) }
    }
  }

  /** @template T @param {T} value @returns {Readonly<T>} */
  static #freeze(value) {
    const obj = /** @type {any} */ (value)
    if (obj && typeof obj === 'object' && !Object.isFrozen(obj)) {
      Object.freeze(obj)
      for (const key of Object.keys(obj)) ProviderAdapter.#freeze(obj[key])
    }
    return value
  }
}
