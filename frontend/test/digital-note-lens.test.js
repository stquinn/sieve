// @ts-check
// DigitalNoteLens — a Digital Note's pages drawn by the real InkRenderer over a
// fake InkContainerProvider, so what is pinned is what reaches the mounted SVG:
// a page as it is answered, every committed stroke added to and trimmed from
// that same SVG, the stroke under the pen drawn once a frame and handed over to
// its committed markup, the live page followed, and a whiteboard's window moved
// by the tablet and by the reader without the page being drawn again.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getStroke } from 'perfect-freehand'
import { DigitalNoteLens } from '../src/static/lens/ink/digital-note-lens.js'
import { PageSurface } from '../src/static/lens/ink/page-surface.js'
import { InkFeed } from '../src/static/contract/ink-container-provider.js'
import { InkRenderer } from '../src/static/renderers/ink-renderer.js'

const UUID = '019a0000-0000-7000-8000-0000000000aa'
const RULED = Object.freeze({ id: 'ruled', params: { spacing: 0.05, margin: 0.12 } })
const DOTS = Object.freeze({ id: 'dots', params: { spacing: 0.04 } })
const GRID = 1404
const ASPECT = 0.75

/** @param {any} value @returns {any} */
const deepFrozen = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFrozen(value[key])
  }
  return value
}

/** A pen stroke along a short line from (x, y). @param {string} id @param {number} [x] @param {number} [y] */
const pen = (id, x = 0.2, y = 0.2) => ({
  id, tool: 'pen', widthClass: 2, startMillis: 0,
  points: Array.from({ length: 12 }, (_, i) => ({ x: x + i * 0.01, y: y + i * 0.004, pressure: 0.5, tMillis: i * 8, tiltX: 0, tiltY: 0, size: 0 })),
})

/** A pencil stroke whose pressure climbs, so its chunks fall in several tone bands. @param {string} id */
const pencil = (id) => ({
  id, tool: 'pencil', widthClass: 2, startMillis: 0,
  points: Array.from({ length: 40 }, (_, i) => ({ x: 0.3 + i * 0.008, y: 0.6, pressure: 0.05 + i * 0.024, tMillis: i * 8, tiltX: 0, tiltY: 0, size: 0 })),
})

/** An export page. @param {any[]} strokes @param {any} [template] */
const exportPage = (strokes, template = RULED) => ({
  note: { id: 'n', created: '2026-11-05T00:00:00Z', title: 'Ideas', pageAspect: 0.75, template, device: { id: 'd', name: 'Note Air 2', model: 'ONYX' } },
  strokes,
})

/** The note's block attrs for pages of these ids. @param {string[]} ids @param {string} [bounds] */
const noteAttrs = (ids, bounds = 'fixed') => ({
  id: UUID, title: 'Ideas', note_device: { id: 'd', name: 'Note Air 2', model: 'ONYX' },
  note: { created: '2026-11-05T00:00:00Z', pageAspect: 0.75, template: RULED, pages: ids.map((id) => ({ id, template: null, bounds })) },
})

/** An InkContainerProvider over one block whose pages the test answers. */
class FakeInkProvider {
  /** @type {string[]} the provider calls, in order */ calls = []
  /** @type {Set<any>} */ feedListeners = new Set()
  /** @type {Set<any>} */ modelListeners = new Set()
  /** @type {Map<string, {page: any, seq: number}>} what loadPage answers, by page */ answers = new Map()
  /** @type {boolean} when set, loadPage answers only when the test resolves it from `waiting` */ defer = false
  /** @type {Array<{pageId: string, resolve: (a: any) => void}>} */ waiting = []
  /** @type {any} */ #block

