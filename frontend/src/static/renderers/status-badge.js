// @ts-check
// status-badge.js — StatusBadge: the shared status × isJobStale → state
// decision tree (survey item A7, docs/design/archive/specs/2026-07-20-block-renderer-extraction.md,
// Phase 4 / issue #47). ai-block's renderer already structured this decision
// (AiBlockRenderer#update, Phase 3); it is hoisted to a shared class here at
// the SECOND badge-bearing kind to migrate (code, Phase 4) so every migrated
// kind reads status off ONE decision tree instead of re-deriving it — fixing
// the drift where a hand-rolled badge collapses TIMEOUT into its generic
// "else → error" bucket. Every MIGRATED kind gets the full five-way split
// below (see status-badge.test.js for the regression coverage of that fix,
// exercised through each consuming renderer's own badge/state build).
//
// PM-free: a pure function of (status, createdAt, id) — usable by a
// renderer's own DOM building (renderers/*) OR (as most callers here
// are, since a "badge" is usually part of a PM-framework headerProvider
// toolbar, not the renderer's own body) an adapter-side header builder that
// needs the same bucket. isJobStale itself lives in ./job-status.js (the
// stateful job-liveness tracker) — imported, not re-implemented.

import { isJobStale } from './job-status.js'

/** @typedef {'pending'|'stale'|'complete'|'timeout'|'error'} StatusBadgeState */

export class StatusBadge {
  /**
   * Classifies a block's job-lifecycle status into one of five buckets every
   * migrated kind's badge/state building switches on. 'stale' means "was
   * PENDING/DISPATCHED, but the server has no record of it (job tracker) AND
   * the CLI-timeout threshold has passed" — see isJobStale/isJobActive/
   * isJobQueued in ./job-status.js for the exact liveness check.
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
