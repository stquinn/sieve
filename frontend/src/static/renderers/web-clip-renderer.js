// @ts-check
// WebClipRenderer — the 'web-clip' kind's look-and-feel: the block shell, the
// status chrome (its header), the page TITLE, the fetched/summarised BODY, and
// this kind's stylesheet.
//
// buildBody() builds AND FILLS the body from bodyMarkdown(), and update()
// re-fills it — guarded on the #contentEl ref. In the editor lens the adapter
// claims the BODY region via handleBuild, so no #contentEl is recorded and the
// seam authors body content via fresh scratch instances. Retry is the base's
// semantic verb (this.retry()).
//
// Status chrome is mount-once/patch: buildHeader() builds the ENTIRE chrome DOM
// once (badge, [spinner|icon][label], the COMPLETE-only [status][link] pair, the
// retry button) and caches refs; update() only toggles hidden/class and writes
// attrs-derived text via textContent (href via property assignment) — keeping a
// hostile fetched title/URL/error string inert.

import { BlockRenderer } from './block-renderer.js'
import { webClipStyles } from './web-clip-renderer.styles.js'
import { StatusBadge } from './status-badge.js'
import { registerBlockRenderer } from './block-kinds.js'

/** @typedef {{ id?: string, source?: string, mode?: string, status?: string, createdAt?: string|null, error?: string|null, title?: string|null, content?: string|null }} WebClipAttrs */

/** @typedef {{ spinner: boolean, glyph: string, modifierClass: string, retry: boolean, label: (domain: string, modeLabel: string, attrs: WebClipAttrs) => string }} WebClipStateChrome */

/** @type {Record<'pending'|'stale'|'timeout'|'error', WebClipStateChrome>} */
const STATE_CHROME = {
  pending: {
    spinner: true, glyph: '', modifierClass: '', retry: false,
    label: (domain, modeLabel) => modeLabel + ' from ' + domain + '…',
  },
  stale: {
    spinner: false, glyph: '⚠', modifierClass: 'web-clip-block__icon--warn', retry: true,
    label: (domain, modeLabel) => modeLabel.replace('ing', '') + ' interrupted — ' + domain,
  },
  timeout: {
    spinner: false, glyph: '⚠', modifierClass: 'web-clip-block__icon--warn', retry: true,
    label: (domain) => 'Timed out — ' + domain,
  },
  error: {
    spinner: false, glyph: '✕', modifierClass: 'web-clip-block__icon--error', retry: true,
    label: (domain, modeLabel, attrs) => (attrs.error || 'Unknown error').trim(),
  },
}

export class WebClipRenderer extends BlockRenderer {
  static styles = webClipStyles
  static rootClass = 'web-clip-block'

  /** @type {HTMLElement|null} */ #spinnerEl = null
  /** @type {HTMLElement|null} */ #iconEl = null
  /** @type {HTMLElement|null} */ #labelEl = null
  /** @type {HTMLElement|null} */ #statusEl = null
  /** @type {HTMLAnchorElement|null} */ #linkEl = null
  /** @type {HTMLButtonElement|null} */ #retryBtn = null
  /** @type {HTMLElement|null} */ #titleEl = null
  /** @type {HTMLElement|null} */ #contentEl = null

  /** The status chrome — this kind's HEADER region — plus root-level drag/
   *  selection guards (the base stamps data-id). @returns {HTMLElement} */
  buildHeader() {
    const dom = this.root
    if (dom) {
      dom.setAttribute('draggable', 'false')
      dom.style.userSelect = 'text'
      dom.addEventListener('dragstart', (e) => e.preventDefault())
      dom.addEventListener('click', (e) => {
        const t = /** @type {HTMLElement} */ (e.target)
        const a = t.closest ? t.closest('a') : null
        if (a && /** @type {HTMLAnchorElement} */ (a).href) {
          // Prevent Wails navigating the internal webview.
          e.preventDefault()
        }
      })
    }

    const renderEl = document.createElement('div')
    renderEl.className = 'web-clip-block__render'
    renderEl.contentEditable = 'false'

    const badge = document.createElement('span')
    badge.className = 'web-clip-block__badge'
    badge.textContent = 'WEB CLIP'
    renderEl.appendChild(badge)

    const header = document.createElement('div')
    header.className = 'web-clip-block__header'

    const spinnerEl = document.createElement('span')
    spinnerEl.className = 'web-clip-block__spinner'
    header.appendChild(spinnerEl)

    const iconEl = document.createElement('span')
    iconEl.className = 'web-clip-block__icon'
    header.appendChild(iconEl)

    const labelEl = document.createElement('span')
    labelEl.className = 'web-clip-block__label'
    header.appendChild(labelEl)

    const statusEl = document.createElement('span')
    statusEl.className = 'web-clip-block__status'
    header.appendChild(statusEl)

    const linkEl = document.createElement('a')
    linkEl.className = 'web-clip-block__source-link'
    linkEl.target = '_blank'
    linkEl.rel = 'noopener noreferrer'
    header.appendChild(linkEl)

    renderEl.appendChild(header)

    const retryBtn = document.createElement('button')
    retryBtn.className = 'web-clip-block__retry'
    retryBtn.textContent = 'Retry'
    retryBtn.addEventListener('click', () => { this.retry() })
    renderEl.appendChild(retryBtn)

    this.#spinnerEl = spinnerEl
    this.#iconEl = iconEl
    this.#labelEl = labelEl
    this.#statusEl = statusEl
    this.#linkEl = linkEl
    this.#retryBtn = retryBtn
    this.#updateChrome(/** @type {WebClipAttrs} */ (this.block.payload))
    return renderEl
  }

