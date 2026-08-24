// @ts-check
// job-status.js — the shared job-lifecycle tracker for block renderers/badges.
//
// A block whose work runs as a server JOB (ai-block, web-clip, smart-card, …)
// shows PENDING/DISPATCHED until the job lands. "Stale" (timed out) must be
// distinguished from "still queued on a bounded worker pool" — so the truth of
// which jobs are ACTIVE vs QUEUED lives server-side and is mirrored here.
//
// This is the "sibling job-status module" home for the family that used to sit
// loose in base/fenced-block-base.js (issue #49 P5; retires TECH-DEBT X-D). It
// is NOT folded into StatusBadge: StatusBadge.classify is a PURE function of
// (status, createdAt, id), whereas job tracking is STATEFUL (two live id sets
// seeded from a fetch and replaced on every jobs:changed snapshot). Keeping the
// mutable state on its own singleton keeps StatusBadge pure; StatusBadge and
// every renderer just READ the liveness via isJobStale.
//
// It NEVER asks: the server pushes the whole snapshot the moment the workspace
// socket connects, and again on every change, so there is no seed to fetch and
// no window in which this tracker is empty but the server is busy.

class JobStatusTracker {
  /** @type {Set<string>} */ #active = new Set()
  /** @type {Set<string>} */ #queued = new Set()

  constructor() {
    // Full-snapshot listener: authoritative replacement of both tracked sets.
    if (typeof document !== 'undefined') {
      document.addEventListener('sieve:jobs-changed', (e) => {
        this.#replace(/** @type {any} */ (e).detail || {})
      })
    }
  }

  /** @param {{active?: {jobId?: string}[], queued?: {jobId?: string}[]}} payload */
  #replace(payload) {
    this.#active.clear()
    this.#queued.clear()
    ;(payload.active || []).forEach((j) => { if (j.jobId) this.#active.add(j.jobId) })
    ;(payload.queued || []).forEach((j) => { if (j.jobId) this.#queued.add(j.jobId) })
  }

  /** @param {string} [id] true if the job is running on the server right now. */
  isActive(id) { return !!id && this.#active.has(id) }

  /** @param {string} [id] true if the job is waiting in the engine queue (not yet running). */
  isQueued(id) { return !!id && this.#queued.has(id) }

  /**
   * A block's job is stale only if the server has NO record of it (neither
   * active NOR queued) AND it has exceeded the CLI-timeout threshold. A QUEUED
   * job is waiting to run on a bounded worker pool — it is NOT stale/timed out,
   * even once createdAt passes the threshold. This is the queued≠timeout fix.
   * @param {string|null} [createdAt] @param {string} [id]
   */
  isStale(createdAt, id) {
    if (this.isActive(id) || this.isQueued(id)) return false
    return isStaleByTime(createdAt)
  }
}

const tracker = new JobStatusTracker()

// isStaleByTime — pure: true when createdAt is older than the CLI timeout
// threshold. State-free, so it stays a standalone helper the tracker leans on.
/** @param {string|null} [createdAt] */
export function isStaleByTime(createdAt) {
  if (!createdAt) return true
  const thresholdMs = (/** @type {any} */ (window).__sieveCliTimeoutLong || 60) * 1000 + 30000
  return Date.now() - new Date(createdAt).getTime() > thresholdMs
}

// Thin named-export delegators over the module singleton — the call sites
// (renderers, badges, the block extension) read liveness by name, unchanged.
/** @param {string} [id] */
export function isJobActive(id) { return tracker.isActive(id) }
/** @param {string} [id] */
export function isJobQueued(id) { return tracker.isQueued(id) }
/** @param {string|null} [createdAt] @param {string} [id] */
export function isJobStale(createdAt, id) { return tracker.isStale(createdAt, id) }
