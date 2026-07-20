// @ts-check
// smart-card-renderer.js — SmartCardRenderer: the renderer half of the
// 'smart-card' kind's renderer/NodeView split (docs/design/specs/2026-07-20-block-renderer-extraction.md,
// Phase 4 / issue #47). Owns look-and-feel ONLY: the card shell, the OG-style
// layout (meta row, thumbnail, title/description/url), the loading/pending
// chrome (driven by the shared StatusBadge decision tree — survey item A7),
// and this kind's complete stylesheet (`static styles`). Zero ProseMirror/
// editor/window.* app-global dependencies — this class mounts identically in
// the note editor's NodeView adapter
// (frontend/src/static/processors/smart-card-renderer.js, which HOLDS an
// instance of this class by composition, never inheritance), a bare-page
// harness, or any future non-PM lens.
//
// What this class deliberately does NOT own, and why — the PM-specificity
// sorting test: EVERY click handler (chrome-host click shielding, click-to-
// edit-when-no-href, Mod+Click to open the URL via the Wails runtime) needs
// either `getPos()` (a NodeView-only closure) or dispatches the
// `sieve:smart-card-edit` CustomEvent carrying `getPos`/`editor` — genuinely
// PM-coupled, so ALL interaction stays adapter-side; this class builds
// static DOM only. The edit-popup dialog (A9) also stays adapter-side for
// now (its twin, smart-link, is unmigrated — see the adapter's header).
//
// Deliberate fix versus the pre-split version (drift the migration survey
// calls out): the old inline `isPending` flag stayed true for a STALE job
// (job tracker has no record + past the CLI timeout) because it only
// suppressed the `smart-card-card--pending` wrapper CLASS, not the
// thumbnail-spinner/placeholder-title content — a stale card was stuck
// showing "loading" chrome forever. `isPending` here is driven by
// StatusBadge.classify() === 'pending' specifically (not 'stale'), so a
// stale card correctly falls back to whatever real data it has (href as
// title, no spinner) instead of hanging.

import { BlockRenderer } from './block-renderer.js'
import { smartCardStyles } from './smart-card-renderer.styles.js'
import { StatusBadge } from './status-badge.js'

/** @typedef {{ id?: string, href?: string, title?: string, description?: string, image?: string, siteName?: string, status?: string, createdAt?: string|null }} SmartCardAttrs */

/** @param {string} url @returns {string} */
function extractDomain(url) {
  try { return new URL(url).hostname } catch (_) { return url }
}

export class SmartCardRenderer extends BlockRenderer {
  // Sheet lives in the sibling smart-card-renderer.styles.js — styles-file-geography
  // convention: a renderer file starts with its class, never a CSS wall.
  static styles = smartCardStyles

  /** @type {HTMLElement|null} */ #renderEl = null

  /** @param {SmartCardAttrs} attrs @returns {HTMLElement} */
  mount(attrs) {
    const dom = document.createElement('div')
    dom.className = 'smart-card-card'

    const renderEl = document.createElement('div')
    renderEl.className = 'smart-card-card__render'
    dom.appendChild(renderEl)

    this.#renderEl = renderEl
    this.update(dom, attrs)
    return dom
  }

  /** @param {HTMLElement} dom @param {SmartCardAttrs} attrs */
  update(dom, attrs) {
    const renderEl = this.#renderEl
    if (!renderEl) return
    renderEl.innerHTML = ''
    dom.setAttribute('data-smart-card-id', attrs.id || '')

    // isPending is driven by the 'pending' bucket ONLY — see file header for
    // why a 'stale' job must NOT keep showing loading chrome.
    const isPending = StatusBadge.classify(attrs.status, attrs.createdAt, attrs.id) === 'pending'
    dom.classList.toggle('smart-card-card--pending', isPending)

    // Row 1: link icon + site name
    const meta = document.createElement('div')
    meta.className = 'smart-card-card__meta'
    const icon = document.createElement('span')
    icon.className = 'smart-card-card__icon'
    icon.textContent = '🔗'
    const site = document.createElement('span')
    site.className = 'smart-card-card__site'
    site.textContent = isPending ? extractDomain(attrs.href || '') : (attrs.siteName || extractDomain(attrs.href || ''))
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
    } else if (attrs.image) {
      const img = document.createElement('img')
      img.src = attrs.image
      img.alt = attrs.title || ''
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
    titleEl.textContent = isPending ? (attrs.href || '…') : (attrs.title || attrs.href || '…')
    content.appendChild(titleEl)

    if (!isPending && attrs.description) {
      const descEl = document.createElement('div')
      descEl.className = 'smart-card-card__description'
      descEl.textContent = attrs.description
      content.appendChild(descEl)
    }

    const urlEl = document.createElement('div')
    urlEl.className = 'smart-card-card__url'
    urlEl.textContent = attrs.href || ''
    content.appendChild(urlEl)

    body.appendChild(content)
    renderEl.appendChild(body)
  }

  // destroy(dom): base no-op is correct — this class owns no timers/observers.
}
