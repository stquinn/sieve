// @ts-check
// code-renderer.js — CodeRenderer: the renderer half of the 'code' kind's
// renderer/NodeView split (Block Renderer Contract,
// docs/design/archive/specs/2026-07-21-block-renderer-contract.md). Owns look-and-feel
// ONLY: the block shell, the HEADER (a stateful language badge), the
// gutter+code-area body chrome, this kind's stylesheet (`static styles`), and
// the content→source outbound mapping (setContent). Zero ProseMirror/editor/
// window.* dependencies.
//
// buildHeader() lays out a CodeHeader via a HeaderBar; buildBody() builds the
// gutter + code-area + the editable <code>. PM-specific concerns stay
// adapter-side: the raw text is ProseMirror-owned (the adapter binds the
// <code>, exposed as renderer.codeElement, as the NodeView's contentDOM), the
// lowlight DECORATION plugin, and the MutationObserver that watches contentDOM
// and reports live text through this renderer's setContent (the contract's
// outbound truth channel).

import { BlockRenderer } from './block-renderer.js'
import { codeStyles } from './code-renderer.styles.js'
import { LineGutter } from './line-gutter.js'
import { AdvancedHeaderProvider, badgeEl, HeaderBar } from './header-bar.js'
import { StatusBadge } from './status-badge.js'

/** @typedef {{ id?: string, source?: string, language?: string, detectionMethod?: string, status?: string, createdAt?: string|null }} CodeAttrs */

// ── Header provider — badge only, but stateful: 'detecting…' while the language
// job runs, the language once known, else 'CODE' (pending/settled off
// StatusBadge.classify — survey item A7). ──
class CodeHeader extends AdvancedHeaderProvider {
  /** @param {CodeAttrs} attrs @returns {HTMLElement} */
  badge(attrs) {
    const state         = StatusBadge.classify(attrs.status, attrs.createdAt, attrs.id)
    const showDetecting = state === 'pending' && (!attrs.language || attrs.language === '')
    let text, cls
    if (showDetecting) { text = 'detecting…'; cls = 'sieve-block__badge--pending' }
    else if (attrs.language && attrs.language !== 'unknown') { text = attrs.language; cls = '' }
    else { text = (attrs.language === 'unknown' ? 'CODE' : attrs.language) || 'CODE'; cls = 'sieve-block__badge--unknown' }
    const b = badgeEl(text, cls)
    if (attrs.detectionMethod) {
      b.setAttribute('data-detection-method', attrs.detectionMethod)
      b.title = 'Detected via ' + attrs.detectionMethod
    }
    return b
  }
}

export class CodeRenderer extends BlockRenderer {
  static styles = codeStyles
  static rootClass = 'sieve-block sieve-block--code'

  /** @type {HeaderBar|null} */ #headerBar = null
  /** @type {HTMLElement|null} */ #gutter = null
  /** @type {HTMLElement|null} */ #codeEl = null

  /** @returns {HTMLElement} */
  buildHeader() {
    // The header's context IS this renderer (contract rule — providers speak
    // semantic verbs, never injected closures; CodeHeader is read-only today).
    this.#headerBar = new HeaderBar(new CodeHeader())
    return this.#headerBar.render(/** @type {CodeAttrs} */ (this.block.payload), this)
  }

  /** @returns {HTMLElement} */
  buildBody() {
    const body = document.createElement('div')
    body.className = 'sieve-block__body'

    const gutter = document.createElement('div')
    gutter.className = 'sieve-block__gutter'
    gutter.contentEditable = 'false'

    const codeArea = document.createElement('div')
    codeArea.className = 'sieve-block__code-area'

    const pre = document.createElement('pre')
    pre.className = 'sieve-block__edit'
    pre.style.whiteSpace = 'pre-wrap'
    pre.style.pointerEvents = 'auto'
    pre.style.outline = 'none'
    pre.style.color = 'var(--theme-text)'

    const codeEl = document.createElement('code')
    codeEl.className = 'hljs'

    pre.appendChild(codeEl)
    codeArea.appendChild(pre)
    body.appendChild(gutter)
    body.appendChild(codeArea)

    this.#gutter = gutter
    this.#codeEl = codeEl
    this.#syncBody(/** @type {CodeAttrs} */ (this.block.payload))
    return body
  }

  /** THE inbound truth channel. @param {import('../sieve-block.js').SieveBlock} block */
  update(block) {
    super.update(block)
    const attrs = /** @type {CodeAttrs} */ (block.payload)
    if (this.#headerBar) this.#headerBar.update(attrs, this)
    this.#syncBody(attrs)
  }

  /** @param {CodeAttrs} attrs */
  #syncBody(attrs) {
    const lang = attrs.language || ''
    if (this.#codeEl) this.#codeEl.className = (lang && lang !== 'unknown') ? 'language-' + lang + ' hljs' : 'hljs'
    this.syncGutterLineCount(attrs.source || '')
  }

  /** The editable <code> the adapter binds as ProseMirror's contentDOM. A
   *  neutral accessor. @returns {HTMLElement|null} */
  get codeElement() { return this.#codeEl }

  /** Live-typing gutter sync the adapter's MutationObserver drives (outside the
   *  render/update lifecycle). @param {string} source */
  syncGutterLineCount(source) { if (this.#gutter) LineGutter.sync(this.#gutter, source) }

  /**
   * Outbound truth report — THIS kind's content attr is `source`, knowledge
   * that lives here and nowhere else (contract §setContent direction; the
   * retired v1 applier used to do this mapping adapter-side).
   * @param {string} text
   */
  setContent(text) { this._pushAttrs({ source: text }) }
}
