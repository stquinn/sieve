// @ts-check
// SmartCardRenderer — the 'smart-card' kind's look-and-feel: the card shell, the
// OG-style layout (meta row, thumbnail, title/description/url), the
// loading/pending chrome, and this kind's stylesheet.
//
// An atom — its whole surface is the BODY, which owns the card content AND the
// root-level pending class + data attr. EVERY click handler (chrome-host
// shielding, click-to-edit-when-no-href, Mod+Click to open) needs getPos() or
// the NodeView closure, so ALL interaction stays adapter-side and this class
// builds static DOM only. The edit dialog's SAVE lands back here as the semantic
// verb setLink(href, title).
//
// `isPending` is driven by StatusBadge.classify() === 'pending' specifically
// (not 'stale'), so a stale card falls back to real data instead of hanging.

import { BlockRenderer } from './block-renderer.js'
import { smartCardStyles } from './smart-card-renderer.styles.js'
import { StatusBadge } from './status-badge.js'
import { registerBlockRenderer } from './block-kinds.js'

/** @typedef {{ id?: string, href?: string, title?: string, description?: string, image?: string, siteName?: string, status?: string, createdAt?: string|null }} SmartCardPayload */

/** @param {string} url @returns {string} */
function extractDomain(url) {
  try { return new URL(url).hostname } catch (_) { return url }
}

export class SmartCardRenderer extends BlockRenderer {
  static styles = smartCardStyles
  static rootClass = 'smart-card-card'

  /** @type {HTMLElement|null} */ #renderEl = null

  /** @returns {HTMLElement} */
  buildBody() {
    this.#renderEl = document.createElement('div')
    this.#renderEl.className = 'smart-card-card__render'
    this.#renderContent(/** @type {SmartCardPayload} */ (this.block.payload))
    return this.#renderEl
  }

  /** @param {import('../contract/sieve-block.js').SieveBlock} block */
  update(block) {
    super.update(block)
    this.#renderContent(/** @type {SmartCardPayload} */ (block.payload))
  }

  /**
   * Repoint the card at a (possibly retitled) URL — the edit dialog's SAVE, and
   * the ONLY place that edit becomes schema. Refreshed card data (description,
   * image, siteName) returns as document truth through update(block).
   * @param {string} href @param {string} title
   */
  setLink(href, title) {
    this._pushAttrs({ href: href, title: title })
  }

  /** @param {SmartCardPayload} payload */
  #renderContent(payload) {
    const dom = this.root, renderEl = this.#renderEl
    if (!dom || !renderEl) return
    renderEl.innerHTML = ''
    dom.setAttribute('data-smart-card-id', payload.id || '')

    const isPending = StatusBadge.classify(payload.status, payload.createdAt, payload.id) === 'pending'
    dom.classList.toggle('smart-card-card--pending', isPending)

    // Row 1: link icon + site name
    const meta = document.createElement('div')
    meta.className = 'smart-card-card__meta'
    const icon = document.createElement('span')
    icon.className = 'smart-card-card__icon'
    icon.textContent = '🔗'
    const site = document.createElement('span')
    site.className = 'smart-card-card__site'
    site.textContent = isPending ? extractDomain(payload.href || '') : (payload.siteName || extractDomain(payload.href || ''))
    meta.appendChild(icon)
    meta.appendChild(site)
    renderEl.appendChild(meta)

    // Row 2: thumbnail + content
    const body = document.createElement('div')
    body.className = 'smart-card-card__body'

    let thumb = document.createElement('div')
    thumb.className = 'smart-card-card__thumb'
    if (isPending) {
      thumb.classList.add('smart-card-card__thumb--spinner')
      const spinner = document.createElement('span')
      spinner.className = 'smart-card-card__spinner'
      thumb.appendChild(spinner)
    } else if (payload.image) {
      const img = document.createElement('img')
      img.src = payload.image
      img.alt = payload.title || ''
      img.className = 'smart-card-card__thumb'
      body.appendChild(img)
      thumb = /** @type {any} */ (null)
    } else {
      thumb.classList.add('smart-card-card__thumb--placeholder')
      thumb.textContent = '🔗'
    }
    if (thumb) body.appendChild(thumb)

    const content = document.createElement('div')
    content.className = 'smart-card-card__content'

    const titleEl = document.createElement('div')
    titleEl.className = 'smart-card-card__title'
    titleEl.textContent = isPending ? (payload.href || '…') : (payload.title || payload.href || '…')
    content.appendChild(titleEl)

    if (!isPending && payload.description) {
      const descEl = document.createElement('div')
      descEl.className = 'smart-card-card__description'
      descEl.textContent = payload.description
      content.appendChild(descEl)
    }

    const urlEl = document.createElement('div')
    urlEl.className = 'smart-card-card__url'
    urlEl.textContent = payload.href || ''
    content.appendChild(urlEl)

    body.appendChild(content)
    renderEl.appendChild(body)
  }

  // destroy(): base no-op is correct — this class owns no timers/observers.
}

registerBlockRenderer('smart-card', () => SmartCardRenderer)
