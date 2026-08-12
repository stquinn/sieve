// @ts-check
// mention-service.js — MentionService: JS protocol peer for the `@` picker's
// typeahead (#74 P4).
//
// A TENANT of the session channel, not its owner (the plane is
// workspace-service.js): it claims the `mention-result` frame word and speaks
// `mention-query`. It is the SECOND tenant and the first non-command one — the
// reason wire ownership moved off CommandService in P1.
//
// IT IS NOT A COMMAND. A typeahead needs a sub-100ms answer with no JobEngine
// job, no worker pool and no result block, none of which the command envelope's
// PENDING/COMPLETE lifecycle can give it — so it is a sibling frame pair on the
// same socket, exactly as Go's handleMentionQuery is a sibling of handleCommand.
//
// It is also the ONLY place the picker touches transport (#49): the UI provider
// (shell/trigger-providers.js) calls search() and never sees a socket. The
// TYPING CADENCE is not this class's business either — debouncing belongs to the
// provider that watches the keyboard; this one round-trips whatever it is asked.

import { ContractViolation } from './sieve-block.js'

/**
 * One offer from Go's Router enumeration face (`domain.Candidate`). `uri` is the
 * truth; `title` is what the `@token` echoes and what the chip caches; `detail`
 * is how two documents with the SAME title are told apart in the picker.
 * @typedef {object} MentionCandidate
 * @property {string} uri
 * @property {string} title
 * @property {string} [kind]
 * @property {string} [detail]
 */

/**
 * @typedef {object} MentionServiceOptions
 * @property {number} [timeoutMs]
 *   — how long an unanswered query waits before it settles EMPTY. It never
 *   rejects: a typeahead that throws is a typeahead that breaks the composer.
 * @property {number} [defaultLimit]
 *   — mirrors Go's mentionDefaultLimit.
 */

/** The inbound frame vocabulary this tenant claims on the plane. */
const MENTION_FRAMES = Object.freeze(['mention-result'])

/** Go floors an absent limit at 8 and caps it at 25; we send its floor. */
const DEFAULT_LIMIT = 8

/** An unanswered typeahead settles empty rather than hanging the picker open. */
const DEFAULT_TIMEOUT_MS = 4000

export class MentionService {
  /** @type {import('./workspace-service.js').WorkspaceService} the session-channel wire owner */ #workspace
  /** @type {Map<string, {resolve: (c: MentionCandidate[]) => void, timer: ReturnType<typeof setTimeout>}>} correlationId → the waiting query */ #pending = new Map()
  /** @type {number} */ #timeoutMs
  /** @type {number} */ #defaultLimit

  /**
   * @param {import('./workspace-service.js').WorkspaceService} workspace
   *   — the session-channel wire owner (injected by the composition root).
   * @param {MentionServiceOptions} [options]
   */
  constructor(workspace, options = {}) {
    if (!workspace || typeof workspace.send !== 'function' || typeof workspace.registerTenant !== 'function') {
      throw new ContractViolation('MentionService requires a WorkspaceService')
    }
    this.#workspace = workspace
    this.#timeoutMs = options.timeoutMs || DEFAULT_TIMEOUT_MS
    this.#defaultLimit = options.defaultLimit || DEFAULT_LIMIT
    // Join the plane at construction — a peer that queries before it can hear
    // the answer is the silent-dead-UI shape the plane exists to prevent.
    this.#workspace.registerTenant(this)
  }

  // ── WorkspaceTenant contract (the plane calls these; nothing else does) ─────

  /** @returns {readonly string[]} */
  get frameTypes() { return MENTION_FRAMES }

  /**
   * Inbound `mention-result` delivery. Go guarantees `candidates` is an array
   * and never null; the Array.isArray guard is the door for a malformed frame,
   * so the picker gets a list to render in every case. An unknown correlation id
   * is dropped (a reply to a superseded or timed-out query).
   * @param {Record<string, any>} msg
   */
  onFrame(msg) {
    const cid = msg && msg.correlationId
    if (!cid) return
    this.#settle(cid, Array.isArray(msg.candidates) ? msg.candidates : [])
  }

  // ── The picker's one verb ──────────────────────────────────────────────────

  /**
   * Asks Go what `query` could mention. Resolves with the candidates, or with an
   * empty list on timeout — it NEVER rejects.
   * @param {string} query
   * @param {number} [limit]
   * @returns {Promise<MentionCandidate[]>}
   */
  search(query, limit) {
    const cid = this.#workspace.newCorrelationId()
    return new Promise((resolve) => {
      this.#pending.set(cid, {
        resolve: resolve,
        timer: setTimeout(() => this.#settle(cid, []), this.#timeoutMs),
      })
      this.#workspace.send({
        type: 'mention-query',
        q: query || '',
        limit: limit || this.#defaultLimit,
        correlationId: cid,
      })
    })
  }

  /**
   * Settles one waiting query exactly once (the timeout and the reply race; the
   * map entry is the token that decides).
   * @param {string} cid @param {MentionCandidate[]} candidates
   */
  #settle(cid, candidates) {
    const entry = this.#pending.get(cid)
    if (!entry) return
    this.#pending.delete(cid)
    clearTimeout(entry.timer)
    entry.resolve(candidates)
  }
}
