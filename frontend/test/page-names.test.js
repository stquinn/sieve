// @ts-check
import { describe, expect, it, vi } from 'vitest'
import { PageNames } from '../src/static/renderers/page-names.js'

/** Friday 20 November 2026, mid-afternoon local time. */
const TODAY = new Date(2026, 10, 20, 15, 30)

/** @param {...(string|undefined)} names @returns {{name?: string}[]} */
const pagesNamed = (...names) => names.map((name) => (name === undefined ? {} : { name }))

describe('PageNames', () => {
  const names = new PageNames(() => TODAY)

  it.each([
    ['an unnamed page', pagesNamed(undefined, undefined), 1, 'Page 2', '2 / 2', 'Page 2 of 2'],
    ['a blank name', pagesNamed('  ', undefined), 0, 'Page 1', '1 / 2', 'Page 1 of 2'],
    ['a name that is no date', pagesNamed(undefined, 'Kitchen'), 1, 'Kitchen', 'Kitchen · 1 / 1', 'Kitchen · 1 / 1'],
    ["today's date", pagesNamed('2026-11-20'), 0, 'Today', 'Today · 1 / 1', 'Today · 1 / 1'],
    ["yesterday's date", pagesNamed('2026-11-19'), 0, 'Yesterday', 'Yesterday · 1 / 1', 'Yesterday · 1 / 1'],
    ["tomorrow's date", pagesNamed('2026-11-21'), 0, 'Tomorrow', 'Tomorrow · 1 / 1', 'Tomorrow · 1 / 1'],
    ['a date of this year', pagesNamed('2026-11-13'), 0, 'Fri 13 Nov', 'Fri 13 Nov · 1 / 1', 'Fri 13 Nov · 1 / 1'],
    ['a date of last year', pagesNamed('2025-11-20'), 0, 'Thu 20 Nov 2025', 'Thu 20 Nov 2025 · 1 / 1', 'Thu 20 Nov 2025 · 1 / 1'],
    ['a date across the new year', pagesNamed('2027-01-01'), 0, 'Fri 1 Jan 2027', 'Fri 1 Jan 2027 · 1 / 1', 'Fri 1 Jan 2027 · 1 / 1'],
    ['a day that is not in its month', pagesNamed('2026-02-30'), 0, '2026-02-30', '2026-02-30 · 1 / 1', '2026-02-30 · 1 / 1'],
    ['a date not in the strict form', pagesNamed('2026-11-2'), 0, '2026-11-2', '2026-11-2 · 1 / 1', '2026-11-2 · 1 / 1'],
    ['the second of a day of three', pagesNamed('2026-11-13', '2026-11-13', '2026-11-13'), 1, 'Fri 13 Nov · 2 / 3', 'Fri 13 Nov · 2 / 3', 'Fri 13 Nov · 2 / 3'],
  ])('calls %s', (_name, pages, index, listed, face, place) => {
    expect([names.listed(pages)[index], names.face(pages, index), names.place(pages, index)]).toEqual([listed, face, place])
  })

  it('counts a run only over adjacent pages of the same name', () => {
    const pages = pagesNamed('2026-11-19', '2026-11-20', '2026-11-20', undefined, '2026-11-20', 'Kitchen', 'Kitchen')
    expect(names.listed(pages)).toEqual(['Yesterday', 'Today · 1 / 2', 'Today · 2 / 2', 'Page 4', 'Today', 'Kitchen · 1 / 2', 'Kitchen · 2 / 2'])
    expect([2, 3, 4].map((i) => names.face(pages, i))).toEqual(['Today · 2 / 2', '4 / 7', 'Today · 1 / 1'])
  })

  it('reads the clock each time a date is labelled, and only then', () => {
    const clock = vi.fn(() => TODAY)
    const counted = new PageNames(clock)
    const pages = pagesNamed('2026-11-20', 'Kitchen')
    expect(counted.listed(pagesNamed('Kitchen', undefined))).toEqual(['Kitchen', 'Page 2'])
    expect(counted.face(pages, 1)).toBe('Kitchen · 1 / 1')
    expect(clock).not.toHaveBeenCalled()
    expect(counted.face(pages, 0)).toBe('Today · 1 / 1')
    clock.mockReturnValue(new Date(2026, 10, 21, 0, 5))
    expect(counted.face(pages, 0)).toBe('Yesterday · 1 / 1')
    expect(clock).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['2026-11-21', { year: 2026, month: 10, day: 21 }],
    ['2028-02-29', { year: 2028, month: 1, day: 29 }],
    ['2026-02-30', null],
    ['2026-11-2', null],
    [' 2026-11-21', null],
    ['Kitchen', null],
  ])('reads %j as a calendar date', (name, want) => {
    expect(PageNames.dateOf(name)).toEqual(want)
  })

  it.each([
    ["a diary with pages of today's date", true, pagesNamed('2026-11-19', '2026-11-20', '2026-11-20', '2026-11-21'), 2],
    ['a diary with no page of today', true, pagesNamed('2026-11-18', '2026-11-19', undefined), 2],
    ['a diary of no pages', true, [], -1],
    ['an ordinary note', false, pagesNamed('Kitchen', undefined), 0],
    ['an ordinary note whose pages are named by dates', false, pagesNamed('2026-11-19', '2026-11-20'), 0],
    ['an ordinary note of no pages', false, [], -1],
  ])('starts a reader of %s at the page it starts at', (_name, diary, pages, want) => {
    expect(names.startOf(pages, diary)).toBe(want)
  })

  it('reads the clock when a diary is started, and only then', () => {
    const clock = vi.fn(() => TODAY)
    const counted = new PageNames(clock)
    const pages = pagesNamed('2026-11-20', '2026-11-21')
    expect(counted.startOf(pages, false)).toBe(0)
    expect(clock).not.toHaveBeenCalled()
    expect(counted.startOf(pages, true)).toBe(0)
    clock.mockReturnValue(new Date(2026, 10, 21, 0, 5))
    expect(counted.startOf(pages, true)).toBe(1)
    expect(clock).toHaveBeenCalledTimes(2)
  })

  it('places a note of no pages at 0 / 0', () => {
    expect([names.listed([]), names.face([], -1)]).toEqual([[], '0 / 0'])
  })
})
