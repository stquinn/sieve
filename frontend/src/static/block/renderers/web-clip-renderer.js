// @ts-check
// web-clip-renderer.js — WebClipRenderer: the renderer half of the 'web-clip'
// kind's renderer/NodeView split (docs/design/archive/specs/2026-07-20-block-renderer-extraction.md,
// Phase 4 / issue #47). Owns look-and-feel ONLY: the block shell, the status
// chrome (badge + icon/label/retry, driven by the shared StatusBadge decision
// tree — survey item A7), and this kind's complete stylesheet (`static
// styles`). Zero ProseMirror/editor/window.* app-global dependencies — this
// class mounts identically in the note editor's NodeView adapter
// (frontend/src/static/processors/web-clip-renderer.js, which HOLDS an
// instance of this class by composition, never inheritance), a bare-page
// harness, or any future non-PM lens.
//
// What this class deliberately does NOT own, and why — the PM-specificity
// sorting test:
//   - The title and fetched/summarised BODY are never built as DOM by this
//     class. Like ai-block, web-clip's title/content are rendered as LIVE
//     ProseMirror nodes inside contentDOM by sieve-block-extension.js's
//     framework-owned titleProvider/contentProvider seam — unavoidably
//     PM-coupled, stays adapter/framework-side. This class only builds the
//     EMPTY contentDOM container the framework seam fills.
//   - Reverse chain-glow hover (cross-block `document.querySelectorAll('.ai-block')`
//     walking to light up referencing ai-blocks) is CROSS-BLOCK behaviour,
//     not this block's own look-and-feel — stays adapter-side, same as
//     ai-block's applyChain.
//   - The read-only-container guard plugin speaks PM plugin props directly —
//     adapter-side, per the sorting test.
//
// Retry is a user ACTION reaching the held Editor (ctx.retry(), a
// PM-framework path) — this PM-free class only builds the retry button and
// invokes whatever callback the adapter registers via onRetry(), mirroring
// LogRenderer's onColumnsAvailable callback-injection pattern for the same
// reason (a callback is just a function; it carries no PM coupling).
//
// Status-chrome shape (2026-07-20 revision — see docs/how-to-intelligent-fenced-blocks.md
// "Renderer / NodeView split" § mount-once/patch-on-update): mount() builds
// the ENTIRE chrome DOM exactly once — badge, [spinner|icon][label], the
// COMPLETE-only [status][link] pair, and the retry button — and caches
// element references. update() NEVER touches innerHTML; it only toggles
// `hidden`/class and writes attrs-derived text via `textContent` (and `href`
// via a real property assignment, never a string built into markup). This
// closes an actual injection hazard the pre-revision version had: `domain`
// (attrs.source, a fetched URL) and `errMsg` (attrs.error, text surfaced from
// a fetched/summarised page or a backend error) were being concatenated
// straight into `element.innerHTML` — a hostile page title, source URL, or
// error string containing markup would have executed as HTML inside the
// editor. STATE_CHROME below is the same "attrs → {glyph, modifier, label,
// spinner, retry}" decision-map shape as the shared StatusBadge tree (A7);
// COMPLETE is handled separately since it swaps to a structurally different
// pair (status text + link) rather than an indicator+label.

import { BlockRenderer } from './block-renderer.js'
import { webClipStyles } from './web-clip-renderer.styles.js'
import { StatusBadge } from './status-badge.js'

