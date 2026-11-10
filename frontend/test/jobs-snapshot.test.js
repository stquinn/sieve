// jobs-snapshot.test.js — verifies applyJobsSnapshot map-building and
// updateStatusBar (.status-bar__jobs) DOM rendering in ai-actions.js.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import '../src/static/ai/ai-actions.js'

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

describe('updateStatusBar (.status-bar__jobs DOM rendering)', () => {
  const pushSnapshot = (detail) => {
    document.dispatchEvent(new CustomEvent('sieve:jobs-changed', { detail }))
  }

  beforeEach(() => {
    document.body.innerHTML = '<div class="status-bar"><div class="status-bar__left"><div class="status-bar__jobs"></div></div></div>'
    pushSnapshot({ active: [], queued: [] })
  })

  afterEach(() => {
    pushSnapshot({ active: [], queued: [] })
    document.body.innerHTML = ''
  })

  it('renders a single active job with its label and tooltip and no +N more cell', () => {
    pushSnapshot({
      active: [{ jobId: 'j1', docId: 'doc1', label: 'Transcribing Field Notes, page 3' }],
      queued: [],
    })
    const slot = document.querySelector('.status-bar__jobs')
    const active = slot.querySelector('.status-bar__job-active')
    const task = slot.querySelector('.status-bar__task')
    expect(active).not.toBeNull()
    expect(active.title).toBe('Transcribing Field Notes, page 3')
    expect(active.querySelector('.status-bar__spinner')).not.toBeNull()
    expect(task.textContent).toBe('Transcribing Field Notes, page 3')
    expect(slot.querySelector('.status-bar__job-more')).toBeNull()
    expect(slot.querySelector('.status-bar__job-queued')).toBeNull()
    expect(window.__sieveActiveJobs).toBe(1)
  })

  it('renders +N more and multiline tooltips for multiple active jobs', () => {
    pushSnapshot({
      active: [
        { jobId: 'j1', label: '/btw: how do we wire the workspace channel?' },
        { jobId: 'j2', label: 'Filing Architecture Notes…' },
        { jobId: 'j3', label: 'Naming Scratchpad…' },
      ],
      queued: [],
    })
    const slot = document.querySelector('.status-bar__jobs')
    const active = slot.querySelector('.status-bar__job-active')
    const task = slot.querySelector('.status-bar__task')
    const more = slot.querySelector('.status-bar__job-more')
    expect(task.textContent).toBe('/btw: how do we wire the workspace channel?')
    expect(active.title).toBe(
      '/btw: how do we wire the workspace channel?\nFiling Architecture Notes…\nNaming Scratchpad…'
    )
    expect(more).not.toBeNull()
    expect(more.textContent).toBe('+2 more')
    expect(more.title).toBe('Filing Architecture Notes…\nNaming Scratchpad…')
    expect(window.__sieveActiveJobs).toBe(3)
  })

  it('renders active, +N more, and queued cells together and clears when idle', () => {
    pushSnapshot({
      active: [
        { jobId: 'j1', label: 'Explaining block…' },
        { jobId: 'j2', label: 'Transcribing Daily Log, page 1' },
      ],
      queued: [
        { jobId: 'q1', label: 'Describe image' },
        { jobId: 'q2', label: 'Smart file' },
      ],
    })
    const slot = document.querySelector('.status-bar__jobs')
    const active = slot.querySelector('.status-bar__job-active')
    const more = slot.querySelector('.status-bar__job-more')
    const queued = slot.querySelector('.status-bar__job-queued')
    expect(active.title).toBe('Explaining block…\nTranscribing Daily Log, page 1')
    expect(more.textContent).toBe('+1 more')
    expect(more.title).toBe('Transcribing Daily Log, page 1')
    expect(queued).not.toBeNull()
    expect(queued.textContent).toBe('2 queued')
    expect(queued.title).toBe('Describe image\nSmart file')

    pushSnapshot({ active: [], queued: [] })
    expect(slot.innerHTML).toBe('')
    expect(window.__sieveActiveJobs).toBe(0)
  })
})
