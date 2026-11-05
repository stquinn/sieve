// @ts-check
// BlockRecordView — one whole block drawn as a RECORD: its kind's own renderer,
// with its normal chrome, marked READ-ONLY, so each kind drops its own editing
// and mutating affordances. No renderer is given a provider, so its outbound
// verbs are inert twice over.
//
// It is told the CONTAINER the block lives in, because a reference to something
// processed server-side is only fetchable relative to the container holding it.

import { SieveBlock } from '../contract/sieve-block.js'
import { getBlockRenderer } from './block-renderers.js'
import { documentAssetUrl } from './asset-urls.js'
import { getLowlight, hastToHtml } from './highlighting.js'

export class BlockRecordView {
  /** @type {string} */ #container
  /** @type {{destroy: () => void}|null} */ #renderer = null

  /** @param {string} [container] the uuid of the container the block lives in */
  constructor(container) {
    this.#container = String(container || '')
  }

  /**
   * Draws a block, releasing whatever this view drew before.
   * @param {string} kind
   * @param {Record<string, any>} attrs the block's wire attrs
   * @returns {HTMLElement|null} the block's DOM, or null when nothing draws its kind
   */
  draw(kind, attrs) {
    this.destroy()
    const Renderer = getBlockRenderer(kind)
    if (!Renderer) return null
    const renderer = new Renderer(new SieveBlock(kind, this.#resolved(attrs || {})), null, undefined, { readOnly: true })
    const dom = renderer.render()
    BlockRecordView.#writeOwnText(renderer, attrs || {})
    this.#renderer = renderer
    return dom
  }

  /** Releases the renderer this view drew with. Idempotent. */
  destroy() {
    if (this.#renderer) this.#renderer.destroy()
    this.#renderer = null
  }

  /**
   * The attrs with what a LENS would have resolved for them added.
   *
   * A kind whose content was processed server-side names the result by a
   * reference the container holds, and turning that into a fetchable url takes
   * the container. A block that was never processed gets nothing, and its kind
   * falls back to whatever it can show from its own text — as does one whose
   * reference names a container this view was not told.
   * @param {Record<string, any>} attrs
   * @returns {Record<string, any>}
   */
  #resolved(attrs) {
    const ref = String(attrs.parsedAssetRef || '')
    // A ref the store minted is already a served route and needs no container;
    // only a bare one has to be resolved against the container holding it.
    if (!ref || (!ref.startsWith('/') && !this.#container)) return attrs
    return Object.assign({}, attrs, { resolvedAssetUrl: documentAssetUrl(this.#container, ref) })
  }

  /**
   * Writes the text a lens would otherwise own into the renderer.
   *
   * A kind whose content is literal source text renders it through a ProseMirror
   * contentDOM in a document — the renderer builds the `<code>` and PM fills it.
   * There is no ProseMirror here, so the record fills it, and highlights the
   * element rather than the subtree: the shared subtree pass wraps every `<pre>`
   * in a line gutter, and the renderer already drew one.
   * @param {any} renderer @param {Record<string, any>} attrs
   */
  static #writeOwnText(renderer, attrs) {
    const code = typeof renderer.codeElement === 'undefined' ? null : renderer.codeElement
    if (!code) return
    const source = String(attrs.source || '')
    code.textContent = source
    if (typeof renderer.syncGutterLineCount === 'function') renderer.syncGutterLineCount(source)
    const lang = String(attrs.language || '').trim()
    const low = getLowlight()
    if (!lang || lang === 'unknown' || !low || !source) return
    try { code.innerHTML = hastToHtml(low.highlight(lang, source).children) } catch (e) { /* unknown language: the plain text stands */ }
  }
}