  /** @param {Record<string, any>} attrs */
  constructor(attrs) { this.#block = deepFrozen({ id: UUID, kind: 'digital-note', attrs }) }

  getUuid() { return UUID }
  getKind() { return 'digital-note' }
  getOrder() { return [UUID] }
  /** @param {string} id */
  getBlock(id) { return id === UUID ? this.#block : null }

  /** @param {any} listener */
  subscribe(listener) {
    this.calls.push('subscribe')
    this.modelListeners.add(listener)
    listener.onChanged({ blockIds: [UUID], orderChanged: true, replaced: [] })
  }

  /** @param {any} listener */
  unsubscribe(listener) { this.modelListeners.delete(listener) }

  /** @param {any} listener */
  subscribeFeed(listener) { this.calls.push('subscribeFeed'); this.feedListeners.add(listener) }

  /** @param {any} listener */
  unsubscribeFeed(listener) { this.feedListeners.delete(listener) }

  /** @param {string} pageId */
  loadPage(pageId) {
    this.calls.push('loadPage ' + pageId)
    if (this.defer) return new Promise((resolve) => this.waiting.push({ pageId, resolve }))
    const answer = this.answers.get(pageId)
    return answer ? Promise.resolve(deepFrozen(structuredClone(answer))) : Promise.reject(new Error('no page ' + pageId))
  }

  /** @returns {number} how many pages have been asked for */
  get loads() { return this.calls.filter((c) => c.startsWith('loadPage')).length }

  /** The block changes, and every follower is cued. @param {Record<string, any>} attrs */
  setAttrs(attrs) {
    this.#block = deepFrozen({ id: UUID, kind: 'digital-note', attrs })
    for (const listener of [...this.modelListeners]) listener.onChanged({ blockIds: [UUID], orderChanged: false, replaced: [] })
  }

  /** @param {Record<string, any>} event */
  emit(event) {
    const frozen = deepFrozen(structuredClone(event))
    for (const listener of [...this.feedListeners]) listener.onFeed(frozen)
  }
}

/** Animation frames, run only when the test says. */
class Frames {
  /** @type {Map<number, FrameRequestCallback>} */ queued = new Map()
  /** @type {number[]} */ cancelled = []
  #next = 1

  install() {
    vi.stubGlobal('requestAnimationFrame', (/** @type {FrameRequestCallback} */ cb) => { const id = this.#next++; this.queued.set(id, cb); return id })
    vi.stubGlobal('cancelAnimationFrame', (/** @type {number} */ id) => { this.cancelled.push(id); this.queued.delete(id) })
  }

  run() {
    const due = [...this.queued.values()]
    this.queued.clear()
    for (const cb of due) cb(0)
  }
}

const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }

const renderer = new InkRenderer({ getStroke })

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
const svgOf = (root) => /** @type {SVGSVGElement} */ (root.querySelector('.ink-page__sheet > svg'))
/** @param {HTMLElement} root @param {string} layer */
const layer = (root, layer) => /** @type {Element} */ (root.querySelector(`g[data-ink="${layer}"]`))
/** @param {HTMLElement} root @param {string} id */
const strokeEls = (root, id) => [...root.querySelectorAll('[data-stroke]')].filter((el) => el.getAttribute('data-stroke') === id)
/** @param {HTMLElement} root */
const position = (root) => root.querySelector('.ink-page__position')?.textContent
/** @param {HTMLElement} root */
const liveButton = (root) => /** @type {HTMLButtonElement} */ (root.querySelector('[data-ink-action="live"]'))
/** @param {HTMLElement} root @param {string} pageId */
const dot = (root, pageId) => /** @type {HTMLElement} */ (root.querySelector(`[data-ink-page="${pageId}"]`))

/** @param {number} stroke @param {number} from @param {number} count */
const points = (stroke, from, count) => Array.from({ length: count }, (_, i) => ({
  record: 'point', stroke, tool: null, widthClass: 0, x: 0.5 + (from + i) * 0.01, y: 0.4, pressure: 0.5, tMillis: (from + i) * 8, tiltX: 0, tiltY: 0,
}))
/** @param {number} stroke @param {'pen'|'pencil'} [tool] @param {number} [x] @param {number} [y] the stroke's origin */
const begin = (stroke, tool = 'pen', x = 0, y = 0) => ({ record: 'begin', stroke, tool, widthClass: 2, x, y, pressure: 0, tMillis: 0, tiltX: 0, tiltY: 0 })
/** @param {number} x @param {number} y the top-left of the tablet's view */
const view = (x, y) => ({ record: 'view', stroke: 0, tool: null, widthClass: 0, x, y, pressure: 0, tMillis: 0, tiltX: 0, tiltY: 0 })

/** The tablet's window with its top-left at (x, y): one sheet at one to one. @param {number} x @param {number} y */
const tabletWindow = (x, y) => ({ x0: x, y0: y, x1: x + 1, y1: y + 1 / ASPECT })

/** @param {HTMLElement} root @returns {{x0: number, y0: number, x1: number, y1: number}} the viewBox, in page units */
const shownWindow = (root) => {
  const [x, y, w, h] = String(svgOf(root).getAttribute('viewBox')).split(' ').map(Number)
  return { x0: x / GRID, y0: y / GRID, x1: (x + w) / GRID, y1: (y + h) / GRID }
}

/** @param {{x0: number, y0: number, x1: number, y1: number}} w @returns {string} the viewBox the renderer writes for it */
const viewBoxOf = (w) => { const b = renderer.windowBox(w); return `${b.x} ${b.y} ${b.width} ${b.height}` }

/** Lays the sheet's SVG out at a size, as a browser would. @param {HTMLElement} root @param {DOMRect|any} rect */
const layOut = (root, rect) => {
  const box = { left: 100, top: 50, width: 600, height: 800, ...rect }
  Object.assign(box, { right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top })
  svgOf(root).getBoundingClientRect = () => /** @type {DOMRect} */ (box)
  return box
}

/** A whiteboard of these strokes, laid out 600 by 800 at (100, 50). @param {any[]} [strokes] */
async function whiteboard(strokes = [pen('a', 0.2, 0.2), pen('b', 2.4, 1.6)]) {
  const shown = await presented({ ids: ['w1'], bounds: 'unbounded', strokes, template: DOTS })
  layOut(shown.root, {})
  return shown
}

/** A whiteboard that is live and following the tablet, whose view is at (2, 3). @param {Frames} frames */
async function followedWhiteboard(frames) {
  const shown = await whiteboard()
  shown.provider.emit({ type: InkFeed.LIVE_PAGE, live: true, pageId: 'w1' })
  shown.provider.emit({ type: InkFeed.LIVE, records: [view(2, 3)] })
  frames.run()
  return shown
}

/** @param {HTMLElement} root @param {string} action */
const press = (root, action) => /** @type {HTMLButtonElement} */ (root.querySelector(`[data-ink-action="${action}"]`)).click()
/** @param {HTMLElement} root @param {string} key @param {KeyboardEventInit} [mods] */
const key = (root, key, mods = {}) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods })
  const page = /** @type {HTMLElement} */ (root.querySelector('.ink-page'))
  page.dispatchEvent(event)
  return event
}
/** @param {HTMLElement} root @param {WheelEventInit} init */
const wheel = (root, init) => {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init })
  // happy-dom's WheelEvent keeps only the deltas of its init.
  for (const [name, value] of Object.entries(init)) {
    if (/** @type {any} */ (event)[name] !== value) Object.defineProperty(event, name, { value })
  }
  const surround = /** @type {HTMLElement} */ (root.querySelector('.ink-page__surround'))
  surround.dispatchEvent(event)
  return event
}
/** Drags the sheet with the primary button. @param {HTMLElement} root @param {number[][]} path client points */
const drag = (root, path) => {
  const sheet = /** @type {HTMLElement} */ (root.querySelector('.ink-page__sheet'))
  const at = (/** @type {string} */ type, /** @type {number[]} */ [clientX, clientY]) =>
    sheet.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX, clientY }))
  at('pointerdown', path[0])
  for (const p of path.slice(1)) at('pointermove', p)
  at('pointerup', path[path.length - 1])
}
/** @param {HTMLElement} root @returns {string[]} the edges whose mark shows */
const edgeMarks = (root) => [...root.querySelectorAll('.ink-page__edge')].filter((el) => !(/** @type {HTMLElement} */ (el)).hidden).map((el) => String(el.getAttribute('data-ink-edge')))

