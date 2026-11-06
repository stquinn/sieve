// @ts-check
// The one surface DigitalNoteLens has: one page of the note at a time, drawn as
// the renderer's SVG on a white sheet, with the page chrome above it. It hears
// the container's feed itself, so the page it shows takes committed strokes and
// the stroke under the pen as they arrive, and offers nothing to write with.
//
// The SVG is built once per page shown and is then only added to and trimmed:
// a committed stroke's markup is parsed into nodes and appended to its layers, a
// removed stroke's nodes are taken out, and a live stroke's one path is swapped
// in the `live` layer. Only showing a page — a turn, a change to the page's own
// entry in the block, a restarted log — draws the SVG again.

import { AbstractSurface } from '../abstract-surface.js'
import { InkRenderer, INK_LAYERS } from '../../renderers/ink-renderer.js'
import { InkFeed } from '../../contract/ink-container-provider.js'
import { rendererStyles } from '../../renderers/renderer-style-registry.js'

/** @typedef {import('../../contract/ink-container-provider.js').InkContainerProvider} InkContainerProvider */
/** @typedef {import('../../contract/ink-container-provider.js').InkFeedEvent} InkFeedEvent */
/** @typedef {import('../../contract/ink-container-provider.js').InkLiveRecord} InkLiveRecord */
/** @typedef {import('../../contract/ink-container-provider.js').InkPage} InkPage */
/** @typedef {import('../../contract/ink-container-provider.js').InkPageStroke} InkPageStroke */
/** @typedef {import('../../renderers/ink-renderer.js').InkWindow} InkWindow */

/**
 * A page as the note's block lists it.
 * @typedef {Readonly<{id: string, template?: any, bounds?: string}>} PageEntry
 */

/**
 * A stroke under the pen: what its begin said, the points so far, and the path
 * drawn for it.
 * @typedef {object} LiveStroke
 * @property {'pen'|'pencil'} tool
 * @property {1|2|3} widthClass
 * @property {{x: number, y: number, pressure: number, tMillis: number}[]} points
 * @property {boolean} ended
 * @property {Element|null} el
 * @property {ReturnType<typeof setTimeout>|null} linger
 */

/** How long an ended live stroke stays drawn when no committed stroke claims it. */
const LIVE_LINGER_MS = 3000

/** Space left round the strokes of an unbounded page, in page units. */
const UNBOUNDED_MARGIN = 0.05

export class PageSurface extends AbstractSurface {
  /** The mode this surface presents. */
  static MODE = 'page'

  /** How the sheet is sized: to the surround's width, or one grid unit to a CSS pixel. */
  static Scale = Object.freeze({ FIT: 'fit', ACTUAL: 'actual' })

