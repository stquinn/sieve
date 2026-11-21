// @ts-check
// The page turning a Digital Note's surfaces offer the toolbar: previous, a
// drop-down of every page, next, and, while some page other than the one shown
// holds ink not yet seen, a count of those pages that shows the next of them.
// The drop-down's closed face and its list call each page as PageNames does, a
// page with unseen ink marked in the list. What each control does is the
// reader's: the pager draws, the reader turns.

import { PageNames } from '../../renderers/page-names.js'
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
  /** @type {PageNames} */ #names

  /** @param {PageReader} reader @param {PageNames} [names] what the pages are called */
  constructor(reader, names = new PageNames()) {
    this.#reader = reader
    this.#names = names
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
    const labels = this.#names.listed(pages)
    const face = this.#names.face(pages, index)
    return new ButtonGroup([
      new ToolbarButton({
        id: 'tb-page-prev', text: '‹', title: 'Previous page', className: 'tb-page-turn',
        enabled: () => index > 0, onClick: () => reader.turn(-1),
      }),
      new ToolbarSelect({
        id: 'tb-page-select', title: 'Page',
        options: pages.map((page, i) => ({ value: page.id, label: labels[i], mark: unseen.has(page.id) })),
        value: () => shown ?? '',
        face: () => face,
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
