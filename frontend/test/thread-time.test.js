// @ts-check
// thread-time.test.js — how a time reads in a thread: a message's label, read
// against a fixed now, and the label of the day separator a message falls
// under. Dates are local calendar times and the locale is fixed, so every label
// is what the platform writes for it.

import { describe, it, expect } from 'vitest'
import { ThreadTime } from '../src/static/renderers/thread-time.js'

const NOW = new Date(2026, 10, 28, 12, 0, 0)
const ago = (/** @type {number} */ ms) => new Date(NOW.getTime() - ms)
const SECOND = 1000
const MINUTE = 60 * SECOND

describe('ThreadTime — what a message says of its time', () => {
  const clock = new ThreadTime('en-GB')

  it.each([
    ['just now', ago(0), ThreadTime.RECENT],
    ['a moment ahead of now', new Date(NOW.getTime() + 5 * SECOND), ThreadTime.RECENT],
    ['59 seconds old', ago(59 * SECOND), ThreadTime.RECENT],
    ['1 minute old', ago(MINUTE), '1 minute ago'],
    ['1 minute 59 seconds old', ago(MINUTE + 59 * SECOND), '1 minute ago'],
    ['2 minutes old', ago(2 * MINUTE), '2 minutes ago'],
    ['5 minutes old', ago(5 * MINUTE), '5 minutes ago'],
    ['5 minutes 1 second old', ago(5 * MINUTE + SECOND), '11:54'],
    ['earlier today', new Date(2026, 10, 28, 9, 5), '09:05'],
    ['yesterday', new Date(2026, 10, 27, 23, 59), '23:59'],
    ['last year', new Date(2025, 10, 28, 8, 30), '08:30'],
  ])('%s', (_name, at, said) => {
    expect(clock.ofMessage(at, NOW)).toBe(said)
  })

  it('never says a date: a message on another day says only its time of day', () => {
    expect(clock.ofMessage(new Date(2026, 10, 22, 14, 7), NOW)).not.toMatch(/November|Sunday|22/)
  })
})

describe('ThreadTime — what a day separator says', () => {
  const clock = new ThreadTime('en-GB')

  it.each([
    ['today, just now', ago(0), ThreadTime.TODAY],
    ['today, just after midnight', new Date(2026, 10, 28, 0, 0, 1), ThreadTime.TODAY],
    ['yesterday, just before midnight', new Date(2026, 10, 27, 23, 59, 59), ThreadTime.YESTERDAY],
    ['yesterday morning', new Date(2026, 10, 27, 6, 0), ThreadTime.YESTERDAY],
    ['two days ago', new Date(2026, 10, 26, 12, 0), 'Thursday 26 November'],
    ['six days ago', new Date(2026, 10, 22, 12, 0), 'Sunday 22 November'],
    ['last year', new Date(2025, 10, 28, 12, 0), 'Friday, 28 November 2025'],
  ])('%s', (_name, at, said) => {
    expect(clock.ofDay(at, NOW)).toBe(said)
  })

  it('reads Yesterday across a month\'s end', () => {
    expect(clock.ofDay(new Date(2026, 10, 30, 22, 0), new Date(2026, 11, 1, 9, 0))).toBe(ThreadTime.YESTERDAY)
  })

  it.each([
    ['a question and its answer either side of midnight fall on two days', new Date(2026, 10, 27, 23, 59, 30), new Date(2026, 10, 28, 0, 0, 20), false],
    ['two times of one day fall on one', new Date(2026, 10, 28, 0, 0, 0), new Date(2026, 10, 28, 23, 59, 59), true],
  ])('%s', (_name, a, b, same) => {
    expect(clock.dayOf(a) === clock.dayOf(b)).toBe(same)
  })
})

describe('ThreadTime.parse', () => {
  it.each([
    ['an ISO timestamp', '2026-11-27T13:58:00Z', new Date('2026-11-27T13:58:00Z').getTime()],
    ['nothing', '', null],
    ['no time at all', 'soon', null],
    ['an absent attr', undefined, null],
  ])('reads %s', (_name, value, time) => {
    const at = ThreadTime.parse(value)
    expect(at ? at.getTime() : null).toBe(time)
  })
})
