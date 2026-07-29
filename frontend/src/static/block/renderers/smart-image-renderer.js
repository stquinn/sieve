// @ts-check
// smart-image-renderer.js — SmartImageRenderer: the renderer half of the
// 'smart-image' kind's renderer/NodeView split. NORMATIVE contract:
// docs/design/archive/specs/2026-07-21-block-renderer-contract.md (APPROVED rev 2).
// Owns look-and-feel ONLY: the image wrapper, the resize handle, the status
// badge (shared StatusBadge decision tree — survey item A7), the premium
// tooltip, and this kind's stylesheet (`static styles`). Zero
// ProseMirror/editor/window.* dependencies.
//
// A true atom — its BODY is the image + resizer + badge (appended straight to
// the root as a fragment, no wrapper). The resize COMMIT is this kind's
// SEMANTIC VERB `resize(width, height)` (subclass-owned, self-invoked by the
// drag handle per the contract's abstract-consumer rule); it maps to schema
// privately via _pushAttrs and effects through the BlockService. The drag
// interaction itself is pure DOM/pointer handling here. resolveSrc is a PURE
// (src, uuid) → URL function (no ctx) the adapter uses when authoring the
// envelope overlay.

import { BlockRenderer } from './block-renderer.js'
import { smartImageStyles } from './smart-image-renderer.styles.js'
import { StatusBadge } from './status-badge.js'

/** @typedef {{ id?: string, src?: string, alt?: string, summary?: string, width?: string, height?: string, status?: string, createdAt?: string|null, error?: string }} SmartImagePayload */

export class SmartImageRenderer extends BlockRenderer {
  static styles = smartImageStyles
  static rootClass = 'image-block node-image'

  /**
   * Pure URL resolution — no ctx, no PM. The adapter calls this with the held
   * Editor's document uuid when authoring the envelope's live overlay.
   * @param {string} src @param {string} [uuid] @returns {string}
   */
  static resolveSrc(src, uuid) {
    if (!src) return ''
    if (src.startsWith('http://') || src.startsWith('https://')) {
      return window.location.origin + '/sieve-image-proxy?url=' + encodeURIComponent(src)
    }
    if (src.startsWith('data:') || src.startsWith('blob:') || src.startsWith('/')) return src
    if (src.startsWith('.assets/')) src = src.substring(8)
    return '/sieve/' + (uuid || '') + '/' + src.split('/').pop()
  }

  /** @type {HTMLImageElement|null} */ #img = null
  /** @type {HTMLElement|null} */ #badge = null