  /** The fetched/summarised page TITLE. @returns {HTMLElement} */
  buildTitle() {
    this.#titleEl = document.createElement('div')
    this.fillTitleSlot(this.#titleEl, /** @type {WebClipAttrs} */ (this.block.payload).title || '')
    return this.#titleEl
  }

  /** The fetched/summarised BODY, self-filled. In the editor lens the adapter
   *  claims this region via handleBuild, so this hook never runs there.
   *  @returns {HTMLElement} */
  buildBody() {
    this.#contentEl = document.createElement('div')
    this.#contentEl.className = 'web-clip-block__content tiptap'
    this.fillBody(this.#contentEl, this.bodyMarkdown())
    return this.#contentEl
  }

  /** The body markdown, derived from THIS instance's block. @returns {string} */
  bodyMarkdown() { return (/** @type {WebClipAttrs} */ (this.block.payload).content || '').trim() }

  /** @param {import('../contract/sieve-block.js').SieveBlock} block */
  update(block) {
    super.update(block)
    const attrs = /** @type {WebClipAttrs} */ (block.payload)
    this.#updateChrome(attrs)
    if (this.#titleEl) this.fillTitleSlot(this.#titleEl, attrs.title || '')
    // REF-GUARDED — a claimed (externally managed) body recorded no #contentEl.
    if (this.#contentEl) this.fillBody(this.#contentEl, this.bodyMarkdown())
  }

  /** @param {WebClipAttrs} attrs */
  #updateChrome(attrs) {
    const spinnerEl = this.#spinnerEl, iconEl = this.#iconEl, labelEl = this.#labelEl
    const statusEl = this.#statusEl, linkEl = this.#linkEl, retryBtn = this.#retryBtn
    if (!spinnerEl || !iconEl || !labelEl || !statusEl || !linkEl || !retryBtn) return

    const domain = attrs.source || ''
    const modeLabel = attrs.mode === 'summarise' ? 'Summarising' : 'Fetching'
    const completeModeLabel = attrs.mode === 'summarise' ? 'Summarised' : 'Fetched'
    const state = StatusBadge.classify(attrs.status, attrs.createdAt, attrs.id)

    if (state === 'complete') {
      spinnerEl.hidden = true
      iconEl.hidden = true
      iconEl.className = 'web-clip-block__icon'
      labelEl.hidden = true
      retryBtn.hidden = true

      statusEl.hidden = false
      statusEl.textContent = completeModeLabel + ' — '
      linkEl.hidden = false
      linkEl.href = attrs.source || ''
      linkEl.textContent = attrs.source || domain
      return
    }

    statusEl.hidden = true
    linkEl.hidden = true

    const chrome = STATE_CHROME[/** @type {'pending'|'stale'|'timeout'|'error'} */ (state)]
    spinnerEl.hidden = !chrome.spinner
    iconEl.hidden = chrome.spinner
    iconEl.className = 'web-clip-block__icon' + (chrome.modifierClass ? ' ' + chrome.modifierClass : '')
    iconEl.textContent = chrome.glyph
    labelEl.hidden = false
    labelEl.textContent = chrome.label(domain, modeLabel, attrs)
    retryBtn.hidden = !chrome.retry
  }

  // destroy(): base no-op is correct — this class owns no timers/observers.
}

registerBlockRenderer('web-clip', () => WebClipRenderer)
