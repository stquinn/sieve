// @ts-check
// invalidation-service.js — InvalidationService: the workspace channel's push
// tenant. It claims the server-INITIATED frames — `invalidate` (a subject is
// stale), `jobs-changed` (the whole job snapshot), `container-deleted` (a
// container ceased to exist) and `container-saved` (a container's content
// reached disk) — and re-publishes them as page-global DOM events on `document`.
//
// WHY DOM EVENTS HERE, WHEN THE HOUSE RULE IS REGISTERED LISTENERS (idiomatic-js
// §4): so that every pushed fact reaches its consumers by ONE mechanism. Some of
// those consumers are htmx attributes — a view refetches itself with
// `hx-trigger="sieve:invalidate-notes from:document"`, and htmx listens for real
// DOM events and nothing else, so a registered-listener API would mean a JS shim
// per view to bridge back into the DOM: the bus rebuilt, with an extra hop.
// Others are pure JS and could have been given a subscribe() (the jobs status
// bar, the workspace's deletion reconciliation), but splitting the delivery by
// who happens to be listening would make one push arrive two ways and force
// every new consumer to pick a side. `jobs-changed` set that precedent and
// `container-deleted` and `container-saved` follow it: the DOM event IS the
// published contract for a pushed fact, deliberately and only here.
//
// It re-dispatches; it never acts. Nothing in this file knows what a topic MEANS
// — which view is stale, what a job count renders as — because the whole point of
// invalidation is that the subject's own consumers decide that.

import { ContractViolation } from './sieve-block.js'
import { WorkspaceFrame, AllTopics } from '../generated/protocol.js'

/** The inbound frame vocabulary this tenant claims on the plane. */
const PUSH_FRAMES = Object.freeze([
  WorkspaceFrame.INVALIDATE,
  WorkspaceFrame.JOBS_CHANGED,
  WorkspaceFrame.CONTAINER_DELETED,
  WorkspaceFrame.CONTAINER_SAVED,
])

/**
 * Every subject the server can declare stale, sourced from the generated Topic
 * enum so this is not a second hand-maintained copy of Go's list. It is a CLOSED
 * list on both sides: a topic no client knows is a view nothing refetches.
 *
 * It is also the resync list — see onConnect. `intent` has no server-side emitter
 * today; it is here because it is a real subject in the contract, and the resync
 * is therefore the only occasion it fires.
 */
const TOPICS = AllTopics

/**
 * The jobs snapshot as it arrives, and as the `sieve:jobs-changed` detail carries
 * it. Both lists are always present — an absent one would be an undefined-length
 * crash in a consumer reading a count rather than "no jobs".
 * @typedef {object} JobsSnapshot
 * @property {object[]} active  jobs a worker is running now
 * @property {object[]} queued  jobs waiting for a worker
 */

/**
 * @typedef {object} InvalidationServiceOptions
 * @property {EventTarget} [target]
 *   — where the events are published; defaults to `document`. Injected for tests.
 */

export class InvalidationService {
  /** @type {import('./workspace-service.js').WorkspaceService} the workspace-channel wire owner */ #workspace
  /** @type {EventTarget} */ #target

  /**
   * @param {import('./workspace-service.js').WorkspaceService} workspace
   *   — the workspace-channel wire owner (injected by the composition root).
   * @param {InvalidationServiceOptions} [options]
   */
  constructor(workspace, options = {}) {
    if (!workspace || typeof workspace.registerTenant !== 'function') {
      throw new ContractViolation('InvalidationService requires a WorkspaceService')
    }
    this.#workspace = workspace
    this.#target = options.target || document
    // Join the plane at construction, before any socket opens: the server sends
    // the jobs snapshot the moment a socket connects, so a tenant that registered
    // lazily would have that first push dropped as unclaimed.
    this.#workspace.registerTenant(this)
  }

  // ── WorkspaceTenant contract (the plane calls these; nothing else does) ─────

  /** @returns {readonly string[]} */
  get frameTypes() { return PUSH_FRAMES }

