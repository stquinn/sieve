// @ts-check
// PendingSlot: the quiet mark of an answer still being written — a dashed box,
// a pulsing dot and "answering…", followed by how long the answer has been
// awaited ("answering… 12s", then "answering… 1m 05s") once its host has said so.
// A host shows it in the answer's place while no block of the answer has landed,
// and under the last block while more are coming. It carries no progress and no
// partial text, and it keeps no clock: the time awaited is written only when the
// host calls `count`, with the time the answer was asked for and the time it is.

import { rendererStyles } from './renderer-style-registry.js'
import { pendingSlotStyles } from './pending-slot.styles.js'

export class PendingSlot {
  /** CSS text using ONLY `--theme-` and `--record-` vars for colour. */
  static styles = pendingSlotStyles

  /** The selector this slot's styles hang off. */
  static ROOT_CLASS = 'pending-slot'

  /** The words the slot shows. */
  static LABEL = 'answering…'

  /**
   * How long an answer asked for at `since` has been awaited at `now`: whole
   * seconds under a minute ("12s"), then minutes and two-digit seconds
   * ("1m 05s"). A `now` before `since` reads as no time at all, and no `since`
   * reads as nothing.
   * @param {Date|null} since @param {Date} now
   * @returns {string}
   */
  static elapsed(since, now) {
    if (!since || Number.isNaN(since.getTime())) return ''
    const seconds = Math.max(0, Math.floor((now.getTime() - since.getTime()) / 1000))
    if (seconds < 60) return seconds + 's'
    return Math.floor(seconds / 60) + 'm ' + String(seconds % 60).padStart(2, '0') + 's'
  }

  /** @type {HTMLElement} */ #element
  /** @type {HTMLElement} the time awaited, which assistive technology is not told every second */ #elapsed

  constructor() {
    rendererStyles.register(PendingSlot)
    const el = document.createElement('div')
    el.className = PendingSlot.ROOT_CLASS
    el.setAttribute('role', 'status')
    const dot = document.createElement('span')
    dot.className = PendingSlot.ROOT_CLASS + '__dot'
    dot.setAttribute('aria-hidden', 'true')
    const label = document.createElement('span')
    label.className = PendingSlot.ROOT_CLASS + '__label'
    label.textContent = PendingSlot.LABEL
    const elapsed = document.createElement('span')
    elapsed.className = PendingSlot.ROOT_CLASS + '__elapsed'
    elapsed.setAttribute('aria-hidden', 'true')
    label.appendChild(elapsed)
    el.append(dot, label)
    this.#element = el
    this.#elapsed = elapsed
  }

  /** @returns {HTMLElement} the slot, for its host to place */
  get element() { return this.#element }

  /**
   * Writes how long the answer asked for at `since` has been awaited at `now`.
   * @param {Date|null} since @param {Date} now
   */
  count(since, now) {
    const said = PendingSlot.elapsed(since, now)
    this.#elapsed.textContent = said ? ' ' + said : ''
  }
}
