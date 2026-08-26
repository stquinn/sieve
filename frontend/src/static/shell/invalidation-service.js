// @ts-check
// invalidation-service.js — InvalidationService: the workspace channel's push
// tenant. It claims the server-INITIATED frames `invalidate`, `jobs-changed`,
// `container-deleted` and `container-saved`, and re-publishes each as a
// page-global DOM event on `document`. DOM events rather than registered
// listeners because htmx views subscribe to these through `hx-trigger`, and htmx
// listens for real DOM events and nothing else. It re-dispatches; it never acts,
// and nothing here knows what a topic MEANS.

import { ContractViolation } from '../contract/sieve-block.js'
import { WorkspaceFrame, AllTopics } from '../generated/protocol.js'

const PUSH_FRAMES = Object.freeze([
  WorkspaceFrame.INVALIDATE,
  WorkspaceFrame.JOBS_CHANGED,
  WorkspaceFrame.CONTAINER_DELETED,
  WorkspaceFrame.CONTAINER_SAVED,
])

/**
 * Every subject the server can declare stale. A CLOSED list on both sides: a
 * topic no client knows is a view nothing refetches. It is also the list
 * onConnect resyncs. `intent` has no server-side emitter today, so that resync
 * is the only occasion it fires.
 */
const TOPICS = AllTopics

/**
 * The jobs snapshot as it arrives, and as the `sieve:jobs-changed` detail carries
 * it. Both lists are always present — an absent one is not "no jobs".
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
  /** @type {import('./workspace-service.js').WorkspaceService} */ #workspace
  /** @type {EventTarget} */ #target

  /**
   * @param {import('./workspace-service.js').WorkspaceService} workspace
   * @param {InvalidationServiceOptions} [options]
   */
  constructor(workspace, options = {}) {
    if (!workspace || typeof workspace.registerTenant !== 'function') {
      throw new ContractViolation('InvalidationService requires a WorkspaceService')
    }
    this.#workspace = workspace
    this.#target = options.target || document
    // Register before any socket opens: the server pushes the jobs snapshot the
    // moment one connects, and an unclaimed frame is dropped.
    this.#workspace.registerTenant(this)
  }

  /** @returns {readonly string[]} */
  get frameTypes() { return PUSH_FRAMES }

  /** @param {Record<string, any>} msg */
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
    if (msg.topic) this.#publishInvalidation(String(msg.topic))
  }

  /**
   * Declares EVERY topic stale, once — the client cannot know what it missed
   * before the socket came up. The jobs snapshot is deliberately not resynced
   * here: the server sends one unprompted on every connect.
   */
  onConnect() {
    for (const topic of TOPICS) this.#publishInvalidation(topic)
  }

  /**
   * Publishes one topic as `sieve:invalidate-{topic}`. The topic is in the event
   * NAME, not the detail: `hx-trigger` matches a name and cannot filter a payload.
   * @param {string} topic
   */
  #publishInvalidation(topic) {
    this.#target.dispatchEvent(new CustomEvent('sieve:invalidate-' + topic, { bubbles: true }))
  }

  /**
   * Publishes the job snapshot as `sieve:jobs-changed`, detail = the snapshot.
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
   * `{uuid}`.
   * @param {string} uuid
   */
  #publishContainerDeleted(uuid) {
    this.#target.dispatchEvent(
      new CustomEvent('sieve:container-deleted', { detail: { uuid: uuid }, bubbles: true }),
    )
  }

  /**
   * Publishes an accomplished save as `sieve:container-saved`, detail =
   * `{uuid, version}`. A version of 0 means the container keeps no version
   * history and cannot answer "is this newer than what I hold".
   * @param {string} uuid
   * @param {number} version
   */
  #publishContainerSaved(uuid, version) {
    this.#target.dispatchEvent(
      new CustomEvent('sieve:container-saved', { detail: { uuid: uuid, version: version }, bubbles: true }),
    )
  }
}
