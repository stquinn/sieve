// @ts-check
// job-status.test.js — the renderer package's job-liveness mirror. It has no
// endpoint to poll: the server pushes the whole snapshot when the workspace
// socket connects and on every change, and InvalidationService republishes that
// as `sieve:jobs-changed` with the snapshot as the event DETAIL — already an
// object, never a JSON string.
import { describe, it, expect } from 'vitest'
import { isJobActive, isJobQueued, isJobStale } from '../src/static/renderers/job-status.js'

/** @param {object} snapshot */
function push(snapshot) {
  document.dispatchEvent(new CustomEvent('sieve:jobs-changed', { detail: snapshot }))
}

describe('job-status tracker', () => {
  it('mirrors a pushed snapshot into the active and queued sets', () => {
    push({ active: [{ jobId: 'a1' }], queued: [{ jobId: 'q1' }] })
    expect(isJobActive('a1')).toBe(true)
    expect(isJobQueued('q1')).toBe(true)
    expect(isJobActive('q1')).toBe(false)
    expect(isJobQueued('a1')).toBe(false)
  })

  it('REPLACES both sets on every push — a job absent from the snapshot is gone', () => {
    push({ active: [{ jobId: 'a1' }], queued: [{ jobId: 'q1' }] })
    push({ active: [], queued: [] })
    expect(isJobActive('a1')).toBe(false)
    expect(isJobQueued('q1')).toBe(false)
  })

  it('survives a snapshot with a list missing rather than treating it as a crash', () => {
    push({ active: [{ jobId: 'a1' }] })
    expect(isJobActive('a1')).toBe(true)
    expect(isJobQueued('a1')).toBe(false)
  })

  it('a QUEUED job is never stale, however old — it is waiting on a bounded pool', () => {
    push({ active: [], queued: [{ jobId: 'q1' }] })
    const ancient = new Date(Date.now() - 1000 * 60 * 60).toISOString()
    expect(isJobStale(ancient, 'q1')).toBe(false)
    expect(isJobStale(ancient, 'unknown')).toBe(true)
  })
})
