// @ts-check
// smart-card-renderer.js — SmartCardRenderer: the renderer half of the
// 'smart-card' kind's renderer/NodeView split. NORMATIVE contract:
// docs/design/specs/2026-07-21-block-renderer-contract.md (APPROVED rev 2).
// Owns look-and-feel ONLY: the card shell, the OG-style layout (meta row,
// thumbnail, title/description/url), the loading/pending chrome (shared
// StatusBadge decision tree — survey item A7), and this kind's stylesheet
// (`static styles`). Zero ProseMirror/editor/window.* dependencies.
//
// An atom — its whole surface is the BODY (buildBody), which owns the card
// content AND the root-level pending class + data attr (an atom's body IS its
// surface). EVERY click handler (chrome-host shielding, click-to-edit-when-no-
// href, Mod+Click to open) needs getPos()/the NodeView closure or dispatches
// `sieve:smart-card-edit` — genuinely PM-coupled, so ALL interaction stays
// adapter-side; this class builds static DOM only. The edit dialog's SAVE lands
// back here as the semantic verb setLink(href, title) (subclass-owned; called
// by the adapter that constructed this concrete type — abstract-consumer rule).
//
// `isPending` is driven by StatusBadge.classify() === 'pending' specifically
// (not 'stale'), so a stale card falls back to real data instead of hanging.

import { BlockRenderer } from './block-renderer.js'
import { smartCardStyles } from './smart-card-renderer.styles.js'
import { StatusBadge } from './status-badge.js'

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

  /** @param {import('../sieve-block.js').SieveBlock} block */
  update(block) {
    super.update(block)
    this.#renderContent(/** @type {SmartCardPayload} */ (block.payload))
  }

  // ── Semantic verbs (kind-specific — contract's abstract-consumer rule) ────

  /**
   * Repoint the card at a (possibly retitled) URL — the edit dialog's SAVE.
   * The verb is the ONLY place that edit becomes schema (via _pushAttrs);
   * refreshed card data (description, image, siteName) returns as document
   * truth through update(block).
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
