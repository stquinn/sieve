// @ts-check
// DigitalNoteLens — a Digital Note's pages drawn by the real InkRenderer over a
// fake InkContainerProvider, so what is pinned is what reaches the mounted SVG:
// a page as it is answered, every committed stroke added to and trimmed from
// that same SVG, the stroke under the pen drawn once a frame and handed over to
// its committed markup, and a whiteboard's window moved by the reader without
// the page being drawn again — and never by the tablet. Its controls are what it
// puts in the workspace toolbar, drawn by the real WorkspaceToolbar, and its
// actions are also what its context menu offers.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getStroke } from 'perfect-freehand'
import { DigitalNoteLens } from '../src/static/lens/ink/digital-note-lens.js'
import { PageSurface } from '../src/static/lens/ink/page-surface.js'
import { TranscriptSurface } from '../src/static/lens/ink/transcript-surface.js'
import { SurfaceIntent } from '../src/static/lens/abstract-surface.js'
import { ActionStatus } from '../src/static/lens/ink/action-status.js'
import { ImageClipboard } from '../src/static/renderers/copy-image.js'
import { InkFeed, InkOpening, InkTranscriptState, InkRefusal } from '../src/static/contract/ink-container-provider.js'
import {
  ASPECT, DOTS, bandData, FakeInkProvider, Frames, GRID, Resizes, UUID, begin, drag, expectWindow, exportPage, key, layOut, layer, mark, noteAttrs, pen, pencil, points, press, renderer, settle, shownWindow, strokeEls, svgOf, tabletWindow, view, viewBoxOf, wheel,
  copiedImages, transcript, TRANSCRIPT_BLOCKS, item, tap, toolbarFor, toolbarIds, placesOf, faceOf, optionsOf, choose, rightClick, menuOf,
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
  const { bar, toolbar } = toolbarFor(lens)
  await lens.presentMode('wysiwyg', root)
  await settle()
  return { provider, lens, root, bar, toolbar, surface: /** @type {PageSurface} */ (lens.surface) }
}