  /**
   * Inbound delivery for all four claimed words.
   * @param {Record<string, any>} msg
   */
  onFrame(msg) {
    if (msg.type === WorkspaceFrame.JOBS_CHANGED) {
      this.#publishJobs(msg)
      return
    }
    if (msg.type === WorkspaceFrame.CONTAINER_DELETED) {
      if (msg.uuid) this.#publishContainerDeleted(String(msg.uuid))
      return
    }
    if (msg.type === WorkspaceFrame.CONTAINER_SAVED) {
      if (msg.uuid) this.#publishContainerSaved(String(msg.uuid), Number(msg.version) || 0)
      return
    }
    // A topic outside the closed list is a Go build ahead of this one. Publishing
    // it anyway is harmless (nothing listens) and honest (the event names what the
    // server said), where dropping it would hide the mismatch entirely.
    if (msg.topic) this.#publishInvalidation(String(msg.topic))
  }

  /**
   * The socket is up: declare EVERY topic stale, once.
   *
   * A blanket resync, not a clever one, because the client cannot know what it
   * missed. A reconnect means some unknown number of invalidations went nowhere,
   * and a first connect means the page's views were rendered by whatever seeded
   * them. Refetching all five costs a handful of cached GETs; getting it wrong
   * costs a stale sidebar nobody can explain.
   *
   * The jobs snapshot is NOT resynced here: the server sends one unprompted on
   * every connect, so asking for it would duplicate a push already in flight.
   */
  onConnect() {
    for (const topic of TOPICS) this.#publishInvalidation(topic)
  }

  // ── Publication ────────────────────────────────────────────────────────────

  /**
   * Publishes one topic as `sieve:invalidate-{topic}`. The topic is in the event
   * NAME rather than its detail so htmx can subscribe to exactly one subject —
   * `hx-trigger` matches a name and cannot filter a payload.
   * @param {string} topic
   */
  #publishInvalidation(topic) {
    this.#target.dispatchEvent(new CustomEvent('sieve:invalidate-' + topic, { bubbles: true }))
  }

  /**
   * Publishes the job snapshot as `sieve:jobs-changed`, detail = the snapshot.
   * This frame carries DATA where an invalidate carries only a name, because its
   * consumers read counts and labels off it — there is no view to refetch and no
   * endpoint left to poll.
   * @param {Record<string, any>} msg
   */
  #publishJobs(msg) {
    /** @type {JobsSnapshot} */
    const detail = {
      active: Array.isArray(msg.active) ? msg.active : [],
      queued: Array.isArray(msg.queued) ? msg.queued : [],
    }
    this.#target.dispatchEvent(new CustomEvent('sieve:jobs-changed', { detail: detail, bubbles: true }))
  }

  /**
   * Publishes an accomplished deletion as `sieve:container-deleted`, detail =
   * `{uuid}`. The uuid is in the DETAIL, not the name, because the subscriber is
   * the workspace reconciling one identity out of the many it holds — the
   * opposite of a topic, which htmx subscribes to by name. (CONTAINER naming
   * rationale: see `protocol.ContainerDeletedFrame`'s godoc.)
   * @param {string} uuid
   */
  #publishContainerDeleted(uuid) {
    this.#target.dispatchEvent(
      new CustomEvent('sieve:container-deleted', { detail: { uuid: uuid }, bubbles: true }),
    )
  }

  /**
   * Publishes an accomplished save as `sieve:container-saved`, detail =
   * `{uuid, version}`. Sibling of the deletion above and shaped for the same
   * reason: the subscriber is an editor asking "is this MY uuid", which is a
   * detail to match on rather than a name to subscribe to. The version rides
   * along because an editor waiting for its OWN save also has to ask "is this
   * save newer than the one I already knew about" — 0 means the container keeps
   * no version history and cannot answer that.
   * @param {string} uuid
   * @param {number} version
   */
  #publishContainerSaved(uuid, version) {
    this.#target.dispatchEvent(
      new CustomEvent('sieve:container-saved', { detail: { uuid: uuid, version: version }, bubbles: true }),
    )
  }
}
