// jobs-snapshot.test.js — verifies the pure activeJobs map-building logic from
// applyJobsSnapshot in ai-actions.js.
//
// ai-actions.js is an IIFE with DOM-touching side effects (setEvaluating,
// updateStatusBar), so it cannot be imported directly. This test co-locates the
// same pure transformation and asserts the shape that applyJobsSnapshot produces.

import { describe, it, expect } from 'vitest'

// Mirror of the pure map-building logic inside applyJobsSnapshot. EVERY
// JobEngine job paints uniformly — commands included (their CommandBadge is an
// additional affordance; #55 decision #5's filter was reversed 2026-07-26).
function buildActiveJobsMap(active) {
  var map = {}
  ;(active || []).forEach(function (j) {
    if (!j.jobId) return
    map[j.jobId] = { label: j.label || 'Working...', docId: j.docId || '', spinTab: !!j.spinTab }
  })
  return map
}

function buildQueuedList(queued) {
  return (queued || []).filter(function (j) { return !!j.jobId })
}

describe('applyJobsSnapshot pure logic (mirrors ai-actions.js)', () => {
  it('builds activeJobs map keyed by jobId', () => {
    var payload = {
      active: [{ jobId: 'j1', docId: 'doc1', label: 'Filing...', spinTab: true }],
      queued: [{ jobId: 'j2' }],
    }
    var map = buildActiveJobsMap(payload.active)
    expect(map['j1']).toEqual({ label: 'Filing...', docId: 'doc1', spinTab: true })
    expect(Object.keys(map)).toHaveLength(1)
  })

  it('stores queued list unchanged', () => {
    var payload = {
      active: [{ jobId: 'j1', docId: 'doc1', label: 'Analyzing...', spinTab: false }],
      queued: [{ jobId: 'j2' }, { jobId: 'j3' }],
    }
    var list = buildQueuedList(payload.queued)
    expect(list).toHaveLength(2)
    expect(list[0].jobId).toBe('j2')
    expect(list[1].jobId).toBe('j3')
  })

  it('handles empty payload gracefully', () => {
    expect(buildActiveJobsMap([])).toEqual({})
    expect(buildActiveJobsMap(undefined)).toEqual({})
    expect(buildQueuedList([])).toEqual([])
    expect(buildQueuedList(undefined)).toEqual([])
  })

  it('skips active entries without jobId', () => {
    var map = buildActiveJobsMap([
      { docId: 'doc1' },
      { jobId: 'j2', docId: 'doc2', label: 'Working', spinTab: true },
    ])
    expect(Object.keys(map)).toHaveLength(1)
    expect(map['j2']).toBeDefined()
    expect(map['j2'].spinTab).toBe(true)
  })

  it('defaults label to "Working..." when absent', () => {
    var map = buildActiveJobsMap([{ jobId: 'j1', docId: 'doc1' }])
    expect(map['j1'].label).toBe('Working...')
  })

  it('defaults docId to empty string when absent', () => {
    var map = buildActiveJobsMap([{ jobId: 'j1' }])
    expect(map['j1'].docId).toBe('')
  })

  it('paints commands-category jobs in the active map like every other job', () => {
    var map = buildActiveJobsMap([
      { jobId: 'cmd-1', category: 'commands', label: '/btw' },
      { jobId: 'j2', category: 'ai', label: 'Filing...' },
    ])
    expect(map['cmd-1']).toEqual({ label: '/btw', docId: '', spinTab: false })
    expect(map['j2']).toBeDefined()
    expect(Object.keys(map)).toHaveLength(2)
  })

  it('keeps commands-category jobs in the queued list like every other job', () => {
    var list = buildQueuedList([
      { jobId: 'cmd-1', category: 'commands' },
      { jobId: 'j2', category: 'ai' },
      { jobId: 'j3' },
    ])
    expect(list.map(function (j) { return j.jobId })).toEqual(['cmd-1', 'j2', 'j3'])
  })
})
