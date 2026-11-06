// @ts-check
// The page turning a Digital Note's surfaces offer the toolbar: previous, the
// page's place, next, and one dot per page (a page with ink not yet seen drawn
// for attention) or, past MAX_DOTS pages, a count of the pages with unseen ink
// that shows the next of them, while there are any. What each control does is
// the reader's: the pager draws, the reader turns.

import { ButtonGroup, ToolbarButton, ToolbarLabel } from '../../renderers/toolbar-button.js'

/** @typedef {Readonly<{id: string}>} NotePage */

/**
 * What the pager's controls ask of the surface that offers it.
 * @typedef {object} PageReader
 * @property {(pageId: string) => void} showPage
 * @property {(delta: number) => void} turn
 * @property {() => void} showNextUnseen
 */

export class NotePager {
  /** The most pages the pager shows a dot each for; past it the pager counts the unseen ones. */
  static MAX_DOTS = 12

  /** @type {PageReader} */ #reader

  /** @param {PageReader} reader */
  constructor(reader) {
    this.#reader = reader
  }

  /**
   * The pager's toolbar group for `pages`, `shown` among them, `unseen` marked.
   * @param {ReadonlyArray<NotePage>} pages
   * @param {string|null} shown
   * @param {ReadonlySet<string>} unseen
   * @returns {ButtonGroup}
   */
  group(pages, shown, unseen) {
    const index = pages.findIndex((page) => page.id === shown)
    const count = pages.length
    const reader = this.#reader
    return new ButtonGroup([
      new ToolbarButton({
        id: 'tb-page-prev', text: '‹', title: 'Previous page', className: 'tb-page-turn',
        enabled: () => index > 0, onClick: () => reader.turn(-1),
      }),
      new ToolbarLabel({
        id: 'tb-page-position', title: 'Page', className: 'tb-page-position',
        text: () => (count ? `${index + 1} / ${count}` : '0 / 0'),
      }),
      new ToolbarButton({
        id: 'tb-page-next', text: '›', title: 'Next page', className: 'tb-page-turn',
        enabled: () => index >= 0 && index < count - 1, onClick: () => reader.turn(1),
      }),
      ...(count > NotePager.MAX_DOTS ? this.#unseenCount(pages, unseen) : this.#dots(pages, shown, unseen)),
    ], { label: 'Pages' })
  }

  /** @param {ReadonlyArray<NotePage>} pages @param {string|null} shown @param {ReadonlySet<string>} unseen
   *  @returns {ToolbarButton[]} one dot per page */
  #dots(pages, shown, unseen) {
    return pages.map((page, i) => new ToolbarButton({
      id: `tb-page-dot-${i + 1}`,
      title: `Page ${i + 1}`,
      className: unseen.has(page.id) ? 'tb-dot tb-attention' : 'tb-dot',
      active: () => page.id === shown,
      onClick: () => { if (page.id !== shown) this.#reader.showPage(page.id) },
    }))
  }

  /** @param {ReadonlyArray<NotePage>} pages @param {ReadonlySet<string>} unseen
   *  @returns {ToolbarButton[]} the count of pages with unseen ink; none while there are none */
  #unseenCount(pages, unseen) {
    const count = pages.filter((page) => unseen.has(page.id)).length
    if (!count) return []
    return [new ToolbarButton({
      id: 'tb-page-unseen', text: `${count} unseen`, className: 'tb-attention',
      title: `Show the next of ${count} pages with unseen ink`,
      onClick: () => this.#reader.showNextUnseen(),
    })]
  }
}
