// @ts-check
// ink-lens-rig.js — what the ink lens suites share: an InkContainerProvider over
// one block whose pages the test answers, animation frames run when the test
// says, the strokes, pages and live records they feed, the reads of what the
// mounted SVG shows, and the images copied from it.

import { vi, expect } from 'vitest'
import { getStroke } from 'perfect-freehand'
import { InkRenderer } from '../../src/static/renderers/ink-renderer.js'
import { ImageClipboard } from '../../src/static/renderers/copy-image.js'

export const UUID = '019a0000-0000-7000-8000-0000000000aa'
export const RULED = Object.freeze({ id: 'ruled', params: { spacing: 0.05, margin: 0.12 } })
export const DOTS = Object.freeze({ id: 'dots', params: { spacing: 0.04 } })
export const GRID = 1404
export const ASPECT = 0.75

/** @param {any} value @returns {any} */
const deepFrozen = (value) => {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const key of Object.keys(value)) deepFrozen(value[key])
  }
  return value
}

/** A pen stroke along a short line from (x, y). @param {string} id @param {number} [x] @param {number} [y] */
export const pen = (id, x = 0.2, y = 0.2) => ({
  id, tool: 'pen', widthClass: 2, startMillis: 0,
  points: Array.from({ length: 12 }, (_, i) => ({ x: x + i * 0.01, y: y + i * 0.004, pressure: 0.5, tMillis: i * 8, tiltX: 0, tiltY: 0, size: 0 })),
})

/** A pencil stroke whose pressure climbs, so its chunks fall in several tone bands. @param {string} id */
export const pencil = (id) => ({
  id, tool: 'pencil', widthClass: 2, startMillis: 0,
  points: Array.from({ length: 40 }, (_, i) => ({ x: 0.3 + i * 0.008, y: 0.6, pressure: 0.05 + i * 0.024, tMillis: i * 8, tiltX: 0, tiltY: 0, size: 0 })),
})

/** An export page. @param {any[]} strokes @param {any} [template] */
export const exportPage = (strokes, template = RULED) => ({
  note: { id: 'n', created: '2026-11-05T00:00:00Z', title: 'Ideas', pageAspect: 0.75, template, device: { id: 'd', name: 'Note Air 2', model: 'ONYX' } },
  strokes,
})

/** The note's block attrs for pages of these ids. @param {string[]} ids @param {string} [bounds] */
export const noteAttrs = (ids, bounds = 'fixed') => ({
  id: UUID, title: 'Ideas', note_device: { id: 'd', name: 'Note Air 2', model: 'ONYX' },
  note_companion: 'companion', note_source_id: '019a0000-0000-7000-8000-0000000000a0',
  note: { created: '2026-11-05T00:00:00Z', pageAspect: 0.75, template: RULED, pages: ids.map((id) => ({ id, template: null, bounds })) },
})

/** An InkContainerProvider over one block whose pages the test answers. */
export class FakeInkProvider {
  /** @type {string[]} the provider calls, in order */ calls = []
  /** @type {Set<any>} */ feedListeners = new Set()
  /** @type {Set<any>} */ modelListeners = new Set()
  /** @type {Map<string, {page: any, seq: number}>} what loadPage answers, by page */ answers = new Map()
  /** @type {boolean} when set, loadPage answers only when the test resolves it from `waiting` */ defer = false
  /** @type {Array<{pageId: string, resolve: (a: any) => void}>} */ waiting = []
  /** @type {any} what openOnTablet resolves with, or settles as when it is a promise; an Error rejects */ opening = { outcome: 'opened', reason: '' }
  /** @type {any} */ #block

  /** @type {string} */ #uuid
  /** @type {string} */ #kind

  /** @param {Record<string, any>} attrs @param {string} [uuid] @param {string} [kind] */
  constructor(attrs, uuid = UUID, kind = 'digital-note') {
    this.#uuid = uuid
    this.#kind = kind
    this.#block = deepFrozen({ id: uuid, kind, attrs })
  }

