// @ts-check
// The composer footer's key hints: what this mount answers to, said once, in the
// place the user is looking when they wonder.
//
// THE LIST IS DERIVED FROM THE LENS'S PUBLISHED SPEC, never from what a
// particular mount happens to know about itself. A hint whose capability the
// lens does not publish is absent — so a draft built without a MentionService
// does not advertise `@`, and no host has to remember to trim the list.
//
// ONE HINT IS UNCONDITIONAL because it is the composer's own key claim
// (`ComposerEditor.claimKey`): Mod+Enter sends, in every arrangement the lens
// is put in. Everything else Enter does is native editor behaviour, so it
// earns no hint of its own.

import { esc } from '../renderers/html-escape.js'
import { LensCapability } from '../contract/lens-capabilities.js'

/**
 * One hint: the chord, and what it does.
 * @typedef {object} Hint
 * @property {string} key
 * @property {string} label
 */

export class ComposerHints {
  /**
   * The platform's modifier key label — matches `window.isMod`'s own
   * detection, so the hint names the same chord the mount actually claims.
   * @returns {string}
   */
  static #modKey() {
    return typeof navigator !== 'undefined' && navigator.platform && navigator.platform.includes('Mac')
      ? '⌘' : 'Ctrl'
  }

  /** @returns {ReadonlyArray<Hint>} the composer's own claim: send */
  static #always() {
    return Object.freeze([Object.freeze({ key: `${ComposerHints.#modKey()}+Enter`, label: 'send' })])
  }

  /** @type {ReadonlyArray<{requires: string, hint: Hint}>} a hint and the
   *  capability that earns it, in the order they are offered. */
  static #EARNED = Object.freeze([
    Object.freeze({ requires: LensCapability.MENTIONS, hint: Object.freeze({ key: '@', label: 'mention' }) }),
    Object.freeze({ requires: LensCapability.COMMANDS, hint: Object.freeze({ key: '/', label: 'command' }) }),
  ])

  /** @type {HTMLElement|null} the row (null → headless: `show` is a no-op) */ #row = null

  /**
   * @param {HTMLElement|null} footerEl the structural `.ask-popup__footer`. The
   *   row is inserted FIRST, so the hints take the footer's left edge and the
   *   chip rows that insert before Send land between them and it.
   */
  constructor(footerEl) {
    if (!footerEl) return
    const row = document.createElement('div')
    row.className = 'ask-popup__hints'
    footerEl.insertBefore(row, footerEl.firstChild)
    this.#row = row
  }

  /**
   * The hints a lens publishing this spec earns. A null spec — no lens mounted
   * yet — earns none: the footer says nothing about a composer that is not there.
   * @param {Readonly<import('../contract/lens-capabilities.js').LensCapabilities>|null} caps
   * @returns {ReadonlyArray<Hint>}
   */
  static hintsFor(caps) {
    if (!caps) return []
    return ComposerHints.#always().concat(ComposerHints.#EARNED
      .filter((e) => !!(/** @type {any} */ (caps)[e.requires]))
      .map((e) => e.hint))
  }

  /**
   * Draws the hints for this spec.
   * @param {Readonly<import('../contract/lens-capabilities.js').LensCapabilities>|null} caps
   */
  show(caps) {
    const row = this.#row
    if (!row) return
    const hints = ComposerHints.hintsFor(caps)
    row.style.display = hints.length ? 'flex' : 'none'
    row.innerHTML = hints.map((h) =>
      '<span class="ask-popup__hint"><b>' + esc(h.key) + '</b> ' + esc(h.label) + '</span>').join('')
  }
}
