// @ts-check
// attachment-chip.js — AttachmentChip: the "this is an attachment" chip, as one
// component. A sibling of StatusBadge and LineGutter in block/renderers/ — a
// shared piece of look-and-feel with no PM, no editor, no window.* and no idea
// what a document is (docs/design/specs/2026-08-19-attachment-block-design.md,
// "The chip is now a shared component").
//
// WHY IT EXISTS. The vocabulary had two implementations — `.ai-block__attachment`
// (carried renderer styles) and `.ask-popup__chips` (shell CSS) — and the
// `attachment` block is the third. Three is where it gets extracted rather than
// copied a third time, which is also when the two existing copies had already
// drifted (8% vs 10% tint, 15rem vs 14rem clamp, one with a `cursor` and one
// without) with nobody able to say which was the intended chip.
//
// WHAT IT IS NOT. It is not the ROW that holds chips. A caller owns its own
// layout — the ai-block footer's scrolling border-topped strip, the composer
// footer's hint-displacing region, the attachment block's shrink-wrapping
// wrapper — and sets `--chip-max-width` on it if its chips clamp. The chip
// itself is only ever as wide as it needs to be.
//
// THE COMPOSER IS DELIBERATELY NOT A CONSUMER. It is not a block, so it carries
// no block styles, and importing a renderer into the shell would cross the
// shell/renderer boundary. It keeps its own component (it has a ✕ affordance and
// a fixed-height footer constraint this chip has no business knowing about) and
// unifies with it on the `--chip-*` TOKENS instead — see attachment-chip.styles.js.
//
// IMMUTABLE ONCE BUILT. Both callers redraw their whole row from the model on
// every change (the model and its chips are one type), so there is no patch path
// to maintain and none is offered. A chip is a value drawn, not a live object.

import { rendererStyles } from './renderer-style-registry.js'
import { attachmentChipStyles } from './attachment-chip.styles.js'

/**
 * One chip's whole contract. Everything is optional because a chip's job is to
 * stay identifiable however little survived: an attachment with no cached title
 * still shows its address, and one with no address at all is still a label.
 * @typedef {object} AttachmentChipSpec
 * @property {string} [uri]     the coordinate this chip stands for. Stamped as
 *   `data-uri` and handed to activate listeners; a chip without one is inert.
 * @property {string} [label]   the primary text. Falls back to `uri`.
 * @property {string} [detail]  quiet secondary text after the label — the kind
 *   and size of a held file ("OpenAPI · 412 KB"). Omitted when empty.
 * @property {string} [tooltip] the `title` attribute — what tells two chips with
 *   the same label apart.
 * @property {boolean} [missing] DANGLING: the target is gone. A normal state,
 *   not an error — greyed and marked, still readable and still clickable.
 * @property {string} [icon]    override the leading glyph.
 */

export class AttachmentChip {
  /** CSS text using ONLY `--theme-` and `--chip-` vars for colour. */
  static styles = attachmentChipStyles

  /** The root class every chip carries — the selector its styles hang off, and
   *  the hook a row uses to reach its own chips. */
  static ROOT_CLASS = 'sieve-attachment-chip'

  /** 📄 — a source the document holds or points at. */
  static #ICON = '\u{1F4C4}'
  /** ⚠ — the target is gone. */
  static #ICON_MISSING = '⚠'

  /** @type {HTMLElement} */ #element
  /** @type {string} */ #uri
  /** @type {Array<(uri: string) => void>} */ #listeners = []

  /** @param {AttachmentChipSpec} [spec] */
  constructor(spec) {
    rendererStyles.register(AttachmentChip)
    const s = spec || {}
    this.#uri = (s.uri || '').trim()
    const missing = !!s.missing
    const label = (s.label || '').trim() || this.#uri
    const detail = (s.detail || '').trim()
    const tooltip = (s.tooltip || '').trim()

    const el = document.createElement('span')
    el.className = AttachmentChip.ROOT_CLASS + (missing ? ' ' + AttachmentChip.ROOT_CLASS + '--missing' : '')
    if (this.#uri) el.setAttribute('data-uri', this.#uri)
    if (tooltip) el.setAttribute('title', tooltip)

    el.appendChild(AttachmentChip.#part('icon', s.icon || (missing ? AttachmentChip.#ICON_MISSING : AttachmentChip.#ICON), true))
    el.appendChild(AttachmentChip.#part('label', label))
    if (detail) el.appendChild(AttachmentChip.#part('detail', detail))

    el.addEventListener('click', (e) => {
      e.preventDefault()
      e.stopPropagation()
      this.#activate()
    })
    // A chip lives inside a read-only block container; it must never start a
    // drag or a selection.
    el.addEventListener('mousedown', (e) => e.preventDefault())

    this.#element = el
  }

  /** The chip's DOM, ready to append. @returns {HTMLElement} */
  get element() { return this.#element }

  /** The coordinate this chip stands for ('' when it has none). @returns {string} */
  get uri() { return this.#uri }

  /**
   * Registers interest in "the user activated this chip", handing back the
   * address. The chip never opens anything itself — it is lens-blind and has no
   * idea what a workspace is; whoever built it does.
   * @param {(uri: string) => void} fn
   * @returns {() => void} unsubscribe
   */
  onActivate(fn) {
    this.#listeners.push(fn)
    return () => { this.#listeners = this.#listeners.filter((l) => l !== fn) }
  }

  /** Fans the address out. A chip with no address is inert — there is nothing to open. */
  #activate() {
    if (!this.#uri) return
    for (const fn of this.#listeners) {
      try { fn(this.#uri) } catch (e) { console.error('[attachment-chip] activate listener threw', e) }
    }
  }

  /**
   * One inner span. textContent, never innerHTML: a title arrives from a
   * document nobody here wrote, and there is no markup in a chip to justify the
   * escaping round-trip.
   * @param {string} part BEM element suffix
   * @param {string} text
   * @param {boolean} [decorative] hide it from assistive tech
   * @returns {HTMLElement}
   */
  static #part(part, text, decorative) {
    const el = document.createElement('span')
    el.className = AttachmentChip.ROOT_CLASS + '__' + part
    el.textContent = text
    if (decorative) el.setAttribute('aria-hidden', 'true')
    return el
  }
}
