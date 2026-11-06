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
import { ActionStatus } from '../src/static/lens/ink/action-status.js'
import { ImageClipboard } from '../src/static/renderers/copy-image.js'
import { InkFeed, InkOpening, InkRefusal } from '../src/static/contract/ink-container-provider.js'
import {
  ASPECT, DOTS, FakeInkProvider, Frames, GRID, UUID, begin, drag, expectWindow, exportPage, key, layOut, layer, mark, noteAttrs, pen, pencil, points, press, renderer, settle, shownWindow, strokeEls, svgOf, tabletWindow, view, viewBoxOf, wheel,
  copiedImages,
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

/** A whiteboard of these strokes, laid out 600 by 800 at (100, 50). @param {any[]} [strokes] */
async function whiteboard(strokes = [pen('a', 0.2, 0.2), pen('b', 2.4, 1.6)]) {
  const shown = await presented({ ids: ['w1'], bounds: 'unbounded', strokes, template: DOTS })
  layOut(shown.root, {})
  return shown
}


/** @param {HTMLElement} root @returns {string[]} the edges whose mark shows */
const edgeMarks = (root) => [...root.querySelectorAll('.ink-page__edge')].filter((el) => !(/** @type {HTMLElement} */ (el)).hidden).map((el) => String(el.getAttribute('data-ink-edge')))

describe('DigitalNoteLens', () => {
  /** @type {Frames} */ let frames
  beforeEach(() => {
    Object.assign(/** @type {any} */ (globalThis).TipTap, { getStroke })
    frames = new Frames()
    frames.install()
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
    expect((w.x1 - w.x0) / (w.y1 - w.y0)).toBeCloseTo(ASPECT, 3)
    if (!strokes.length) expectWindow(w, tabletWindow(0, 0))
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
    return { x: w.x0 + (cx - 100) / 600 * (w.x1 - w.x0), y: w.y0 + (cy - 50) / 800 * (w.y1 - w.y0) }
  }

  it.each([
    ['dragging the sheet', (/** @type {HTMLElement} */ root) => drag(root, [[400, 400], [350, 380], [300, 350]]),
      (/** @type {any} */ before, /** @type {any} */ after) => {
        const u = (before.x1 - before.x0) / 600
        expectWindow(after, { x0: before.x0 + 100 * u, y0: before.y0 + 50 * u, x1: before.x1 + 100 * u, y1: before.y1 + 50 * u })
      }],
    ['the wheel', (/** @type {HTMLElement} */ root) => expect(wheel(root, { deltaX: 30, deltaY: 120 }).defaultPrevented).toBe(true),
      (/** @type {any} */ before, /** @type {any} */ after) => {
        const u = (before.x1 - before.x0) / 600
        expectWindow(after, { x0: before.x0 + 30 * u, y0: before.y0 + 120 * u, x1: before.x1 + 30 * u, y1: before.y1 + 120 * u })
      }],
    ['Ctrl and the wheel, about the pointer', (/** @type {HTMLElement} */ root) => wheel(root, { deltaY: -200, ctrlKey: true, clientX: 250, clientY: 300 }),
      (/** @type {any} */ before, /** @type {any} */ after, /** @type {HTMLElement} */ root) => {
        expect(after.x1 - after.x0).toBeCloseTo((before.x1 - before.x0) / Math.exp(0.4), 4)
        const p = planeAt(root, 250, 300)
        expect(p.x).toBeCloseTo(before.x0 + 150 / 600 * (before.x1 - before.x0), 3)
        expect(p.y).toBeCloseTo(before.y0 + 250 / 800 * (before.y1 - before.y0), 3)
      }],
    ['an arrow key', (/** @type {HTMLElement} */ root) => expect(key(root, 'ArrowRight').defaultPrevented).toBe(true),
      (/** @type {any} */ before, /** @type {any} */ after) => {
        const step = 0.1 * (before.x1 - before.x0)
        expectWindow(after, { ...before, x0: before.x0 + step, x1: before.x1 + step })
      }],
    ['the + key', (/** @type {HTMLElement} */ root) => expect(key(root, '+', { shiftKey: true }).defaultPrevented).toBe(true),
      (/** @type {any} */ before, /** @type {any} */ after) => {
        expect(after.x1 - after.x0).toBeCloseTo((before.x1 - before.x0) / 1.25, 4)
        expect((after.x0 + after.x1) / 2).toBeCloseTo((before.x0 + before.x1) / 2, 4)
      }],
    ['the zoom out button, after two zooms in', (/** @type {HTMLElement} */ root) => { press(root, 'zoom-in'); press(root, 'zoom-in'); press(root, 'zoom-out') },
      (/** @type {any} */ before, /** @type {any} */ after) => {
        expect(after.x1 - after.x0).toBeCloseTo((before.x1 - before.x0) / 1.25, 4)
        expect((after.y0 + after.y1) / 2).toBeCloseTo((before.y0 + before.y1) / 2, 4)
      }],
    ['the 100% button', (/** @type {HTMLElement} */ root) => press(root, 'actual'),
      (/** @type {any} */ before, /** @type {any} */ after) => {
        expect((after.x1 - after.x0) * GRID).toBeCloseTo(600, 1)
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
    provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'w1', seq: 11, stroke: pen('near', 0.25, 0.3) })
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
})
