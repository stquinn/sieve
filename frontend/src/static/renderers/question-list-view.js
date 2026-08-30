// @ts-check
// QuestionListView — the shared drawing of a QUESTION: the ordered blocks a
// question IS, each rendered as the kind it is, by composing that kind's own
// renderer.
//
// A SUB-COMPONENT, NOT A KIND'S RENDERER. It draws a question wherever a
// question appears; the CHROME around one — a block shell, a badge, a footer, a
// turn's frame — belongs to whichever renderer is hosting it, because different
// lenses frame the same question differently. Chrome and drawing separate for
// the same reason StatusBadge and LineGutter are their own components.
//
// IT DRAWS THE BODY SLOT, AND ONLY THAT. It is handed the slot rather than the
// whole list so the slot rule cannot be re-derived here: classification is
// QuestionList.fold's, once, and a host draws the other two slots with its own
// affordances — what a question was HANDED as chips of its own choosing, and
// what it is ABOUT as POINTING, which has no entry at all and shows as the
// lineage affordances on whatever local presence the target has.
//
// EVERY ELEMENT IS A WHOLE BLOCK, drawn by its kind's own renderer with its
// normal chrome, and marked READ-ONLY — the framework flag, so each kind
// disables its own editing and mutating affordances rather than this class
// knowing what any of them are. A question is a RECORD of what was asked, and a
// record is READ: its elements' read affordances are live, so this class
// intercepts no gesture on its way to one.
//
// PM-free, host-blind, transport-blind: no ProseMirror, no nested editor, no
// window.*. No composed renderer is given a provider, so its outbound verbs are
// inert twice over. The one thing it is told is the CONTAINER, because an
// element's reference to something processed server-side is only fetchable
// relative to the document holding it.
//
// AN ELEMENT IS NOT ADDRESSABLE. It lives inside its parent's payload, so no
// composed DOM presents a document-block identity — see BlockIdentity, which is
// what keeps a gesture inside a question resolving to the block hosting it.

import { BlockIdentity } from './block-identity.js'
import { SieveBlock } from '../contract/sieve-block.js'
import { getBlockRenderer } from './block-renderers.js'
import { documentAssetUrl } from './asset-urls.js'
import { badgeEl } from './header-bar.js'
import { getLowlight, hastToHtml } from './highlighting.js'

/** @typedef {import('./question-list.js').QuestionElement} QuestionElement */

export class QuestionListView {
  /** @type {Array<{destroy: () => void}>} composed renderers this draw owns */ #composed = []
  /** @type {MutationObserver|null} keeps late content anonymous */ #watcher = null
  /** @type {string} the container whose assets an element's refs name */ #container

  /** @param {string} [container] the uuid of the document the question is asked
   *  in — what an element's asset reference is resolved against */
  constructor(container) {
    this.#container = String(container || '')
  }

