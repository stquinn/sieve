// @ts-check
// SmartImageRenderer — the 'smart-image' kind's look-and-feel: the image frame,
// the resize handles, the status badge and the description strap, plus this
// kind's stylesheet.
//
// A true atom — its BODY is the image + resize handles + badge, appended straight
// to the root as a fragment. The resize COMMIT is this kind's SEMANTIC VERB
// `resize(width, height)`, self-invoked by the drag handles; the drag itself is
// pure DOM/pointer handling here. resolveSrc is a PURE (src, uuid) → URL
// function the adapter uses when authoring the block overlay.

import { BlockRenderer } from './block-renderer.js'
import { smartImageStyles } from './smart-image-renderer.styles.js'
import { StatusBadge } from './status-badge.js'
import { resolveImageSrc } from './asset-urls.js'
import { registerBlockRenderer } from './block-kinds.js'

/** @typedef {{ id?: string, src?: string, alt?: string, summary?: string, width?: string, height?: string, status?: string, createdAt?: string|null, error?: string, showSummary?: boolean }} SmartImagePayload */
/** @typedef {'both' | 'x' | 'y'} ResizeAxis */

/** The smallest size, in CSS px, a drag may leave on either axis. */
const MIN_PX = 40

/**
 * The three resize handles. The handle grabbed IS the intent: the corner keeps
 * the ratio, the right edge moves width only, the bottom edge height only.
 * @type {ReadonlyArray<{ modifier: string, axis: ResizeAxis, cursor: string }>}
 */
const RESIZE_HANDLES = Object.freeze([
  Object.freeze({ modifier: 'corner', axis: /** @type {ResizeAxis} */ ('both'), cursor: 'nwse-resize' }),
  Object.freeze({ modifier: 'right', axis: /** @type {ResizeAxis} */ ('x'), cursor: 'ew-resize' }),
  Object.freeze({ modifier: 'bottom', axis: /** @type {ResizeAxis} */ ('y'), cursor: 'ns-resize' }),
])

export class SmartImageRenderer extends BlockRenderer {
  static styles = smartImageStyles
  static rootClass = 'image-block node-image'

  /**
   * Pure URL resolution — no ctx, no PM. The adapter calls this with the held
   * Editor's document uuid when authoring the block's live overlay.
   * @param {string} src @param {string} [uuid] @returns {string}
   */
  static resolveSrc(src, uuid) {
    return resolveImageSrc(src, uuid)
  }

  /** @type {HTMLImageElement|null} */ #img = null
  /** @type {HTMLElement|null} */ #badge = null
  /** @type {HTMLElement|null} */ #summary = null

  /** @returns {DocumentFragment} */
  buildBody() {
    const frag = document.createDocumentFragment()

    const img = document.createElement('img')
    img.style.maxWidth = '100%'
    img.style.display = 'block'
    // Registered once, for the element's life: `src` changes across updates and
    // each new source is re-judged on its own merits.
    img.addEventListener('load', () => this.#fillIfSizeless())

    const badge = document.createElement('span')
    badge.className = 'smart-image-status'

    // The image and its chrome live in a frame that hugs the image, so the resize
    // handles and badge anchor to the IMAGE, not the full-width block root.
    const frame = document.createElement('div')
    frame.className = 'smart-image-frame'
    frame.appendChild(img)
    for (const spec of RESIZE_HANDLES) {
      const handle = document.createElement('div')
      handle.className = `image-resizer image-resizer--${spec.modifier}`
      this.#setupResize(img, handle, spec)
      if (spec.axis === 'both') {
        handle.addEventListener('dblclick', (e) => {
          e.preventDefault(); e.stopPropagation()
          this.#resetToNatural(img)
        })
      }
      frame.appendChild(handle)
    }
    frame.appendChild(badge)

    // The description strap: CHROME, not prose — text typeset like a paragraph
    // invites a caret an atom NodeView can never provide. Read-only but SELECTABLE.
    const summary = document.createElement('div')
    summary.className = 'smart-image-summary'

    frag.appendChild(frame)
    frag.appendChild(summary)

    this.#img = img
    this.#badge = badge
    this.#summary = summary

    this.#renderState(/** @type {SmartImagePayload} */ (this.block.payload))
    return frag
  }

  /** @param {import('../contract/sieve-block.js').SieveBlock} block */
  update(block) {
    super.update(block)
    this.#renderState(/** @type {SmartImagePayload} */ (block.payload))
  }

  /**
   * Commit the image's display dimensions (CSS px, string-valued as persisted).
   * The ONLY place the drag's result becomes schema.
   * @param {string} width @param {string} height
   */
  resize(width, height) {
    this._pushAttrs({ width: width, height: height })
  }

  /** @param {SmartImagePayload} payload */
  #renderState(payload) {
    const dom = this.root, img = this.#img, badge = this.#badge
    if (!dom || !img || !badge) return

    img.src = payload.src || ''
    img.alt = payload.alt || ''
    // The stored width is INTENT — what the user set, or the image's own measured
    // width — and `max-width:100%` clamps it to the pane for display only, so the
    // stored value survives a narrow window. Height is never stamped: a clamped
    // width with a literal height squashes the image, so the ratio rides on
    // `aspect-ratio`, which also reserves the box before the image decodes.
    const w = payload.width || '', h = payload.height || ''
    img.style.width = w ? (String(w).match(/^\d+$/) ? w + 'px' : w) : ''
    img.style.height = 'auto'
    img.style.aspectRatio = (w && h) ? `${parseFloat(String(w))} / ${parseFloat(String(h))}` : ''
    // An already-decoded image fires no further `load`, so judge it here too.
    if (img.complete) this.#fillIfSizeless()

    // showSummary is a PERSISTED attribute, so a block re-opens as it was left.
    const summaryText = (payload.summary || '').trim()
    if (this.#summary) {
      this.#summary.textContent = summaryText
      this.#summary.classList.toggle('smart-image-summary--shown', !!(payload.showSummary && summaryText))
    }

    const state = StatusBadge.classify(payload.status, payload.createdAt, payload.id)
    if (state === 'pending') {
      badge.textContent = 'Processing…'
      badge.className = 'smart-image-status smart-image-status--pending'
    } else if (state === 'stale' || state === 'timeout' || state === 'error') {
      const errText = (payload.error || '').trim()
      badge.textContent = errText || (state === 'timeout' ? 'Timed out' : 'Failed')
      // The badge is the sole home for failure text.
      badge.className = 'smart-image-status smart-image-status--error'
    } else {
      badge.textContent = ''
      badge.className = 'smart-image-status'
    }
  }

