// @ts-check
// address-status.js — AddressStatus: what is known about whether the coordinates
// a document renders still point at something (#82).
//
// A PERSISTED ATTACHMENT KEEPS ITS OWN FACE. An ai-block stores `{uri, title}`
// and nothing more, so a chip whose target document has since been deleted goes
// on showing the cached title with nothing to say the document is gone. The
// answer is already on the wire: `mention-resolve` replies `found:false` with a
// reason rather than dropping the frame, so "is that still there?" costs one
// round trip and no new frame.
//
// THE POLICY IS WHY THIS IS NOT A METHOD ON MentionService. That class
// round-trips whatever it is asked, and cadence is deliberately the caller's
// business — the picker's debounce lives in the picker. Here the caller is a
// RENDERER, and a renderer redraws on every transaction that touches its node:
// asking per chip per redraw would put a frame on the wire per character typed.
// So an address is asked about AT MOST ONCE, and every later redraw reads the
// remembered verdict instead.
//
// ITS LIFETIME IS THE EDITOR'S, and that is the whole of the cache-invalidation
// story: AbstractEditor builds one over its mention peer and it dies with the
// editor, so reopening a document (or switching back to its tab) asks again. A
// container that came back is live again on the next fresh load.
//
// AN UNANSWERED PROBE IS NOT A VERDICT. A timed-out round trip leaves the
// address UNKNOWN, and it is not retried — greying a document that is merely
// unreachable would be a lie told confidently, and re-asking on each redraw is
// the chatter this class exists to prevent.

import { ContractViolation } from './sieve-block.js'

/**
 * What is known about one address. UNKNOWN is the state a chip renders
 * NORMALLY in — the default has to be "fine", or every block would flicker
 * through a dangling look on the way to its first answer.
 */
export const AddressState = Object.freeze({
  UNKNOWN: 'unknown',
  LIVE: 'live',
  DANGLING: 'dangling',
})

/** @typedef {'unknown'|'live'|'dangling'} AddressStateValue */

/**
 * The one thing this class needs of a wire peer: ask where a coordinate opens.
 * MentionService satisfies it; a test stub satisfies it in three lines. Neither
 * `found:false` (the address resolves to nothing) nor `null` (no answer came)
 * may reject — see MentionService.resolve.
 * @typedef {object} AddressResolver
 * @property {(uri: string) => Promise<{found: boolean}|null>} resolve
 */

export class AddressStatus {
  /** @type {AddressResolver} */ #resolver
  /** @type {Map<string, AddressStateValue>} address → the verdict Go gave. Only
   *  definitive answers land here; an unanswered probe leaves none. */ #verdicts = new Map()
  /** @type {Map<string, Promise<AddressStateValue>>} address → its ONE probe,
   *  ever. Membership — not the verdict map — is what caps the traffic, so an
   *  address that never got an answer is still never asked about twice. */ #probes = new Map()

  /** @param {AddressResolver} resolver the peer that can ask Go */
  constructor(resolver) {
    if (!resolver || typeof resolver.resolve !== 'function') {
      throw new ContractViolation('AddressStatus requires something that can resolve an address')
    }
    this.#resolver = resolver
  }

  /**
   * The remembered verdict, synchronously — what a draw pass reads. UNKNOWN
   * covers both "not asked yet" and "asked, no answer": a caller that must tell
   * them apart wants `check`, whose promise settles either way.
   * @param {string} uri
   * @returns {AddressStateValue}
   */
  stateOf(uri) {
    return this.#verdicts.get((uri || '').trim()) || AddressState.UNKNOWN
  }

  /**
   * Asks about `uri`, at most once for the life of this object; every later call
   * hands back the same promise. Safe to call from a redraw for exactly that
   * reason — a row rebuilt on every keystroke puts nothing further on the wire.
   * @param {string} uri
   * @returns {Promise<AddressStateValue>}
   */
  check(uri) {
    const address = (uri || '').trim()
    if (!address) return Promise.resolve(AddressState.UNKNOWN)
    const asked = this.#probes.get(address)
    if (asked) return asked
    const probe = Promise.resolve(this.#resolver.resolve(address)).then((target) => {
      if (!target) return AddressState.UNKNOWN   // no answer is not an answer
      const state = target.found ? AddressState.LIVE : AddressState.DANGLING
      this.#verdicts.set(address, state)
      return state
    })
    this.#probes.set(address, probe)
    return probe
  }
}
