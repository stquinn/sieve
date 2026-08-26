// @ts-check
// A window-filling overlay that hosts ONE element for focused viewing. Two layers:
// a reusable overlay SHELL (backdrop, title bar, toolbar slot, Esc/backdrop/× close,
// focus capture+restore) and a media CONTROLLER (mode:'media' only) that adds
// pan/zoom via @panzoom/panzoom. The shell is the deliberate reuse seam for a future
// mode:'live'. Pure view-layer: zoom/pan is ephemeral, never persisted.

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

    stage.addEventListener('mousedown', (e) => { if (e.target === stage) this.close() })

    overlay.append(bar, stage)
    document.body.appendChild(overlay)
    this.#overlay = overlay
    document.addEventListener('keydown', this.#onKey)
    overlay.focus()

    if (spec.mode === 'media') {
      // Panzoom measures the content when it initialises, and a fresh <img> with its
      // `src` set but not yet loaded is 0x0 — cursor-anchored wheel zoom would compute
      // its focal against a zero-size element and drift to a corner. Defer setup until
      // the image loads; an already-sized element (a diagram's SVG) sets up at once.
      const img = spec.element instanceof HTMLImageElement ? spec.element : content.querySelector('img')
      if (img && !img.complete) {
        const ready = () => { if (this.#overlay === overlay) this.#enableMedia(stage, content, toolbar) }
        img.addEventListener('load', ready, { once: true })
        img.addEventListener('error', ready, { once: true })
      } else {
        this.#enableMedia(stage, content, toolbar)
      }
    }
  }

  /** @param {HTMLElement} stage @param {HTMLElement} content @param {HTMLElement} toolbar */
  #enableMedia(stage, content, toolbar) {
    const PZ = /** @type {any} */ (window).Panzoom
    if (!PZ) return // no lib (e.g. unit env): shell still shows content statically
    // NO `contain`. panzoom's contain couples panning to scale in BOTH directions:
    // 'outside' blocks zoom-OUT below cover, 'inside' blocks zoom-IN above fit, and a
    // lightbox wants FREE zoom. The CSS already lays the content out fit-to-window, so
    // scale 1 = fit = 100% readout and panzoom zooms freely either way. Free pan is
    // the accepted trade-off.
    const pz = PZ(content, {
      maxScale: 10, minScale: 0.1, step: 0.3,
      cursor: 'grab', canvas: true,
    })
    this.#panzoom = pz
    // Cursor-anchored wheel zoom. panzoom's zoomToPoint measures the cursor offset
    // from the PARENT's content-box origin and assumes the panzoomed element sits
    // there; the stage flex-centres `content`, so its layout box is inset by
    // gap=(stageInner−contentLayout)/2 per axis and the focal is off by exactly that,
    // drifting the zoom to a corner. Shift the cursor point back by the gap first.
    // offsetWidth/Height are LAYOUT metrics (transform-immune), so the gap is stable
    // across pan/zoom, and <img> and inline <svg> share the identical gap.
    stage.addEventListener('wheel', (e) => {
      e.preventDefault()
      const gapX = (stage.clientWidth - content.offsetWidth) / 2
      const gapY = (stage.clientHeight - content.offsetHeight) / 2
      pz.zoomWithWheel({
        preventDefault() {},
        deltaX: e.deltaX, deltaY: e.deltaY,
        clientX: e.clientX - gapX, clientY: e.clientY - gapY,
      })
    }, { passive: false })
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
    // Restore a borrowed live element via its placeholder. panzoom's transform lived
    // on the discarded content wrapper, not the element, so it returns pristine. No
    // placeholder (or a wiped one) → the element is discarded.
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
