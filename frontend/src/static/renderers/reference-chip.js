// @ts-check
// ReferenceChip: the "this is a reference" chip, as one component — shared
// look-and-feel with no PM, no editor, no window.* and no idea what a document
// is.
//
// IT IS NOT THE ROW THAT HOLDS CHIPS. A caller owns its own layout and sets
// `--chip-max-width` on it if its chips clamp; the chip itself is only ever as
// wide as it needs to be.
//
// IMMUTABLE ONCE BUILT: callers redraw their whole row from the model on every
// change, so no patch path is offered.

import { rendererStyles } from './renderer-style-registry.js'
import { referenceChipStyles } from './reference-chip.styles.js'

/**
 * One chip's whole contract. Everything is optional because a chip's job is to
 * stay identifiable however little survived: a reference with no cached title
 * still shows its address, and one with no address at all is still a label.
 * @typedef {object} ReferenceChipSpec
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

export class ReferenceChip {
  /** CSS text using ONLY `--theme-` and `--chip-` vars for colour. */
  static styles = referenceChipStyles

  /** The selector this chip's styles hang off, and a row's hook to its chips. */
  static ROOT_CLASS = 'sieve-reference-chip'

  /** 📄 — a source the document holds or points at. */
  static #ICON = '\u{1F4C4}'
  /** ⚠ — the target is gone. */
  static #ICON_MISSING = '⚠'

  /** @type {HTMLElement} */ #element
  /** @type {string} */ #uri
  /** @type {Array<(uri: string) => void>} */ #listeners = []

  /** @param {ReferenceChipSpec} [spec] */
  constructor(spec) {
    rendererStyles.register(ReferenceChip)
    const s = spec || {}
    this.#uri = (s.uri || '').trim()
    const missing = !!s.missing
    const label = (s.label || '').trim() || this.#uri
    const detail = (s.detail || '').trim()
    const tooltip = (s.tooltip || '').trim()

    const el = document.createElement('span')
    el.className = ReferenceChip.ROOT_CLASS + (missing ? ' ' + ReferenceChip.ROOT_CLASS + '--missing' : '')
    if (this.#uri) el.setAttribute('data-uri', this.#uri)
    if (tooltip) el.setAttribute('title', tooltip)

    el.appendChild(ReferenceChip.#part('icon', s.icon || (missing ? ReferenceChip.#ICON_MISSING : ReferenceChip.#ICON), true))
    el.appendChild(ReferenceChip.#part('label', label))
    if (detail) el.appendChild(ReferenceChip.#part('detail', detail))

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
   * address. The chip never opens anything itself.
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
      try { fn(this.#uri) } catch (e) { console.error('[reference-chip] activate listener threw', e) }
    }
  }

  /**
   * One inner span. textContent, never innerHTML: a title arrives from a
   * document nobody here wrote, and a chip has no markup to justify escaping.
   * @param {string} part BEM element suffix
   * @param {string} text
   * @param {boolean} [decorative] hide it from assistive tech
   * @returns {HTMLElement}
   */
  static #part(part, text, decorative) {
    const el = document.createElement('span')
    el.className = ReferenceChip.ROOT_CLASS + '__' + part
    el.textContent = text
    if (decorative) el.setAttribute('aria-hidden', 'true')
    return el
  }
}
