// @ts-check
// LiveInkLens — the Live view drawn by the real InkRenderer over a fake
// InkContainerProvider: it shows the page its block names, of the note its
// block names, moves when the block moves, follows the tablet's window and the
// nib, offers the reader no gesture but Open this note, and says when it is
// waiting for the tablet.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getStroke } from 'perfect-freehand'
import { LiveInkLens } from '../src/static/lens/ink/live-ink-lens.js'
import { LiveSurface } from '../src/static/lens/ink/live-surface.js'
import { InkFeed } from '../src/static/contract/ink-container-provider.js'
import {
  ASPECT, DOTS, FakeInkProvider, Frames, GRID, begin, drag, expectWindow, exportPage, key, layOut, layer, mark, noteAttrs, pen, points,
  renderer, settle, shownWindow, strokeEls, svgOf, tabletWindow, view, viewBoxOf, wheel, copiedImages, press,
} from './helpers/ink-lens-rig.js'

const LIVE = '019a0000-0000-7000-8000-00000000live'

/**
 * The Live view's block attrs: the mirrored note's header for pages `ids`, and what it mirrors.
 * @param {{container?: string, page?: string, waiting?: boolean, ids?: string[], bounds?: string, title?: string}} [opts]
 */
const liveAttrs = (opts = {}) => ({
  ...noteAttrs(opts.ids || ['p1', 'p2'], opts.bounds),
  id: LIVE,
  title: 'Live · Note Air 2',
  live: { container: opts.container ?? 'note-x', title: opts.title ?? 'Ideas', page: opts.page ?? 'p1', waiting: opts.waiting === true },
})

/**
 * A Live lens presented over a view of `attrs`, every page of `pages` answered with `strokes` at seq 10.
 * @param {Record<string, any>} attrs @param {{pages?: string[], strokes?: any[], template?: any}} [opts]
 */
async function presented(attrs, opts = {}) {
  const provider = new FakeInkProvider(attrs, LIVE, 'ink-live')
  for (const id of opts.pages || ['p1', 'p2', 'q1', 'w1']) {
    provider.answers.set(id, { page: exportPage(opts.strokes || [pen('s-' + id)], opts.template), seq: 10 })
  }
  const lens = new LiveInkLens(LIVE, { provider })
  const root = document.createElement('div')
  document.body.appendChild(root)
  await lens.presentMode('wysiwyg', root)
  await settle()
  return { provider, lens, root, surface: /** @type {LiveSurface} */ (lens.surface) }
}

/** A whiteboard being written, laid out 600 by 800 at (100, 50). */
async function whiteboard() {
  const shown = await presented(liveAttrs({ ids: ['w1'], bounds: 'unbounded', page: 'w1' }),
    { strokes: [pen('a', 0.2, 0.2), pen('b', 2.4, 1.6)], template: DOTS })
  layOut(shown.root, {})
  return shown
}

/** @param {HTMLElement} root @param {string} selector */
const text = (root, selector) => root.querySelector(selector)?.textContent
/** @param {HTMLElement} root */
const openNote = (root) => /** @type {HTMLButtonElement} */ (root.querySelector('[data-ink-action="open-note"]'))

