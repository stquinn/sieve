// @ts-check
// The page turning a Digital Note's surfaces offer the toolbar: previous, a
// drop-down of every page, next, and, while some page other than the one shown
// holds ink not yet seen, a count of those pages that shows the next of them.
// The drop-down's closed face is the page's place (`3 / 12`); its list names
// each page by its own name, else `Page n`, a page with unseen ink marked. What
// each control does is the reader's: the pager draws, the reader turns.

import { ButtonGroup, ToolbarButton, ToolbarSelect } from '../../renderers/toolbar-button.js'

/** @typedef {Readonly<{id: string, name?: string}>} NotePage */

/**
 * What the pager's controls ask of the surface that offers it.
 * @typedef {object} PageReader
 * @property {(pageId: string) => void} showPage
 * @property {(delta: number) => void} turn
 * @property {() => void} showNextUnseen
 */

export class NotePager {
  /** @type {PageReader} */ #reader

  /** @param {PageReader} reader */
  constructor(reader) {
    this.#reader = reader
  }

  /**
   * What the list calls a page: its name, else its place from 1.
   * @param {NotePage} page @param {number} index
   * @returns {string}
   */
  static label(page, index) {
    const name = typeof page.name === 'string' ? page.name.trim() : ''
    return name || `Page ${index + 1}`
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
    const others = pages.filter((page) => page.id !== shown && unseen.has(page.id)).length
    return new ButtonGroup([
      new ToolbarButton({
        id: 'tb-page-prev', text: '‹', title: 'Previous page', className: 'tb-page-turn',
        enabled: () => index > 0, onClick: () => reader.turn(-1),
      }),
      new ToolbarSelect({
        id: 'tb-page-select', title: 'Page',
        options: pages.map((page, i) => ({ value: page.id, label: NotePager.label(page, i), mark: unseen.has(page.id) })),
        value: () => shown ?? '',
        face: () => (count ? `${index + 1} / ${count}` : '0 / 0'),
        onChange: (pageId) => { if (pageId !== shown) reader.showPage(pageId) },
      }),
      new ToolbarButton({
        id: 'tb-page-next', text: '›', title: 'Next page', className: 'tb-page-turn',
        enabled: () => index >= 0 && index < count - 1, onClick: () => reader.turn(1),
      }),
      ...(others ? [new ToolbarButton({
        id: 'tb-page-unseen', text: `${others} unseen`, className: 'tb-attention',
        title: `Show the next of ${others} page${others === 1 ? '' : 's'} with unseen ink`,
        onClick: () => reader.showNextUnseen(),
      })] : []),
    ], { label: 'Pages' })
  }
}
