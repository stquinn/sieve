// @ts-check
// media-lightbox.js — a window-filling overlay that hosts ONE element for
// focused viewing. Two layers: a reusable overlay SHELL (backdrop, title bar,
// toolbar slot, Esc/backdrop/× close, focus capture+restore) and a media
// CONTROLLER (mode:'media' only) that adds pan/zoom via @panzoom/panzoom.
// The shell is the deliberate reuse seam for a future mode:'live' focus mode.
// Pure view-layer: zoom/pan is ephemeral, never persisted (docs spec §Architecture).

/** @typedef {{ element: HTMLElement, title: string, mode: 'media' }} ExpandSpec */

export class MediaLightbox {
  static #singleton = null

  static shared() { return (MediaLightbox.#singleton ??= new MediaLightbox()) }
  static closeSingleton() { if (MediaLightbox.#singleton) MediaLightbox.#singleton.close() }

  /** @type {HTMLElement|null} */ #overlay = null
  /** @type {HTMLElement|null} */ #prevFocus = null
  /** @type {any} */ #panzoom = null
  /** @type {(e: KeyboardEvent) => void} */ #onKey

  constructor() {
    this.#onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); this.close() } }
  }

  /** @param {ExpandSpec} spec — takes ownership of spec.element (destroyed on close) */
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
    const pz = PZ(content, {
      maxScale: 10, minScale: 0.1, step: 0.3,
      cursor: 'grab', canvas: true, contain: 'outside',
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

  /** Restores previous focus and cleans up overlay resources. */
  close() {
    if (!this.#overlay) return
    document.removeEventListener('keydown', this.#onKey)
    if (this.#panzoom && typeof this.#panzoom.destroy === 'function') this.#panzoom.destroy()
    this.#panzoom = null
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
