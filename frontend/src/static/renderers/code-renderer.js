// @ts-check
// CodeRenderer — the 'code' kind's look-and-feel: the block shell, the HEADER (a
// stateful language badge), the gutter + code-area body chrome, this kind's
// stylesheet, and the content→source outbound mapping (setContent).
//
// PM-specific concerns stay adapter-side: the raw text is ProseMirror-owned (the
// adapter binds the <code>, exposed as renderer.codeElement, as the NodeView's
// contentDOM), the lowlight DECORATION plugin, and the MutationObserver that
// watches contentDOM and reports live text through setContent.

import { BlockRenderer } from './block-renderer.js'
import { codeStyles } from './code-renderer.styles.js'
import { LineGutter } from './line-gutter.js'
import { AdvancedHeaderProvider, badgeEl, HeaderBar } from './header-bar.js'
import { StatusBadge } from './status-badge.js'
import { registerBlockRenderer } from './block-kinds.js'

/** @typedef {{ id?: string, source?: string, language?: string, detectionMethod?: string, status?: string, createdAt?: string|null }} CodeAttrs */

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

  /**
   * This kind IS insertable from the keyboard, and this is what a fresh one is:
   * nothing. Every attr the block needs — language, status, timestamps — is the
   * server's to fill on create.
   * @returns {{label: string, description: string, defaults: Record<string, any>}}
   */
  static insertSpec() {
    return { label: 'Code', description: 'Source, syntax-highlighted', defaults: {} }
  }

  /** @returns {HTMLElement} */
  buildHeader() {
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
    // A record's text is read, never typed into: no lens binds this as an
    // editable surface, and the attribute says so to any that tried.
    if (this.readOnly) {
      pre.setAttribute('contenteditable', 'false')
      pre.style.pointerEvents = 'none'
    }

    pre.appendChild(codeEl)
    codeArea.appendChild(pre)
    body.appendChild(gutter)
    body.appendChild(codeArea)

    this.#gutter = gutter
    this.#codeEl = codeEl
    this.#syncBody(/** @type {CodeAttrs} */ (this.block.payload))
    return body
  }

  /** @param {import('../contract/sieve-block.js').SieveBlock} block */
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

  /** The editable <code> the adapter binds as ProseMirror's contentDOM. @returns {HTMLElement|null} */
  get codeElement() { return this.#codeEl }

  /** Live-typing gutter sync the adapter's MutationObserver drives (outside the
   *  render/update lifecycle). @param {string} source */
  syncGutterLineCount(source) { if (this.#gutter) LineGutter.sync(this.#gutter, source) }

  /**
   * Outbound truth report — THIS kind's content attr is `source`, knowledge
   * that lives here and nowhere else.
   * @param {string} text
   */
  setContent(text) { this._pushAttrs({ source: text }) }
}

registerBlockRenderer('code', () => CodeRenderer)
