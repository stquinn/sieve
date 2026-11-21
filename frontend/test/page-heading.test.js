// @ts-check
import { describe, expect, it } from 'vitest'
import { PageHeading } from '../src/static/renderers/page-heading.js'

const DIARY = Object.freeze({ type: ['diary'], period: ['2026-11'] })

describe('PageHeading.textOf', () => {
  it.each([
    ['a diary page named by a date', DIARY, '2026-11-21', 'Saturday 21 November 2026'],
    ['a day with no leading zero', DIARY, '2027-01-01', 'Friday 1 January 2027'],
    ['a leap day', DIARY, '2028-02-29', 'Tuesday 29 February 2028'],
    ['a diary page named by no date', DIARY, 'Kitchen', ''],
    ['a day not in its month', DIARY, '2026-02-30', ''],
    ['a date not in the strict form', DIARY, '2026-11-2', ''],
    ['a date with space round it', DIARY, ' 2026-11-21', ''],
    ['an unnamed diary page', DIARY, undefined, ''],
    ['a notebook page named by a date', {}, '2026-11-21', ''],
    ['a note with no properties', undefined, '2026-11-21', ''],
    ['a note of two types', { type: ['diary', 'other'] }, '2026-11-21', ''],
    ['a note of another type', { type: ['journal'] }, '2026-11-21', ''],
  ])('heads %s', (_, properties, name, want) => {
    expect(PageHeading.textOf(properties, name)).toBe(want)
  })
})

describe('PageHeading.at', () => {
  it.each([
    ['ruled with a margin', { id: 'ruled', params: { spacing: 0.05, margin: 0.12 } }, 0.14, 0.04, 0.0275],
    ['ruled without a margin', { id: 'ruled', params: { spacing: 0.05 } }, 0.02, 0.04, 0.0275],
    ['narrow ruled with a margin', { id: 'ruled', params: { spacing: 0.038, margin: 0.12 } }, 0.14, 0.0304, 0.0209],
    ['ruled with margin 0', { id: 'ruled', params: { spacing: 0.05, margin: 0 } }, 0.02, 0.04, 0.0275],
    ['grid', { id: 'grid', params: { spacing: 0.04 } }, 0.02, 0.032, 0.022],
    ['dots', { id: 'dots', params: { spacing: 0.04 } }, 0.02, 0.032, 0.022],
    ['a margin on a template that is not ruled', { id: 'grid', params: { spacing: 0.04, margin: 0.12 } }, 0.02, 0.032, 0.022],
    ['blank', { id: 'blank' }, 0.02, 0.04, 0.0275],
    ['no template', null, 0.02, 0.04, 0.0275],
    ['zero spacing', { id: 'ruled', params: { spacing: 0, margin: 0.12 } }, 0.14, 0.04, 0.0275],
    ['an unknown template', { id: 'isometric', params: { spacing: 0.06 } }, 0.02, 0.048, 0.033],
  ])('places the heading of %s', (_, template, x, baseline, size) => {
    const heading = /** @type {PageHeading} */ (PageHeading.at(template, 'Saturday 21 November 2026'))
    expect(heading.text).toBe('Saturday 21 November 2026')
    expect([heading.x, heading.baseline, heading.size].map((n) => Number(n.toFixed(6)))).toEqual([x, baseline, size])
    expect(Object.isFrozen(heading)).toBe(true)
  })

  it('has no heading for no text', () => {
    expect(PageHeading.at({ id: 'ruled', params: { spacing: 0.05 } }, '')).toBeNull()
  })
})

describe('PageHeading.of', () => {
  const page = (/** @type {any} */ note, /** @type {any} */ pageOf) => /** @type {any} */ ({ note: { pageAspect: 0.8, ...note }, page: pageOf, strokes: [] })
  const RULED = Object.freeze({ id: 'ruled', params: { spacing: 0.05, margin: 0.12 } })

  it('heads an export page from its note\'s type, its name and its template', () => {
    const heading = PageHeading.of(page({ template: RULED, properties: DIARY }, { id: 'p', properties: { name: ['2026-11-21'] } }))
    expect(heading && [heading.text, Number(heading.x.toFixed(6))]).toEqual(['Saturday 21 November 2026', 0.14])
  })

  it.each([
    ['a page of two names', { template: RULED, properties: DIARY }, { id: 'p', properties: { name: ['2026-11-21', '2026-11-22'] } }],
    ['a page with no properties', { template: RULED, properties: DIARY }, { id: 'p' }],
    ['a fixture with no page', { template: RULED }, undefined],
  ])('has none for %s', (_, note, pageOf) => {
    expect(PageHeading.of(page(note, pageOf))).toBeNull()
  })
})