/** @typedef {{ id?: string, source?: string, mode?: string, status?: string, createdAt?: string|null, error?: string|null }} WebClipAttrs */

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
  // Sheet lives in the sibling web-clip-renderer.styles.js — styles-file-geography
  // convention: a renderer file starts with its class, never a CSS wall.
  static styles = webClipStyles

  /** @type {HTMLElement|null} */ #contentDOM = null
  /** @type {HTMLElement|null} */ #spinnerEl = null
  /** @type {HTMLElement|null} */ #iconEl = null
  /** @type {HTMLElement|null} */ #labelEl = null
  /** @type {HTMLElement|null} */ #statusEl = null
  /** @type {HTMLAnchorElement|null} */ #linkEl = null
  /** @type {HTMLButtonElement|null} */ #retryBtn = null
  /** @type {(() => void)|null} */ #onRetry = null

  /** The live ProseMirror contentDOM the adapter binds as its NodeView's
   *  contentDOM — this class builds the empty container; the framework's
   *  titleProvider/contentProvider seam fills it with real PM nodes, never
   *  this class. @returns {HTMLElement|null} */
  get contentDOM() { return this.#contentDOM }

  /** Registers the callback the retry button invokes — the adapter's hook
   *  into ctx.retry() (a PM-framework path this PM-free class never touches
   *  directly). @param {() => void} cb */
  onRetry(cb) { this.#onRetry = cb }

  /** @param {WebClipAttrs} attrs @returns {HTMLElement} */
  mount(attrs) {
    const dom = document.createElement('div')
    dom.className = 'web-clip-block'
    dom.setAttribute('draggable', 'false')
    dom.style.userSelect = 'text'

    // renderEl holds the chrome (badge, indicator/label, status/link, retry) —
    // built ONCE here, never rebuilt by update(). contentEditable=false —
    // like ai-block's badge and question — so the caret can never land in it.
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
    retryBtn.addEventListener('click', () => { if (this.#onRetry) this.#onRetry() })
    renderEl.appendChild(retryBtn)

    dom.appendChild(renderEl)

    // contentDOM is a VISIBLE, ProseMirror-owned region holding the fetched/
    // summarised markdown as real document nodes — a direct analog of
    // ai-block's response body. ProseMirror tracks it by reference; it is
    // never removed from dom.
    const contentDOM = document.createElement('div')
    contentDOM.className = 'web-clip-block__content tiptap'
    dom.appendChild(contentDOM)

    dom.addEventListener('dragstart', (e) => e.preventDefault())
    dom.addEventListener('click', (e) => {
      const a = /** @type {HTMLElement} */ (e.target).closest ? /** @type {HTMLElement} */ (e.target).closest('a') : null
      if (a && /** @type {HTMLAnchorElement} */ (a).href) {
        // Prevent Wails from navigating the internal webview. (Ctrl+Click is
        // handled by the global capture in editor.js.)
        e.preventDefault()
      }
    })

    this.#contentDOM = contentDOM
    this.#spinnerEl = spinnerEl
    this.#iconEl = iconEl
    this.#labelEl = labelEl
    this.#statusEl = statusEl
    this.#linkEl = linkEl
    this.#retryBtn = retryBtn

    this.update(dom, attrs)
    return dom
  }

  /**
   * Patches the status chrome in place from the shared StatusBadge decision
   * tree — every dynamic value is written via `textContent`/property
   * assignment (never `innerHTML`), so attrs-derived text (a fetched page's
   * domain, a backend error string) can never be interpreted as markup. The
   * textual title/body content is the framework seam's job, not this
   * method's.
   * @param {HTMLElement} dom
   * @param {WebClipAttrs} attrs
   */
  update(dom, attrs) {
    dom.setAttribute('data-id', attrs.id || '')
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
      iconEl.className = 'web-clip-block__icon'   // reset any stale modifier class
      labelEl.hidden = true
      retryBtn.hidden = true

      statusEl.hidden = false
      statusEl.textContent = completeModeLabel + ' — '
      linkEl.hidden = false
      linkEl.href = attrs.source || ''
      linkEl.textContent = attrs.source || domain
      // The title + fetched body are rendered into contentDOM as real PM nodes
      // via the framework's titleProvider/contentProvider seam (title folds in
      // as an h1), not here — only the interactive source link stays as
      // header chrome.
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

  // destroy(dom): base no-op is correct — this class owns no timers/observers.
}
