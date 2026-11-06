// @ts-check
// DigitalNoteLens — a Digital Note's pages drawn by the real InkRenderer over a
// fake InkContainerProvider, so what is pinned is what reaches the mounted SVG:
// a page as it is answered, every committed stroke added to and trimmed from
// that same SVG, the stroke under the pen drawn once a frame and handed over to
// its committed markup, and the live page followed.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getStroke } from 'perfect-freehand'
import { DigitalNoteLens } from '../src/static/lens/ink/digital-note-lens.js'
import { PageSurface } from '../src/static/lens/ink/page-surface.js'
import { InkFeed } from '../src/static/contract/ink-container-provider.js'
import { InkRenderer } from '../src/static/renderers/ink-renderer.js'

const UUID = '019a0000-0000-7000-8000-0000000000aa'
const RULED = Object.freeze({ id: 'ruled', params: { spacing: 0.05, margin: 0.12 } })

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
/** @param {number} stroke @param {'pen'|'pencil'} [tool] */
const begin = (stroke, tool = 'pen') => ({ record: 'begin', stroke, tool, widthClass: 2, x: 0, y: 0, pressure: 0, tMillis: 0, tiltX: 0, tiltY: 0 })
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

  it('frames an unbounded page round its strokes, wherever they lie on the plane', async () => {
    const strokes = [pen('a', -0.6, -0.4), pen('b', 1.4, 0.9)]
    const { root } = await presented({ ids: ['w1'], bounds: 'unbounded', strokes })
    const [x, y, w, h] = String(svgOf(root).getAttribute('viewBox')).split(' ').map(Number)
    for (const p of strokes.flatMap((s) => s.points)) {
      expect(p.x * 1404).toBeGreaterThan(x)
      expect(p.x * 1404).toBeLessThan(x + w)
      expect(p.y * 1404).toBeGreaterThan(y)
      expect(p.y * 1404).toBeLessThan(y + h)
    }
    expect(x).toBeLessThan(0)
    expect(strokeEls(root, 'a')).toHaveLength(1)
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
