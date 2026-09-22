// @ts-check
// trigger-layout.js — TriggerLayout: HOW a picker's candidates are arranged.
//
// A provider declares its layout as DATA, the way it declares `providesIcons`,
// and the popover reads that data to build its container, size its scroller and
// pick its arrow model. Nothing here draws: the popover owns the container and
// the cell, the provider owns what goes inside one.

import { ContractViolation } from '../contract/sieve-block.js'

/**
 * @typedef {object} TriggerLayoutSpec
 * @property {number} [columns]
 *   candidates per row. 1 is the list every picker had before there was a
 *   choice; more than one makes the picker a GRID, which is what turns the
 *   arrow keys two-dimensional.
 * @property {number} [rows]
 *   rows visible before the picker scrolls. 0 leaves the popover's own height
 *   cap in charge, which is what a list wants.
 * @property {boolean} [hasCaption]
 *   whether a footer names the selected candidate. A grid of bare glyphs cannot
 *   say what is selected; a list of named rows already does.
 */

export class TriggerLayout {
  /** @type {number} */ #columns
  /** @type {number} */ #rows
  /** @type {boolean} */ #hasCaption

  /** @param {TriggerLayoutSpec} [spec] */
  constructor(spec = {}) {
    const columns = spec.columns == null ? 1 : spec.columns
    const rows = spec.rows == null ? 0 : spec.rows
    if (!Number.isInteger(columns) || columns < 1) {
      throw new ContractViolation('a TriggerLayout needs at least one column')
    }
    if (!Number.isInteger(rows) || rows < 0) {
      throw new ContractViolation('a TriggerLayout row count must be a whole number of rows')
    }
    this.#columns = columns
    this.#rows = rows
    this.#hasCaption = !!spec.hasCaption
    Object.freeze(this)
  }

  /** @returns {number} candidates per row */
  get columns() { return this.#columns }

  /** @returns {number} rows visible before scrolling; 0 = the popover's own cap */
  get rows() { return this.#rows }

  /** @returns {boolean} whether a footer names the selected candidate */
  get hasCaption() { return this.#hasCaption }

  /**
   * More than one column, which is the whole difference the popover acts on:
   * a grid claims ←/→ and steps ↑/↓ by a row, a list claims neither and steps
   * by one.
   * @returns {boolean}
   */
  get isGrid() { return this.#columns > 1 }

  /** The default every provider inherits: one candidate per row, no caption,
   *  the popover's own height cap. */
  static LIST = new TriggerLayout()
}