describe('LiveInkLens', () => {
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

  it('shows the page its block names, with the device, the note and the page as plain text', async () => {
    const { provider, root, lens } = await presented(liveAttrs({ page: 'p2' }))
    expect(lens.mode).toBe(LiveSurface.MODE)
    expect(provider.calls.slice(0, 3)).toEqual(['subscribeFeed', 'subscribe', 'loadPage p2'])
    expect([text(root, '.ink-page__title'), text(root, '.ink-page__device'), text(root, '.ink-page__position'), text(root, '.ink-page__indicator')])
      .toEqual(['Ideas', 'Note Air 2', 'Page 2 / 2', 'Live'])
    expect(strokeEls(root, 's-p2')).toHaveLength(1)
    expect(lens.stats().readout?.map((c) => c.text)).toEqual(['Live', 'Page 2 of 2', '1 stroke'])
  })

  it('draws the committed strokes and the pen live on the page written, and nothing of another page', async () => {
    const { provider, root } = await presented(liveAttrs())
    provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'p2', seq: 11, stroke: pen('elsewhere') })
    provider.emit({ type: InkFeed.LIVE, records: [begin(7), ...points(7, 0, 12), mark('end', 7)] })
    frames.run()
    expect([strokeEls(root, 'elsewhere').length, layer(root, 'live').children.length]).toEqual([0, 1])
    provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'p1', seq: 11, stroke: pen('s7', 0.5, 0.4) })
    expect([strokeEls(root, 's7').length, layer(root, 'live').children.length]).toEqual([1, 0])
    expect(root.querySelector('.ink-page__dots, [data-unseen]')).toBeNull()
  })

  it.each([
    ['to another page of the note', { page: 'p2' }, 'p2', 'Page 2 / 2', 'Ideas'],
    ['to another note', { container: 'note-y', title: 'Board', ids: ['q1'], page: 'q1' }, 'q1', 'Page 1 / 1', 'Board'],
  ])('moves with its block %s', async (_name, next, shows, position, title) => {
    const { provider, root, surface } = await presented(liveAttrs())
    provider.setAttrs(liveAttrs(next))
    await settle()
    expect([surface.shownPage, text(root, '.ink-page__position'), text(root, '.ink-page__title'), provider.loads]).toEqual([shows, position, title, 2])
    provider.emit({ type: InkFeed.STROKE_ADDED, pageId: 'p1', seq: 11, stroke: pen('old-page') })
    expect(strokeEls(root, 'old-page')).toHaveLength(0)
  })

  it('says it is waiting for the tablet, keeps the last page and draws no pen, until the tablet is live again', async () => {
    const { provider, root, surface } = await presented(liveAttrs({ page: 'p2' }))
    provider.setAttrs(liveAttrs({ page: 'p2', waiting: true }))
    await settle()
    provider.emit({ type: InkFeed.LIVE, records: [begin(7), ...points(7, 0, 4)] })
    frames.run()
    expect([surface.shownPage, provider.loads, text(root, '.ink-page__indicator'), layer(root, 'live').children.length])
      .toEqual(['p2', 1, 'Waiting for the tablet…', 0])
    expect(root.querySelector('.ink-page__indicator')?.hasAttribute('data-waiting')).toBe(true)
    provider.setAttrs(liveAttrs({ page: 'p2' }))
    provider.emit({ type: InkFeed.LIVE, records: [begin(8), ...points(8, 0, 4)] })
    frames.run()
    expect([text(root, '.ink-page__indicator'), layer(root, 'live').children.length, provider.loads]).toEqual(['Live', 1, 1])
  })

  it('Open this note asks the host to open the mirrored note, and does nothing before one is mirrored', async () => {
    const { provider, root, lens, surface } = await presented(liveAttrs())
    /** @type {any[]} */
    const intents = []
    lens.onEvent((e) => { if (e.type === 'open-container') intents.push(e) })
    openNote(root).click()
    expect(intents).toEqual([{ type: 'open-container', uuid: 'note-x' }])
    provider.setAttrs(liveAttrs({ container: '', title: '', page: '', ids: [] }))
    await settle()
    expect(openNote(root).disabled).toBe(true)
    surface.openNote()
    expect(intents).toHaveLength(1)
    expect(root.querySelector('.ink-page__empty')?.textContent).toMatch(/Nothing has been written/)
  })

  it("puts a whiteboard's window on the tablet's at a VIEW, redrawing only the ruling", async () => {
    const { provider, root } = await whiteboard()
    const svg = svgOf(root)
    const nodes = [...root.querySelectorAll('[data-stroke]')]
    const ruling = layer(root, 'ruling')
    const marks = ruling.firstElementChild
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
    expect(root.querySelector('.ink-page__edge')).toBeNull()
  })

  it.each([
    ['the last of several VIEWs heard in one frame', [[view(1, 1)], [view(2, 2)], [view(3, 4)]], tabletWindow(3, 4)],
    ["a begin's origin while no VIEW is heard", [[begin(7, 'pen', -2, 0.5)]], tabletWindow(-2, 0.5)],
    ["a VIEW over a later begin's origin", [[view(1, 2)], [begin(7, 'pen', 5, 5)]], tabletWindow(1, 2)],
  ])('follows %s, in one update', async (_name, batches, expected) => {
    const { provider, root } = await whiteboard()
    const svg = svgOf(root)
    const set = vi.spyOn(svg, 'setAttribute')
    for (const records of batches) provider.emit({ type: InkFeed.LIVE, records })
    expect(frames.queued.size).toBe(1)
    frames.run()
    expect(set.mock.calls.filter(([name]) => name === 'viewBox')).toHaveLength(1)
    expect(svg.getAttribute('viewBox')).toBe(viewBoxOf(expected))
  })

  it('offers the reader no gesture that moves the view: no pager, zoom or scale, and the wheel, a drag and the keys move nothing', async () => {
    const { provider, root, lens, surface } = await whiteboard()
    provider.emit({ type: InkFeed.LIVE, records: [view(2, 3)] })
    frames.run()
    const before = svgOf(root).getAttribute('viewBox')
    expect(wheel(root, { deltaX: 30, deltaY: 120 }).defaultPrevented).toBe(false)
    expect(wheel(root, { deltaY: -200, ctrlKey: true }).defaultPrevented).toBe(false)
    drag(root, [[400, 400], [300, 300]])
    for (const k of ['ArrowRight', '+', '-', 'PageDown', 'PageUp']) {
      const event = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
      expect(lens.claimKey(event)).toBe(false)
      expect(key(root, k).defaultPrevented).toBe(false)
    }
    frames.run()
    expect(svgOf(root).getAttribute('viewBox')).toBe(before)
    expectWindow(shownWindow(root), tabletWindow(2, 3))
    expect([...root.querySelectorAll('button')].map((b) => b.getAttribute('data-ink-action'))).toEqual(['open-note', 'copy-page'])
    expect(surface.window).not.toBeNull()
  })

  describe('a live stroke out of view on a long fixed page', () => {
    /** A page laid out 1000 wide (1333 tall) in a surround showing its top 300 px, the scroll applied to the layout. */
    const scrolled = async () => {
      const shown = await presented(liveAttrs())
      const surround = /** @type {HTMLElement} */ (shown.root.querySelector('.ink-page__surround'))
      const offset = { left: 0, top: 0 }
      surround.getBoundingClientRect = () => /** @type {DOMRect} */ ({ left: 0, top: 0, width: 1000, height: 300, right: 1000, bottom: 300 })
      const scrollTo = vi.fn((/** @type {number} */ left, /** @type {number} */ top) => { offset.left = left; offset.top = top })
      surround.scrollTo = /** @type {any} */ (scrollTo)
      svgOf(shown.root).getBoundingClientRect = () => /** @type {DOMRect} */ ({ left: -offset.left, top: -offset.top, width: 1000, height: 1000 / ASPECT, right: 1000, bottom: 1000 / ASPECT })
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

  it('fits the whole of a fixed sheet in view', async () => {
    const { root } = await presented(liveAttrs())
    const surround = /** @type {HTMLElement} */ (root.querySelector('.ink-page__surround'))
    expect([surround.dataset.scale, svgOf(root).style.width]).toEqual(['whole', '100%'])
  })

  it('reloads the page shown when the log restarts', async () => {
    const { provider, root } = await presented(liveAttrs())
    provider.answers.set('p1', { page: exportPage([pen('n1')]), seq: 2 })
    provider.emit({ type: InkFeed.LOG_RESTARTED })
    await settle()
    expect([strokeEls(root, 'n1').length, strokeEls(root, 's-p1').length, provider.loads]).toEqual([1, 0, 2])
  })

  it("Copy page copies the page as the tablet's window frames it, and Open in e-ink is not offered", async () => {
    const { provider, root } = await whiteboard()
    const copied = copiedImages()
    provider.emit({ type: InkFeed.LIVE, records: [view(2, 3)] })
    frames.run()
    press(root, 'copy-page')
    await settle()
    expect(copied).toHaveLength(1)
    expect(copied[0].svg).toContain(`viewBox="${viewBoxOf(tabletWindow(2, 3))}"`)
    expect([copied[0].width, copied[0].height]).toEqual([GRID, Math.round(GRID / ASPECT)])
    expect(text(root, '.ink-page__status')).toBe('Copied')
    expect(root.querySelector('[data-ink-action="open-on-tablet"]')).toBeNull()
    expect(provider.calls).not.toContain('openOnTablet')
  })

  it('is read-only by construction', async () => {
    const { lens } = await presented(liveAttrs())
    expect(lens.getCapabilities()).toEqual({ markdown: false, mentions: false, commands: false, blocks: false })
    expect(await lens.setMode('markdown')).toBe(false)
    expect(() => new LiveInkLens(LIVE, { provider: { getOrder: () => [], subscribe: () => {} } })).toThrow('InkContainerProvider')
  })

  it('destroy stops hearing the feed and the block, and cancels its frame and timers', async () => {
    const { provider, lens, root } = await presented(liveAttrs())
    vi.useFakeTimers()
    provider.emit({ type: InkFeed.LIVE, records: [begin(7), ...points(7, 0, 12), mark('end', 7)] })
    expect(frames.queued.size).toBe(1)
    lens.destroy()
    expect([provider.feedListeners.size, provider.modelListeners.size, frames.queued.size, vi.getTimerCount()]).toEqual([0, 0, 0, 0])
    expect(root.childElementCount).toBe(0)
  })
})