  getUuid() { return this.#uuid }
  getKind() { return this.#kind }
  getOrder() { return [this.#uuid] }
  /** @param {string} id */
  getBlock(id) { return id === this.#uuid ? this.#block : null }

  /** @param {any} listener */
  subscribe(listener) {
    this.calls.push('subscribe')
    this.modelListeners.add(listener)
    listener.onChanged({ blockIds: [this.#uuid], orderChanged: true, replaced: [] })
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

  openOnTablet() {
    this.calls.push('openOnTablet')
    return Promise.resolve(this.opening).then((o) => {
      if (o instanceof Error) throw o
      return deepFrozen(structuredClone(o))
    })
  }

  /** @returns {number} how many pages have been asked for */
  get loads() { return this.calls.filter((c) => c.startsWith('loadPage')).length }

  /** The block changes, and every follower is cued. @param {Record<string, any>} attrs */
  setAttrs(attrs) {
    this.#block = deepFrozen({ id: this.#uuid, kind: this.#kind, attrs })
    for (const listener of [...this.modelListeners]) listener.onChanged({ blockIds: [this.#uuid], orderChanged: false, replaced: [] })
  }

  /** @param {Record<string, any>} event */
  emit(event) {
    const frozen = deepFrozen(structuredClone(event))
    for (const listener of [...this.feedListeners]) listener.onFeed(frozen)
  }
}

/** Animation frames, run only when the test says. */
export class Frames {
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

export const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve() }

export const renderer = new InkRenderer({ getStroke })

/** @param {HTMLElement} root */
export const svgOf = (root) => /** @type {SVGSVGElement} */ (root.querySelector('.ink-page__sheet > svg'))
/** @param {HTMLElement} root @param {string} layer */
export const layer = (root, layer) => /** @type {Element} */ (root.querySelector(`g[data-ink="${layer}"]`))
/** @param {HTMLElement} root @param {string} id */
export const strokeEls = (root, id) => [...root.querySelectorAll('[data-stroke]')].filter((el) => el.getAttribute('data-stroke') === id)
/** @param {number} stroke @param {number} from @param {number} count */
export const points = (stroke, from, count) => Array.from({ length: count }, (_, i) => ({
  record: 'point', stroke, tool: null, widthClass: 0, x: 0.5 + (from + i) * 0.01, y: 0.4, pressure: 0.5, tMillis: (from + i) * 8, tiltX: 0, tiltY: 0,
}))
/** @param {number} stroke @param {'pen'|'pencil'} [tool] @param {number} [x] @param {number} [y] the stroke's origin */
export const begin = (stroke, tool = 'pen', x = 0, y = 0) => ({ record: 'begin', stroke, tool, widthClass: 2, x, y, pressure: 0, tMillis: 0, tiltX: 0, tiltY: 0 })
/** @param {number} x @param {number} y the top-left of the tablet's view */
export const view = (x, y) => ({ record: 'view', stroke: 0, tool: null, widthClass: 0, x, y, pressure: 0, tMillis: 0, tiltX: 0, tiltY: 0 })

/** The tablet's window with its top-left at (x, y): one sheet at one to one. @param {number} x @param {number} y */
export const tabletWindow = (x, y) => ({ x0: x, y0: y, x1: x + 1, y1: y + 1 / ASPECT })

/** @param {HTMLElement} root @returns {{x0: number, y0: number, x1: number, y1: number}} the viewBox, in page units */
export const shownWindow = (root) => {
  const [x, y, w, h] = String(svgOf(root).getAttribute('viewBox')).split(' ').map(Number)
  return { x0: x / GRID, y0: y / GRID, x1: (x + w) / GRID, y1: (y + h) / GRID }
}

/** @param {{x0: number, y0: number, x1: number, y1: number}} w @returns {string} the viewBox the renderer writes for it */
export const viewBoxOf = (w) => { const b = renderer.windowBox(w); return `${b.x} ${b.y} ${b.width} ${b.height}` }

/** Lays the sheet's SVG out at a size, as a browser would. @param {HTMLElement} root @param {DOMRect|any} rect */
export const layOut = (root, rect) => {
  const box = { left: 100, top: 50, width: 600, height: 800, ...rect }
  Object.assign(box, { right: box.left + box.width, bottom: box.top + box.height, x: box.left, y: box.top })
  svgOf(root).getBoundingClientRect = () => /** @type {DOMRect} */ (box)
  return box
}

/** @param {HTMLElement} root @param {string} action */
export const press = (root, action) => /** @type {HTMLButtonElement} */ (root.querySelector(`[data-ink-action="${action}"]`)).click()
/** @param {HTMLElement} root @param {string} key @param {KeyboardEventInit} [mods] */
export const key = (root, key, mods = {}) => {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...mods })
  const page = /** @type {HTMLElement} */ (root.querySelector('.ink-page'))
  page.dispatchEvent(event)
  return event
}
/** @param {HTMLElement} root @param {WheelEventInit} init */
export const wheel = (root, init) => {
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
export const drag = (root, path) => {
  const sheet = /** @type {HTMLElement} */ (root.querySelector('.ink-page__sheet'))
  const at = (/** @type {string} */ type, /** @type {number[]} */ [clientX, clientY]) =>
    sheet.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, button: 0, pointerId: 1, clientX, clientY }))
  at('pointerdown', path[0])
  for (const p of path.slice(1)) at('pointermove', p)
  at('pointerup', path[path.length - 1])
}
/** @param {{x0: number, y0: number, x1: number, y1: number}} actual @param {{x0: number, y0: number, x1: number, y1: number}} expected */
export const expectWindow = (actual, expected) => {
  for (const k of /** @type {const} */ (['x0', 'y0', 'x1', 'y1'])) expect(actual[k]).toBeCloseTo(expected[k], 3)
}
/** @param {'end'|'remove'} record @param {number} stroke */
export const mark = (record, stroke) => ({ record, stroke, tool: null, widthClass: 0, x: 0, y: 0, pressure: 0, tMillis: 0, tiltX: 0, tiltY: 0 })

/**
 * Stands in for the clipboard's PNG write: every image an ink lens copies is
 * kept, as the SVG it would be drawn from and the size it would be drawn at.
 * @returns {Array<{svg: string, width: number, height: number}>}
 */
export const copiedImages = () => {
  /** @type {Array<{svg: string, width: number, height: number}>} */
  const copied = []
  vi.spyOn(ImageClipboard.prototype, 'copySvg').mockImplementation((svg, width, height) => {
    copied.push({ svg, width, height })
    return Promise.resolve()
  })
  return copied
}