  static styles = /* css */ `
  .ink-page {
    display: flex;
    flex-direction: column;
    min-height: 100%;
    background: var(--theme-bgDark);
    outline: none;
  }

  .ink-page__chrome {
    position: sticky;
    top: 0;
    z-index: 1;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px 16px;
    padding: 8px 24px;
    background: var(--theme-bg);
    border-bottom: 1px solid var(--theme-border);
    color: var(--theme-textDim);
    font-family: var(--theme-uiFont);
    font-size: 0.85em;
  }

  .ink-page__heading {
    display: flex;
    align-items: baseline;
    gap: 10px;
    min-width: 0;
    flex: 1 1 auto;
  }

  .ink-page__title {
    color: var(--theme-text);
    font-size: 1.1em;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ink-page__device { color: var(--theme-muted); white-space: nowrap; }

  .ink-page__notice { color: var(--theme-accentYellow); }

  .ink-page__pager {
    display: flex;
    align-items: center;
    gap: 6px;
  }

  .ink-page__pager button {
    border: 1px solid transparent;
    border-radius: 4px;
    background: none;
    color: var(--theme-textDim);
    font: inherit;
    padding: 2px 8px;
    cursor: pointer;
  }

  .ink-page__pager button:hover:not(:disabled) {
    color: var(--theme-text);
    border-color: var(--theme-border2);
  }

  .ink-page__pager button:disabled { opacity: 0.4; cursor: default; }

  .ink-page__position {
    font-variant-numeric: tabular-nums;
    color: var(--theme-text);
    min-width: 4.5em;
    text-align: center;
  }

  .ink-page__dots { display: flex; flex-wrap: wrap; gap: 2px; }

  .ink-page__pager .ink-page__dot {
    position: relative;
    width: 14px;
    height: 14px;
    padding: 0;
  }

  .ink-page__dot::before {
    content: '';
    position: absolute;
    inset: 4px;
    border-radius: 50%;
    background: var(--theme-border2);
  }

  .ink-page__dot[aria-current="page"]::before { background: var(--theme-text); }

  .ink-page__dot[data-unseen]::after {
    content: '';
    position: absolute;
    top: 0;
    right: 0;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--theme-accentPrimary);
  }

  .ink-page__pager .ink-page__live {
    color: var(--theme-accentRed);
    border-color: color-mix(in srgb, var(--theme-accentRed) 40%, transparent);
  }

  .ink-page__live::before {
    content: '';
    display: inline-block;
    width: 7px;
    height: 7px;
    margin-right: 6px;
    border-radius: 50%;
    background: var(--theme-accentRed);
    vertical-align: 1px;
  }

  .ink-page__live[aria-pressed="false"]::before { background: none; box-shadow: inset 0 0 0 1px var(--theme-accentRed); }

  .ink-page__surround {
    flex: 1 1 auto;
    overflow-x: auto;
    padding: 24px;
  }

  .ink-page__sheet {
    margin: 0 auto;
    width: fit-content;
    box-shadow: 0 0 0 1px var(--theme-border2), 0 2px 10px color-mix(in srgb, var(--theme-text) 18%, transparent);
  }

  .ink-page[data-scale="fit"] .ink-page__sheet { width: auto; max-width: 100%; }

  .ink-page__sheet > svg { display: block; height: auto; }

  .ink-page__empty {
    margin: 48px auto;
    color: var(--theme-muted);
    text-align: center;
  }
`

  /** @type {InkContainerProvider} */ #provider
  /** @type {(event: KeyboardEvent) => boolean} */ #claimKey
  /** @type {InkRenderer} */ #renderer = new InkRenderer()

  /** @type {boolean} between mount and unmount */ #mounted = false
  /** @type {HTMLElement} */ #root
  /** @type {HTMLElement} */ #title
  /** @type {HTMLElement} */ #device
  /** @type {HTMLElement} */ #notice
  /** @type {HTMLElement} */ #position
  /** @type {HTMLElement} */ #dots
  /** @type {HTMLButtonElement} */ #prev
  /** @type {HTMLButtonElement} */ #next
  /** @type {HTMLButtonElement} */ #scaleButton
  /** @type {HTMLButtonElement} */ #liveButton
  /** @type {HTMLElement} */ #surround
  /** @type {HTMLElement} */ #sheet

  /** @type {ReadonlyArray<PageEntry>} */ #pages = []
  /** @type {any} the note header's attrs: pageAspect, template */ #note = {}

  /** @type {string|null} the page shown, null when the note has none */ #shown = null
  /** @type {boolean} whether a page, or the note's having none, has been shown */ #painted = false
  /** @type {number} the seq of the log the shown page reflects */ #seq = 0
  /** @type {number} the load the shown page waits on; 0 when it is drawn */ #loading = 0
  /** @type {number} the last load asked for, so an answer to an older one is dropped */ #loads = 0
  /** @type {InkFeedEvent[]} stroke events for the shown page heard while it loads */ #held = []
  /** @type {string|null} the page the SVG on the sheet draws */ #drawn = null
  /** @type {InkWindow|null} the part of the plane an unbounded page is drawn through; null for a fixed page */ #window = null
  /** @type {Map<string, Element>|null} the drawn SVG's layers by name; null while none is drawn for the shown page */ #layers = null
  /** @type {Map<string, Element[]>} every drawn element of each committed stroke, by stroke id */ #strokes = new Map()

