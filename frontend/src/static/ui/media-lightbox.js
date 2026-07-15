// @ts-check
// media-lightbox.js — a window-filling overlay that hosts ONE element for
// focused viewing. Two layers: a reusable overlay SHELL (backdrop, title bar,
// toolbar slot, Esc/backdrop/× close, focus capture+restore) and a media
// CONTROLLER (mode:'media' only) that adds pan/zoom via @panzoom/panzoom.
// The shell is the deliberate reuse seam for a future mode:'live' focus mode.
// Pure view-layer: zoom/pan is ephemeral, never persisted (docs spec §Architecture).

/** @typedef {{ element: Element, title: string, mode: 'media' }} ExpandSpec */

export class MediaLightbox {
  static #singleton = null

  static shared() { return (MediaLightbox.#singleton ??= new MediaLightbox()) }
  static closeSingleton() { if (MediaLightbox.#singleton) MediaLightbox.#singleton.close() }

  /** @type {HTMLElement|null} */ #overlay = null
  /** @type {HTMLElement|null} */ #prevFocus = null
  /** @type {any} */ #panzoom = null
  /** @type {(e: KeyboardEvent) => void} */ #onKey
  /** @type {{ el: Element, placeholder: Comment|null }|null} */ #borrowed = null

  constructor() {
    this.#onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); this.close() } }
  }

  /**
   * @param {ExpandSpec} spec — BORROWS spec.element. If it is currently in the DOM
   * (a "promoted" live pane, e.g. a diagram's rendered SVG), it is moved into the
   * overlay and RESTORED to its exact original spot on close. A detached element
   * (e.g. a freshly-built <img>) has no origin and is discarded on close.
   */
  open(spec) {
    if (!spec || !spec.element) return
    if (this.#overlay) this.close()
    this.#prevFocus = /** @type {HTMLElement|null} */ (document.activeElement)

    const overlay = document.createElement('div')
    overlay.className = 'media-lightbox'
    overlay.tabIndex = -1

    const bar = document.createElement('div')
    bar.className = 'media-lightbox__bar'
    const title = document.createElement('span')
    title.className = 'media-lightbox__title'
    title.textContent = spec.title || ''
    const toolbar = document.createElement('div')
    toolbar.className = 'media-lightbox__toolbar'
    const closeBtn = document.createElement('button')
    closeBtn.className = 'media-lightbox__close'
    closeBtn.textContent = '✕'
    closeBtn.setAttribute('aria-label', 'Close')
    closeBtn.addEventListener('click', () => this.close())
    bar.append(title, toolbar, closeBtn)

    const stage = document.createElement('div')
    stage.className = 'media-lightbox__stage'
    const content = document.createElement('div')
    content.className = 'media-lightbox__content'
    // Borrow the element: if it is live in the DOM, leave a comment placeholder in
    // its spot so close() can restore it exactly. innerHTML re-renders of the origin
    // (rare — the overlay blocks editor interaction) wipe the placeholder, in which
    // case the element is simply discarded and the newer content wins (no dup).
    const origin = spec.element.parentNode
    if (origin) {
      const ph = document.createComment('media-lightbox-borrow')
      origin.replaceChild(ph, spec.element)
      this.#borrowed = { el: spec.element, placeholder: ph }
    } else {
      this.#borrowed = { el: spec.element, placeholder: null }
    }
    content.appendChild(spec.element)
    stage.appendChild(content)

    // Backdrop click (stage, not content) closes.
    stage.addEventListener('mousedown', (e) => { if (e.target === stage) this.close() })

    overlay.append(bar, stage)
    document.body.appendChild(overlay)
    this.#overlay = overlay
    document.addEventListener('keydown', this.#onKey)
    overlay.focus()

    if (spec.mode === 'media') this.#enableMedia(stage, content, toolbar)
  }

  /**
   * Wires @panzoom/panzoom onto content plus a wheel-zoom listener,
   * double-click fit↔2× toggle, live zoom-% readout, and toolbar buttons.
   * @param {HTMLElement} stage @param {HTMLElement} content @param {HTMLElement} toolbar
   */
  #enableMedia(stage, content, toolbar) {
    const PZ = /** @type {any} */ (window).Panzoom
    if (!PZ) return // no lib (e.g. unit env): shell still shows content statically
    // NO `contain`. panzoom's contain couples panning to scale in BOTH directions:
    // 'outside' (cover) blocks zoom-OUT below cover; 'inside' blocks zoom-IN above
    // fit. A lightbox wants FREE zoom — the CSS (.media-lightbox__content
    // max-width/height:100%) already lays the content out fit-to-window, so scale 1
    // = fit = 100% readout, and panzoom then zooms freely in (→maxScale) and out
    // (→minScale) and Fit/reset returns to scale 1. Free pan is the accepted
    // trade-off (you can pan a zoomed image off-centre).
    const pz = PZ(content, {
      maxScale: 10, minScale: 0.1, step: 0.3,
      cursor: 'grab', canvas: true,
    })
    this.#panzoom = pz
    stage.addEventListener('wheel', pz.zoomWithWheel, { passive: false })
    // Double-click toggles fit(reset) ↔ 2×.
    content.addEventListener('dblclick', () => {
      if (pz.getScale() > 1.05) pz.reset()
      else pz.zoom(2, { animate: true })
    })

    const readout = document.createElement('span')
    readout.className = 'media-lightbox__zoom'
    const sync = () => { readout.textContent = Math.round(pz.getScale() * 100) + '%' }
    content.addEventListener('panzoomchange', sync)

    const btn = (label, aria, fn) => {
      const b = document.createElement('button')
      b.className = 'media-lightbox__tool'
      b.textContent = label; b.setAttribute('aria-label', aria)
      b.addEventListener('click', (e) => { e.preventDefault(); fn() })
      return b
    }
    toolbar.append(
      btn('−', 'Zoom out', () => pz.zoomOut()),
      readout,
      btn('+', 'Zoom in', () => pz.zoomIn()),
      btn('Fit', 'Fit to window', () => pz.reset()),
    )
    sync()
  }

  /** Restores the borrowed element to its origin, previous focus, and cleans up. */
  close() {
    if (!this.#overlay) return
    document.removeEventListener('keydown', this.#onKey)
    if (this.#panzoom && typeof this.#panzoom.destroy === 'function') this.#panzoom.destroy()
    this.#panzoom = null
    // Restore a borrowed live element to its origin via the placeholder. panzoom's
    // transform lived on the (discarded) content wrapper, not the element, so it
    // returns pristine. No placeholder (or a wiped one) → the element is discarded.
    const b = this.#borrowed
    this.#borrowed = null
    if (b && b.placeholder && b.placeholder.parentNode) {
      b.placeholder.parentNode.replaceChild(b.el, b.placeholder)
    }
    this.#overlay.remove()
    this.#overlay = null
    const prev = this.#prevFocus
    this.#prevFocus = null
    if (prev && typeof prev.focus === 'function') prev.focus()
  }
}

/** @param {ExpandSpec|null|undefined} spec @returns {boolean} */
export function expandBlock(spec) {
  if (!spec || !spec.element) return false
  MediaLightbox.shared().open(spec)
  return true
}

export function closeLightbox() { MediaLightbox.closeSingleton() }