  /**
   * Redraws `el` as the question's body. The whole list is rebuilt rather than
   * patched: a question is settled at the moment it is asked, so a redraw only
   * ever happens because a different question arrived.
   * @param {HTMLElement} el
   * @param {ReadonlyArray<QuestionElement>} body  the body slot, in authored order
   * @returns {number} how many elements were drawn — 0 means there is nothing to
   *   show, and the host hides the region
   */
  fill(el, body) {
    this.destroy()
    el.innerHTML = ''
    const elements = body || []
    for (const element of elements) el.appendChild(this.#row(element))
    this.#keepAnonymous(el)
    return elements.length
  }

  /** Releases the renderers this view composed, and the watcher over them. */
  destroy() {
    if (this.#watcher) { this.#watcher.disconnect(); this.#watcher = null }
    for (const renderer of this.#composed) renderer.destroy()
    this.#composed = []
  }

  /**
   * One element's row: the kind as DATA on the row, the kind's own rendering
   * inside it.
   * @param {QuestionElement} element
   * @returns {HTMLElement}
   */
  #row(element) {
    const row = document.createElement('div')
    row.className = 'ai-block__element'
    row.setAttribute('data-kind', element.kind)
    // NOTHING IS INTERCEPTED HERE. A row once swallowed gestures at its boundary
    // as a second line of defence, and that is exactly what a read affordance
    // needs to receive: a capture-phase stopPropagation still lets a keystroke
    // reach the input, so the box filled while the filter never fired. The two
    // guarantees that matter carry themselves — an element presents no identity
    // (#anonymise) and a read-only renderer's outbound verbs are inert
    // (BlockRenderer) — and each is pinned by its own test.
    row.appendChild(this.#content(element))
    return row
  }

  /**
   * An element's rendering: the kind's OWN renderer, drawing the whole block it
   * would draw anywhere else, marked READ-ONLY — a question is a record, so a
   * kind's editing and mutating affordances are off while its chrome is not.
   *
   * The kind comes from the all-blocks registry, so there is no per-kind arm
   * here and never will be: the day a kind is drawable, it is drawable inside a
   * question. What text a composed renderer would take from a lens is written in
   * afterwards, because in a question there is no lens to take it from.
   * @param {QuestionElement} element
   * @returns {HTMLElement}
   */
  #content(element) {
    const Renderer = getBlockRenderer(element.kind)
    if (!Renderer) return QuestionListView.#unknown(element)
    const renderer = new Renderer(new SieveBlock(element.kind, this.#resolved(element)), null, undefined, { readOnly: true })
    const dom = BlockIdentity.strip(renderer.render())
    QuestionListView.#writeOwnText(renderer, element.attrs || {})
    this.#composed.push(renderer)
    return dom
  }

  /**
   * An element's attrs with what a LENS would have resolved for it added.
   *
   * A kind whose content was processed server-side names the result by a
   * reference the document holds, and turning that into a fetchable url takes
   * the container it lives in — a host concern, which is why in the document a
   * NodeView overlays it. A record is hosted here, so this is where it happens.
   * An element that was never processed gets nothing, and its kind falls back to
   * whatever it can show from its own text — as does one whose reference names a
   * container this view was not told, which is the honest answer rather than a
   * url built around a hole.
   * @param {QuestionElement} element
   * @returns {Record<string, any>}
   */
  #resolved(element) {
    const attrs = element.attrs || {}
    const ref = String(attrs.parsedAssetRef || '')
    // A ref the store minted is already a served route and needs no container;
    // only a bare one has to be resolved against the document holding it.
    if (!ref || (!ref.startsWith('/') && !this.#container)) return attrs
    return Object.assign({}, attrs, { resolvedAssetUrl: documentAssetUrl(this.#container, ref) })
  }

  /**
   * Writes the text a lens would otherwise own into a composed renderer.
   *
   * A kind whose content is literal source text renders it through a ProseMirror
   * contentDOM in the document — the renderer builds the `<code>` and PM fills
   * it. There is no ProseMirror here, so the record fills it, and highlights the
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

  /**
   * A kind with no rendering here: its name, and its text if it carries any as
   * a literal. Never blank — an element a question is composed of is always
   * visible.
   * @param {QuestionElement} element
   * @returns {HTMLElement}
   */
  static #unknown(element) {
    const attrs = element.attrs || {}
    const el = document.createElement('div')
    el.className = 'ai-block__element-plain'
    el.appendChild(badgeEl(element.kind))
    const text = String(attrs.content || attrs.source || '')
    if (text) {
      const pre = document.createElement('pre')
      pre.textContent = text
      el.appendChild(pre)
    }
    return el
  }

  /** Keeps the drawn question anonymous for as long as it is drawn — a kind may
   *  inject content long after it was composed. @param {HTMLElement} el */
  #keepAnonymous(el) {
    this.#watcher = BlockIdentity.keepAnonymous(el)
  }
}
