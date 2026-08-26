// @ts-check
// MentionService: the JS protocol peer for the `@` picker's typeahead.
//
// A TENANT of the workspace channel, not its owner: it claims the
// `mention-result` and `mention-resolved` frame words and speaks `mention-query`
// and `mention-resolve`. A typeahead is answered directly — no job, no
// PENDING/COMPLETE lifecycle.
//
// It is the ONLY place the picker touches transport, and debouncing is not its
// business: it round-trips whatever it is asked, whenever it is asked.
//
// JS NEVER DECODES A COORDINATE — a uri travels through here as an OPAQUE
// string, and what comes back is already actionable: a uuid and a block id.

import { ContractViolation } from '../contract/sieve-block.js'
import { WorkspaceFrame } from '../generated/protocol.js'

/**
 * One offer from Go's Router enumeration face (`domain.Candidate`).
 * @typedef {object} MentionCandidate
 * @property {string} uri
 * @property {string} title
 * @property {string} [kind]
 * @property {string} [detail]  the picker's disambiguation line (folder · snippet)
 * @property {string} [summary] the target's OWN one-liner — a different sentence
 *   from `detail`, and what an accepted mention seeds into the block it mints
 */

/**
 * Where a coordinate opens (`domain.OpenTarget` on the wire) — the only thing
 * the frontend is allowed to know about an address. `found` false means Go
 * refused or found nothing, and `error` says which.
 * @typedef {object} MentionTarget
 * @property {string} uri      the address it was resolved from, echoed back
 * @property {boolean} found
 * @property {string} uuid     the document to open
 * @property {string} blockId  the block to reveal, empty for a whole container
 * @property {string} kind
 * @property {string} title
 * @property {string} error
 */

/**
 * @typedef {object} MentionServiceOptions
 * @property {number} [timeoutMs]
 *   — how long an unanswered query waits before it settles EMPTY.
 * @property {number} [defaultLimit]
 *   — mirrors Go's mentionDefaultLimit.
 */

const MENTION_FRAMES = Object.freeze([WorkspaceFrame.MENTION_RESULT, WorkspaceFrame.MENTION_RESOLVED])

/** Go floors an absent limit at 8 and caps it at 25; we send its floor. */
const DEFAULT_LIMIT = 8

/** An unanswered typeahead settles empty rather than hanging the picker open. */
const DEFAULT_TIMEOUT_MS = 4000

export class MentionService {
  /** @type {import('./workspace-service.js').WorkspaceService} */ #workspace
  /** @type {Map<string, {settle: (answer: any) => void, timer: ReturnType<typeof setTimeout>}>}
   *  correlationId → the waiting request. One map serves BOTH verbs — an id is
   *  unique whatever asked for it. */ #pending = new Map()
  /** @type {number} */ #timeoutMs
  /** @type {number} */ #defaultLimit

  /**
   * @param {import('./workspace-service.js').WorkspaceService} workspace
   * @param {MentionServiceOptions} [options]
   */
  constructor(workspace, options = {}) {
    if (!workspace || typeof workspace.send !== 'function' || typeof workspace.registerTenant !== 'function') {
      throw new ContractViolation('MentionService requires a WorkspaceService')
    }
    this.#workspace = workspace
    this.#timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS
    this.#defaultLimit = options.defaultLimit || DEFAULT_LIMIT
    // Join the plane at construction: a peer that queries before it can hear the
    // answer never hears it.
    this.#workspace.registerTenant(this)
  }

  /** @returns {readonly string[]} */
  get frameTypes() { return MENTION_FRAMES }

  /**
   * Inbound delivery for both claimed words. An unknown correlation id is
   * dropped — it answers a superseded or timed-out request.
   * @param {Record<string, any>} msg
   */
  onFrame(msg) {
    const cid = msg && msg.correlationId
    if (!cid) return
    if (msg.type === WorkspaceFrame.MENTION_RESOLVED) {
      this.#settle(cid, MentionService.#targetOf(msg))
      return
    }
    this.#settle(cid, Array.isArray(msg.candidates) ? msg.candidates : [])
  }

  /**
   * Asks Go what `query` could mention. Resolves with the candidates, or with an
   * empty list on timeout — it NEVER rejects.
   * @param {string} query
   * @param {number} [limit]
   * @returns {Promise<MentionCandidate[]>}
   */
  search(query, limit) {
    return this.#request({
      type: WorkspaceFrame.MENTION_QUERY,
      q: query || '',
      limit: limit || this.#defaultLimit,
    }, [])
  }

  /**
   * Asks Go WHERE a coordinate opens. `uri` is opaque here — never parsed, split
   * or prefix-tested on the way out. Resolves with the target (which may itself
   * say `found: false`), or with null when the address is empty or the
   * round-trip times out. It NEVER rejects.
   * @param {string} uri
   * @returns {Promise<MentionTarget|null>}
   */
  resolve(uri) {
    const address = (uri || '').trim()
    if (!address) return Promise.resolve(null)
    return this.#request({ type: WorkspaceFrame.MENTION_RESOLVE, uri: address }, null)
  }

  /**
   * Puts a correlated frame on the plane and hands back the promise of its
   * reply. `onTimeout` is what that promise settles with when no reply arrives —
   * no verb here leaves a caller waiting.
   * @template T
   * @param {Record<string, any>} frame  the verb's own fields (no correlation id)
   * @param {T} onTimeout
   * @returns {Promise<T>}
   */
  #request(frame, onTimeout) {
    const cid = this.#workspace.newCorrelationId()
    return new Promise((settle) => {
      this.#pending.set(cid, {
        settle: settle,
        timer: setTimeout(() => this.#settle(cid, onTimeout), this.#timeoutMs),
      })
      this.#workspace.send(Object.assign({}, frame, { correlationId: cid }))
    })
  }

  /**
   * Normalizes a `mention-resolved` frame into a total MentionTarget, so a
   * consumer never has to tell an absent key from an empty one.
   * @param {Record<string, any>} msg
   * @returns {MentionTarget}
   */
  static #targetOf(msg) {
    return {
      uri: msg.uri || '',
      found: msg.found === true,
      uuid: msg.uuid || '',
      blockId: msg.blockId || '',
      kind: msg.kind || '',
      title: msg.title || '',
      error: msg.error || '',
    }
  }

  /**
   * Settles one waiting request exactly once — the timeout and the reply race,
   * and the map entry is the token that decides.
   * @param {string} cid @param {any} answer
   */
  #settle(cid, answer) {
    const entry = this.#pending.get(cid)
    if (!entry) return
    this.#pending.delete(cid)
    clearTimeout(entry.timer)
    entry.settle(answer)
  }
}
