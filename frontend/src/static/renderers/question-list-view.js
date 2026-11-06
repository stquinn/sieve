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
import { BlockRecordView } from './block-record-view.js'
import { badgeEl } from './header-bar.js'

/** @typedef {import('./question-list.js').QuestionElement} QuestionElement */

export class QuestionListView {
  /** @type {Array<BlockRecordView>} the record views this draw owns */ #composed = []
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
   * would draw anywhere else, as a record (BlockRecordView).
   *
   * The kind comes from the all-blocks registry, so there is no per-kind arm
   * here and never will be: the day a kind is drawable, it is drawable inside a
   * question.
   * @param {QuestionElement} element
   * @returns {HTMLElement}
   */
  #content(element) {
    const view = new BlockRecordView(this.#container)
    const dom = view.draw(element.kind, element.attrs || {})
    if (!dom) return QuestionListView.#unknown(element)
    this.#composed.push(view)
    return BlockIdentity.strip(dom)
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