/** @param {HTMLElement} bar @returns {string|undefined} the page drop-down's closed face */
const position = (bar) => faceOf(bar, 'tb-page-select')
/** @param {HTMLElement} bar */
const openLive = (bar) => item(bar, 'tb-open-live')
/** @param {HTMLElement} bar @param {number} n the page's place, from 1 @returns {boolean} whether its option is marked unseen */
const unseenPage = (bar, n) => optionsOf(bar, 'tb-page-select')[n - 1].startsWith('● ')
/** @param {HTMLElement} bar @returns {string} the value of the page chosen in the drop-down */
const chosenPage = (bar) => String(/** @type {HTMLSelectElement} */ (/** @type {unknown} */ (item(bar, 'tb-page-select'))).value)

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

  it("shows the block's first page as it is answered, hearing the feed before asking for it, with no bar of its own", async () => {
    const { provider, root, bar, lens } = await presented()
    expect(lens.mode).toBe(PageSurface.MODE)
    expect(provider.calls.slice(0, 3)).toEqual(['subscribeFeed', 'subscribe', 'loadPage p1'])
    expect(position(bar)).toBe('1 / 2')
    expect(root.querySelectorAll('button, header')).toHaveLength(0)
    expect(strokeEls(root, 's1')).toHaveLength(1)
    expect(layer(root, 'ruling').children.length).toBeGreaterThan(0)
    expect(item(bar, 'tb-ink-notice')).toBeNull()
  })

  const PAGER = ['tb-page-prev', 'tb-page-select', 'tb-page-next']
  const TOGGLE = ['|', 'tb-toggle-mode-btn']
  /** @param {Awaited<ReturnType<typeof presented>>} shown */
  const unableToOpen = async (shown) => {
    shown.provider.opening = { outcome: InkOpening.NO_TABLET, reason: '' }
    tap(shown.bar, 'tb-open-on-tablet')
    await settle()
  }
  it.each([
    ['a fixed page of a note from a tablet', {}, null,
      { start: PAGER, middle: ['tb-scale'], end: ['tb-open-on-tablet', 'tb-copy-page', ...TOGGLE] }],
    ['a whiteboard of one page', { ids: ['w1'], bounds: 'unbounded' }, null,
      { start: [], middle: ['tb-zoom-out', 'tb-zoom-in', 'tb-zoom-actual', 'tb-zoom-fit'], end: ['tb-open-on-tablet', 'tb-copy-page', ...TOGGLE] }],
    ['a page being written on the tablet, another page holding unseen ink, after an action said what came of it', {},
      async (/** @type {Awaited<ReturnType<typeof presented>>} */ shown) => {
        shown.provider.emit({ type: InkFeed.LIVE_PAGE, live: true, pageId: 'p1', view: 'live-view' })
        shown.provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'p2', seq: 11, stroke: pen('s2') })
        await unableToOpen(shown)
      },
      { start: [...PAGER, 'tb-page-unseen'], middle: ['tb-scale'], end: ['tb-ink-status', 'tb-open-on-tablet', 'tb-copy-page', 'tb-open-live', ...TOGGLE] }],
    ['the transcript', {}, (/** @type {Awaited<ReturnType<typeof presented>>} */ shown) => shown.lens.setMode(TranscriptSurface.MODE),
      { start: PAGER, middle: [], end: ['tb-open-on-tablet', ...TOGGLE] }],
    ['the transcript, after an action said what came of it', {},
      async (/** @type {Awaited<ReturnType<typeof presented>>} */ shown) => { await unableToOpen(shown); await shown.lens.setMode(TranscriptSurface.MODE) },
      { start: PAGER, middle: [], end: ['tb-ink-status', 'tb-open-on-tablet', ...TOGGLE] }],
  ])('lays out the toolbar, for %s: the pager at the start, the sizing in the middle, the actions and then the mode toggle at the end', async (_name, opts, setup, places) => {
    const shown = await presented(opts)
    if (setup) await setup(shown)
    await settle()
    expect(placesOf(shown.bar)).toEqual(places)
    expect(item(shown.bar, 'tb-toggle-mode-btn')?.textContent).toBe(shown.lens.mode === PageSurface.MODE ? 'Transcript' : 'Page')
  })

  it.each([
    ['a pen stroke', pen('s2', 0.5, 0.5)],
    ['a pencil stroke, to the one path of each band it touches', pencil('s2')],
  ])('adds %s above the held seq into the same SVG', async (_name, stroke) => {
    const { provider, root } = await presented()
    const svg = svgOf(root)
    const existing = strokeEls(root, 's1')[0]
    provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'p1', seq: 11, stroke })
    const markup = renderer.renderStroke(/** @type {any} */ (stroke))
    expect(svgOf(root)).toBe(svg)
    expect(strokeEls(root, 's1')[0]).toBe(existing)
    expect(strokeEls(layer(root, 'pen'), 's2')).toHaveLength(markup.pen ? 1 : 0)
    expect(bandData(root)).toEqual(markup.bands)
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

  it('advertises where the reader is as its target\'s label — the page shown among the pages, and the mode — and mints no blocks', async () => {
    const { lens, surface } = await presented({ ids: ['p1', 'p2', 'p3'] })
    /** @type {any[]} */ const adverts = []
    lens.setSelectionListener({ onSelectionChanged: (c) => adverts.push(c) })
    expect(lens.getSelectionContext().target.label).toBe('Page 1 of 3')

    surface.turn(1)
    await settle()
    expect(adverts.at(-1).target.label).toBe('Page 2 of 3')
    expect(adverts.at(-1).docUuid).toBe(UUID)

    await lens.toggleMode()
    await settle()
    expect(adverts.at(-1).target.label).toBe('Page 2 of 3, transcript')
    expect(lens.getCapabilities().blocks).toBe(false)
  })

  it("removes a removed stroke, a pencil stroke's part of every band's one path, and leaves the rest", async () => {
    const { provider, root } = await presented({ strokes: [pencil('s1'), pencil('s2'), pen('s8'), pen('s9')] })
    const bands = renderer.renderStroke(/** @type {any} */ (pencil('s1'))).bands
    expect(bands.filter(Boolean).length).toBeGreaterThan(1)
    expect(bandData(root)).toEqual(bands.map((d) => d + d))
    provider.emit({ type: InkFeed.STROKE_REMOVED, pageId: 'p1', seq: 11, strokeId: 's1' })
    provider.emit({ type: InkFeed.STROKE_REMOVED, pageId: 'p1', seq: 12, strokeId: 's8' })
    expect(bandData(root)).toEqual(bands)
    expect([strokeEls(root, 's8').length, strokeEls(root, 's9').length]).toEqual([0, 1])
    provider.emit({ type: InkFeed.STROKE_REMOVED, pageId: 'p1', seq: 13, strokeId: 's2' })
    expect(bandData(root)).toEqual(bands.map(() => ''))
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
    const { provider, root, bar } = await presented()
    provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'p2', seq: 11, stroke: pen('s2') })
    expect([unseenPage(bar, 2), unseenPage(bar, 1), chosenPage(bar)]).toEqual([true, false, 'p1'])
    expect(strokeEls(root, 's2')).toHaveLength(0)
    choose(bar, 'tb-page-select', 'p2')
    await settle()
    expect(position(bar)).toBe('2 / 2')
    expect([unseenPage(bar, 2), chosenPage(bar)]).toEqual([false, 'p2'])
  })

  it.each([
    ['previous', 'tb-page-prev', 'p2', 'p1'],
    ['next', 'tb-page-next', 'p1', 'p2'],
  ])('turns to the %s page from the toolbar, and dims the turn that would leave the note', async (_name, id, from, to) => {
    const { bar, surface } = await presented()
    surface.showPage(from)
    await settle()
    expect(item(bar, id)?.disabled).toBe(false)
    tap(bar, id)
    await settle()
    expect(surface.shownPage).toBe(to)
    expect(item(bar, id)?.disabled).toBe(true)
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

  it('draws a pencil stroke under the pen in its tone, one path per band and its tail, and its commit changes nothing drawn', async () => {
    const { provider, root } = await presented()
    const stroke = { ...pencil('s7'), points: pencil('s7').points.slice(0, 36) }
    const records = stroke.points.map((q) => ({ record: 'point', stroke: 7, tool: null, widthClass: 0, ...q }))
    /** @param {Element} scope @returns {string[]} the path data drawn in each band's tone, lightest first */
    const toned = (scope) => [0, 1, 2, 3, 4, 5, 6].map((i) => [...scope.querySelectorAll(`path[fill="url(#ink-b${i})"]`)].map((el) => el.getAttribute('d')).join(''))
    provider.emit({ type: InkFeed.LIVE_PAGE, live: true, pageId: 'p1', view: 'live-view' })
    provider.emit({ type: InkFeed.LIVE, records: [{ ...begin(7, 'pencil'), widthClass: stroke.widthClass }, ...records.slice(0, 12)] })
    frames.run()
    const first = layer(root, 'live').querySelector('path')
    expect(first?.getAttribute('fill')).toMatch(/^url\(#ink-b\d\)$/)
    for (let n = 12; n < records.length; n += 5) {
      provider.emit({ type: InkFeed.LIVE, records: records.slice(n, n + 5) })
      frames.run()
    }
    expect(layer(root, 'live').querySelector('path')).toBe(first)
    const live = toned(layer(root, 'live'))
    expect(live.filter(Boolean).length).toBeGreaterThan(1)
    expect(layer(root, 'live').querySelectorAll('path').length).toBeLessThanOrEqual(live.filter(Boolean).length + 1)
    provider.emit({ type: InkFeed.LIVE, records: [mark('end', 7)] })
    provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'p1', seq: 11, stroke })
    expect(layer(root, 'live').children).toHaveLength(0)
    expect(bandData(root)).toEqual(live)
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
    const { provider, root, bar, surface, lens } = await presented()
    /** @type {any[]} */
    const intents = []
    lens.onEvent((e) => { if (e.type === 'open-container') intents.push(e) })
    expect(openLive(bar)).toBeNull()
    provider.emit({ type: InkFeed.LIVE_PAGE, live: true, pageId: 'p2', view: 'live-view' })
    provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'p2', seq: 11, stroke: pen('s2') })
    await settle()
    expect([surface.shownPage, position(bar), provider.loads, unseenPage(bar, 2)]).toEqual(['p1', '1 / 2', 1, true])
    openLive(bar)?.click()
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
    expect(openLive(bar)).toBeNull()
    surface.openLive()
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
    const { provider, bar } = await presented()
    provider.answers.set('p3', { page: exportPage([]), seq: 10 })
    provider.setAttrs(noteAttrs(ids))
    await settle()
    expect(position(bar)).toBe(shows)
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
    ['the zoom out button, after two zooms in', (/** @type {HTMLElement} */ _root, /** @type {HTMLElement} */ bar) => { tap(bar, 'tb-zoom-in'); tap(bar, 'tb-zoom-in'); tap(bar, 'tb-zoom-out') },
      (/** @type {any} */ before, /** @type {any} */ after) => {
        expect((before.x1 - before.x0) / (after.x1 - after.x0)).toBeCloseTo(1.25, 4)
        expect((after.y0 + after.y1) / 2).toBeCloseTo((before.y0 + before.y1) / 2, 4)
      }],
    ['the 100% button', (/** @type {HTMLElement} */ _root, /** @type {HTMLElement} */ bar) => tap(bar, 'tb-zoom-actual'),
      (/** @type {any} */ before, /** @type {any} */ after) => {
        expect((after.x1 - after.x0) * GRID).toBeCloseTo(SURROUND.width, 1)
        expect((after.x0 + after.x1) / 2).toBeCloseTo((before.x0 + before.x1) / 2, 4)
      }],
    ['the fit all button', (/** @type {HTMLElement} */ _root, /** @type {HTMLElement} */ bar) => tap(bar, 'tb-zoom-fit'),
      (/** @type {any} */ _before, /** @type {any} */ after) => {
        expect(after.x0).toBeLessThan(0.2)
        expect(after.x1).toBeGreaterThan(2.51)
      }],
  ])('%s moves the window, redrawing only the ruling, and the tablet does not move it back', async (_name, gesture, check) => {
    const { provider, root, bar } = await whiteboard()
    provider.emit({ type: InkFeed.LIVE_PAGE, live: true, pageId: 'w1', view: 'live-view' })
    provider.emit({ type: InkFeed.LIVE, records: [view(2, 3)] })
    frames.run()
    const before = shownWindow(root)
    const svg = svgOf(root)
    const nodes = [...root.querySelectorAll('[data-stroke]')]
    const ruling = layer(root, 'ruling')
    gesture(root, bar)
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
  ])('marks the %s edge for a stroke added beyond a window the reader has moved, until the window shows it', async (edge, x, y) => {
    const { provider, root, surface } = await whiteboard([pen('a', 0.2, 0.2)])
    key(root, 'ArrowDown')
    frames.run()
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
    key(root, 'ArrowDown')
    provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'w1', seq: 11, stroke: pen('near', 0.25, 0.22) })
    provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'w1', seq: 12, stroke: pen('far', 6, 0.3) })
    expect(edgeMarks(root)).toEqual(['right'])
    provider.emit({ type: InkFeed.STROKE_REMOVED, pageId: 'w1', seq: 13, strokeId: 'far' })
    expect(edgeMarks(root)).toEqual([])
  })

  describe('Fit all, which goes on framing the ink until the reader moves the window', () => {
    /** @param {HTMLElement} bar @returns {boolean} whether Fit all is drawn pressed */
    const fitting = (bar) => !!item(bar, 'tb-zoom-fit')?.classList.contains('active')
    /** @param {{x0: number, y0: number, x1: number, y1: number}} w @param {number} x @param {number} y */
    const inside = (w, x, y) => x > w.x0 && x < w.x1 && y > w.y0 && y < w.y1

    it('is in force when a whiteboard opens framing its ink: a stroke committed far outside is framed with the rest, and its removal frames the rest again', async () => {
      const { provider, root, bar } = await whiteboard()
      const opened = shownWindow(root)
      expect(fitting(bar)).toBe(true)
      provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'w1', seq: 11, stroke: pen('far', 7, 4) })
      frames.run()
      const grown = shownWindow(root)
      expect([inside(grown, 7.01, 4.01), inside(grown, 0.2, 0.2), edgeMarks(root), fitting(bar)]).toEqual([true, true, [], true])
      provider.emit({ type: InkFeed.STROKE_REMOVED, pageId: 'w1', seq: 12, strokeId: 'far' })
      frames.run()
      expectWindow(shownWindow(root), opened)
      expect(fitting(bar)).toBe(true)
    })

    it('leaves the window where it is for a stroke committed inside it', async () => {
      const { provider, root } = await whiteboard()
      const before = svgOf(root).getAttribute('viewBox')
      provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'w1', seq: 11, stroke: pen('near', 1, 1) })
      frames.run()
      expect(svgOf(root).getAttribute('viewBox')).toBe(before)
    })

    it('grows the window to keep the pen in view while a live stroke runs out of it, and never moves it for one inside', async () => {
      const { provider, root } = await whiteboard()
      const before = svgOf(root).getAttribute('viewBox')
      provider.emit({ type: InkFeed.LIVE_PAGE, live: true, pageId: 'w1', view: 'live-view' })
      /** @param {number} x @param {number} y @param {number} t */
      const at = (x, y, t) => ({ record: 'point', stroke: 7, tool: null, widthClass: 0, x, y, pressure: 0.5, tMillis: t, tiltX: 0, tiltY: 0 })
      provider.emit({ type: InkFeed.LIVE, records: [begin(7, 'pen', 0, 0), at(1, 1, 0), at(1.5, 1.2, 10)] })
      frames.run()
      expect(svgOf(root).getAttribute('viewBox')).toBe(before)
      for (const [i, x] of [5, 6, 8].entries()) {
        provider.emit({ type: InkFeed.LIVE, records: [at(x, 1.5, 20 + i * 10)] })
        frames.run()
        expect(inside(shownWindow(root), x, 1.5)).toBe(true)
      }
      provider.emit({ type: InkFeed.LIVE, records: [mark('end', 7)] })
      provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'w1', seq: 11, stroke: { ...pen('s7', 1, 1), points: [{ x: 1, y: 1, pressure: 0.5, tMillis: 0 }, { x: 8, y: 1.5, pressure: 0.5, tMillis: 40 }] } })
      frames.run()
      const framed = shownWindow(root)
      expect([inside(framed, 8, 1.5), inside(framed, 0.2, 0.2), layer(root, 'live').children.length]).toEqual([true, true, 0])
    })

    it.each([
      ['dragging the sheet', (/** @type {HTMLElement} */ root) => drag(root, [[400, 400], [380, 390]])],
      ['the wheel', (/** @type {HTMLElement} */ root) => wheel(root, { deltaY: 20 })],
      ['Ctrl and the wheel', (/** @type {HTMLElement} */ root) => wheel(root, { deltaY: -50, ctrlKey: true, clientX: 300, clientY: 200 })],
      ['an arrow key', (/** @type {HTMLElement} */ root) => key(root, 'ArrowLeft')],
      ['the + key', (/** @type {HTMLElement} */ root) => key(root, '+', { shiftKey: true })],
      ['the zoom in button', (/** @type {HTMLElement} */ _root, /** @type {HTMLElement} */ bar) => tap(bar, 'tb-zoom-in')],
      ['the zoom out button', (/** @type {HTMLElement} */ _root, /** @type {HTMLElement} */ bar) => tap(bar, 'tb-zoom-out')],
      ['the 100% button', (/** @type {HTMLElement} */ _root, /** @type {HTMLElement} */ bar) => tap(bar, 'tb-zoom-actual')],
    ])('ends when the reader moves the window by %s: ink outside it is marked at the edge and the window stays, until Fit all is pressed again', async (_name, gesture) => {
      const { provider, root, bar } = await whiteboard()
      gesture(root, bar)
      frames.run()
      const taken = svgOf(root).getAttribute('viewBox')
      expect(fitting(bar)).toBe(false)
      provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'w1', seq: 11, stroke: pen('far', 9, 0.5) })
      frames.run()
      expect([svgOf(root).getAttribute('viewBox'), edgeMarks(root)]).toEqual([taken, ['right']])
      tap(bar, 'tb-zoom-fit')
      frames.run()
      expect([fitting(bar), inside(shownWindow(root), 9.01, 0.51), edgeMarks(root)]).toEqual([true, true, []])
      provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'w1', seq: 12, stroke: pen('farther', -6, 0.5) })
      frames.run()
      expect(inside(shownWindow(root), -5.99, 0.51)).toBe(true)
    })

    it.each([
      ['fitting, is framed round the ink as it is when the tab comes back', true],
      ['moved by the reader, keeps its place', false],
    ])('carries across a tab switch: a window %s', async (_name, fits) => {
      const shown = await whiteboard()
      if (!fits) { key(shown.root, 'ArrowDown'); frames.run() }
      const before = shownWindow(shown.root)
      const viewState = shown.lens.viewState
      shown.lens.destroy()
      shown.provider.answers.set('w1', { page: exportPage([pen('a', 0.2, 0.2), pen('b', 2.4, 1.6), pen('away', 6, 3)], DOTS), seq: 12 })
      const lens = new DigitalNoteLens(UUID, { provider: shown.provider, viewState })
      shown.toolbar.show(lens)
      await lens.presentMode('page', shown.root)
      await settle()
      layOut(shown.root, SURROUND)
      frames.run()
      const after = shownWindow(shown.root)
      expect([fitting(shown.bar), inside(after, 6.01, 3.01)]).toEqual([fits, fits])
      if (!fits) expectWindow(after, before)
      shown.provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'w1', seq: 13, stroke: pen('later', -4, 0.5) })
      frames.run()
      expect(inside(shownWindow(shown.root), -3.99, 0.51)).toBe(fits)
    })
  })

  it('leaves a fixed page to scroll: no gesture or zoom key moves it', async () => {
    const { root, bar, surface } = await presented()
    layOut(root, {})
    const viewBox = svgOf(root).getAttribute('viewBox')
    expect(wheel(root, { deltaY: 100 }).defaultPrevented).toBe(false)
    drag(root, [[400, 400], [300, 300]])
    expect(key(root, '+', { shiftKey: true }).defaultPrevented).toBe(false)
    expect(key(root, '-').defaultPrevented).toBe(false)
    expect([surface.pannable, surface.panBy(0.1, 0), surface.fitAll(), surface.window]).toEqual([false, false, false, null])
    expect(frames.queued.size).toBe(0)
    expect(svgOf(root).getAttribute('viewBox')).toBe(viewBox)
    expect([item(bar, 'tb-zoom-in'), item(bar, 'tb-scale') !== null]).toEqual([null, true])
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
    ['a fixed page', {}, ['Page 1 of 2', '2 strokes', 'Note Air 2']],
    ['a whiteboard', { ids: ['w1'], bounds: 'unbounded' }, ['Whiteboard', '2 strokes', 'Note Air 2']],
  ])('reports where the reader is, the ink on %s and the device it was written on to the status bar', async (_name, opts, readout) => {
    const { provider, lens } = await presented({ ...opts, strokes: [pen('s1')] })
    /** @type {any[]} */
    const seen = []
    lens.onEvent((e) => { if (e.type === 'stats') seen.push(e) })
    expect(lens.stats().readout?.map((c) => c.text)).toEqual([readout[0], '1 stroke', 'Note Air 2'])
    provider.emit({ type: InkFeed.STROKE_ADDED, pageId: opts.ids ? 'w1' : 'p1', seq: 11, stroke: pen('s2') })
    expect(seen.at(-1).readout.map((/** @type {any} */ c) => c.text)).toEqual(readout)
  })

  it('counts every stroke on the page, one that draws nothing included', async () => {
    const dot = { ...pencil('dot'), points: pencil('dot').points.slice(0, 1) }
    const { root, lens } = await presented({ strokes: [pen('s1'), dot] })
    expect(strokeEls(root, 'dot')).toHaveLength(0)
    expect(lens.stats().readout?.map((c) => c.text)).toEqual(['Page 1 of 2', '2 strokes', 'Note Air 2'])
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
     * @param {{provider: FakeInkProvider, lens: DigitalNoteLens, root: HTMLElement, toolbar: any}} shown
     */
    const remount = async (shown) => {
      const viewState = shown.lens.viewState
      shown.lens.destroy()
      const lens = new DigitalNoteLens(UUID, { provider: shown.provider, viewState })
      shown.toolbar.show(lens)
      await lens.presentMode('wysiwyg', shown.root)
      await settle()
      return { ...shown, lens, surface: /** @type {PageSurface} */ (lens.surface) }
    }
    /** A stroke begun `startMillis` after the note was created. @param {string} id @param {number} startMillis */
    const at = (id, startMillis) => ({ ...pen(id), startMillis })

    it("keeps the page shown, the sheet's scale and the pages marked unseen", async () => {
      const shown = await presented({ ids: ['p1', 'p2', 'p3'] })
      shown.surface.turn(1)
      shown.surface.setScale(150)
      shown.provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'p3', seq: 11, stroke: pen('s3') })
      await settle()
      const { surface, bar, provider } = await remount(shown)
      expect([surface.shownPage, surface.scale, [...surface.unseenPages]]).toEqual(['p2', 150, ['p3']])
      expect([unseenPage(bar, 3), chosenPage(bar), faceOf(bar, 'tb-scale')]).toEqual([true, 'p2', '150%'])
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
      const { surface, bar } = await remount(shown)
      await settle()
      expect([surface.shownPage, [...surface.unseenPages]]).toEqual(['p2', ['p1']])
      expect(unseenPage(bar, 1)).toBe(true)
      surface.turn(1)
      await settle()
      expect([...surface.unseenPages]).toEqual(['p1'])
      choose(bar, 'tb-page-select', 'p1')
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

  /** Fourteen pages, `p1`…`p14`. */
  const FOURTEEN = Array.from({ length: 14 }, (_, i) => `p${i + 1}`)

  it.each([
    ['page', null],
    ['transcript', ['Enter', { ctrlKey: true }]],
  ])('in the %s, lists every page in the drop-down, shows the one chosen, and turns with ‹ ›', async (_mode, flip) => {
    const shown = await presented({ ids: FOURTEEN })
    if (flip) { key(shown.root, .../** @type {[string, any]} */ (flip)); await settle() }
    const { bar } = shown
    expect([position(bar), optionsOf(bar, 'tb-page-select')]).toEqual(['1 / 14', FOURTEEN.map((_, i) => `Page ${i + 1}`)])
    choose(bar, 'tb-page-select', 'p9')
    await settle()
    expect([/** @type {any} */ (shown.lens.surface).shownPage, position(bar), chosenPage(bar)]).toEqual(['p9', '9 / 14', 'p9'])
    tap(bar, 'tb-page-next')
    await settle()
    tap(bar, 'tb-page-next')
    await settle()
    tap(bar, 'tb-page-prev')
    await settle()
    expect(position(bar)).toBe('10 / 14')
  })

  it.each([
    ['no page named', {}, ['Page 1', 'Page 2', 'Page 3']],
    ['a page named, the others numbered', { 1: 'Kitchen' }, ['Page 1', 'Kitchen', 'Page 3']],
    ['a blank name, numbered', { 0: '  ' }, ['Page 1', 'Page 2', 'Page 3']],
  ])('calls each page in the list by its name, else its place: %s', async (_name, names, labels) => {
    const { provider, bar } = await presented({ ids: ['p1', 'p2', 'p3'] })
    const attrs = noteAttrs(['p1', 'p2', 'p3'])
    attrs.note.pages = attrs.note.pages.map((p, i) => (Object.hasOwn(names, i) ? { ...p, name: /** @type {any} */ (names)[i] } : p))
    provider.setAttrs(attrs)
    await settle()
    expect([optionsOf(bar, 'tb-page-select'), position(bar)]).toEqual([labels, '1 / 3'])
  })

  it('marks each page with unseen ink in the list, and counts them beside it, the count showing each in turn', async () => {
    const { provider, bar, surface } = await presented({ ids: FOURTEEN })
    expect(item(bar, 'tb-page-unseen')).toBeNull()
    provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'p9', seq: 11, stroke: pen('s2') })
    provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'p5', seq: 12, stroke: pen('s3') })
    const unseen = () => item(bar, 'tb-page-unseen')
    expect([unseen()?.textContent, optionsOf(bar, 'tb-page-select').filter((t) => t.startsWith('● '))]).toEqual(['2 unseen', ['● Page 5', '● Page 9']])
    unseen()?.click()
    await settle()
    expect([surface.shownPage, unseen()?.textContent, unseenPage(bar, 5)]).toEqual(['p5', '1 unseen', false])
    unseen()?.click()
    await settle()
    expect([surface.shownPage, unseen()]).toEqual(['p9', null])
  })

  it('shows a notice in the toolbar for a template it cannot draw', async () => {
    const { bar } = await presented({ template: { id: 'hexagons', params: {} } })
    expect(item(bar, 'tb-ink-notice')?.textContent).toMatch(/unknown template/i)
  })

  /** @param {HTMLElement} root */
  const scaleOf = (root) => /** @type {HTMLElement} */ (root.querySelector('.ink-page__surround')).dataset.scale

  it('opens a note it has no view of at Fit page, the whole page in the surround, and offers every level and fit', async () => {
    const { root, bar, surface } = await presented()
    expect([surface.scale, scaleOf(root), svgOf(root).style.width, faceOf(bar, 'tb-scale')]).toEqual([PageSurface.Scale.PAGE, 'page', '100%', 'Fit page'])
    expect(optionsOf(bar, 'tb-scale')).toEqual(['25%', '50%', '75%', '100%', '150%', '200%', 'Fit width', 'Fit page'])
  })

  it.each([
    ['25%', '25', 25, `${GRID / 4}px`],
    ['100%', '100', 100, `${GRID}px`],
    ['200%', '200', 200, `${GRID * 2}px`],
    ['Fit width', 'fit', 'fit', '100%'],
    ['Fit page', 'page', 'page', '100%'],
  ])('sizes the sheet %s from the drop-down, and keeps it across a tab switch', async (label, value, scale, width) => {
    const shown = await presented()
    if (value === 'page') choose(shown.bar, 'tb-scale', '50')
    choose(shown.bar, 'tb-scale', value)
    expect([scaleOf(shown.root), svgOf(shown.root).style.width, shown.surface.scale, faceOf(shown.bar, 'tb-scale')]).toEqual([String(scale), width, scale, label])
    const viewState = shown.lens.viewState
    shown.lens.destroy()
    const lens = new DigitalNoteLens(UUID, { provider: shown.provider, viewState })
    shown.toolbar.show(lens)
    await lens.presentMode('page', shown.root)
    await settle()
    expect([scaleOf(shown.root), /** @type {PageSurface} */ (lens.surface).scale, faceOf(shown.bar, 'tb-scale')]).toEqual([String(scale), scale, label])
  })

  describe('Ctrl and the wheel, and a pinch, on a fixed page', () => {
    /**
     * Lays the sheet out as a browser would at its scale: a fit at `fitWidth`
     * CSS pixels across, a level at its own width, the surround's scroll moving it.
     * @param {HTMLElement} root @param {number} fitWidth
     */
    const layOutScaled = (root, fitWidth) => {
      const svg = svgOf(root)
      const surround = /** @type {HTMLElement} */ (root.querySelector('.ink-page__surround'))
      /** @type {{left: number, top: number}} */ const scroll = { left: 0, top: 0 }
      Object.defineProperty(surround, 'scrollLeft', { get: () => scroll.left, set: (v) => { scroll.left = Math.max(0, v) }, configurable: true })
      Object.defineProperty(surround, 'scrollTop', { get: () => scroll.top, set: (v) => { scroll.top = Math.max(0, v) }, configurable: true })
      svg.getBoundingClientRect = () => {
        const width = svg.style.width.endsWith('px') ? parseFloat(svg.style.width) : fitWidth
        const box = { left: 100 - scroll.left, top: 50 - scroll.top, width, height: width / ASPECT }
        return /** @type {DOMRect} */ ({ ...box, right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top })
      }
      return scroll
    }

    it.each([
      ['Fit page, shown at 43%, in', 'page', 600, -1, 50],
      ['Fit page, shown at 43%, out', 'page', 600, 1, 25],
      ['Fit width, shown at 71%, in', 'fit', 1000, -1, 75],
      ['Fit width, shown at 71%, out', 'fit', 1000, 1, 50],
      ['Fit page, shown at 20%, out: nothing smaller', 'page', 281, 1, 'page'],
      ['Fit width, shown at 250%, in: nothing larger', 'fit', 3510, -1, 'fit'],
      ['100%, in', 100, 0, -1, 150],
      ['100%, out', 100, 0, 1, 75],
      ['200%, in: the largest', 200, 0, -1, 200],
      ['25%, out: the smallest', 25, 0, 1, 25],
    ])('steps from %s', async (_name, from, fitWidth, sign, to) => {
      const { root, bar, surface } = await presented()
      surface.setScale(from)
      layOutScaled(root, fitWidth)
      expect(wheel(root, { deltaY: 100 * sign, ctrlKey: true, clientX: 300, clientY: 300 }).defaultPrevented).toBe(true)
      expect([surface.scale, faceOf(bar, 'tb-scale')]).toEqual([to, PageSurface.SCALES.find((c) => c.scale === to)?.label])
    })

    it('steps one level for every 40 pixels of travel, a level per event at most, Cmd as Ctrl', async () => {
      const { root, surface } = await presented()
      surface.setScale(100)
      layOutScaled(root, 0)
      for (let i = 0; i < 3; i++) wheel(root, { deltaY: -12, metaKey: true })
      expect(surface.scale).toBe(100)
      wheel(root, { deltaY: -12, metaKey: true })
      expect(surface.scale).toBe(150)
      wheel(root, { deltaY: 30, metaKey: true })
      expect(surface.scale).toBe(150)
      wheel(root, { deltaY: -600, ctrlKey: true })
      expect(surface.scale).toBe(200)
    })

    it('keeps the point under the pointer where it is, as far as the scroll allows', async () => {
      const { root, surface } = await presented()
      surface.setScale(100)
      const scroll = layOutScaled(root, 0)
      wheel(root, { deltaY: -100, ctrlKey: true, clientX: 800, clientY: 650 })
      expect(surface.scale).toBe(150)
      const r = svgOf(root).getBoundingClientRect()
      expect([(800 - r.left) / r.width, (650 - r.top) / r.height]).toEqual([700 / GRID, 600 / (GRID / ASPECT)].map((v) => expect.closeTo(v, 6)))
      expect([scroll.left, scroll.top]).toEqual([350, 300].map((v) => expect.closeTo(v, 6)))
      surface.setScale(100)
      Object.assign(scroll, { left: 0, top: 0 })
      wheel(root, { deltaY: 100, ctrlKey: true, clientX: 800, clientY: 650 })
      expect([surface.scale, scroll.left, scroll.top]).toEqual([75, 0, 0])
    })

    it.each([
      ['spread', [1.1, 1.25, 1.6], 200],
      ['pinched', [0.9, 0.8, 0.6], 50],
    ])('a pinch %s steps a level each time it grows or shrinks by a fifth', async (_name, scales, to) => {
      const { root, surface } = await presented()
      surface.setScale(100)
      layOutScaled(root, 0)
      const surround = /** @type {HTMLElement} */ (root.querySelector('.ink-page__surround'))
      /** @param {string} type @param {number} scale */
      const gesture = (type, scale) => {
        const event = new Event(type, { bubbles: true, cancelable: true })
        Object.assign(event, { scale, clientX: 300, clientY: 300 })
        surround.dispatchEvent(event)
        return event
      }
      expect(gesture('gesturestart', 1).defaultPrevented).toBe(true)
      for (const scale of scales) gesture('gesturechange', scale)
      expect(surface.scale).toBe(to)
    })
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

  describe('Open on device', () => {
    /** @param {HTMLElement} bar */
    const action = (bar) => /** @type {HTMLButtonElement} */ (item(bar, 'tb-open-on-tablet'))
    /** @param {HTMLElement} bar @returns {string} what the toolbar says; '' when it says nothing */
    const status = (bar) => String(item(bar, 'tb-ink-status')?.textContent ?? '')

    it.each([
      ['the tablet goes live', { outcome: InkOpening.OPENED, reason: '' }, 'Opened on Note Air 2'],
      ['no tablet connected', { outcome: InkOpening.NO_TABLET, reason: '' }, 'No tablet connected'],
      ['another tablet connected', { outcome: InkOpening.OTHER_TABLET, reason: '' }, 'Connected to another tablet'],
      ['SieveInk not in front', { outcome: InkOpening.REFUSED, reason: InkRefusal.NOT_FOREGROUND }, 'SieveInk is not open on the tablet'],
      ['the note not shared', { outcome: InkOpening.REFUSED, reason: InkRefusal.NOT_OFFERED }, 'This note is not shared with this Sieve'],
      ['refused for another reason', { outcome: InkOpening.REFUSED, reason: 'busy' }, 'The tablet refused (busy)'],
      ['no answer', { outcome: InkOpening.NO_ANSWER, reason: '' }, 'The tablet did not answer'],
      ['nothing could be asked', new Error('no note'), 'Could not ask the tablet'],
    ])('words %s in the toolbar, briefly', async (_, opening, words) => {
      const { provider, bar } = await presented()
      provider.opening = opening
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.useFakeTimers()
      action(bar).click()
      expect(status(bar)).toBe('Opening on Note Air 2…')
      await vi.advanceTimersByTimeAsync(0)
      expect([status(bar), action(bar).disabled]).toEqual([words, false])
      expect(provider.calls.filter((c) => c.startsWith('openOnTablet'))).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(ActionStatus.SHOWN_MS)
      expect(item(bar, 'tb-ink-status')).toBeNull()
    })

    it('is one ask while one is under way, disabled meanwhile', async () => {
      const { provider, bar, lens } = await presented()
      /** @type {(v: any) => void} */ let answer = () => {}
      provider.opening = new Promise((resolve) => { answer = resolve })
      action(bar).click()
      const again = lens.openOnTablet()
      expect([action(bar).disabled, provider.calls.filter((c) => c.startsWith('openOnTablet')).length]).toEqual([true, 1])
      answer({ outcome: InkOpening.OPENED, reason: '' })
      await again
      expect([action(bar).disabled, status(bar)]).toEqual([false, 'Opened on Note Air 2'])
    })

    it.each([
      ['the first page', [], 'p1'],
      ['the second page, turned to', [['PageDown']], 'p2'],
      ['the page shown in transcript', [['PageDown'], ['Enter', { ctrlKey: true }]], 'p2'],
    ])('asks for the page the reader is on: %s', async (_name, keys, page) => {
      const { provider, root, bar } = await presented()
      for (const [k, mods] of /** @type {Array<[string, any?]>} */ (keys)) {
        key(root, k, mods)
        await settle()
      }
      action(bar).click()
      await settle()
      expect(provider.calls.filter((c) => c.startsWith('openOnTablet'))).toEqual([`openOnTablet ${page}`])
    })

    it('is offered only for a note that came from a tablet', async () => {
      const { provider, bar } = await presented()
      expect(action(bar)).not.toBeNull()
      const { note_source_id: _, ...attrs } = noteAttrs(['p1', 'p2'])
      provider.setAttrs(attrs)
      await settle()
      expect(action(bar)).toBeNull()
    })
  })

  describe('its actions, in the toolbar and the context menu', () => {
    // The Mermaid in a transcript is drawn by a stand-in: the real one is a script the page loads.
    beforeEach(() => {
      vi.stubGlobal('mermaid', { initialize() {}, render: () => Promise.resolve({ svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' }) })
    })

    /** The ids of the action buttons in the toolbar, in order. @param {HTMLElement} bar */
    const actionIds = (bar) => toolbarIds(bar).filter((id) => ['tb-open-on-tablet', 'tb-copy-page', 'tb-transcribe-page', 'tb-new-document', 'tb-open-live', 'tb-refresh-description'].includes(id))
    /** Chooses the entry of the context menu that says `label`. @param {{lens: DigitalNoteLens, root: HTMLElement}} shown @param {string} label */
    const fromMenu = (shown, label) => {
      const page = /** @type {Element} */ (shown.root.querySelector('.ink-page, .ink-transcript'))
      rightClick(shown.lens, page).intents[0].items.find((/** @type {any} */ i) => i.label === label).action()
    }
    /** @param {{lens: DigitalNoteLens, root: HTMLElement}} shown @returns {string[]} the context menu's entries */
    const menuNow = (shown) => menuOf(rightClick(shown.lens, /** @type {Element} */ (shown.root.querySelector('.ink-page, .ink-transcript'))).intents[0])

    const { note_source_id: _source, ...NOT_FROM_A_TABLET } = noteAttrs(['p1', 'p2'])
    const TRANSCRIPT = transcript('p1', { state: InkTranscriptState.READY, key: 'k1', blocks: TRANSCRIPT_BLOCKS })

    it.each([
      ['the page', {}, null, null,
        ['Open on device', 'Copy page', 'Transcribe this page', 'Refresh name and summary', '—', 'Transcript']],
      ['the page, while it is written on the tablet', {}, null, { type: InkFeed.LIVE_PAGE, live: true, pageId: 'p1', view: 'live-view' },
        ['Open on device', 'Copy page', 'Transcribe this page', 'Go to Live', 'Refresh name and summary', '—', 'Transcript']],
      ['the page of a note not from a tablet', { attrs: NOT_FROM_A_TABLET }, null, null,
        ['Copy page', 'Transcribe this page', 'Refresh name and summary', '—', 'Transcript']],
      ['a page with no transcript', { transcript: true }, transcript('p1'), null,
        ['Open on device', 'Transcribe this page', 'Refresh name and summary', '—', 'Page']],
      ['a transcript', { transcript: true }, TRANSCRIPT, null,
        ['Open on device', 'New document', 'Refresh name and summary', '—', 'Page']],
      ['a stale transcript', { transcript: true }, transcript('p1', { state: InkTranscriptState.STALE, blocks: TRANSCRIPT_BLOCKS }), null,
        ['Open on device', 'Transcribe again', 'Refresh name and summary', '—', 'Page']],
      ['a failed transcript', { transcript: true }, transcript('p1', { failed: 'The model timed out.' }), null,
        ['Open on device', 'Try again', 'Refresh name and summary', '—', 'Page']],
      ['a transcript under way', { transcript: true }, transcript('p1', { running: true }), null,
        ['Open on device', 'Refresh name and summary', '—', 'Page']],
    ])('offers, on %s, the actions in the menu, and those not menu-only in the toolbar, from one list', async (_name, opts, answer, event, menu) => {
      const shown = await presented()
      if (opts.attrs) { shown.provider.setAttrs(opts.attrs); await settle() }
      if (answer) shown.provider.transcripts.set('p1', answer)
      if (opts.transcript) { key(shown.root, 'Enter', { ctrlKey: true }); await settle() }
      if (event) shown.provider.emit(event)
      const { intents, event: click, escaped } = rightClick(shown.lens, /** @type {Element} */ (shown.root.querySelector('.ink-page')))
      expect([click.defaultPrevented, escaped, intents.length]).toEqual([true, false, 1])
      expect(menuOf(intents[0])).toEqual(menu)
      const offered = shown.lens.actions.offered(shown.lens.mode)
      expect(actionIds(shown.bar)).toEqual(offered.filter((a) => !a.menuOnly).map((a) => 'tb-' + a.id))
      expect(offered.filter((a) => a.menuOnly).map((a) => a.id)).toEqual(['transcribe-page', 'refresh-description'].filter((id) => offered.some((a) => a.id === id)))
      expect(intents[0].items.slice(0, offered.length).map((/** @type {any} */ i) => i.label))
        .toEqual(offered.map((a) => (typeof a.label === 'function' ? a.label() : a.label)))
    })

    it('draws an action that cannot run now disabled in both, and runs one chosen from the menu', async () => {
      const { provider, lens, root, bar } = await presented()
      /** @type {(v: any) => void} */ let answer = () => {}
      provider.opening = new Promise((resolve) => { answer = resolve })
      provider.described = new Promise(() => {})
      const page = /** @type {Element} */ (root.querySelector('.ink-page'))
      const items = () => rightClick(lens, page).intents[0].items
      items().find((/** @type {any} */ i) => i.label === 'Open on device').action()
      items().find((/** @type {any} */ i) => i.label === 'Refresh name and summary').action()
      expect(menuOf({ items: items() })).toEqual(['[Open on device]', 'Copy page', 'Transcribe this page', '[Refresh name and summary]', '—', 'Transcript'])
      expect([item(bar, 'tb-open-on-tablet')?.disabled, item(bar, 'tb-copy-page')?.disabled]).toEqual([true, false])
      expect(provider.calls.filter((c) => c.startsWith('openOnTablet') || c === 'refreshDescription')).toEqual(['openOnTablet p1', 'refreshDescription'])
      answer({ outcome: InkOpening.OPENED, reason: '' })
      await settle()
      expect(menuOf({ items: items() })[0]).toBe('Open on device')
      const copied = copiedImages()
      items().find((/** @type {any} */ i) => i.label === 'Copy page').action()
      await settle()
      expect([copied.length, item(bar, 'tb-ink-status')?.textContent]).toEqual([1, 'Copied'])
      items().find((/** @type {any} */ i) => i.label === 'Transcript').action()
      await settle()
      expect(lens.mode).toBe(TranscriptSurface.MODE)
    })

    it.each([
      ['the transcript', '.ink-transcript'],
      ['a block of the transcript', '.ink-transcript__blocks > [data-kind="diagram"]'],
    ])('raises the same menu from a right-click on %s', async (_name, selector) => {
      const shown = await presented()
      shown.provider.transcripts.set('p1', TRANSCRIPT)
      key(shown.root, 'Enter', { ctrlKey: true })
      await settle()
      const { event, intents, escaped } = rightClick(shown.lens, /** @type {Element} */ (shown.root.querySelector(selector)), 410, 220)
      expect([event.defaultPrevented, escaped, intents[0].x, intents[0].y, menuOf(intents[0])])
        .toEqual([true, false, 410, 220, ['Open on device', 'New document', 'Refresh name and summary', '—', 'Page']])
    })

    it("places the menu the menu key raises at the surface's corner", async () => {
      const { lens, root } = await presented()
      const page = /** @type {HTMLElement} */ (root.querySelector('.ink-page'))
      page.getBoundingClientRect = () => /** @type {DOMRect} */ ({ left: 40, top: 90, width: 500, height: 400, right: 540, bottom: 490 })
      const { intents } = rightClick(lens, page, 0, 0)
      expect([intents[0].x, intents[0].y]).toEqual([56, 106])
    })

    it.each([
      ['untranscribed, it is transcribed', transcript('p1'), ['transcribePage p1']],
      ['transcribed, it is shown as it is', TRANSCRIPT, []],
      ['being transcribed, it is left to finish', transcript('p1', { running: true }), []],
    ])('Transcribe this page, on the page, shows its transcript; %s', async (_name, answer, transcribes) => {
      const shown = await presented()
      shown.provider.transcripts.set('p1', answer)
      fromMenu(shown, 'Transcribe this page')
      await settle()
      expect([shown.lens.mode, document.activeElement === shown.root.querySelector('.ink-page--transcript')]).toEqual([TranscriptSurface.MODE, true])
      expect(shown.provider.calls.filter((c) => c.startsWith('transcribePage'))).toEqual(transcribes)
    })

    it('Transcribe again in the transcript transcribes the page, as the button beside it does', async () => {
      const shown = await presented()
      shown.provider.transcripts.set('p1', transcript('p1', { state: InkTranscriptState.STALE, blocks: TRANSCRIPT_BLOCKS }))
      key(shown.root, 'Enter', { ctrlKey: true })
      await settle()
      expect(menuNow(shown)).toContain('Transcribe again')
      fromMenu(shown, 'Transcribe again')
      await settle()
      expect(shown.provider.calls.filter((c) => c.startsWith('transcribePage'))).toEqual(['transcribePage p1'])
    })

    it.each([
      ['asked', undefined, DigitalNoteLens.RefreshWords.ASKED],
      ['refused with a reason', new Error('No AI is configured.'), 'No AI is configured.'],
      ['refused in words', 'This note has no ink yet.', 'This note has no ink yet.'],
      ['refused with nothing to say', new Error(''), DigitalNoteLens.RefreshWords.FAILED],
    ])('Refresh name and summary asks the provider once, and says when it is %s', async (_name, described, words) => {
      const shown = await presented()
      const { provider, bar } = shown
      provider.described = described
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.useFakeTimers()
      fromMenu(shown, 'Refresh name and summary')
      expect([item(bar, 'tb-ink-status')?.textContent, menuNow(shown)]).toEqual([DigitalNoteLens.RefreshWords.ASKING, expect.arrayContaining(['[Refresh name and summary]'])])
      await vi.advanceTimersByTimeAsync(0)
      expect([item(bar, 'tb-ink-status')?.textContent, menuNow(shown)]).toEqual([words, expect.arrayContaining(['Refresh name and summary'])])
      expect(provider.calls.filter((c) => c === 'refreshDescription')).toHaveLength(1)
      await vi.advanceTimersByTimeAsync(ActionStatus.SHOWN_MS)
      expect(item(bar, 'tb-ink-status')).toBeNull()
    })

    it('keeps what came of an action in the toolbar across a mode switch', async () => {
      const { provider, root, bar } = await presented()
      provider.opening = { outcome: InkOpening.NO_TABLET, reason: '' }
      tap(bar, 'tb-open-on-tablet')
      await settle()
      key(root, 'Enter', { ctrlKey: true })
      await settle()
      expect(item(bar, 'tb-ink-status')?.textContent).toBe('No tablet connected')
    })
  })

  describe('Copy page', () => {
    /** @param {HTMLElement} bar */
    const status = (bar) => item(bar, 'tb-ink-status')?.textContent
    /** @param {string} svg @returns {Element} the SVG document's root, as HTML parses inline SVG */
    const parsed = (svg) => {
      const template = document.createElement('template')
      template.innerHTML = svg
      return /** @type {Element} */ (template.content.firstElementChild)
    }

    it('copies the page drawn as a self-contained SVG, the whole sheet 1404 across, pencil tone and all, without the pen', async () => {
      const { provider, root, bar } = await presented({ strokes: [pen('s1'), pencil('t1')] })
      const copied = copiedImages()
      provider.emit({ type: InkFeed.LIVE_PAGE, live: true, pageId: 'p1', view: 'live-view' })
      provider.emit({ type: InkFeed.LIVE, records: [begin(7), ...points(7, 0, 12)] })
      frames.run()
      expect(layer(root, 'live').children.length).toBe(1)
      tap(bar, 'tb-copy-page')
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
      expect(bandData(doc)).toEqual(renderer.renderStroke(/** @type {any} */ (pencil('t1'))).bands)
      expect(doc.querySelector('g[data-ink="b3"]')?.getAttribute('fill')).toBe('url(#ink-b3)')
      expect(doc.querySelector('g[data-ink="live"]')?.children.length).toBe(0)
      expect(svg).not.toMatch(/<image|<style|<foreignObject|href=|@import|font-family|class=/)
      expect(layer(root, 'live').children.length).toBe(1)
      expect(status(bar)).toBe('Copied')
    })

    it("copies a whiteboard's window as it is shown, 1404 across", async () => {
      const { bar, surface } = await whiteboard()
      const copied = copiedImages()
      surface.zoomBy(2)
      tap(bar, 'tb-copy-page')
      await settle()
      const w = /** @type {any} */ (surface.window)
      const doc = parsed(copied[0].svg)
      expect(doc.getAttribute('viewBox')).toBe(viewBoxOf(w))
      expect([copied[0].width, copied[0].height]).toEqual([GRID, Math.round(GRID * (w.y1 - w.y0) / (w.x1 - w.x0))])
    })

    it('says when there is nothing to copy, and when the clipboard does not take it', async () => {
      const { provider, bar } = await presented({ ids: [] })
      copiedImages()
      tap(bar, 'tb-copy-page')
      await settle()
      expect(status(bar)).toBe(PageSurface.CopyWords.NOTHING)
      provider.answers.set('p1', { page: exportPage([pen('s1')]), seq: 10 })
      provider.setAttrs(noteAttrs(['p1']))
      await settle()
      vi.spyOn(ImageClipboard.prototype, 'copySvg').mockRejectedValue(new Error('denied'))
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      tap(bar, 'tb-copy-page')
      await settle()
      expect(status(bar)).toBe(PageSurface.CopyWords.FAILED)
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

  describe('the transcript', () => {
    /** @param {HTMLElement} root @returns {string} */
    const notice = (root) => {
      const el = /** @type {HTMLElement} */ (root.querySelector('.ink-transcript__notice'))
      return el.hidden ? '' : String(el.textContent)
    }
    /** @param {HTMLElement} root @param {string} action @returns {string} what the button says; '' when hidden */
    const button = (root, action) => {
      const el = /** @type {HTMLButtonElement|null} */ (root.querySelector(`.ink-transcript__bar [data-ink-action="${action}"]`))
      return el && !el.hidden ? String(el.textContent) : ''
    }
    /** @param {HTMLElement} root @returns {string[]} the kinds of the blocks drawn */
    const drawn = (root) => [...root.querySelectorAll('.ink-transcript__blocks > [data-kind]')].map((el) => String(el.getAttribute('data-kind')))
    /** @param {HTMLElement} root @returns {string} */
    const working = (root) => String(root.querySelector('.ink-transcript__bar .ink-page__status')?.textContent || '')
    /** @param {HTMLElement} bar */
    const toggle = (bar) => /** @type {HTMLButtonElement} */ (item(bar, 'tb-toggle-mode-btn'))

    // The Mermaid in a transcript is drawn by a stand-in: the real one is a script the page loads.
    beforeEach(() => {
      vi.stubGlobal('mermaid', { initialize() {}, render: () => Promise.resolve({ svg: '<svg xmlns="http://www.w3.org/2000/svg"/>' }) })
    })

    /** A lens presented over pages p1 and p2 and switched to its transcript. */
    async function transcript_() {
      const shown = await presented()
      key(shown.root, 'Enter', { ctrlKey: true })
      await settle()
      return { ...shown, surface: /** @type {TranscriptSurface} */ (shown.lens.surface) }
    }

    it('Mod+Enter and the toolbar toggle switch between the page and its transcript, the keyboard and the toolbar going with them', async () => {
      const { lens, root, bar, provider } = await presented()
      expect([toggle(bar).textContent, toggle(bar).title]).toEqual(['Transcript', 'Show the transcript of the page as text and diagrams'])
      /** @type {string[]} */ const modes = []
      lens.onEvent((e) => { if (e.type === 'mode-changed') modes.push(String(e.mode)) })
      expect(key(root, 'Enter', { metaKey: true }).defaultPrevented).toBe(true)
      await settle()
      expect(lens.mode).toBe(TranscriptSurface.MODE)
      expect(document.activeElement).toBe(root.querySelector('.ink-page--transcript'))
      expect([toggle(bar).textContent, toggle(bar).title]).toEqual(['Page', 'Show the page as it was written'])
      expect(toolbarIds(bar)).toEqual(['tb-page-prev', 'tb-page-select', 'tb-page-next', 'tb-open-on-tablet', 'tb-toggle-mode-btn'])
      toggle(bar).click()
      await settle()
      expect(lens.mode).toBe(PageSurface.MODE)
      expect(document.activeElement).toBe(root.querySelector('.ink-page--reader'))
      expect(item(bar, 'tb-scale')).not.toBeNull()
      expect(modes).toEqual([TranscriptSurface.MODE, PageSurface.MODE])
      expect(provider.calls.filter((c) => c.startsWith('loadTranscript'))).toEqual(['loadTranscript p1'])
      expect(key(root, 'Enter', { altKey: true, ctrlKey: true }).defaultPrevented).toBe(false)
    })

    it.each([
      ['untranscribed', transcript('p1'), TranscriptSurface.Words.INVITE, { transcribe: 'Transcribe this page', 'new-document': '' }, [], ''],
      ['being transcribed', transcript('p1', { running: true }), '', { transcribe: '', 'new-document': '' }, [], TranscriptSurface.Words.RUNNING],
      ['transcribed', transcript('p1', { state: InkTranscriptState.READY, key: 'k1', blocks: TRANSCRIPT_BLOCKS }), '', { transcribe: '', 'new-document': 'New document' }, ['prose', 'diagram'], ''],
      ['transcribed before the page changed', transcript('p1', { state: InkTranscriptState.STALE, key: 'k0', blocks: TRANSCRIPT_BLOCKS }), TranscriptSurface.Words.STALE,
        { transcribe: 'Transcribe again', 'new-document': '' }, ['prose', 'diagram'], ''],
      ['being transcribed again', transcript('p1', { state: InkTranscriptState.STALE, key: 'k0', blocks: TRANSCRIPT_BLOCKS, running: true }), TranscriptSurface.Words.STALE,
        { transcribe: '', 'new-document': '' }, ['prose', 'diagram'], TranscriptSurface.Words.RUNNING],
      ['not transcribable without an AI', transcript('p1', { available: false, unavailable: 'No AI is configured.' }), 'No AI is configured.',
        { transcribe: '', 'new-document': '' }, [], ''],
      ['failed', transcript('p1', { failed: 'The model timed out.' }), 'The model timed out.', { transcribe: 'Try again', 'new-document': '' }, [], ''],
    ])('draws a page %s', async (_name, answer, said, buttons, kinds, work) => {
      const shown = await presented()
      shown.provider.transcripts.set('p1', answer)
      key(shown.root, 'Enter', { ctrlKey: true })
      await settle()
      expect(notice(shown.root)).toBe(said)
      expect({ transcribe: button(shown.root, 'transcribe'), 'new-document': button(shown.root, 'new-document') }).toEqual(buttons)
      expect(drawn(shown.root)).toEqual(kinds)
      expect(working(shown.root)).toBe(work)
    })

    it("draws the transcript of the page the reader is on, a page's own, and turns with the pager and the page keys", async () => {
      const shown = await presented()
      shown.provider.transcripts.set('p1', transcript('p1', { state: InkTranscriptState.READY, blocks: TRANSCRIPT_BLOCKS }))
      key(shown.root, 'Enter', { ctrlKey: true })
      await settle()
      expect([position(shown.bar), drawn(shown.root)]).toEqual(['1 / 2', ['prose', 'diagram']])
      key(shown.root, 'PageDown')
      await settle()
      expect([position(shown.bar), drawn(shown.root), notice(shown.root)]).toEqual(['2 / 2', [], TranscriptSurface.Words.INVITE])
      tap(shown.bar, 'tb-page-prev')
      await settle()
      expect(drawn(shown.root)).toEqual(['prose', 'diagram'])
      expect(shown.provider.calls.filter((c) => c.startsWith('loadTranscript'))).toEqual(['loadTranscript p1', 'loadTranscript p2', 'loadTranscript p1'])
    })

    it('transcribes the page when asked, and draws the transcript the feed then brings', async () => {
      const { provider, root } = await transcript_()
      press(root, 'transcribe')
      await settle()
      expect(provider.calls).toContain('transcribePage p1')
      expect([working(root), button(root, 'transcribe')]).toEqual([TranscriptSurface.Words.RUNNING, ''])
      provider.emit({ type: InkFeed.TRANSCRIPT, transcript: transcript('p2', { state: InkTranscriptState.READY, blocks: TRANSCRIPT_BLOCKS }) })
      expect(drawn(root)).toEqual([])
      provider.emit({ type: InkFeed.TRANSCRIPT, transcript: transcript('p1', { state: InkTranscriptState.READY, blocks: TRANSCRIPT_BLOCKS }) })
      expect([working(root), drawn(root), button(root, 'new-document')]).toEqual(['', ['prose', 'diagram'], 'New document'])
    })

    it('asks again when ink lands on the page shown, which is how it learns the transcript is stale; ink elsewhere marks its page', async () => {
      const { provider, root, bar } = await transcript_()
      provider.transcripts.set('p1', transcript('p1', { state: InkTranscriptState.READY, blocks: TRANSCRIPT_BLOCKS }))
      provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'p1', seq: 11, stroke: pen('s2') })
      await settle()
      expect(button(root, 'new-document')).toBe('New document')
      provider.transcripts.set('p1', transcript('p1', { state: InkTranscriptState.STALE, blocks: TRANSCRIPT_BLOCKS }))
      provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'p1', seq: 12, stroke: pen('s3') })
      await settle()
      expect([notice(root), button(root, 'transcribe'), drawn(root)]).toEqual([TranscriptSurface.Words.STALE, 'Transcribe again', ['prose', 'diagram']])
      provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'p2', seq: 13, stroke: pen('s4') })
      expect(unseenPage(bar, 2)).toBe(true)
      expect(provider.calls.filter((c) => c === 'loadTranscript p1')).toHaveLength(3)
    })

    it('New document asks for a document from the transcript and has the host open it', async () => {
      const shown = await presented()
      shown.provider.transcripts.set('p1', transcript('p1', { state: InkTranscriptState.READY, blocks: TRANSCRIPT_BLOCKS }))
      key(shown.root, 'Enter', { ctrlKey: true })
      await settle()
      /** @type {any[]} */ const opened = []
      shown.lens.onEvent((e) => { if (e.type === SurfaceIntent.OPEN_CONTAINER) opened.push(e.uuid) })
      press(shown.root, 'new-document')
      await settle()
      expect([shown.provider.calls.at(-1), opened]).toEqual(['newDocumentFromTranscript p1', ['doc-new']])
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      shown.provider.made = new Error('not transcribed')
      press(shown.root, 'new-document')
      await settle()
      expect([opened, working(shown.root)]).toEqual([['doc-new'], TranscriptSurface.Words.NOT_MADE])
    })

    it('keeps its mode, page and marks across a tab switch, and hands them back to the page', async () => {
      const shown = await transcript_()
      shown.surface.turn(1)
      shown.provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'p1', seq: 11, stroke: pen('s9') })
      await settle()
      const viewState = shown.lens.viewState
      shown.lens.destroy()
      const lens = new DigitalNoteLens(UUID, { provider: shown.provider, viewState })
      shown.toolbar.show(lens)
      await lens.presentMode('wysiwyg', shown.root)
      await settle()
      const surface = /** @type {TranscriptSurface} */ (lens.surface)
      expect([lens.mode, surface.shownPage, [...surface.unseenPages]]).toEqual([TranscriptSurface.MODE, 'p2', ['p1']])
      await lens.toggleMode()
      await settle()
      const page = /** @type {PageSurface} */ (lens.surface)
      expect([page.mode, page.shownPage, [...page.unseenPages]]).toEqual([PageSurface.MODE, 'p2', ['p1']])
    })
  })
})
