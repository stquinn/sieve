// @ts-check
// StatusBadge — the shared status × isJobStale → state decision tree, so every
// kind reads status off ONE tree instead of re-deriving it (a hand-rolled badge
// collapses TIMEOUT into its generic "else → error" bucket).
//
// PM-free: a pure function of (status, createdAt, id), usable by a renderer's
// own DOM building or by an adapter-side header builder that needs the same
// bucket. isJobStale itself lives in ./job-status.js.

import { isJobStale } from './job-status.js'

/** @typedef {'pending'|'stale'|'complete'|'timeout'|'error'} StatusBadgeState */

export class StatusBadge {
  /**
   * Classifies a block's job-lifecycle status into one of five buckets. 'stale'
   * means "was PENDING/DISPATCHED, but the server has no record of it AND the
   * CLI-timeout threshold has passed" — see isJobStale in ./job-status.js.
   * @param {string} [status]
   * @param {string|null} [createdAt]
   * @param {string} [id]
   * @returns {StatusBadgeState}
   */
  static classify(status, createdAt, id) {
    const s = status || 'PENDING'
    if (s === 'PENDING' || s === 'DISPATCHED') {
      return isJobStale(createdAt, id) ? 'stale' : 'pending'
    }
    if (s === 'COMPLETE') return 'complete'
    if (s === 'TIMEOUT') return 'timeout'
    return 'error'
  }
}
