// @ts-check
// InkRenderer against the ink conformance set (docs/ink-contract.md
// §Conformance): each fixture page renders to the SVG committed beside it, byte
// for byte. Regenerate those with `npx vitest run test/ink-renderer.test.js -u`
// only for a deliberate contract change.
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { getStroke } from 'perfect-freehand'
import { InkRenderer, INK_RULES } from '../src/static/renderers/ink-renderer.js'

const ASSETS = path.resolve(process.cwd(), '../docs/design/specs/assets')
const FIXTURES = Object.freeze([
  '2026-10-31-boox-test-page',
  '2026-11-02-live-page',
  '2026-11-02-width-tilt-pressure-ladder',
])
const PX = 1 / INK_RULES.grid

/** @param {string} fixture @returns {import('../src/static/renderers/ink-renderer.js').InkPage} */
const loadPage = (fixture) => JSON.parse(readFileSync(path.join(ASSETS, fixture, 'boox-page-strokes.json'), 'utf8'))

const renderer = new InkRenderer({ getStroke })

const AIR2_ASPECT = 0.8292971
const PAGE = Object.freeze({ x0: 0, y0: 0, x1: 1, y1: 1 / AIR2_ASPECT })

/**
 * The marks of a `ruling` group, read back from its markup.
 * @param {string} group
 * @returns {{h: number[], v: number[], dots: number[][], flagged: boolean, paths: number}}
 */
const marksOf = (group) => ({
  h: [...group.matchAll(/M-?[\d.]+ (-?[\d.]+)h[\d.]+v1h-/g)].map((m) => Number(m[1])),
  v: [...group.matchAll(/M(-?[\d.]+) -?[\d.]+v[\d.]+h1v-/g)].map((m) => Number(m[1])),
  dots: [...group.matchAll(/M(-?\d+) (-?\d+)m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0z/g)].map((m) => [Number(m[1]), Number(m[2])]),
  flagged: group.includes('data-ink-template="unknown"'),
  paths: (group.match(/<path /g) ?? []).length,
})

describe('InkRenderer renders the conformance set', () => {
  it.each(FIXTURES)('%s matches its committed SVG', async (fixture) => {
    await expect(renderer.renderPage(loadPage(fixture)))
      .toMatchFileSnapshot(path.join(ASSETS, fixture, 'boox-page-strokes.svg'))
  })

  it.each(FIXTURES)('%s renders the same bytes from a fresh renderer', (fixture) => {
    const page = loadPage(fixture)
    expect(new InkRenderer({ getStroke }).renderPage(page)).toBe(renderer.renderPage(page))
  })
})

describe('InkRenderer.widthFor', () => {
  // Widths measured on the ladder fixture's tablet PNG (its README), in pixels
  // at a 1404-pixel page; the rule must land within a pixel of each.
  it.each([
    ['pen', 1, 0.95, 5.5],
    ['pen', 2, 0.95, 6.5],
    ['pen', 3, 0.95, 9.0],
    ['pencil', 1, 0.98, 6.0],
    ['pencil', 2, 0.98, 8.0],
    ['pencil', 3, 0.98, 11.0],
    ['pencil', 2, 0.23, 2.0],
    ['pencil', 2, 0.50, 6.0],
    ['pencil', 2, 0.83, 8.0],
    ['pencil', 2, 0.97, 8.0],
  ])('%s class %i at p=%f is %fpx wide', (tool, widthClass, pressure, px) => {
    expect(Math.abs(renderer.widthFor(/** @type {any} */ (tool), widthClass, pressure) - px * PX)).toBeLessThan(PX)
  })

  // The rules themselves: affine in the nominal class width, pencil saturating at p=0.8.
  it.each([
    ['pen', 0.95, 0.76],
    ['pencil', 0.8, 1.09],
    ['pencil', 1, 1.09],
  ])('%s at p=%f is 4.2px + %f x nominal', (tool, pressure, slope) => {
    for (const widthClass of /** @type {const} */ ([1, 2, 3])) {
      expect(renderer.widthFor(/** @type {any} */ (tool), widthClass, pressure))
        .toBeCloseTo(4.2 * PX + slope * INK_RULES.nominal[widthClass], 5)
    }
  })

  it.each([
    ['marker', 2],
    ['pen', 4],
  ])('rejects tool %s class %i', (tool, widthClass) => {
    expect(() => renderer.widthFor(/** @type {any} */ (tool), widthClass, 0.5)).toThrow(/ink: unknown/)
  })
})

