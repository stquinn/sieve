// @ts-check
// SmartImageRenderer — the 'smart-image' kind's look-and-feel: the image frame,
// the resize handle, the status badge and the description strap, plus this
// kind's stylesheet.
//
// A true atom — its BODY is the image + resizer + badge, appended straight to
// the root as a fragment. The resize COMMIT is this kind's SEMANTIC VERB
// `resize(width, height)`, self-invoked by the drag handle; the drag itself is
// pure DOM/pointer handling here. resolveSrc is a PURE (src, uuid) → URL
// function the adapter uses when authoring the block overlay.

import { BlockRenderer } from './block-renderer.js'
import { smartImageStyles } from './smart-image-renderer.styles.js'
import { StatusBadge } from './status-badge.js'
import { resolveImageSrc } from './asset-urls.js'
import { registerBlockRenderer } from './block-kinds.js'

/** @typedef {{ id?: string, src?: string, alt?: string, summary?: string, width?: string, height?: string, status?: string, createdAt?: string|null, error?: string, showSummary?: boolean }} SmartImagePayload */

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

    const resizer = document.createElement('div')
    resizer.className = 'image-resizer'

    const badge = document.createElement('span')
    badge.className = 'smart-image-status'

    // The image and its chrome live in a frame that hugs the image, so the resize
    // handle and badge anchor to the IMAGE, not the full-width block root.
    const frame = document.createElement('div')
    frame.className = 'smart-image-frame'
    frame.appendChild(img)
    frame.appendChild(resizer)
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

    // BLOCK, full width: an image block owns its own line, and side-by-side
    // layout is the column container's job. The root must NOT be shrink-to-fit
    // (fit-content/max-content) — the image carries max-width:100%, and a
    // percentage against an indefinite container resolves circularly.
    if (this.root) this.root.style.display = 'block'
    this.#setupResize(img, resizer)
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
   * intrinsic size of its own lays out at zero, showing only the resize handle.
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

  /** @param {HTMLImageElement} img @param {HTMLElement} resizer */
  #setupResize(img, resizer) {
    let isResizing = false, startX = 0, startW = 0, ratio = 1

    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation()
      isResizing = true; startX = e.clientX
      // Drag from the STORED width, not the rendered one: when a stored width is
      // wider than the pane, starting from the clamped value silently rewrites the
      // user's intent down to the window size. Ratio comes from the rendered box,
      // where the true aspect shows up whatever set it.
      const stored = parseFloat(String(this.block.payload.width || ''))
      startW = Number.isFinite(stored) && stored > 0 ? stored : img.clientWidth
      const startH = img.clientHeight
      ratio = (img.clientWidth > 0 && startH > 0) ? img.clientWidth / startH : 1
      document.body.style.cursor = 'nwse-resize'

      // The width the drag INTENDS, which is what gets stored; it may exceed the pane.
      let intentW = startW

      const onMove = (/** @type {MouseEvent} */ e) => {
        if (!isResizing) return
        intentW = Math.max(40, startW + (e.clientX - startX))
        img.style.width = intentW + 'px'
        img.style.aspectRatio = `${ratio} / 1` // height stays auto — never squash
      }

      const onUp = () => {
        if (!isResizing) return
        isResizing = false
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        // Store intent, not the clamped render — see the startW comment above.
        const w = Math.round(intentW)
        this.resize(String(w), String(Math.max(1, Math.round(w / ratio))))
      }

      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    })
  }

  // destroy(): base no-op — resize listeners live on `window` only during a drag.
}

registerBlockRenderer('smart-image', () => SmartImageRenderer)
