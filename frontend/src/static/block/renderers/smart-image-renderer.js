// @ts-check
// smart-image-renderer.js — SmartImageRenderer: the renderer half of the
// 'smart-image' kind's renderer/NodeView split (docs/design/specs/2026-07-20-block-renderer-extraction.md,
// Phase 4 / issue #47). Owns look-and-feel ONLY: the image wrapper, the
// resize handle, the status badge (driven by the shared StatusBadge decision
// tree — survey item A7), the premium tooltip, and this kind's complete
// stylesheet (`static styles`). Zero ProseMirror/editor/window.* app-global
// dependencies — this class mounts identically in the note editor's NodeView
// adapter (frontend/src/static/processors/smart-image-renderer.js, which
// HOLDS an instance of this class by composition, never inheritance), a
// bare-page harness, or any future non-PM lens.
//
// A true atom (no contentDOM) — there is nothing PM-specific in this kind's
// own look-and-feel at all; the adapter's job shrinks to schema data (attrs/
// nodeConfig/parseAttrs) and the two callbacks below:
//   - resize COMMIT (onResize) persists width/height via ctx.updateAttributes
//     — a PM-framework write path, so only the FINAL commit crosses the
//     callback; the drag interaction itself (mousemove/mouseup, aspect-ratio
//     math) is pure DOM/pointer handling and lives here.
//   - resolveSrc is a PURE (src, uuid) → URL function (no ctx) — the adapter
//     resolves `ctx.getEditor()?.uuid` and passes attrs.src ALREADY resolved,
//     mirroring the effectiveAttrs pattern DiagramRenderer/CodeRenderer/
//     LogRenderer already established for injecting adapter-computed values.

import { BlockRenderer } from './block-renderer.js'
import { smartImageStyles } from './smart-image-renderer.styles.js'
import { StatusBadge } from './status-badge.js'

/** @typedef {{ id?: string, src?: string, alt?: string, summary?: string, width?: string, height?: string, status?: string, createdAt?: string|null, error?: string }} SmartImageAttrs */

export class SmartImageRenderer extends BlockRenderer {
  // Sheet lives in the sibling smart-image-renderer.styles.js — styles-file-geography
  // convention: a renderer file starts with its class, never a CSS wall.
  static styles = smartImageStyles

  /**
   * Pure URL resolution — no ctx, no PM. The adapter calls this with the
   * held Editor's document uuid before handing attrs to mount()/update().
   * @param {string} src
   * @param {string} [uuid]
   * @returns {string}
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
  /** @type {HTMLElement|null} */ #resizer = null
  /** @type {HTMLElement|null} */ #badge = null
  /** @type {((dims: { width: string, height: string }) => void)|null} */ #onResize = null

  /** Registers the callback the resize handle invokes on drag-COMMIT (mouseup)
   *  — the adapter's hook into ctx.updateAttributes (a PM-framework path this
   *  PM-free class never touches directly).
   *  @param {(dims: { width: string, height: string }) => void} cb */
  onResize(cb) { this.#onResize = cb }

  /**
   * @param {SmartImageAttrs} attrs — `src` is expected ALREADY RESOLVED (see
   *   the static resolveSrc doc above).
   * @returns {HTMLElement}
   */
  mount(attrs) {
    const dom = document.createElement('div')
    dom.className = 'image-block node-image'
    dom.style.display = 'inline-block'

    const img = document.createElement('img')
    img.style.maxWidth = '100%'
    img.style.display = 'block'

    const resizer = document.createElement('div')
    resizer.className = 'image-resizer'

    const badge = document.createElement('span')
    badge.className = 'smart-image-status'

    dom.appendChild(img)
    dom.appendChild(resizer)
    dom.appendChild(badge)

    this.#img = img
    this.#resizer = resizer
    this.#badge = badge

    this.#setupResize(dom, img, resizer)
    this.update(dom, attrs)
    return dom
  }

  /** @param {HTMLElement} dom @param {SmartImageAttrs} attrs */
  update(dom, attrs) {
    const img = this.#img, badge = this.#badge
    if (!img || !badge) return

    img.src = attrs.src || ''
    img.alt = attrs.alt || ''
    const w = attrs.width || '', h = attrs.height || ''
    img.style.width  = w ? (String(w).match(/^\d+$/) ? w + 'px' : w) : ''
    img.style.height = h ? (String(h).match(/^\d+$/) ? h + 'px' : h) : ''
    if (attrs.summary) dom.setAttribute('data-tooltip', attrs.summary)
    else dom.removeAttribute('data-tooltip')
    if (attrs.id) dom.setAttribute('data-id', attrs.id)

    // Badge state via the shared StatusBadge decision tree (survey item A7).
    // Deliberate fix versus the pre-split version: the old inline check only
    // tested `status === 'PENDING'` for staleness (never DISPATCHED), so a
    // stale DISPATCHED job stuck showing "Processing…" forever — classify()
    // checks both, closing that gap as part of this migration.
    const state = StatusBadge.classify(attrs.status, attrs.createdAt, attrs.id)
    if (state === 'pending') {
      badge.textContent = 'Processing…'
      badge.className = 'smart-image-status smart-image-status--pending'
    } else if (state === 'stale' || state === 'timeout' || state === 'error') {
      // Surface the framework's specific error text (classifyJobError writes
      // {status, error}); fall back to a generic label.
      const errText = (attrs.error || '').trim()
      badge.textContent = errText || (state === 'timeout' ? 'Timed out' : 'Failed')
      badge.className = 'smart-image-status smart-image-status--error'
      if (errText) dom.setAttribute('data-tooltip', errText)
    } else {
      badge.textContent = ''
      badge.className = 'smart-image-status'
    }
  }

  /** @param {HTMLElement} dom @param {HTMLImageElement} img @param {HTMLElement} resizer */
  #setupResize(dom, img, resizer) {
    let isResizing = false, startX = 0, startW = 0, startH = 0, ratio = 1

    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation()
      isResizing = true; startX = e.clientX
      startW = img.clientWidth; startH = img.clientHeight
      ratio = startH > 0 ? startW / startH : 1
      document.body.style.cursor = 'nwse-resize'

      const onMove = (/** @type {MouseEvent} */ e) => {
        if (!isResizing) return
        const w = Math.max(40, startW + (e.clientX - startX))
        const h = Math.round(w / ratio)
        img.style.width = w + 'px'; img.style.height = h + 'px'
      }

      const onUp = () => {
        if (!isResizing) return
        isResizing = false
        window.removeEventListener('mousemove', onMove)
        window.removeEventListener('mouseup', onUp)
        document.body.style.cursor = ''
        if (this.#onResize) {
          this.#onResize({
            width:  String(Math.round(img.offsetWidth)),
            height: String(Math.round(img.offsetHeight)),
          })
        }
      }

      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    })
  }

  // destroy(dom): base no-op is correct — the resize listeners are attached
  // to `window` only DURING an active drag and are removed on mouseup within
  // the same gesture; nothing survives past that to clean up.
}
