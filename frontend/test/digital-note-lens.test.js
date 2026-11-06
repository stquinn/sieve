// @ts-check
// DigitalNoteLens — a Digital Note's pages drawn by the real InkRenderer over a
// fake InkContainerProvider, so what is pinned is what reaches the mounted SVG:
// a page as it is answered, every committed stroke added to and trimmed from
// that same SVG, the stroke under the pen drawn once a frame and handed over to
// its committed markup, and a whiteboard's window moved by the reader without
// the page being drawn again — and never by the tablet.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getStroke } from 'perfect-freehand'
import { DigitalNoteLens } from '../src/static/lens/ink/digital-note-lens.js'
import { PageSurface } from '../src/static/lens/ink/page-surface.js'
import { ReadingSurface } from '../src/static/lens/ink/reading-surface.js'
import { SurfaceIntent } from '../src/static/lens/abstract-surface.js'
import { ActionStatus } from '../src/static/lens/ink/action-status.js'
import { ImageClipboard } from '../src/static/renderers/copy-image.js'
import { InkFeed, InkOpening, InkReadingState, InkRefusal } from '../src/static/contract/ink-container-provider.js'
import {
  ASPECT, DOTS, FakeInkProvider, Frames, GRID, Resizes, UUID, begin, drag, expectWindow, exportPage, key, layOut, layer, mark, noteAttrs, pen, pencil, points, press, renderer, settle, shownWindow, strokeEls, svgOf, tabletWindow, view, viewBoxOf, wheel,
  copiedImages, reading, READ_BLOCKS,
} from './helpers/ink-lens-rig.js'

/**
 * A lens presented over a note of pages `ids`, each answered with `strokes` at seq 10.
 * @param {{ids?: string[], strokes?: any[], bounds?: string, template?: any}} [opts]
 */
async function presented(opts = {}) {
  const ids = opts.ids || ['p1', 'p2']
  const provider = new FakeInkProvider(noteAttrs(ids, opts.bounds))
  for (const id of ids) provider.answers.set(id, { page: exportPage(opts.strokes || [pen('s1')], opts.template), seq: 10 })
  const lens = new DigitalNoteLens(UUID, { provider })
  const root = document.createElement('div')
  document.body.appendChild(root)
  await lens.presentMode('wysiwyg', root)
  await settle()
  return { provider, lens, root, surface: /** @type {PageSurface} */ (lens.surface) }
}

/** @param {HTMLElement} root */
const position = (root) => root.querySelector('.ink-page__position')?.textContent
/** @param {HTMLElement} root */
const openLive = (root) => /** @type {HTMLButtonElement} */ (root.querySelector('[data-ink-action="open-live"]'))
/** @param {HTMLElement} root @param {string} pageId */
const dot = (root, pageId) => /** @type {HTMLElement} */ (root.querySelector(`[data-ink-page="${pageId}"]`))

/** The reader's surround, and so a whiteboard's window, is twice as wide as it is high. */
const SURROUND = Object.freeze({ width: 1000, height: 500 })

/** A whiteboard of these strokes, laid out filling the surround at (100, 50). @param {any[]} [strokes] */
async function whiteboard(strokes = [pen('a', 0.2, 0.2), pen('b', 2.4, 1.6)]) {
  const shown = await presented({ ids: ['w1'], bounds: 'unbounded', strokes, template: DOTS })
  layOut(shown.root, SURROUND)
  return shown
}


/** @param {HTMLElement} root @returns {string[]} the edges whose mark shows */
const edgeMarks = (root) => [...root.querySelectorAll('.ink-page__edge')].filter((el) => !(/** @type {HTMLElement} */ (el)).hidden).map((el) => String(el.getAttribute('data-ink-edge')))

