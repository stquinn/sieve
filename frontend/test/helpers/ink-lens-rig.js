// @ts-check
// ink-lens-rig.js — what the ink lens suites share: an InkContainerProvider over
// one block whose pages the test answers, animation frames run when the test
// says, the strokes, pages and live records they feed, the transcribes of what the
// mounted SVG shows, the workspace toolbar a lens fills, and the images copied
// from it.

import { vi, expect } from 'vitest'
import { getStroke } from 'perfect-freehand'
import { InkRenderer } from '../../src/static/renderers/ink-renderer.js'
import { ImageClipboard } from '../../src/static/renderers/copy-image.js'
import { WorkspaceToolbar } from '../../src/static/shell/workspace-toolbar.js'

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

/** A transcript of a page as the host answers it. @param {string} pageId @param {Record<string, any>} [over] */
export const transcript = (pageId, over = {}) => ({
  pageId, state: 'none', key: '', blocks: [], running: false, available: true, unavailable: '', failed: '', ...over,
})

/** The blocks of a ready transcript: a heading and a Mermaid diagram. */
export const TRANSCRIPT_BLOCKS = Object.freeze([
  { id: 'b1', kind: 'prose', attrs: { id: 'b1', content: '# Kitchen\n\nTiles [?] by Friday.' } },
  { id: 'b2', kind: 'diagram', attrs: { id: 'b2', source: 'flowchart TD\n  A --> B', diagramType: 'mermaid', mode: 'render', status: 'COMPLETE' } },
])

/** An InkContainerProvider over one block whose pages and transcripts the test answers. */
export class FakeInkProvider {
  /** @type {string[]} the provider calls, in order */ calls = []
  /** @type {Set<any>} */ feedListeners = new Set()
  /** @type {Set<any>} */ modelListeners = new Set()
  /** @type {Map<string, {page: any, seq: number}>} what loadPage answers, by page */ answers = new Map()
  /** @type {boolean} when set, loadPage answers only when the test resolves it from `waiting` */ defer = false
  /** @type {Array<{pageId: string, resolve: (a: any) => void}>} */ waiting = []
  /** @type {any} what openOnTablet resolves with, or settles as when it is a promise; an Error rejects */ opening = { outcome: 'opened', reason: '' }
  /** @type {string} what the container is called */ name = ''
  /** @type {Map<string, any>} what loadTranscript answers, by page; a page with none is unread */ transcripts = new Map()
  /** @type {Map<string, any>} what transcribePage answers, by page; a page with none answers its transcript running */ transcribes = new Map()
  /** @type {any} what newDocumentFromTranscript resolves with; an Error rejects */ made = 'doc-new'
  /** @type {any} what refreshDescription settles as when it is a promise; an Error or a string rejects */ described = undefined
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
  getName() { return this.name }
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

  /** @param {string|null} pageId */
  openOnTablet(pageId) {
    this.calls.push('openOnTablet ' + pageId)
    return Promise.resolve(this.opening).then((o) => {
      if (o instanceof Error) throw o
      return deepFrozen(structuredClone(o))
    })
  }

  /** @param {string} pageId */
  loadTranscript(pageId) {
    this.calls.push('loadTranscript ' + pageId)
    return Promise.resolve(deepFrozen(structuredClone(this.transcripts.get(pageId) || transcript(pageId))))
  }

  /** @param {string} pageId */
  transcribePage(pageId) {
    this.calls.push('transcribePage ' + pageId)
    const answer = this.transcribes.get(pageId) || transcript(pageId, { running: true })
    return Promise.resolve(deepFrozen(structuredClone(answer)))
  }

  /** @param {string} pageId */
  newDocumentFromTranscript(pageId) {
    this.calls.push('newDocumentFromTranscript ' + pageId)
    return Promise.resolve(this.made).then((m) => {
      if (m instanceof Error) throw m
      return m
    })
  }