describe('InkRenderer.renderLiveStroke', () => {
  const page = loadPage('2026-10-31-boox-test-page')
  const svg = renderer.renderPage(page)
  const pen = page.strokes.find((s) => s.tool === 'pen')
  const pencil = page.strokes.find((s) => s.tool === 'pencil')
  if (!pen || !pencil) throw new Error('fixture needs both tools')

  it('draws a pen stroke exactly as the page does', () => {
    const live = renderer.renderLiveStroke(pen)
    expect(live).toMatch(/^<path data-stroke=/)
    expect(svg).toContain(live)
  })

  it('draws a pencil stroke as the page chunk outlines, untoned', () => {
    const live = renderer.renderLiveStroke(pencil)
    const liveSubpaths = (/ d="([^"]*)"/.exec(live)?.[1] ?? '').split(/(?=M)/)
    const pageSubpaths = renderer.renderStroke(pencil).bands.join('')
      .match(/<path d="[^"]*"/g)?.map((p) => p.slice(9, -1)) ?? []
    expect(live).toContain(`fill="${INK_RULES.pencil.liveFill}"`)
    expect(liveSubpaths.length).toBeGreaterThan(1)
    expect([...liveSubpaths].sort()).toEqual([...pageSubpaths].sort())
    for (const part of renderer.renderStroke(pencil).bands) if (part) expect(svg).toContain(part)
  })

  it('draws nothing from a single point', () => {
    expect(renderer.renderLiveStroke({ ...pencil, points: pencil.points.slice(0, 1) })).toBe('')
  })
})

