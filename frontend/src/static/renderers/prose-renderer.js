// @ts-check
// ProseRenderer — the 'prose' kind's look-and-feel, and there is almost none of
// it: prose IS its markdown, so the block is its rendered content and no shell,
// badge or chrome around it.
//
// PROSE IS A KIND LIKE ANY OTHER, and this class is why it can be drawn like
// any other. In the document lens prose is NATIVE — TipTap owns the nodes and
// there is no NodeView — so nothing there ever builds one. Everywhere prose has
// to be DRAWN rather than edited (a question's elements, a popup, a bare page)
// this is what draws it, reached through the same registry every other kind is
// reached through.

import { BlockRenderer } from './block-renderer.js'
import { registerBlockRenderer } from './block-kinds.js'

/** @typedef {{ id?: string, content?: string }} ProseAttrs */

export class ProseRenderer extends BlockRenderer {
  static rootClass = 'sieve-block sieve-block--prose'

  /** @type {HTMLElement|null} */ #contentEl = null

  /** The rendered markdown, through the sanctioned instance. @returns {HTMLElement} */
  buildBody() {
    this.#contentEl = document.createElement('div')
    this.#contentEl.className = 'sieve-block__content'
    this.fillBody(this.#contentEl, this.bodyMarkdown())
    return this.#contentEl
  }

  /** @param {import('../contract/sieve-block.js').SieveBlock} block */
  update(block) {
    super.update(block)
    if (this.#contentEl) this.fillBody(this.#contentEl, this.bodyMarkdown())
  }

  /** The markdown this block is. @returns {string} */
  bodyMarkdown() {
    return String(/** @type {ProseAttrs} */ (this.block.payload).content || '')
  }

  /**
   * Outbound truth report — THIS kind's content attr is `content`, knowledge
   * that lives here and nowhere else.
   * @param {string} text
   */
  setContent(text) { this._pushAttrs({ content: text }) }
}

registerBlockRenderer('prose', () => ProseRenderer)