  /** @returns {DocumentFragment} */
  buildBody() {
    const frag = document.createDocumentFragment()

    const img = document.createElement('img')
    img.style.maxWidth = '100%'
    img.style.display = 'block'
    // The floor is MEASURED, so it can only be decided once the image has decoded
    // and been laid out. Registered once, for the element's life: `src` changes
    // across updates, and each new source has to be re-judged on its own merits.
    img.addEventListener('load', () => this.#fillIfSizeless())

    const resizer = document.createElement('div')
    resizer.className = 'image-resizer'

    const badge = document.createElement('span')
    badge.className = 'smart-image-status'

    frag.appendChild(img)
    frag.appendChild(resizer)
    frag.appendChild(badge)

    this.#img = img
    this.#badge = badge

    if (this.root) this.root.style.display = 'inline-block'
    this.#setupResize(img, resizer)
    this.#renderState(/** @type {SmartImagePayload} */ (this.block.payload))
    return frag
  }

  /** @param {import('../sieve-block.js').SieveBlock} block */
  update(block) {
    super.update(block)
    this.#renderState(/** @type {SmartImagePayload} */ (block.payload))
  }

  // ── Semantic verbs (kind-specific — contract's abstract-consumer rule) ────

  /**
   * Commit the image's display dimensions (CSS px, string-valued as persisted).
   * Self-invoked by this kind's own resize handle on drag release; the verb is
   * the ONLY place the drag's result becomes schema (via _pushAttrs).
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
    // Responsive sizing. The stored width is INTENT — what the user set, or the
    // image's own measured width — and `max-width:100%` (set in the constructor)
    // clamps it to the pane for display only, so the stored value survives a narrow
    // window and comes back when the window grows. Height is never stamped: a
    // clamped width with a literal height squashes the image, so the ratio is
    // carried by `aspect-ratio` instead, which also reserves the box before the
    // image decodes and stops the block jumping on load.
    const w = payload.width || '', h = payload.height || ''
    img.style.width = w ? (String(w).match(/^\d+$/) ? w + 'px' : w) : ''
    img.style.height = 'auto'
    img.style.aspectRatio = (w && h) ? `${parseFloat(String(w))} / ${parseFloat(String(h))}` : ''
    // An already-decoded image fires no further `load`, so judge it here too.
    if (img.complete) this.#fillIfSizeless()
    if (payload.summary) dom.setAttribute('data-tooltip', payload.summary)
    else dom.removeAttribute('data-tooltip')

    const state = StatusBadge.classify(payload.status, payload.createdAt, payload.id)
    if (state === 'pending') {
      badge.textContent = 'Processing…'
      badge.className = 'smart-image-status smart-image-status--pending'
    } else if (state === 'stale' || state === 'timeout' || state === 'error') {
      const errText = (payload.error || '').trim()
      badge.textContent = errText || (state === 'timeout' ? 'Timed out' : 'Failed')
      badge.className = 'smart-image-status smart-image-status--error'
      if (errText) dom.setAttribute('data-tooltip', errText)
    } else {
      badge.textContent = ''
      badge.className = 'smart-image-status'
    }
  }

  /**
   * The unsized case: an image the document gives no width AND that has no
   * intrinsic size of its own lays out at zero, showing only the resize handle
   * (#53). Such an image fills the available width instead — the responsive
   * default, which needs no invented number and re-adapts on every window resize.
   *
   * The trigger is MEASURED — "this image actually laid out at zero", not "this
   * payload has no width" — and that distinction is the whole design. A raster
   * always has an intrinsic size, so it lays out at its natural width and is left
   * untouched. That matters because the unsized blocks already on disk are mostly
   * PNGs rendering correctly today, and filling the pane blindly would inflate
   * them past their real size (and blow small icons up into blurry banners).
   *
   * DISPLAY-only: never pushed back to schema, so it cannot rewrite a document the
   * user never chose to resize.
   */
  #fillIfSizeless() {
    const img = this.#img
    if (!img || !img.complete || !img.getAttribute('src') || !img.isConnected) return

    const payload = /** @type {SmartImagePayload} */ (this.block.payload)
    if (payload.width) return       // the document sizes it — respect that
    if (img.clientWidth > 0) return // it lays out fine on its own

    img.style.width = '100%'
    // No intrinsic ratio either (an SVG with neither size nor viewBox): a width
    // alone still leaves the box flat, so give it a plain 4:3 one.
    if (img.clientHeight === 0) img.style.aspectRatio = '4 / 3'
  }

  /** @param {HTMLImageElement} img @param {HTMLElement} resizer */
  #setupResize(img, resizer) {
    let isResizing = false, startX = 0, startW = 0, ratio = 1

    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation()
      isResizing = true; startX = e.clientX
      // Drag from the STORED width, not the rendered one. When a stored width is
      // wider than the pane, `max-width:100%` clamps the display — starting from
      // the clamped value would silently rewrite the user's intent down to the
      // window size on the first nudge. Ratio still comes from the rendered box,
      // which is where the true aspect shows up whether it came from the payload,
      // `aspect-ratio`, or the image itself.
      const stored = parseFloat(String(this.block.payload.width || ''))
      startW = Number.isFinite(stored) && stored > 0 ? stored : img.clientWidth
      const startH = img.clientHeight
      ratio = (img.clientWidth > 0 && startH > 0) ? img.clientWidth / startH : 1
      document.body.style.cursor = 'nwse-resize'

      // The width the drag INTENDS, which is what gets stored. It can exceed the
      // pane; `max-width:100%` handles the display side.
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
