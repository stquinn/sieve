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

  /** Overridden fully in Task 3. Stub keeps the shell usable meanwhile. */
  #enableMedia(_stage, _content, _toolbar) { /* pan/zoom wired in Task 3 */ }

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