describe('InkRenderer.renderRuling', () => {
  const ruling = (/** @type {any} */ template, /** @type {any} */ window = PAGE) => marksOf(renderer.renderRuling(template, window))

  // The contract's presets on a fixed Note Air 2 page (1404 x 1693 grid units).
  it.each([
    ['ruled', { spacing: 0.05, margin: 0.12 }, { h: [25, 0, 1685], v: [168] }],
    ['ruled', { spacing: 0.05 }, { h: [25, 0, 1685], v: [] }],
    ['ruled', { spacing: 0.038, margin: 0.12 }, { h: [32, 0, 1654], v: [168] }],
    ['ruled', { spacing: 0.038 }, { h: [32, 0, 1654], v: [] }],
    ['grid', { spacing: 0.04 }, { h: [31, 0, 1685], v: [0, 1348], vCount: 25 }],
  ])('%s %j draws its lines', (id, params, want) => {
    const m = ruling({ id, params })
    expect([m.h.length, m.h[0], m.h[m.h.length - 1]]).toEqual(want.h)
    expect(m.v.length).toBe(want.vCount ?? want.v.length)
    expect(want.v.every((x) => m.v.includes(x))).toBe(true)
    expect(m.dots).toEqual([])
    expect(m.flagged).toBe(false)
  })

  it('draws dots at every crossing of a dots template', () => {
    const m = ruling({ id: 'dots', params: { spacing: 0.04 } })
    expect(m.dots.length).toBe(26 * 31)
    expect(m.dots[0]).toEqual([0, 0])
    expect(m.dots[m.dots.length - 1]).toEqual([1404, 1685])
    expect([m.h, m.v]).toEqual([[], []])
    expect(m.paths).toBe(1)
  })

  it('paints the ruling first after the background, in the mark colour', () => {
    const group = renderer.renderRuling({ id: 'ruled', params: { spacing: 0.05 } }, PAGE)
    expect(group.startsWith('<g data-ink="ruling" fill="#888888">')).toBe(true)
    const svg = renderer.renderPage({ note: { pageAspect: AIR2_ASPECT, template: { id: 'ruled', params: { spacing: 0.05 } } }, strokes: [] })
    const lines = svg.split('\n')
    expect(lines[2]).toMatch(/^<rect /)
    expect(lines[3]).toBe(group.split('\n')[0])
    expect(svg).toContain(group)
    expect(svg.indexOf('data-ink="ruling"')).toBeLessThan(svg.indexOf('data-ink="pen"'))
  })

  it.each([
    ['blank', { id: 'blank' }],
    ['no template', null],
    ['no spacing', { id: 'grid', params: {} }],
    ['no params', { id: 'ruled' }],
    ['zero spacing', { id: 'dots', params: { spacing: 0 } }],
    ['zero spacing with margin', { id: 'ruled', params: { spacing: 0, margin: 0.12 } }],
  ])('%s draws an empty group, unflagged', (_, template) => {
    const group = renderer.renderRuling(template, PAGE)
    expect(group).toBe('<g data-ink="ruling" fill="#888888"></g>')
  })

  it('treats margin 0 like an absent margin', () => {
    expect(ruling({ id: 'ruled', params: { spacing: 0.05, margin: 0 } }).v).toEqual([])
  })

  it('draws an unknown id as blank and flags the group', () => {
    const group = renderer.renderRuling({ id: 'isometric', params: { spacing: 0.05 } }, PAGE)
    expect(marksOf(group)).toMatchObject({ h: [], v: [], dots: [], flagged: true })
    expect(group).toBe('<g data-ink="ruling" fill="#888888" data-ink-template="unknown"></g>')
  })

  it('rounds each mark position, not the spacing', () => {
    // 0.05 is 70.2 grid units: accumulated rounding of 70 would give 210, not 211.
    expect(ruling({ id: 'ruled', params: { spacing: 0.05 } }, { x0: 0, y0: 0, x1: 1, y1: 0.2 }).h).toEqual([0, 70, 140, 211])
  })

  it('tiles an unbounded plane on its own origin into negative coordinates', () => {
    const m = ruling({ id: 'ruled', params: { spacing: 0.05, margin: 0.12 } }, { x0: -1.5, y0: -0.3, x1: 0.5, y1: 0.3 })
    expect(m.h.length).toBe(13)
    expect([m.h[0], m.h[6], m.h[12]]).toEqual([-421, 0, 421])
    expect(m.v).toEqual([-1236, 168])
  })

  it('clips lines to the window', () => {
    const group = renderer.renderRuling({ id: 'ruled', params: { spacing: 0.5 } }, { x0: -1.5, y0: 0, x1: 0.5, y1: 1 })
    expect(group).toContain('M-2106 0h2808v1h-2808z')
  })

  it.each([
    ['grid', { spacing: 0.04 }],
    ['ruled', { spacing: 0.05, margin: 0.12 }],
    ['dots', { spacing: 0.04 }],
  ])('%s marks are identical in the overlap of two windows', (id, params) => {
    const template = { id, params }
    const wide = ruling(template, { x0: -1, y0: -1, x1: 1, y1: 1 })
    const narrow = ruling(template, { x0: -0.5, y0: -0.5, x1: 0.5, y1: 0.5 })
    const g = INK_RULES.grid
    const inside = (/** @type {number} */ c) => c >= -0.5 * g && c < 0.5 * g
    expect(narrow.h.length + narrow.v.length + narrow.dots.length).toBeGreaterThan(0)
    expect(wide.h.filter(inside)).toEqual(narrow.h)
    expect(wide.v.filter(inside)).toEqual(narrow.v)
    expect(wide.dots.filter(([x, y]) => inside(x) && inside(y))).toEqual(narrow.dots)
  })

  it('counts a mark touching the window only when it overlaps its interior', () => {
    const at = (/** @type {number} */ y0, /** @type {number} */ y1) =>
      ruling({ id: 'ruled', params: { spacing: 0.5 } }, { x0: 0, y0, x1: 1, y1 }).h
    expect(at(0, 0.5)).toEqual([0])
    expect(at(0.5, 1)).toEqual([702])
    expect(at(0, 0.5001)).toEqual([0, 702])
  })
})