  /**
   * The unsized case: an image the document gives no width AND that has no
   * intrinsic size of its own lays out at zero, showing only the resize handles.
   * Such an image fills the available width instead — the responsive default.
   *
   * The trigger is the IMAGE's intrinsic size, not a layout observation: a raster
   * always reports a natural size and is left untouched, so only an SVG with no
   * width/height and no viewBox reports 0.
   *
   * DISPLAY-only: never pushed back to schema, so it cannot rewrite a document
   * the user never chose to resize.
   */
  #fillIfSizeless() {
    const img = this.#img
    if (!img || !img.complete || !img.getAttribute('src') || !img.isConnected) return

    const payload = /** @type {SmartImagePayload} */ (this.block.payload)
    if (payload.width) return   // the document sizes it — respect that
    // naturalWidth, NOT clientWidth: clientWidth reads 0 while the box is still
    // being resolved, so keying off it fires on ordinary rasters.
    if (img.naturalWidth > 0) return

    img.style.width = '100%'
    // No intrinsic ratio either: a width alone still leaves the box flat.
    if (img.naturalHeight === 0) img.style.aspectRatio = '4 / 3'
  }

  /**
   * Wire one resize handle. Every gesture starts from the STORED size, not the
   * rendered one: a stored width wider than the pane is clamped for display, and
   * starting from the clamped value would silently rewrite the user's intent down
   * to the window size. The rendered box is only the fallback for an unsized image.
   * @param {HTMLImageElement} img @param {HTMLElement} handle
   * @param {{ axis: ResizeAxis, cursor: string }} spec
   */
  #setupResize(img, handle, { axis, cursor }) {
    handle.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation()
      const start = this.#startSize(img)
      const startX = e.clientX, startY = e.clientY
      let size = start
      document.body.style.cursor = cursor

      const onMove = (/** @type {MouseEvent} */ e) => {
        size = this.#dragTo(axis, start, e.clientX - startX, e.clientY - startY)
        img.style.width = size.w + 'px'
        img.style.aspectRatio = `${size.w} / ${size.h}` // height stays auto
      }

      const onUp = () => {
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        const w = Math.round(size.w), h = Math.max(1, Math.round(size.h))
        // A click is a drag of zero; so is each half of a double-click.
        if (w === Math.round(start.w) && h === Math.max(1, Math.round(start.h))) return
        this.resize(String(w), String(h))
      }

      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    })
  }

  /**
   * The size a gesture starts from: stored width/height where the document has
   * them, the rendered box where it does not.
   * @param {HTMLImageElement} img @returns {{ w: number, h: number }}
   */
  #startSize(img) {
    const payload = /** @type {SmartImagePayload} */ (this.block.payload)
    const storedW = parseFloat(String(payload.width || ''))
    const storedH = parseFloat(String(payload.height || ''))
    const w = storedW > 0 ? storedW : img.clientWidth
    if (storedH > 0) return { w, h: storedH }
    const ratio = (img.clientWidth > 0 && img.clientHeight > 0) ? img.clientWidth / img.clientHeight : 1
    return { w, h: w / ratio }
  }

  /**
   * The size a drag of (dx, dy) from `start` intends on one handle's axis. Both
   * axes are floored at MIN_PX; the corner keeps the start ratio at its floor.
   * @param {ResizeAxis} axis @param {{ w: number, h: number }} start
   * @param {number} dx @param {number} dy @returns {{ w: number, h: number }}
   */
  #dragTo(axis, start, dx, dy) {
    if (axis === 'x') return { w: Math.max(MIN_PX, start.w + dx), h: start.h }
    if (axis === 'y') return { w: start.w, h: Math.max(MIN_PX, start.h + dy) }
    const ratio = start.h > 0 ? start.w / start.h : 1
    const w = Math.max(MIN_PX, MIN_PX * ratio, start.w + dx)
    return { w, h: w / ratio }
  }

  /**
   * Return the block to the image's own size, read from the decoded image. An
   * image with no intrinsic size (an SVG without width/height) clears both attrs,
   * which is the unsized responsive default.
   * @param {HTMLImageElement} img
   */
  #resetToNatural(img) {
    if (img.naturalWidth > 0 && img.naturalHeight > 0) {
      this.resize(String(img.naturalWidth), String(img.naturalHeight))
    } else {
      this.resize('', '')
    }
  }

  // destroy(): base no-op — resize listeners live on `window` only during a drag.
}

registerBlockRenderer('smart-image', () => SmartImageRenderer)