  /** @type {Set<string>} pages with ink not seen since it arrived */ #unseen = new Set()
  /** @type {string|null} the page the tablet shows as written; null when the note is not live */ #livePage = null
  /** @type {boolean} whether the shown page follows the live page */ #following = true
  /** @type {Map<number, LiveStroke>} the strokes under the pen, in the order they began */ #live = new Map()
  /** @type {Set<number>} live strokes whose path is out of date */ #stale = new Set()
  /** @type {number} the pending animation frame; 0 when none */ #frame = 0

  /** @type {string} */ #scale = PageSurface.Scale.FIT

  /**
   * @param {InkContainerProvider} provider the note's provider; its feed is heard
   *   from mount to unmount
   * @param {(event: KeyboardEvent) => boolean} claimKey the lens's key claim,
   *   asked first for every key pressed in the surface
   */
  constructor(provider, claimKey) {
    super()
    this.#provider = provider
    this.#claimKey = claimKey
    rendererStyles.register(PageSurface)
    this.#root = this.#el('div', 'ink-page')
    this.#root.tabIndex = 0
    this.#root.dataset.scale = this.#scale
    const chrome = this.#el('header', 'ink-page__chrome')
    const heading = this.#el('div', 'ink-page__heading')
    this.#title = this.#el('span', 'ink-page__title')
    this.#device = this.#el('span', 'ink-page__device')
    heading.append(this.#title, this.#device)
    this.#notice = this.#el('span', 'ink-page__notice')
    this.#notice.hidden = true
    const pager = this.#el('nav', 'ink-page__pager')
    pager.setAttribute('aria-label', 'Pages')
    this.#prev = this.#button('prev', '‹', 'Previous page')
    this.#position = this.#el('span', 'ink-page__position')
    this.#next = this.#button('next', '›', 'Next page')
    this.#dots = this.#el('span', 'ink-page__dots')
    this.#scaleButton = this.#button('scale', '', '')
    this.#liveButton = this.#button('live', '', 'Follow the page being written')
    this.#liveButton.className = 'ink-page__live'
    this.#liveButton.hidden = true
    pager.append(this.#prev, this.#position, this.#next, this.#dots, this.#scaleButton, this.#liveButton)
    chrome.append(heading, this.#notice, pager)
    this.#surround = this.#el('div', 'ink-page__surround')
    this.#sheet = this.#el('div', 'ink-page__sheet')
    this.#surround.appendChild(this.#sheet)
    this.#root.append(chrome, this.#surround)
  }

  /** @returns {string} */
  get mode() { return PageSurface.MODE }

  /** @returns {{ chars: number, lines: number, blockCount: number }} */
  stats() { return { chars: 0, lines: 0, blockCount: 0 } }

  /** @returns {string|null} the id of the page shown */
  get shownPage() { return this.#shown }

  /** @returns {string} one of PageSurface.Scale */
  get scale() { return this.#scale }

  /**
   * Puts the page in the editor's root and starts hearing the feed, which is
   * before the container's first cue asks for a page.
   * @param {HTMLElement} rootEl
   */
  mount(rootEl) {
    this.#root.addEventListener('click', this.#onClick)
    this.#root.addEventListener('keydown', this.#onKeyDown)
    rootEl.appendChild(this.#root)
    this.#mounted = true
    this.#provider.subscribeFeed(this)
  }

  /** Stops hearing the feed, drops every pending frame, timer and load, and
   *  removes the DOM. */
  unmount() {
    this.#provider.unsubscribeFeed(this)
    this.#mounted = false
    this.#clearLive()
    if (this.#frame) cancelAnimationFrame(this.#frame)
    this.#frame = 0
    this.#loads++
    this.#root.removeEventListener('click', this.#onClick)
    this.#root.removeEventListener('keydown', this.#onKeyDown)
    this.#root.remove()
    this.#layers = null
  }

  /**
   * The note's block changed: the chrome is redrawn from it, and a page is drawn
   * only when the page to show is another one, its own entry changed, or it is
   * not drawn (its load failed).
   * @param {unknown} _change @param {InkContainerProvider} provider
   */
  applyContainerChange(_change, provider) {
    const index = this.#indexOf(this.#shown)
    const before = this.#drawnWith(this.#shown)
    this.#read(provider)
    const target = this.#target(index)
    const undrawn = target !== null && target !== this.#drawn && !this.#loading
    if (!this.#painted || undrawn || target !== this.#shown || this.#drawnWith(target) !== before) this.#show(target)
    else this.#renderChrome()
  }

  /** Draws the shown page again from the note as it now stands.
   *  @param {InkContainerProvider} provider */
  paintContainer(provider) {
    const index = this.#indexOf(this.#shown)
    this.#read(provider)
    this.#show(this.#target(index))
  }

  /**
   * The page to show: the live page while it is followed, else the page shown
   * while the note lists it, else the page now at the shown page's index (the
   * first, before any is shown), else none.
   * @param {number} index the shown page's index before the block changed
   * @returns {string|null}
   */
  #target(index) {
    if (this.#following && this.#livePage !== null && this.#indexOf(this.#livePage) >= 0) return this.#livePage
    if (this.#indexOf(this.#shown) >= 0) return this.#shown
    const at = Math.min(Math.max(index, 0), this.#pages.length - 1)
    return at >= 0 ? this.#pages[at].id : null
  }

  flushPending() {}

  /**
   * One event of the note's feed.
   * @param {InkFeedEvent} event
   */
  onFeed(event) {
    if (!this.#mounted) return
    switch (event.type) {
      case InkFeed.STROKE_ADDED:
      case InkFeed.STROKE_REMOVED:
        this.#onStroke(event)
        break
      case InkFeed.LIVE:
        this.#onLive(event.records)
        break
      case InkFeed.LIVE_PAGE:
        this.#onLivePage(event.live ? event.pageId : null)
        break
      case InkFeed.LOG_RESTARTED:
        this.#unseen.clear()
        this.#clearLive()
        this.#show(this.#shown ?? (this.#pages.length ? this.#pages[0].id : null))
        break
    }
  }

  /**
   * Shows the page `delta` pages on from the shown one, clamped to the note. A
   * page turned to by hand pauses following unless it is the live page.
   * @param {number} delta
   */
  turn(delta) {
    const index = this.#indexOf(this.#shown)
    const to = Math.min(Math.max(index + delta, 0), this.#pages.length - 1)
    if (to < 0 || to === index) return
    this.#navigate(this.#pages[to].id)
  }

  /** Shows the live page and follows it from now on. Does nothing while the
   *  note is not live. */
  returnToLive() {
    if (this.#livePage === null) return
    this.#following = true
    if (this.#livePage !== this.#shown) this.#show(this.#livePage)
    else this.#renderChrome()
  }

  /** Switches the sheet between fitting the surround's width and actual size. */
  toggleScale() {
    this.#scale = this.#scale === PageSurface.Scale.FIT ? PageSurface.Scale.ACTUAL : PageSurface.Scale.FIT
    this.#applyScale()
    this.#renderChrome()
  }

  /** @param {string} pageId */
  #navigate(pageId) {
    if (this.#livePage !== null) this.#following = pageId === this.#livePage
    this.#show(pageId)
  }

  /** @param {InkContainerProvider} provider */
  #read(provider) {
    const id = provider.getOrder()[0]
    const block = id ? provider.getBlock(id) : null
    const attrs = (block && block.attrs) || {}
    this.#note = attrs.note || {}
    this.#pages = Array.isArray(this.#note.pages) ? this.#note.pages.filter((/** @type {any} */ p) => p && p.id) : []
    this.#title.textContent = String(attrs.title || 'Untitled note')
    this.#device.textContent = String((attrs.note_device && attrs.note_device.name) || '')
  }

  /** What the drawing of a page depends on in the block, as one comparable string.
   *  @param {string|null} pageId @returns {string} */
  #drawnWith(pageId) {
    const entry = this.#pages[this.#indexOf(pageId)]
    if (!entry) return ''
    return JSON.stringify([entry.template ?? null, entry.bounds ?? null, this.#note.template ?? null, this.#note.pageAspect ?? null])
  }

  /** @param {string|null} pageId @returns {number} -1 for a page the note does not list */
  #indexOf(pageId) {
    return pageId === null ? -1 : this.#pages.findIndex((p) => p.id === pageId)
  }

  /**
   * Asks for a page and draws it when it comes. The SVG already shown stays until
   * then; stroke events for the page heard meanwhile are held and applied above
   * the seq the answer reflects.
   * @param {string|null} pageId
   */
  #show(pageId) {
    if (pageId !== this.#shown) {
      this.#clearLive()
      this.#layers = null
    }
    this.#shown = pageId
    this.#painted = true
    this.#seq = 0
    this.#held = []
    if (pageId !== null) this.#unseen.delete(pageId)
    const load = ++this.#loads
    this.#renderChrome()
    if (pageId === null) {
      this.#loading = 0
      this.#showEmpty('This note has no pages yet.')
      return
    }
    this.#loading = load
    this.#provider.loadPage(pageId).then((answer) => {
      if (load !== this.#loads || !this.#mounted) return
      this.#draw(answer.page)
      this.#seq = answer.seq
      this.#loading = 0
      const held = this.#held
      this.#held = []
      for (const event of held) this.#applyStroke(event)
    }, (err) => {
      if (load !== this.#loads || !this.#mounted) return
      console.warn('[ink] the page could not be loaded', pageId, err)
      this.#loading = 0
      this.#showEmpty('This page could not be loaded.')
    })
  }

  /** @param {string} text */
  #showEmpty(text) {
    this.#layers = null
    this.#drawn = null
    this.#strokes = new Map()
    const empty = this.#el('p', 'ink-page__empty')
    empty.textContent = text
    this.#sheet.replaceChildren(empty)
    this.#notice.hidden = true
  }

  /** @param {Readonly<InkPage>} page */
  #draw(page) {
    const entry = this.#pages[this.#indexOf(this.#shown)]
    this.#window = entry && entry.bounds === 'unbounded' ? this.#frameOf(page) : null
    const svg = this.#parse(this.#renderer.renderPage(/** @type {any} */ (page), this.#window ?? undefined))[0]
    this.#layers = new Map(INK_LAYERS.map((name) => [name, /** @type {Element} */ (svg.querySelector(`g[data-ink="${name}"]`))]))
    this.#strokes = new Map()
    for (const name of INK_LAYERS) {
      if (name === 'live' || name === 'ruling') continue
      for (const el of /** @type {Element} */ (this.#layers.get(name)).children) this.#index(el)
    }
    this.#sheet.replaceChildren(svg)
    if (this.#drawn !== this.#shown) this.#surround.scrollTo(0, 0)
    this.#drawn = this.#shown
    this.#notice.hidden = !svg.querySelector('g[data-ink="ruling"][data-ink-template="unknown"]')
    this.#notice.textContent = 'Unknown template, drawn blank'
    this.#applyScale()
    for (const n of this.#live.keys()) this.#stale.add(n)
    for (const stroke of this.#live.values()) stroke.el = null
    this.#schedule()
  }

  /**
   * The window an unbounded page is drawn through: the box round its strokes
   * with a margin, or the sheet its aspect gives when it has none.
   * @param {Readonly<InkPage>} page @returns {InkWindow}
   */
  #frameOf(page) {
    let [x0, y0, x1, y1] = [Infinity, Infinity, -Infinity, -Infinity]
    for (const stroke of page.strokes) {
      for (const p of stroke.points) {
        x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y)
        x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y)
      }
    }
    if (!(x1 >= x0)) return { x0: 0, y0: 0, x1: 1, y1: 1 / page.note.pageAspect }
    const m = UNBOUNDED_MARGIN
    return { x0: x0 - m, y0: y0 - m, x1: x1 + m, y1: y1 + m }
  }

  /** @param {InkFeedEvent} event */
  #onStroke(event) {
    const pageId = /** @type {any} */ (event).pageId
    if (pageId !== this.#shown) {
      this.#unseen.add(pageId)
      this.#renderChrome()
      return
    }
    if (this.#loading) {
      this.#held.push(event)
      return
    }
    this.#applyStroke(event)
  }

  /** @param {InkFeedEvent} event */
  #applyStroke(event) {
    const e = /** @type {any} */ (event)
    if (!this.#layers || e.seq <= this.#seq) return
    this.#seq = e.seq
    if (e.type === InkFeed.STROKE_REMOVED) {
      for (const el of this.#strokes.get(e.strokeId) || []) el.remove()
      this.#strokes.delete(e.strokeId)
      return
    }
    const markup = this.#renderer.renderStroke(/** @type {any} */ (e.stroke))
    this.#append('pen', markup.pen)
    markup.bands.forEach((part, i) => this.#append(`b${i}`, part))
    if (this.#shown === this.#livePage) this.#claimLive(e.stroke)
  }

  /** @param {string} layer @param {string} markup */
  #append(layer, markup) {
    if (!markup) return
    const group = /** @type {Element} */ (/** @type {Map<string, Element>} */ (this.#layers).get(layer))
    for (const el of this.#fragment(markup)) {
      group.appendChild(el)
      this.#index(el)
    }
  }

  /** @param {Element} el */
  #index(el) {
    const id = el.getAttribute('data-stroke')
    if (!id) return
    const els = this.#strokes.get(id)
    if (els) els.push(el)
    else this.#strokes.set(id, [el])
  }

  /** @param {ReadonlyArray<InkLiveRecord>} records */
  #onLive(records) {
    if (this.#livePage === null || this.#livePage !== this.#shown) return
    for (const r of records) {
      switch (r.record) {
        case 'begin':
          this.#dropLive(r.stroke)
          this.#live.set(r.stroke, {
            tool: r.tool === 'pencil' ? 'pencil' : 'pen',
            widthClass: /** @type {1|2|3} */ ([1, 2, 3].includes(r.widthClass) ? r.widthClass : 2),
            points: [], ended: false, el: null, linger: null,
          })
          break
        case 'point': {
          const stroke = this.#live.get(r.stroke)
          if (!stroke || stroke.ended) break
          stroke.points.push({ x: r.x, y: r.y, pressure: r.pressure, tMillis: r.tMillis })
          this.#stale.add(r.stroke)
          break
        }
        case 'end': {
          const stroke = this.#live.get(r.stroke)
          if (!stroke || stroke.ended) break
          stroke.ended = true
          stroke.linger = setTimeout(() => this.#dropLive(r.stroke), LIVE_LINGER_MS)
          break
        }
        case 'remove':
          this.#dropLive(r.stroke)
          break
      }
    }
    this.#schedule()
  }

  /**
   * A committed stroke on the live page takes the place of the oldest ended
   * live stroke drawn with the same tool and width class.
   * @param {Readonly<InkPageStroke>} committed
   */
  #claimLive(committed) {
    for (const [n, stroke] of this.#live) {
      if (stroke.ended && stroke.tool === committed.tool && stroke.widthClass === committed.widthClass) {
        this.#dropLive(n)
        return
      }
    }
  }

  /** @param {string|null} pageId the live page, null when the note stops being live */
  #onLivePage(pageId) {
    if (pageId !== this.#livePage) this.#clearLive()
    this.#livePage = pageId
    if (pageId === null) this.#following = true
    if (pageId !== null && this.#following && pageId !== this.#shown && this.#indexOf(pageId) >= 0) this.#show(pageId)
    else this.#renderChrome()
  }

  #schedule() {
    if (this.#frame || this.#stale.size === 0 || !this.#mounted) return
    this.#frame = requestAnimationFrame(() => this.#redrawLive())
  }

  /** Redraws the path of every live stroke that changed since the last frame. */
  #redrawLive() {
    this.#frame = 0
    const group = this.#layers && this.#layers.get('live')
    if (!group) return
    for (const n of this.#stale) {
      const stroke = this.#live.get(n)
      if (!stroke) continue
      const markup = this.#renderer.renderLiveStroke({ id: `live-${n}`, tool: stroke.tool, widthClass: stroke.widthClass, points: stroke.points })
      const el = markup ? this.#fragment(markup)[0] : null
      if (stroke.el && el) stroke.el.replaceWith(el)
      else if (stroke.el) stroke.el.remove()
      else if (el) group.appendChild(el)
      stroke.el = el
    }
    this.#stale.clear()
  }

  /** @param {number} n */
  #dropLive(n) {
    const stroke = this.#live.get(n)
    if (!stroke) return
    if (stroke.linger) clearTimeout(stroke.linger)
    if (stroke.el) stroke.el.remove()
    this.#live.delete(n)
    this.#stale.delete(n)
  }

  #clearLive() {
    for (const n of [...this.#live.keys()]) this.#dropLive(n)
  }

  #applyScale() {
    this.#root.dataset.scale = this.#scale
    const svg = this.#sheet.querySelector('svg')
    if (svg) svg.style.width = this.#scale === PageSurface.Scale.FIT ? '100%' : `${svg.getAttribute('width')}px`
  }

  #renderChrome() {
    const index = this.#indexOf(this.#shown)
    const count = this.#pages.length
    this.#position.textContent = count ? `${index + 1} / ${count}` : '0 / 0'
    this.#prev.disabled = index <= 0
    this.#next.disabled = index < 0 || index >= count - 1
    const dots = this.#pages.map((page, i) => {
      const dot = this.#button('', '', `Page ${i + 1}`)
      dot.className = 'ink-page__dot'
      dot.dataset.inkPage = page.id
      if (page.id === this.#shown) dot.setAttribute('aria-current', 'page')
      if (this.#unseen.has(page.id)) dot.dataset.unseen = ''
      return dot
    })
    this.#dots.replaceChildren(...dots)
    const actual = this.#scale === PageSurface.Scale.ACTUAL
    this.#scaleButton.textContent = actual ? 'Fit width' : '100%'
    this.#scaleButton.title = actual ? 'Fit the page to the width' : 'Show the page at actual size'
    const following = this.#following && this.#livePage === this.#shown
    this.#liveButton.hidden = this.#livePage === null
    this.#liveButton.textContent = following ? 'Live' : 'Back to live'
    this.#liveButton.setAttribute('aria-pressed', String(following))
  }

  /** @param {Event} event */
  #onClick = (event) => {
    const target = /** @type {Element} */ (event.target)
    const button = target && typeof target.closest === 'function' ? target.closest('button') : null
    if (!button) {
      if (target && this.#sheet.contains(target)) this.#root.focus()
      return
    }
    const page = button.getAttribute('data-ink-page')
    if (page !== null) {
      if (page !== this.#shown) this.#navigate(page)
      return
    }
    switch (button.getAttribute('data-ink-action')) {
      case 'prev': this.turn(-1); break
      case 'next': this.turn(1); break
      case 'scale': this.toggleScale(); break
      case 'live': this.returnToLive(); break
    }
  }

  /** @param {KeyboardEvent} event */
  #onKeyDown = (event) => {
    if (this.#claimKey(event)) event.preventDefault()
  }

  /**
   * Nodes from the renderer's markup, parsed as HTML parses inline SVG, so every
   * element lands in the SVG namespace.
   * @param {string} markup @returns {Element[]}
   */
  #parse(markup) {
    const template = document.createElement('template')
    template.innerHTML = markup
    return [...template.content.children]
  }

  /** @param {string} markup SVG elements @returns {Element[]} */
  #fragment(markup) {
    return [.../** @type {Element} */ (this.#parse(`<svg>${markup}</svg>`)[0]).children]
  }

  /** @param {string} tag @param {string} className @returns {HTMLElement} */
  #el(tag, className) {
    const el = document.createElement(tag)
    el.className = className
    return el
  }

  /** @param {string} action @param {string} text @param {string} label @returns {HTMLButtonElement} */
  #button(action, text, label) {
    const button = document.createElement('button')
    button.type = 'button'
    if (action) button.dataset.inkAction = action
    button.textContent = text
    if (label) button.setAttribute('aria-label', label)
    return button
  }
}