/** @param {{x0: number, y0: number, x1: number, y1: number}} actual @param {{x0: number, y0: number, x1: number, y1: number}} expected */
const expectWindow = (actual, expected) => {
  for (const k of /** @type {const} */ (['x0', 'y0', 'x1', 'y1'])) expect(actual[k]).toBeCloseTo(expected[k], 3)
}
/** @param {'end'|'remove'} record @param {number} stroke */
const mark = (record, stroke) => ({ record, stroke, tool: null, widthClass: 0, x: 0, y: 0, pressure: 0, tMillis: 0, tiltX: 0, tiltY: 0 })

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
    provider.emit({ type: InkFeed.LIVE_PAGE, live: true, pageId: 'p1' })
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
    provider.emit({ type: InkFeed.LIVE_PAGE, live: true, pageId: 'p1' })
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
    provider.emit({ type: InkFeed.LIVE_PAGE, live: true, pageId: 'p1' })
    provider.emit({ type: InkFeed.LIVE, records: [begin(7, 'pencil'), ...points(7, 0, 12), mark('end', 7)] })
    frames.run()
    provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'p1', seq: 11, stroke: pen('s7') })
    expect(layer(root, 'live').children).toHaveLength(1)
    vi.advanceTimersByTime(3000)
    expect(layer(root, 'live').children).toHaveLength(0)
  })

  it('drops a live stroke the tablet abandons', async () => {
    const { provider, root } = await presented()
    provider.emit({ type: InkFeed.LIVE_PAGE, live: true, pageId: 'p1' })
    provider.emit({ type: InkFeed.LIVE, records: [begin(7), ...points(7, 0, 12)] })
    frames.run()
    provider.emit({ type: InkFeed.LIVE, records: [mark('remove', 7)] })
    expect(layer(root, 'live').children).toHaveLength(0)
  })

  it('draws no live records while the page shown is not the live page', async () => {
    const { provider, root, surface } = await presented()
    provider.emit({ type: InkFeed.LIVE_PAGE, live: true, pageId: 'p1' })
    surface.turn(1)
    await settle()
    provider.emit({ type: InkFeed.LIVE, records: [begin(7), ...points(7, 0, 12)] })
    expect(frames.queued.size).toBe(0)
    expect(layer(root, 'live').children).toHaveLength(0)
  })

  it('follows the live page, pauses on a turn by hand, and the live affordance resumes it', async () => {
    const { provider, root, surface } = await presented()
    expect(liveButton(root).hidden).toBe(true)
    provider.emit({ type: InkFeed.LIVE_PAGE, live: true, pageId: 'p2' })
    await settle()
    expect([position(root), surface.shownPage, liveButton(root).hidden, liveButton(root).textContent]).toEqual(['2 / 2', 'p2', false, 'Live'])

    surface.turn(-1)
    await settle()
    expect([surface.shownPage, liveButton(root).textContent]).toEqual(['p1', 'Back to live'])
    provider.emit({ type: InkFeed.LIVE_PAGE, live: true, pageId: 'p2' })
    expect(surface.shownPage).toBe('p1')

    liveButton(root).click()
    await settle()
    expect([surface.shownPage, liveButton(root).getAttribute('aria-pressed')]).toEqual(['p2', 'true'])

    provider.emit({ type: InkFeed.LIVE_PAGE, live: false, pageId: null })
    expect(liveButton(root).hidden).toBe(true)
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

  it("moves the window onto the tablet's at a VIEW, redrawing only the ruling", async () => {
    const { provider, root } = await whiteboard()
    const svg = svgOf(root)
    const nodes = [...root.querySelectorAll('[data-stroke]')]
    const ruling = layer(root, 'ruling')
    const marks = ruling.firstElementChild
    provider.emit({ type: InkFeed.LIVE_PAGE, live: true, pageId: 'w1' })
    provider.emit({ type: InkFeed.LIVE, records: [view(-1.3, 2.17)] })
    frames.run()
    expect(svgOf(root)).toBe(svg)
    expect([...root.querySelectorAll('[data-stroke]')]).toEqual(nodes)
    expect(layer(root, 'ruling')).toBe(ruling)
    expect(ruling.firstElementChild).not.toBe(marks)
    const w = tabletWindow(-1.3, 2.17)
    expect(svg.getAttribute('viewBox')).toBe(viewBoxOf(w))
    const box = renderer.windowBox(w)
    expect([svg.getAttribute('width'), svg.getAttribute('height')]).toEqual([box.width, box.height])
    const background = /** @type {Element} */ ([...svg.children].find((el) => el.tagName.toLowerCase() === 'rect'))
    expect([background.getAttribute('x'), background.getAttribute('y')]).toEqual([box.x, box.y])
    const step = DOTS.params.spacing * GRID
    const centres = [...String(ruling.firstElementChild?.getAttribute('d')).matchAll(/M(-?[\d.]+) (-?[\d.]+)m/g)].map((m) => [Number(m[1]), Number(m[2])])
    expect(centres.length).toBeGreaterThan(100)
    for (const [x, y] of centres) {
      expect(x).toBe(Math.round(Math.round(x / step) * step))
      expect(y).toBe(Math.round(Math.round(y / step) * step))
      expect(x).toBeGreaterThan(w.x0 * GRID - 4)
      expect(y).toBeLessThan(w.y1 * GRID + 4)
    }
    expect(Math.min(...centres.map(([x]) => x))).toBe(Math.round(Math.ceil((w.x0 * GRID - 3) / step) * step))
  })

  it.each([
    ['the last of several VIEWs heard in one frame', [[view(1, 1)], [view(2, 2)], [view(3, 4)]], tabletWindow(3, 4)],
    ["a begin's origin while no VIEW is heard", [[begin(7, 'pen', -2, 0.5)]], tabletWindow(-2, 0.5)],
    ["a VIEW over a later begin's origin", [[view(1, 2)], [begin(7, 'pen', 5, 5)]], tabletWindow(1, 2)],
  ])('follows %s, in one update', async (_name, batches, expected) => {
    const { provider, root } = await whiteboard()
    provider.emit({ type: InkFeed.LIVE_PAGE, live: true, pageId: 'w1' })
    const svg = svgOf(root)
    const set = vi.spyOn(svg, 'setAttribute')
    for (const records of batches) provider.emit({ type: InkFeed.LIVE, records })
    expect(frames.queued.size).toBe(1)
    frames.run()
    expect(set.mock.calls.filter(([name]) => name === 'viewBox')).toHaveLength(1)
    expect(svg.getAttribute('viewBox')).toBe(viewBoxOf(expected))
  })

  /** The plane point under a client point of the laid-out sheet. */
  const planeAt = (/** @type {HTMLElement} */ root, /** @type {number} */ cx, /** @type {number} */ cy) => {
    const w = shownWindow(root)
    return { x: w.x0 + (cx - 100) / 600 * (w.x1 - w.x0), y: w.y0 + (cy - 50) / 800 * (w.y1 - w.y0) }
  }

  it.each([
    ['dragging the sheet', (/** @type {HTMLElement} */ root) => drag(root, [[400, 400], [350, 380], [300, 350]]),
      (/** @type {any} */ before, /** @type {any} */ after) => expectWindow(after, { x0: before.x0 + 100 / 600, y0: before.y0 + 50 / 600, x1: before.x1 + 100 / 600, y1: before.y1 + 50 / 600 })],
    ['the wheel', (/** @type {HTMLElement} */ root) => expect(wheel(root, { deltaX: 30, deltaY: 120 }).defaultPrevented).toBe(true),
      (/** @type {any} */ before, /** @type {any} */ after) => expectWindow(after, { x0: before.x0 + 30 / 600, y0: before.y0 + 120 / 600, x1: before.x1 + 30 / 600, y1: before.y1 + 120 / 600 })],
    ['Ctrl and the wheel, about the pointer', (/** @type {HTMLElement} */ root) => wheel(root, { deltaY: -200, ctrlKey: true, clientX: 250, clientY: 300 }),
      (/** @type {any} */ before, /** @type {any} */ after, /** @type {HTMLElement} */ root) => {
        expect(after.x1 - after.x0).toBeCloseTo((before.x1 - before.x0) / Math.exp(0.4), 4)
        const p = planeAt(root, 250, 300)
        expect(p.x).toBeCloseTo(before.x0 + 150 / 600 * (before.x1 - before.x0), 3)
        expect(p.y).toBeCloseTo(before.y0 + 250 / 800 * (before.y1 - before.y0), 3)
      }],
    ['an arrow key', (/** @type {HTMLElement} */ root) => expect(key(root, 'ArrowRight').defaultPrevented).toBe(true),
      (/** @type {any} */ before, /** @type {any} */ after) => expectWindow(after, { ...before, x0: before.x0 + 0.1, x1: before.x1 + 0.1 })],
    ['the + key', (/** @type {HTMLElement} */ root) => expect(key(root, '+', { shiftKey: true }).defaultPrevented).toBe(true),
      (/** @type {any} */ before, /** @type {any} */ after) => {
        expect(after.x1 - after.x0).toBeCloseTo(0.8, 4)
        expect((after.x0 + after.x1) / 2).toBeCloseTo((before.x0 + before.x1) / 2, 4)
      }],
    ['the zoom out button', (/** @type {HTMLElement} */ root) => press(root, 'zoom-out'),
      (/** @type {any} */ before, /** @type {any} */ after) => {
        expect(after.x1 - after.x0).toBeCloseTo(1.25, 4)
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
  ])('%s moves the window and pauses following until the live button resumes it', async (_name, gesture, check) => {
    const { provider, root } = await followedWhiteboard(frames)
    const before = shownWindow(root)
    expectWindow(before, tabletWindow(2, 3))
    gesture(root)
    frames.run()
    check(before, shownWindow(root), root)
    expect([liveButton(root).textContent, liveButton(root).getAttribute('aria-pressed')]).toEqual(['Back to live', 'false'])
    const moved = svgOf(root).getAttribute('viewBox')
    provider.emit({ type: InkFeed.LIVE, records: [view(-4, -4)] })
    frames.run()
    expect(svgOf(root).getAttribute('viewBox')).toBe(moved)
    liveButton(root).click()
    frames.run()
    expect(svgOf(root).getAttribute('viewBox')).toBe(viewBoxOf(tabletWindow(-4, -4)))
    expect(liveButton(root).getAttribute('aria-pressed')).toBe('true')
    provider.emit({ type: InkFeed.LIVE, records: [view(1, 1)] })
    frames.run()
    expect(svgOf(root).getAttribute('viewBox')).toBe(viewBoxOf(tabletWindow(1, 1)))
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

  describe('a live stroke out of view on a followed fixed page', () => {
    /** A fixed page laid out 1000 wide (1333 tall) in a surround showing its top 300 px, the scroll applied to the layout. */
    const scrolled = async () => {
      const shown = await presented()
      const surround = /** @type {HTMLElement} */ (shown.root.querySelector('.ink-page__surround'))
      const offset = { left: 0, top: 0 }
      surround.getBoundingClientRect = () => /** @type {DOMRect} */ ({ left: 0, top: 0, width: 1000, height: 300, right: 1000, bottom: 300 })
      const scrollTo = vi.fn((/** @type {number} */ left, /** @type {number} */ top) => { offset.left = left; offset.top = top })
      surround.scrollTo = /** @type {any} */ (scrollTo)
      svgOf(shown.root).getBoundingClientRect = () => /** @type {DOMRect} */ ({ left: -offset.left, top: -offset.top, width: 1000, height: 1000 / ASPECT, right: 1000, bottom: 1000 / ASPECT })
      shown.provider.emit({ type: InkFeed.LIVE_PAGE, live: true, pageId: 'p1' })
      return { ...shown, surround, scrollTo }
    }

    it('is scrolled into view the least needed, once', async () => {
      const { provider, scrollTo } = await scrolled()
      provider.emit({ type: InkFeed.LIVE, records: [begin(7), ...points(7, 0, 4)] })
      frames.run()
      provider.emit({ type: InkFeed.LIVE, records: points(7, 4, 4) })
      frames.run()
      expect(scrollTo).toHaveBeenCalledTimes(1)
      const [left, top] = scrollTo.mock.calls[0]
      expect([left, top]).toEqual([0, expect.closeTo(400 - 300 + 48, 6)])
    })

    it('is left alone while the reader is scrolling', async () => {
      const { provider, surround, scrollTo } = await scrolled()
      surround.dispatchEvent(new Event('scroll'))
      provider.emit({ type: InkFeed.LIVE, records: [begin(7), ...points(7, 0, 4)] })
      frames.run()
      expect(scrollTo).not.toHaveBeenCalled()
    })
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
    provider.emit({ type: InkFeed.LIVE_PAGE, live: true, pageId: 'p1' })
    provider.emit({ type: InkFeed.LIVE, records: [begin(7), ...points(7, 0, 12), mark('end', 7)] })
    expect(frames.queued.size).toBe(1)
    lens.destroy()
    expect([provider.feedListeners.size, provider.modelListeners.size, frames.queued.size, vi.getTimerCount()]).toEqual([0, 0, 0, 0])
    expect(root.childElementCount).toBe(0)
  })
})