describe('DigitalNoteLens', () => {
  /** @type {Frames} */ let frames
  /** @type {Resizes} */ let resizes
  beforeEach(() => {
    Object.assign(/** @type {any} */ (globalThis).TipTap, { getStroke })
    frames = new Frames()
    frames.install()
    resizes = new Resizes()
    resizes.install()
    resizes.size = [SURROUND.width, SURROUND.height]
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    document.body.innerHTML = ''
  })

  it("shows the block's first page as it is answered, hearing the feed before asking for it", async () => {
    const { provider, root, lens } = await presented()
    expect(lens.mode).toBe(PageSurface.MODE)
    expect(provider.calls.slice(0, 3)).toEqual(['subscribeFeed', 'subscribe', 'loadPage p1'])
    expect(position(root)).toBe('1 / 2')
    expect(root.querySelector('.ink-page__title')?.textContent).toBe('Ideas')
    expect(root.querySelector('.ink-page__device')?.textContent).toBe('Note Air 2')
    expect(strokeEls(root, 's1')).toHaveLength(1)
    expect(layer(root, 'ruling').children.length).toBeGreaterThan(0)
    expect(/** @type {HTMLElement} */ (root.querySelector('.ink-page__notice')).hidden).toBe(true)
  })

  it.each([
    ['a pen stroke', pen('s2', 0.5, 0.5)],
    ['a pencil stroke, in each band it touches', pencil('s2')],
  ])('adds %s above the held seq into the same SVG', async (_name, stroke) => {
    const { provider, root } = await presented()
    const svg = svgOf(root)
    const existing = strokeEls(root, 's1')[0]
    provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'p1', seq: 11, stroke })
    const markup = renderer.renderStroke(/** @type {any} */ (stroke))
    expect(svgOf(root)).toBe(svg)
    expect(strokeEls(root, 's1')[0]).toBe(existing)
    expect(strokeEls(layer(root, 'pen'), 's2')).toHaveLength(markup.pen ? 1 : 0)
    markup.bands.forEach((part, i) => expect(strokeEls(layer(root, `b${i}`), 's2')).toHaveLength(part ? 1 : 0))
    if (stroke.tool === 'pencil') expect(markup.bands.filter(Boolean).length).toBeGreaterThan(1)
  })

  it.each([
    ['at the held seq', 10],
    ['below it', 7],
  ])('drops a stroke event %s', async (_name, seq) => {
    const { provider, root } = await presented()
    provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'p1', seq, stroke: pen('s2') })
    provider.emit({ type: InkFeed.STROKE_REMOVED, pageId: 'p1', seq, strokeId: 's1' })
    expect(strokeEls(root, 's2')).toHaveLength(0)
    expect(strokeEls(root, 's1')).toHaveLength(1)
  })

  it("removes every element of a removed stroke, a pencil stroke's in every band", async () => {
    const { provider, root } = await presented({ strokes: [pencil('s1'), pen('s9')] })
    expect(strokeEls(root, 's1').length).toBeGreaterThan(1)
    provider.emit({ type: InkFeed.STROKE_REMOVED, pageId: 'p1', seq: 11, strokeId: 's1' })
    expect(strokeEls(root, 's1')).toHaveLength(0)
    expect(strokeEls(root, 's9')).toHaveLength(1)
  })

  it('applies the stroke events heard while a page loads above the seq it is answered at', async () => {
    const provider = new FakeInkProvider(noteAttrs(['p1']))
    provider.defer = true
    const lens = new DigitalNoteLens(UUID, { provider })
    const root = document.createElement('div')
    await lens.presentMode('page', root)
    provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'p1', seq: 3, stroke: pen('early') })
    provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'p1', seq: 5, stroke: pen('late') })
    provider.waiting[0].resolve({ page: exportPage([pen('s1')]), seq: 4 })
    await settle()
    expect(strokeEls(root, 'early')).toHaveLength(0)
    expect(strokeEls(root, 'late')).toHaveLength(1)
  })

  it('marks a page with ink not seen, and showing it clears the mark', async () => {
    const { provider, root } = await presented()
    provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'p2', seq: 11, stroke: pen('s2') })
    expect(dot(root, 'p2').hasAttribute('data-unseen')).toBe(true)
    expect(dot(root, 'p1').hasAttribute('data-unseen')).toBe(false)
    expect(strokeEls(root, 's2')).toHaveLength(0)
    dot(root, 'p2').click()
    await settle()
    expect(position(root)).toBe('2 / 2')
    expect(dot(root, 'p2').hasAttribute('data-unseen')).toBe(false)
  })

  it('draws the stroke under the pen in the live layer, once a frame', async () => {
    const { provider, root } = await presented()
    provider.emit({ type: InkFeed.LIVE_PAGE, live: true, pageId: 'p1', view: 'live-view' })
    provider.emit({ type: InkFeed.LIVE, records: [begin(7), ...points(7, 0, 4)] })
    provider.emit({ type: InkFeed.LIVE, records: points(7, 4, 4) })
    provider.emit({ type: InkFeed.LIVE, records: points(7, 8, 4) })
    expect(frames.queued.size).toBe(1)
    expect(layer(root, 'live').children).toHaveLength(0)
    frames.run()
    expect(layer(root, 'live').children).toHaveLength(1)
    const first = layer(root, 'live').firstElementChild
    provider.emit({ type: InkFeed.LIVE, records: points(7, 12, 4) })
    frames.run()
    expect(layer(root, 'live').children).toHaveLength(1)
    expect(layer(root, 'live').firstElementChild).not.toBe(first)
    expect(layer(root, 'live').firstElementChild?.getAttribute('d')).not.toBe(first?.getAttribute('d'))
  })

  it('keeps an ended live stroke until its committed stroke is drawn, and then only that', async () => {
    const { provider, root } = await presented()
    provider.emit({ type: InkFeed.LIVE_PAGE, live: true, pageId: 'p1', view: 'live-view' })
    provider.emit({ type: InkFeed.LIVE, records: [begin(7), ...points(7, 0, 12), mark('end', 7)] })
    frames.run()
    expect(layer(root, 'live').children).toHaveLength(1)
    provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'p1', seq: 11, stroke: pen('s7', 0.5, 0.4) })
    expect(layer(root, 'live').children).toHaveLength(0)
    expect(strokeEls(root, 's7')).toHaveLength(1)
  })

  it('takes an ended live stroke no committed stroke claims away after a while', async () => {
    const { provider, root } = await presented()
    vi.useFakeTimers()
    provider.emit({ type: InkFeed.LIVE_PAGE, live: true, pageId: 'p1', view: 'live-view' })
    provider.emit({ type: InkFeed.LIVE, records: [begin(7, 'pencil'), ...points(7, 0, 12), mark('end', 7)] })
    frames.run()
    provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'p1', seq: 11, stroke: pen('s7') })
    expect(layer(root, 'live').children).toHaveLength(1)
    vi.advanceTimersByTime(3000)
    expect(layer(root, 'live').children).toHaveLength(0)
  })

  it('drops a live stroke the tablet abandons', async () => {
    const { provider, root } = await presented()
    provider.emit({ type: InkFeed.LIVE_PAGE, live: true, pageId: 'p1', view: 'live-view' })
    provider.emit({ type: InkFeed.LIVE, records: [begin(7), ...points(7, 0, 12)] })
    frames.run()
    provider.emit({ type: InkFeed.LIVE, records: [mark('remove', 7)] })
    expect(layer(root, 'live').children).toHaveLength(0)
  })

  it('draws no live records while the page shown is not the live page', async () => {
    const { provider, root, surface } = await presented()
    provider.emit({ type: InkFeed.LIVE_PAGE, live: true, pageId: 'p1', view: 'live-view' })
    surface.turn(1)
    await settle()
    provider.emit({ type: InkFeed.LIVE, records: [begin(7), ...points(7, 0, 12)] })
    expect(frames.queued.size).toBe(0)
    expect(layer(root, 'live').children).toHaveLength(0)
  })

  it('never moves the reader off the page shown, marks the live page while it is written, and offers the Live view', async () => {
    const { provider, root, surface, lens } = await presented()
    /** @type {any[]} */
    const intents = []
    lens.onEvent((e) => { if (e.type === 'open-container') intents.push(e) })
    expect(openLive(root).hidden).toBe(true)
    provider.emit({ type: InkFeed.LIVE_PAGE, live: true, pageId: 'p2', view: 'live-view' })
    provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'p2', seq: 11, stroke: pen('s2') })
    await settle()
    expect([surface.shownPage, position(root), provider.loads, dot(root, 'p2').hasAttribute('data-unseen')]).toEqual(['p1', '1 / 2', 1, true])
    expect(openLive(root).hidden).toBe(false)
    openLive(root).click()
    expect(intents).toEqual([{ type: 'open-container', uuid: 'live-view' }])

    surface.turn(1)
    await settle()
    provider.emit({ type: InkFeed.LIVE, records: [begin(7), ...points(7, 0, 4)] })
    frames.run()
    expect([surface.shownPage, layer(root, 'live').children.length]).toEqual(['p2', 1])
    provider.emit({ type: InkFeed.LIVE_PAGE, live: true, pageId: 'p1', view: 'live-view' })
    await settle()
    expect([surface.shownPage, provider.loads]).toEqual(['p2', 2])

    provider.emit({ type: InkFeed.LIVE_PAGE, live: false, pageId: null, view: null })
    expect(openLive(root).hidden).toBe(true)
    openLive(root).click()
    expect(intents).toHaveLength(1)
  })

  it('reloads the shown page when the log restarts, and holds the new seq', async () => {
    const { provider, root } = await presented()
    provider.answers.set('p1', { page: exportPage([pen('n1')]), seq: 2 })
    provider.emit({ type: InkFeed.LOG_RESTARTED })
    await settle()
    expect(provider.calls.filter((c) => c === 'loadPage p1')).toHaveLength(2)
    expect(strokeEls(root, 's1')).toHaveLength(0)
    provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'p1', seq: 3, stroke: pen('n2') })
    expect(strokeEls(root, 'n2')).toHaveLength(1)
  })

  it.each([
    ['a page added', ['p1', 'p2', 'p3'], '1 / 3', 1],
    ['the shown page removed', ['p2'], '1 / 1', 2],
  ])('follows the block when %s', async (_name, ids, shows, loads) => {
    const { provider, root } = await presented()
    provider.answers.set('p3', { page: exportPage([]), seq: 10 })
    provider.setAttrs(noteAttrs(ids))
    await settle()
    expect(position(root)).toBe(shows)
    expect(provider.loads).toBe(loads)
  })

  it('asks again for a page that could not be loaded when the block changes', async () => {
    const { provider, root } = await presented({ ids: ['p1'] })
    provider.answers.delete('p1')
    provider.emit({ type: InkFeed.LOG_RESTARTED })
    await settle()
    expect(root.querySelector('.ink-page__empty')?.textContent).toMatch(/could not be loaded/)
    provider.answers.set('p1', { page: exportPage([pen('n1')]), seq: 3 })
    provider.setAttrs(noteAttrs(['p1']))
    await settle()
    expect(strokeEls(root, 'n1')).toHaveLength(1)
    provider.setAttrs(noteAttrs(['p1']))
    await settle()
    expect(provider.loads).toBe(3)
  })

  it.each([
    ['all its ink, wherever it lies on the plane', [pen('a', -0.6, -0.4), pen('b', 1.4, 0.9)]],
    ['the sheet at the origin when it has none', []],
  ])('opens a whiteboard that is not live framing %s', async (_name, strokes) => {
    const { root } = await whiteboard(strokes)
    const w = shownWindow(root)
    expect((w.x1 - w.x0) / (w.y1 - w.y0)).toBeCloseTo(SURROUND.width / SURROUND.height, 3)
    if (!strokes.length) expectWindow(w, { x0: 0, y0: 0, x1: 1, y1: SURROUND.height / SURROUND.width })
    const points = strokes.flatMap((s) => s.points)
    for (const p of points) {
      expect(p.x).toBeGreaterThan(w.x0)
      expect(p.x).toBeLessThan(w.x1)
      expect(p.y).toBeGreaterThan(w.y0)
      expect(p.y).toBeLessThan(w.y1)
    }
    if (points.length) {
      const xs = points.map((p) => p.x)
      const ys = points.map((p) => p.y)
      const tight = (w.x1 - w.x0) - (Math.max(...xs) - Math.min(...xs)) <= 0.1001 || (w.y1 - w.y0) - (Math.max(...ys) - Math.min(...ys)) <= 0.1001
      expect(tight).toBe(true)
      expect(strokeEls(root, 'a')).toHaveLength(1)
    }
  })

  it.each([
    ['a VIEW', [view(-1.3, 2.17)]],
    ["a begin's origin", [begin(7, 'pen', -2, 0.5)]],
  ])("keeps the reader's window when the tablet moves its own, by %s", async (_name, records) => {
    const { provider, root } = await whiteboard()
    const before = svgOf(root).getAttribute('viewBox')
    provider.emit({ type: InkFeed.LIVE_PAGE, live: true, pageId: 'w1', view: 'live-view' })
    provider.emit({ type: InkFeed.LIVE, records })
    frames.run()
    expect(svgOf(root).getAttribute('viewBox')).toBe(before)
  })

  /** The plane point under a client point of the laid-out sheet. */
  const planeAt = (/** @type {HTMLElement} */ root, /** @type {number} */ cx, /** @type {number} */ cy) => {
    const w = shownWindow(root)
    return { x: w.x0 + (cx - 100) / SURROUND.width * (w.x1 - w.x0), y: w.y0 + (cy - 50) / SURROUND.height * (w.y1 - w.y0) }
  }

  it.each([
    ['dragging the sheet', (/** @type {HTMLElement} */ root) => drag(root, [[400, 400], [350, 380], [300, 350]]),
      (/** @type {any} */ before, /** @type {any} */ after) => {
        const u = (before.x1 - before.x0) / SURROUND.width
        expectWindow(after, { x0: before.x0 + 100 * u, y0: before.y0 + 50 * u, x1: before.x1 + 100 * u, y1: before.y1 + 50 * u })
      }],
    ['the wheel', (/** @type {HTMLElement} */ root) => expect(wheel(root, { deltaX: 30, deltaY: 120 }).defaultPrevented).toBe(true),
      (/** @type {any} */ before, /** @type {any} */ after) => {
        const u = (before.x1 - before.x0) / SURROUND.width
        expectWindow(after, { x0: before.x0 + 30 * u, y0: before.y0 + 120 * u, x1: before.x1 + 30 * u, y1: before.y1 + 120 * u })
      }],
    ['Ctrl and the wheel, about the pointer', (/** @type {HTMLElement} */ root) => wheel(root, { deltaY: -200, ctrlKey: true, clientX: 250, clientY: 300 }),
      (/** @type {any} */ before, /** @type {any} */ after, /** @type {HTMLElement} */ root) => {
        expect(after.x1 - after.x0).toBeCloseTo((before.x1 - before.x0) / Math.exp(0.4), 4)
        const p = planeAt(root, 250, 300)
        expect(p.x).toBeCloseTo(before.x0 + 150 / SURROUND.width * (before.x1 - before.x0), 3)
        expect(p.y).toBeCloseTo(before.y0 + 250 / SURROUND.height * (before.y1 - before.y0), 3)
      }],
    ['an arrow key', (/** @type {HTMLElement} */ root) => expect(key(root, 'ArrowRight').defaultPrevented).toBe(true),
      (/** @type {any} */ before, /** @type {any} */ after) => {
        const step = 0.1 * (before.x1 - before.x0)
        expectWindow(after, { ...before, x0: before.x0 + step, x1: before.x1 + step })
      }],
    ['the + key', (/** @type {HTMLElement} */ root) => expect(key(root, '+', { shiftKey: true }).defaultPrevented).toBe(true),
      (/** @type {any} */ before, /** @type {any} */ after) => {
        expect((before.x1 - before.x0) / (after.x1 - after.x0)).toBeCloseTo(1.25, 4)
        expect((after.x0 + after.x1) / 2).toBeCloseTo((before.x0 + before.x1) / 2, 4)
      }],
    ['the zoom out button, after two zooms in', (/** @type {HTMLElement} */ root) => { press(root, 'zoom-in'); press(root, 'zoom-in'); press(root, 'zoom-out') },
      (/** @type {any} */ before, /** @type {any} */ after) => {
        expect((before.x1 - before.x0) / (after.x1 - after.x0)).toBeCloseTo(1.25, 4)
        expect((after.y0 + after.y1) / 2).toBeCloseTo((before.y0 + before.y1) / 2, 4)
      }],
    ['the 100% button', (/** @type {HTMLElement} */ root) => press(root, 'actual'),
      (/** @type {any} */ before, /** @type {any} */ after) => {
        expect((after.x1 - after.x0) * GRID).toBeCloseTo(SURROUND.width, 1)
        expect((after.x0 + after.x1) / 2).toBeCloseTo((before.x0 + before.x1) / 2, 4)
      }],
    ['the fit all button', (/** @type {HTMLElement} */ root) => press(root, 'fit'),
      (/** @type {any} */ _before, /** @type {any} */ after) => {
        expect(after.x0).toBeLessThan(0.2)
        expect(after.x1).toBeGreaterThan(2.51)
      }],
  ])('%s moves the window, redrawing only the ruling, and the tablet does not move it back', async (_name, gesture, check) => {
    const { provider, root } = await whiteboard()
    provider.emit({ type: InkFeed.LIVE_PAGE, live: true, pageId: 'w1', view: 'live-view' })
    provider.emit({ type: InkFeed.LIVE, records: [view(2, 3)] })
    frames.run()
    const before = shownWindow(root)
    const svg = svgOf(root)
    const nodes = [...root.querySelectorAll('[data-stroke]')]
    const ruling = layer(root, 'ruling')
    gesture(root)
    frames.run()
    check(before, shownWindow(root), root)
    expect([svgOf(root), [...root.querySelectorAll('[data-stroke]')], layer(root, 'ruling')]).toEqual([svg, nodes, ruling])
    const moved = svgOf(root).getAttribute('viewBox')
    provider.emit({ type: InkFeed.LIVE, records: [view(-4, -4)] })
    frames.run()
    expect(svgOf(root).getAttribute('viewBox')).toBe(moved)
  })

  it('holds zoom between a quarter of a sheet and all the ink', async () => {
    const { root, surface } = await whiteboard([pen('a', -3, -2), pen('b', 4, 5)])
    const fit = shownWindow(root)
    for (let i = 0; i < 20; i++) key(root, '+', { shiftKey: true })
    frames.run()
    expect(shownWindow(root).x1 - shownWindow(root).x0).toBeCloseTo(0.25, 4)
    for (let i = 0; i < 40; i++) key(root, '-')
    frames.run()
    expect(shownWindow(root).x1 - shownWindow(root).x0).toBeCloseTo(fit.x1 - fit.x0, 4)
    surface.fitAll()
    frames.run()
    expectWindow(shownWindow(root), fit)
  })

  it.each([
    ['right', 3.5, 0.3],
    ['left', -3, 0.4],
    ['bottom', 0.3, 4],
    ['top', 0.3, -3],
  ])('marks the %s edge for a stroke added beyond it, until the window shows it', async (edge, x, y) => {
    const { provider, root, surface } = await whiteboard([pen('a', 0.2, 0.2)])
    expect(edgeMarks(root)).toEqual([])
    provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'w1', seq: 11, stroke: pen('far', x, y) })
    expect(strokeEls(layer(root, 'pen'), 'far')).toHaveLength(1)
    expect(edgeMarks(root)).toEqual([edge])
    surface.fitAll()
    frames.run()
    expect(edgeMarks(root)).toEqual([])
  })

  it('marks no edge for a stroke added inside the window, and drops the mark of one removed', async () => {
    const { provider, root } = await whiteboard([pen('a', 0.2, 0.2)])
    provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'w1', seq: 11, stroke: pen('near', 0.25, 0.22) })
    provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'w1', seq: 12, stroke: pen('far', 6, 0.3) })
    expect(edgeMarks(root)).toEqual(['right'])
    provider.emit({ type: InkFeed.STROKE_REMOVED, pageId: 'w1', seq: 13, strokeId: 'far' })
    expect(edgeMarks(root)).toEqual([])
  })

  it('leaves a fixed page to scroll: no gesture or zoom key moves it', async () => {
    const { root, surface } = await presented()
    layOut(root, {})
    const viewBox = svgOf(root).getAttribute('viewBox')
    expect(wheel(root, { deltaY: 100 }).defaultPrevented).toBe(false)
    expect(wheel(root, { deltaY: 100, ctrlKey: true }).defaultPrevented).toBe(false)
    drag(root, [[400, 400], [300, 300]])
    expect(key(root, '+', { shiftKey: true }).defaultPrevented).toBe(false)
    expect(key(root, '-').defaultPrevented).toBe(false)
    expect([surface.pannable, surface.panBy(0.1, 0), surface.fitAll(), surface.window]).toEqual([false, false, false, null])
    expect(frames.queued.size).toBe(0)
    expect(svgOf(root).getAttribute('viewBox')).toBe(viewBox)
    expect(root.querySelector('.ink-page__view')?.hasAttribute('hidden')).toBe(true)
    expect(/** @type {HTMLElement} */ (root.querySelector('[data-ink-action="scale"]')).hidden).toBe(false)
  })

  it('never scrolls the reader to a live stroke written out of view', async () => {
    const { provider, root } = await presented()
    const surround = /** @type {HTMLElement} */ (root.querySelector('.ink-page__surround'))
    surround.getBoundingClientRect = () => /** @type {DOMRect} */ ({ left: 0, top: 0, width: 1000, height: 300, right: 1000, bottom: 300 })
    const scrollTo = vi.fn()
    surround.scrollTo = /** @type {any} */ (scrollTo)
    svgOf(root).getBoundingClientRect = () => /** @type {DOMRect} */ ({ left: 0, top: 0, width: 1000, height: 1000 / ASPECT, right: 1000, bottom: 1000 / ASPECT })
    provider.emit({ type: InkFeed.LIVE_PAGE, live: true, pageId: 'p1', view: 'live-view' })
    provider.emit({ type: InkFeed.LIVE, records: [begin(7), ...points(7, 0, 4)] })
    frames.run()
    expect(layer(root, 'live').children).toHaveLength(1)
    expect(scrollTo).not.toHaveBeenCalled()
  })

  it.each([
    ['a whiteboard of one page', { ids: ['w1'], bounds: 'unbounded' }, true],
    ['a note of several pages', {}, false],
  ])('hides the pager on %s', async (_name, opts, hidden) => {
    const { root } = await presented(opts)
    expect(/** @type {HTMLElement} */ (root.querySelector('.ink-page__pages')).hidden).toBe(hidden)
  })

  it.each([
    ['a fixed page', {}, ['Page 1 of 2', '2 strokes']],
    ['a whiteboard', { ids: ['w1'], bounds: 'unbounded' }, ['Whiteboard', '2 strokes']],
  ])('reports where the reader is and the ink on %s to the status bar', async (_name, opts, readout) => {
    const { provider, lens } = await presented({ ...opts, strokes: [pen('s1')] })
    /** @type {any[]} */
    const seen = []
    lens.onEvent((e) => { if (e.type === 'stats') seen.push(e) })
    expect(lens.stats().readout?.map((c) => c.text)).toEqual([readout[0], '1 stroke'])
    provider.emit({ type: InkFeed.STROKE_ADDED, pageId: opts.ids ? 'w1' : 'p1', seq: 11, stroke: pen('s2') })
    expect(seen.at(-1).readout.map((/** @type {any} */ c) => c.text)).toEqual(readout)
  })

  it('counts every stroke on the page, one that draws nothing included', async () => {
    const dot = { ...pencil('dot'), points: pencil('dot').points.slice(0, 1) }
    const { root, lens } = await presented({ strokes: [pen('s1'), dot] })
    expect(strokeEls(root, 'dot')).toHaveLength(0)
    expect(lens.stats().readout?.map((c) => c.text)).toEqual(['Page 1 of 2', '2 strokes'])
  })

  it("gives a whiteboard's window the surround's shape: framed again while it frames the ink, otherwise kept about its centre", async () => {
    const { root } = await whiteboard()
    const surround = /** @type {HTMLElement} */ (root.querySelector('.ink-page__surround'))
    resizes.resize(surround, 600, 600)
    frames.run()
    const square = shownWindow(root)
    expect((square.x1 - square.x0) / (square.y1 - square.y0)).toBeCloseTo(1, 3)
    for (const [x, y] of [[0.2, 0.2], [2.51, 1.644]]) {
      expect([x > square.x0, x < square.x1, y > square.y0, y < square.y1]).toEqual([true, true, true, true])
    }
    key(root, 'ArrowRight')
    frames.run()
    const moved = shownWindow(root)
    resizes.resize(surround, SURROUND.width, SURROUND.height)
    frames.run()
    const wide = shownWindow(root)
    expect((wide.x1 - wide.x0) / (wide.y1 - wide.y0)).toBeCloseTo(2, 3)
    expect([(wide.x0 + wide.x1) / 2, (wide.y0 + wide.y1) / 2, wide.x1 - wide.x0])
      .toEqual([(moved.x0 + moved.x1) / 2, (moved.y0 + moved.y1) / 2, moved.x1 - moved.x0].map((v) => expect.closeTo(v, 3)))
  })

  describe('across a tab switch', () => {
    /**
     * Destroys the lens, as a tab switch does, and presents another over the
     * same note with the view state the first one reported.
     * @param {{provider: FakeInkProvider, lens: DigitalNoteLens, root: HTMLElement}} shown
     */
    const remount = async (shown) => {
      const viewState = shown.lens.viewState
      shown.lens.destroy()
      const lens = new DigitalNoteLens(UUID, { provider: shown.provider, viewState })
      await lens.presentMode('wysiwyg', shown.root)
      await settle()
      return { ...shown, lens, surface: /** @type {PageSurface} */ (lens.surface) }
    }
    /** A stroke begun `startMillis` after the note was created. @param {string} id @param {number} startMillis */
    const at = (id, startMillis) => ({ ...pen(id), startMillis })

    it("keeps the page shown, the sheet's scale and the pages marked unseen", async () => {
      const shown = await presented({ ids: ['p1', 'p2', 'p3'] })
      shown.surface.turn(1)
      shown.surface.toggleScale()
      shown.provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'p3', seq: 11, stroke: pen('s3') })
      await settle()
      const { surface, root, provider } = await remount(shown)
      expect([surface.shownPage, surface.scale, [...surface.unseenPages]]).toEqual(['p2', PageSurface.Scale.ACTUAL, ['p3']])
      expect([dot(root, 'p3').hasAttribute('data-unseen'), dot(root, 'p2').getAttribute('aria-current')]).toEqual([true, 'page'])
      expect(provider.loads).toBe(3)
    })

    it("keeps a whiteboard's window", async () => {
      const shown = await whiteboard()
      key(shown.root, 'ArrowDown')
      key(shown.root, '+', { shiftKey: true })
      frames.run()
      const before = shownWindow(shown.root)
      const { root } = await remount(shown)
      expectWindow(shownWindow(root), before)
    })

    it('marks the pages that took ink while it was away, and clears a mark only when its page is shown', async () => {
      const shown = await presented({ ids: ['p1', 'p2', 'p3'], strokes: [at('old', 100)] })
      shown.surface.turn(1)
      await settle()
      for (const id of ['p2', 'p3']) shown.provider.answers.set(id, { page: exportPage([at('old', 100)]), seq: 12 })
      shown.provider.answers.set('p1', { page: exportPage([at('old', 100), at('new', 500)]), seq: 12 })
      const { surface, root } = await remount(shown)
      await settle()
      expect([surface.shownPage, [...surface.unseenPages]]).toEqual(['p2', ['p1']])
      expect(dot(root, 'p1').hasAttribute('data-unseen')).toBe(true)
      surface.turn(1)
      await settle()
      expect([...surface.unseenPages]).toEqual(['p1'])
      dot(root, 'p1').click()
      await settle()
      expect([surface.shownPage, [...surface.unseenPages]]).toEqual(['p1', []])
    })

    it('asks for no other page when nothing was written while it was away', async () => {
      const shown = await presented({ ids: ['p1', 'p2', 'p3'] })
      const before = shown.provider.loads
      const { provider } = await remount(shown)
      await settle()
      expect(provider.loads - before).toBe(1)
    })
  })

  it('counts the pages with unseen ink past twelve pages, and the count shows each in turn', async () => {
    const ids = Array.from({ length: 13 }, (_, i) => `p${i + 1}`)
    const { provider, root, surface } = await presented({ ids })
    expect(root.querySelectorAll('.ink-page__dot')).toHaveLength(0)
    expect(root.querySelector('[data-ink-action="unseen"]')).toBeNull()
    provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'p9', seq: 11, stroke: pen('s2') })
    provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'p5', seq: 12, stroke: pen('s3') })
    const unseen = () => /** @type {HTMLButtonElement|null} */ (root.querySelector('[data-ink-action="unseen"]'))
    expect(unseen()?.textContent).toBe('2 unseen')
    unseen()?.click()
    await settle()
    expect([surface.shownPage, unseen()?.textContent]).toEqual(['p5', '1 unseen'])
    unseen()?.click()
    await settle()
    expect([surface.shownPage, unseen()]).toEqual(['p9', null])
  })

  it('shows a notice for a template it cannot draw', async () => {
    const { root } = await presented({ template: { id: 'hexagons', params: {} } })
    const notice = /** @type {HTMLElement} */ (root.querySelector('.ink-page__notice'))
    expect(notice.hidden).toBe(false)
    expect(notice.textContent).toMatch(/unknown template/i)
  })

  it('switches the sheet between fitting the width and actual size', async () => {
    const { root, surface } = await presented()
    expect(svgOf(root).style.width).toBe('100%')
    surface.toggleScale()
    expect(svgOf(root).style.width).toBe('1404px')
    expect(root.querySelector('[data-ink-action="scale"]')?.textContent).toBe('Fit width')
  })

  it.each([
    ['PageDown', {}, 'p2', true],
    ['PageUp', {}, 'p1', true],
    ['PageDown', { shiftKey: true }, 'p1', false],
    ['ArrowRight', {}, 'p1', false],
  ])('%s %j turns to %s', async (key, mods, shows, claimed) => {
    const { root, surface } = await presented()
    const event = new KeyboardEvent('keydown', Object.assign({ key, bubbles: true, cancelable: true }, mods))
    const page = /** @type {HTMLElement} */ (root.querySelector('.ink-page'))
    page.dispatchEvent(event)
    await settle()
    expect([surface.shownPage, event.defaultPrevented]).toEqual([shows, claimed])
  })

  describe('Open in e-ink', () => {
    /** @param {HTMLElement} root */
    const action = (root) => /** @type {HTMLButtonElement} */ (root.querySelector('[data-ink-action="open-on-tablet"]'))
    /** @param {HTMLElement} root */
    const status = (root) => /** @type {HTMLElement} */ (root.querySelector('.ink-page__status'))

    it.each([
      ['the tablet goes live', { outcome: InkOpening.OPENED, reason: '' }, 'Opened on Note Air 2'],
      ['no tablet connected', { outcome: InkOpening.NO_TABLET, reason: '' }, 'No tablet connected'],
      ['another tablet connected', { outcome: InkOpening.OTHER_TABLET, reason: '' }, 'Connected to another tablet'],
      ['SieveInk not in front', { outcome: InkOpening.REFUSED, reason: InkRefusal.NOT_FOREGROUND }, 'SieveInk is not open on the tablet'],
      ['the note not shared', { outcome: InkOpening.REFUSED, reason: InkRefusal.NOT_OFFERED }, 'This note is not shared with this Sieve'],
      ['refused for another reason', { outcome: InkOpening.REFUSED, reason: 'busy' }, 'The tablet refused (busy)'],
      ['no answer', { outcome: InkOpening.NO_ANSWER, reason: '' }, 'The tablet did not answer'],
      ['nothing could be asked', new Error('no note'), 'Could not ask the tablet'],
    ])('words %s in place, briefly', async (_, opening, words) => {
      const { provider, root } = await presented()
      provider.opening = opening
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.useFakeTimers()
      action(root).click()
      expect(status(root).textContent).toBe('Opening on Note Air 2…')
      await vi.advanceTimersByTimeAsync(0)
      expect([status(root).hidden, status(root).textContent, action(root).disabled]).toEqual([false, words, false])
      expect(provider.calls.filter((c) => c === 'openOnTablet')).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(ActionStatus.SHOWN_MS)
      expect(status(root).hidden).toBe(true)
    })

    it('is one ask while one is under way, disabled meanwhile', async () => {
      const { provider, root, surface } = await presented()
      /** @type {(v: any) => void} */ let answer = () => {}
      provider.opening = new Promise((resolve) => { answer = resolve })
      action(root).click()
      const again = surface.openOnTablet()
      expect([action(root).disabled, provider.calls.filter((c) => c === 'openOnTablet').length]).toEqual([true, 1])
      answer({ outcome: InkOpening.OPENED, reason: '' })
      await again
      expect([action(root).disabled, status(root).textContent]).toEqual([false, 'Opened on Note Air 2'])
    })

    it('is offered only for a note that came from a tablet', async () => {
      const { provider, root } = await presented()
      expect(action(root).hidden).toBe(false)
      const { note_source_id: _, ...attrs } = noteAttrs(['p1', 'p2'])
      provider.setAttrs(attrs)
      await settle()
      expect(action(root).hidden).toBe(true)
    })
  })

  describe('Copy page', () => {
    /** @param {HTMLElement} root */
    const status = (root) => root.querySelector('.ink-page__status')?.textContent
    /** @param {string} svg @returns {Element} the SVG document's root, as HTML parses inline SVG */
    const parsed = (svg) => {
      const template = document.createElement('template')
      template.innerHTML = svg
      return /** @type {Element} */ (template.content.firstElementChild)
    }

    it('copies the page drawn as a self-contained SVG, the whole sheet 1404 across, pencil tone and all, without the pen', async () => {
      const { provider, root } = await presented({ strokes: [pen('s1'), pencil('t1')] })
      const copied = copiedImages()
      provider.emit({ type: InkFeed.LIVE_PAGE, live: true, pageId: 'p1', view: 'live-view' })
      provider.emit({ type: InkFeed.LIVE, records: [begin(7), ...points(7, 0, 12)] })
      frames.run()
      expect(layer(root, 'live').children.length).toBe(1)
      press(root, 'copy-page')
      await settle()
      expect(copied).toHaveLength(1)
      const { svg, width, height } = copied[0]
      expect([width, height]).toEqual([GRID, Math.round(GRID / ASPECT)])
      expect(svg.startsWith('<svg xmlns="http://www.w3.org/2000/svg"')).toBe(true)
      const doc = parsed(svg)
      expect([doc.getAttribute('width'), doc.getAttribute('height'), doc.getAttribute('viewBox')])
        .toEqual([String(GRID), String(Math.round(GRID / ASPECT)), `0 0 ${GRID} ${Math.round(GRID / ASPECT)}`])
      expect(doc.hasAttribute('style')).toBe(false)
      expect(doc.querySelectorAll('defs pattern').length).toBe(7)
      expect(doc.querySelector('g[data-ink="ruling"]')?.children.length).toBeGreaterThan(0)
      expect(doc.querySelectorAll('[data-stroke="s1"]')).toHaveLength(1)
      expect([...doc.querySelectorAll('[data-stroke="t1"]')].some((g) => /^url\(#ink-b\d\)$/.test(String(g.parentElement?.getAttribute('fill'))))).toBe(true)
      expect(doc.querySelector('g[data-ink="live"]')?.children.length).toBe(0)
      expect(svg).not.toMatch(/<image|<style|<foreignObject|href=|@import|font-family|class=/)
      expect(layer(root, 'live').children.length).toBe(1)
      expect(status(root)).toBe('Copied')
    })

    it("copies a whiteboard's window as it is shown, 1404 across", async () => {
      const { root, surface } = await whiteboard()
      const copied = copiedImages()
      surface.zoomBy(2)
      press(root, 'copy-page')
      await settle()
      const w = /** @type {any} */ (surface.window)
      const doc = parsed(copied[0].svg)
      expect(doc.getAttribute('viewBox')).toBe(viewBoxOf(w))
      expect([copied[0].width, copied[0].height]).toEqual([GRID, Math.round(GRID * (w.y1 - w.y0) / (w.x1 - w.x0))])
    })

    it('says when there is nothing to copy, and when the clipboard does not take it', async () => {
      const { provider, root } = await presented({ ids: [] })
      copiedImages()
      press(root, 'copy-page')
      await settle()
      expect(status(root)).toBe(PageSurface.CopyWords.NOTHING)
      provider.answers.set('p1', { page: exportPage([pen('s1')]), seq: 10 })
      provider.setAttrs(noteAttrs(['p1']))
      await settle()
      vi.spyOn(ImageClipboard.prototype, 'copySvg').mockRejectedValue(new Error('denied'))
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      press(root, 'copy-page')
      await settle()
      expect(status(root)).toBe(PageSurface.CopyWords.FAILED)
    })
  })

  it('is read-only by construction', async () => {
    const { lens } = await presented()
    expect(lens.getCapabilities()).toEqual({ markdown: false, mentions: false, commands: false, blocks: false })
    expect(await lens.setMode('markdown')).toBe(false)
    expect(await lens.setPresenting(true)).toBe(false)
    await lens.flushSave()
    expect(() => new DigitalNoteLens(UUID, { provider: { getOrder: () => [], subscribe: () => {} } })).toThrow('InkContainerProvider')
  })

  it('destroy stops hearing the feed and the block, and cancels its frame and timers', async () => {
    const { provider, lens, root } = await presented()
    vi.useFakeTimers()
    provider.emit({ type: InkFeed.LIVE_PAGE, live: true, pageId: 'p1', view: 'live-view' })
    provider.emit({ type: InkFeed.LIVE, records: [begin(7), ...points(7, 0, 12), mark('end', 7)] })
    expect(frames.queued.size).toBe(1)
    lens.destroy()
    expect([provider.feedListeners.size, provider.modelListeners.size, frames.queued.size, vi.getTimerCount()]).toEqual([0, 0, 0, 0])
    expect(root.childElementCount).toBe(0)
  })

  it("heads the page with what the note is called, the tablet's title until it has a name, and takes a name given while it is shown", async () => {
    const { provider, root } = await presented()
    expect(root.querySelector('.ink-page__title')?.textContent).toBe('Ideas')
    provider.rename('Kitchen extension planning')
    expect(root.querySelector('.ink-page__title')?.textContent).toBe('Kitchen extension planning')
  })

  describe('the reading', () => {
    /** @param {HTMLElement} root @returns {string} */
    const notice = (root) => {
      const el = /** @type {HTMLElement} */ (root.querySelector('.ink-reading__notice'))
      return el.hidden ? '' : String(el.textContent)
    }
    /** @param {HTMLElement} root @param {string} action @returns {string} what the button says; '' when hidden */
    const button = (root, action) => {
      const el = /** @type {HTMLButtonElement|null} */ (root.querySelector(`.ink-reading__bar [data-ink-action="${action}"]`))
      return el && !el.hidden ? String(el.textContent) : ''
    }
    /** @param {HTMLElement} root @returns {string[]} the kinds of the blocks drawn */
    const drawn = (root) => [...root.querySelectorAll('.ink-reading__blocks > [data-kind]')].map((el) => String(el.getAttribute('data-kind')))
    /** @param {HTMLElement} root @returns {string} */
    const working = (root) => String(root.querySelector('.ink-reading__bar .ink-page__status')?.textContent || '')
    /** @param {HTMLElement} root @param {string} mode */
    const modeButton = (root, mode) => /** @type {HTMLButtonElement} */ (root.querySelector(`[data-ink-action="mode"][data-ink-mode="${mode}"]`))
    /** @param {HTMLElement} root @param {string} mode */
    const pressed = (root, mode) => modeButton(root, mode).getAttribute('aria-pressed')

    // The Mermaid in a reading is drawn by a stand-in: the real one is a script the page loads.
    beforeEach(() => {
      vi.stubGlobal('mermaid', { initialize() {}, render: () => Promise.resolve({ svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' }) })
    })

    /** A lens presented over pages p1 and p2 and switched to its reading. */
    async function reading_() {
      const shown = await presented()
      key(shown.root, 'Enter', { ctrlKey: true })
      await settle()
      return { ...shown, surface: /** @type {ReadingSurface} */ (shown.lens.surface) }
    }

    it('Mod+Enter and the chrome switch between the page and its reading, the keyboard going with them', async () => {
      const { lens, root, provider } = await presented()
      expect(pressed(root, 'page')).toBe('true')
      /** @type {string[]} */ const modes = []
      lens.onEvent((e) => { if (e.type === 'mode-changed') modes.push(String(e.mode)) })
      expect(key(root, 'Enter', { metaKey: true }).defaultPrevented).toBe(true)
      await settle()
      expect(lens.mode).toBe(ReadingSurface.MODE)
      expect(document.activeElement).toBe(root.querySelector('.ink-page--reading'))
      expect([pressed(root, 'page'), pressed(root, 'reading')]).toEqual(['false', 'true'])
      modeButton(root, 'page').click()
      await settle()
      expect(lens.mode).toBe(PageSurface.MODE)
      expect(document.activeElement).toBe(root.querySelector('.ink-page--reader'))
      modeButton(root, 'page').click()
      await settle()
      expect(modes).toEqual([ReadingSurface.MODE, PageSurface.MODE])
      expect(provider.calls.filter((c) => c.startsWith('loadReading'))).toEqual(['loadReading p1'])
      expect(key(root, 'Enter', { altKey: true, ctrlKey: true }).defaultPrevented).toBe(false)
    })

    it.each([
      ['unread', reading('p1'), ReadingSurface.Words.INVITE, { read: 'Read this page', 'new-document': '' }, [], ''],
      ['being read', reading('p1', { running: true }), '', { read: '', 'new-document': '' }, [], ReadingSurface.Words.RUNNING],
      ['read', reading('p1', { state: InkReadingState.READY, key: 'k1', blocks: READ_BLOCKS }), '', { read: '', 'new-document': 'New document' }, ['prose', 'diagram'], ''],
      ['read before the page changed', reading('p1', { state: InkReadingState.STALE, key: 'k0', blocks: READ_BLOCKS }), ReadingSurface.Words.STALE,
        { read: 'Read again', 'new-document': '' }, ['prose', 'diagram'], ''],
      ['being read again', reading('p1', { state: InkReadingState.STALE, key: 'k0', blocks: READ_BLOCKS, running: true }), ReadingSurface.Words.STALE,
        { read: '', 'new-document': '' }, ['prose', 'diagram'], ReadingSurface.Words.RUNNING],
      ['unreadable without an AI', reading('p1', { available: false, unavailable: 'No AI is configured.' }), 'No AI is configured.',
        { read: '', 'new-document': '' }, [], ''],
      ['failed', reading('p1', { failed: 'The model timed out.' }), 'The model timed out.', { read: 'Try again', 'new-document': '' }, [], ''],
    ])('draws a page %s', async (_name, answer, said, buttons, kinds, work) => {
      const shown = await presented()
      shown.provider.readings.set('p1', answer)
      key(shown.root, 'Enter', { ctrlKey: true })
      await settle()
      expect(notice(shown.root)).toBe(said)
      expect({ read: button(shown.root, 'read'), 'new-document': button(shown.root, 'new-document') }).toEqual(buttons)
      expect(drawn(shown.root)).toEqual(kinds)
      expect(working(shown.root)).toBe(work)
    })

    it("draws the reading of the page the reader is on, a page's own, and turns with the pager and the page keys", async () => {
      const shown = await presented()
      shown.provider.readings.set('p1', reading('p1', { state: InkReadingState.READY, blocks: READ_BLOCKS }))
      key(shown.root, 'Enter', { ctrlKey: true })
      await settle()
      expect([position(shown.root), drawn(shown.root)]).toEqual(['1 / 2', ['prose', 'diagram']])
      key(shown.root, 'PageDown')
      await settle()
      expect([position(shown.root), drawn(shown.root), notice(shown.root)]).toEqual(['2 / 2', [], ReadingSurface.Words.INVITE])
      press(shown.root, 'prev')
      await settle()
      expect(drawn(shown.root)).toEqual(['prose', 'diagram'])
      expect(shown.provider.calls.filter((c) => c.startsWith('loadReading'))).toEqual(['loadReading p1', 'loadReading p2', 'loadReading p1'])
    })

    it('reads the page when asked, and draws the reading the feed then brings', async () => {
      const { provider, root } = await reading_()
      press(root, 'read')
      await settle()
      expect(provider.calls).toContain('readPage p1')
      expect([working(root), button(root, 'read')]).toEqual([ReadingSurface.Words.RUNNING, ''])
      provider.emit({ type: InkFeed.READING, reading: reading('p2', { state: InkReadingState.READY, blocks: READ_BLOCKS }) })
      expect(drawn(root)).toEqual([])
      provider.emit({ type: InkFeed.READING, reading: reading('p1', { state: InkReadingState.READY, blocks: READ_BLOCKS }) })
      expect([working(root), drawn(root), button(root, 'new-document')]).toEqual(['', ['prose', 'diagram'], 'New document'])
    })

    it('asks again when ink lands on the page shown, which is how it learns the reading is stale; ink elsewhere marks its page', async () => {
      const { provider, root } = await reading_()
      provider.readings.set('p1', reading('p1', { state: InkReadingState.READY, blocks: READ_BLOCKS }))
      provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'p1', seq: 11, stroke: pen('s2') })
      await settle()
      expect(button(root, 'new-document')).toBe('New document')
      provider.readings.set('p1', reading('p1', { state: InkReadingState.STALE, blocks: READ_BLOCKS }))
      provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'p1', seq: 12, stroke: pen('s3') })
      await settle()
      expect([notice(root), button(root, 'read'), drawn(root)]).toEqual([ReadingSurface.Words.STALE, 'Read again', ['prose', 'diagram']])
      provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'p2', seq: 13, stroke: pen('s4') })
      expect(dot(root, 'p2').hasAttribute('data-unseen')).toBe(true)
      expect(provider.calls.filter((c) => c === 'loadReading p1')).toHaveLength(3)
    })

    it('New document asks for a document from the reading and has the host open it', async () => {
      const shown = await presented()
      shown.provider.readings.set('p1', reading('p1', { state: InkReadingState.READY, blocks: READ_BLOCKS }))
      key(shown.root, 'Enter', { ctrlKey: true })
      await settle()
      /** @type {any[]} */ const opened = []
      shown.lens.onEvent((e) => { if (e.type === SurfaceIntent.OPEN_CONTAINER) opened.push(e.uuid) })
      press(shown.root, 'new-document')
      await settle()
      expect([shown.provider.calls.at(-1), opened]).toEqual(['newDocumentFromReading p1', ['doc-new']])
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      shown.provider.made = new Error('not read')
      press(shown.root, 'new-document')
      await settle()
      expect([opened, working(shown.root)]).toEqual([['doc-new'], ReadingSurface.Words.NOT_MADE])
    })

    it('keeps its mode, page and marks across a tab switch, and hands them back to the page', async () => {
      const shown = await reading_()
      shown.surface.turn(1)
      shown.provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'p1', seq: 11, stroke: pen('s9') })
      await settle()
      const viewState = shown.lens.viewState
      shown.lens.destroy()
      const lens = new DigitalNoteLens(UUID, { provider: shown.provider, viewState })
      await lens.presentMode('wysiwyg', shown.root)
      await settle()
      const surface = /** @type {ReadingSurface} */ (lens.surface)
      expect([lens.mode, surface.shownPage, [...surface.unseenPages]]).toEqual([ReadingSurface.MODE, 'p2', ['p1']])
      await lens.toggleMode()
      await settle()
      const page = /** @type {PageSurface} */ (lens.surface)
      expect([page.mode, page.shownPage, [...page.unseenPages]]).toEqual([PageSurface.MODE, 'p2', ['p1']])
    })
  })
})