  refreshDescription() {
    this.calls.push('refreshDescription')
    return Promise.resolve(this.described).then((d) => {
      if (d instanceof Error || typeof d === 'string') throw d
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

/**
 * Stands in for ResizeObserver: an element observed takes `size` at once, as a
 * browser reports the size of an element it starts observing, and the test says
 * when it takes another.
 */
export class Resizes {
  /** @type {[number, number]|null} the content size an element observed takes at once; null for none */ size = null
  /** @type {Set<{cb: Function, targets: Set<Element>}>} */ #observers = new Set()

  install() {
    const resizes = this
    const observers = this.#observers
    vi.stubGlobal('ResizeObserver', class {
      #entry
      /** @param {Function} cb */
      constructor(cb) { this.#entry = { cb, targets: new Set() }; observers.add(this.#entry) }
      /** @param {Element} el */
      observe(el) {
        this.#entry.targets.add(el)
        if (resizes.size) resizes.resize(el, ...resizes.size)
      }
      /** @param {Element} el */
      unobserve(el) { this.#entry.targets.delete(el) }
      disconnect() { observers.delete(this.#entry) }
    })
  }

  /** @returns {number} the observers connected */
  get observing() { return this.#observers.size }

  /** @param {Element} el @param {number} width @param {number} height its content box */
  resize(el, width, height) {
    for (const o of [...this.#observers]) {
      if (o.targets.has(el)) o.cb([{ target: el, contentRect: { width, height } }], o)
    }
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

/**
 * The workspace toolbar, over a host of its own in the document, showing `lens`.
 * @param {any} lens
 * @returns {{bar: HTMLElement, toolbar: WorkspaceToolbar}}
 */
export const toolbarFor = (lens) => {
  const bar = document.createElement('div')
  bar.id = 'editor-toolbar'
  document.body.appendChild(bar)
  const toolbar = new WorkspaceToolbar(bar)
  toolbar.show(lens)
  return { bar, toolbar }
}
/** @param {HTMLElement} bar @param {string} id @returns {HTMLButtonElement|null} the toolbar item of that id */
export const item = (bar, id) => /** @type {HTMLButtonElement|null} */ (bar.querySelector(`[id="${id}"]`))
/** @param {HTMLElement} bar @param {string} id */
export const tap = (bar, id) => /** @type {HTMLButtonElement} */ (item(bar, id)).click()
/** @param {HTMLElement} bar @param {string} id @returns {string|undefined} what the drop-down of that id says while closed */
export const faceOf = (bar, id) => item(bar, id)?.closest('.tb-select')?.querySelector('.tb-select__face')?.textContent ?? undefined
/** @param {HTMLElement} bar @param {string} id @returns {string[]} the texts of the drop-down's options, in order */
export const optionsOf = (bar, id) => [.../** @type {HTMLSelectElement} */ (/** @type {unknown} */ (item(bar, id))).options].map((o) => String(o.textContent))
/** Chooses `value` in the drop-down of that id, as the reader does. @param {HTMLElement} bar @param {string} id @param {string} value */
export const choose = (bar, id, value) => {
  const select = /** @type {HTMLSelectElement} */ (/** @type {unknown} */ (item(bar, id)))
  select.value = value
  select.dispatchEvent(new Event('change', { bubbles: true }))
}
/**
 * Right-clicks `target` at a client point (0, 0 is the menu key's), and returns
 * the event and the context-menu intents the lens raised.
 * @param {any} lens @param {Element} target @param {number} [clientX] @param {number} [clientY]
 */
export const rightClick = (lens, target, clientX = 300, clientY = 200) => {
  /** @type {any[]} */
  const intents = []
  const off = lens.onEvent((/** @type {any} */ e) => { if (e.type === 'context-menu') intents.push(e) })
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX, clientY })
  let escaped = false
  const outside = () => { escaped = true }
  document.addEventListener('contextmenu', outside)
  target.dispatchEvent(event)
  document.removeEventListener('contextmenu', outside)
  off()
  return { event, intents, escaped }
}
/** @param {{items: ReadonlyArray<any>}} intent @returns {string[]} its entries, a divider as `—` and a disabled entry in brackets */
export const menuOf = (intent) => intent.items.map((i) => (i.type === 'divider' ? '—' : i.disabled ? `[${i.label}]` : i.label))
/** @param {HTMLElement} bar @returns {string[]} the ids of the toolbar's items, in order, each group's own in it */
export const toolbarIds = (bar) => [...bar.querySelectorAll('[id]')].map((el) => el.id)
/** @param {HTMLElement} bar @returns {Record<string, string[]>} each place of the toolbar drawn, by name, and the ids of its items in order, a separator as `|` */
export const placesOf = (bar) => Object.fromEntries([...bar.children].map((place) => [
  String(place.className).replace('tb-place tb-place--', ''),
  [...place.querySelectorAll('[id], .tb-sep')].map((el) => (el.classList.contains('tb-sep') ? '|' : el.id)),
]))
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
