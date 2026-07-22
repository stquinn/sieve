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
    const w = payload.width || '', h = payload.height || ''
    img.style.width  = w ? (String(w).match(/^\d+$/) ? w + 'px' : w) : ''
    img.style.height = h ? (String(h).match(/^\d+$/) ? h + 'px' : h) : ''
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

  /** @param {HTMLImageElement} img @param {HTMLElement} resizer */
  #setupResize(img, resizer) {
    let isResizing = false, startX = 0, startW = 0, ratio = 1

    resizer.addEventListener('mousedown', (e) => {
      e.preventDefault(); e.stopPropagation()
      isResizing = true; startX = e.clientX
      startW = img.clientWidth
      const startH = img.clientHeight
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
        this.resize(String(Math.round(img.offsetWidth)), String(Math.round(img.offsetHeight)))
      }

      window.addEventListener('mousemove', onMove)
      window.addEventListener('mouseup', onUp)
    })
  }

  // destroy(): base no-op — resize listeners live on `window` only during a drag.
}
