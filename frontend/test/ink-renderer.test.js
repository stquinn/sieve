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
