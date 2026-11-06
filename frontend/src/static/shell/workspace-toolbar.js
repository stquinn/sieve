// @ts-check
// The workspace's toolbar: workspace chrome whose contents are the active
// lens's answer. The host says which lens is active; the toolbar asks that lens
// for its items and draws them, and draws nothing while no lens is active or the
// lens offers nothing.
//
// It follows the lens on the lens's RAW event stream. A `toolbar-changed` event
// means the lens's answer changed — another surface, another mode, another page
// — and the items are asked for again. Every other event refreshes the drawn
// items' state: the raw stream carries every caret move (`selection-changed`,
// `transaction`), which the coalesced selection update drops, and a bold
// button's active state must follow a caret that only moved.
//
// The strip is laid out in the places its items declare (ToolbarPlace): each
// place is a `.tb-place` drawn in order, the start and the end sharing the room
// the middle leaves, so the middle sits between them and the end against the
// right edge. An answer whose items are all at the start is drawn as one start
// place, which lays its items out as the strip's own.

import { SurfaceEvent } from '../lens/abstract-surface.js'
import { ToolbarPlace } from '../renderers/toolbar-button.js'

/**
 * What the toolbar asks of the active lens.
 * @typedef {object} ToolbarLens
 * @property {() => ReadonlyArray<import('../renderers/toolbar-button.js').ToolbarItem>} toolbarContents
 * @property {(fn: (event: {type: string}) => void) => () => void} onEvent
 */

export class WorkspaceToolbar {
  /** @type {HTMLElement|null} */ #host
  /** @type {ToolbarLens|null} */ #lens = null
  /** @type {(() => void)|null} */ #unsubscribe = null
  /** @type {ReadonlyArray<import('../renderers/toolbar-button.js').ToolbarItem>} */ #items = []

  /** @param {HTMLElement|null} host the toolbar's element; null makes every method a no-op */
  constructor(host) {
    this.#host = host
  }

  /** @returns {ToolbarLens|null} the lens whose answer is drawn */
  get lens() { return this.#lens }

  /**
   * Draws `lens`'s answer and follows it from now on; null empties the toolbar.
   * Showing the lens already shown changes nothing.
   * @param {ToolbarLens|null} lens
   */
  show(lens) {
    if (lens === this.#lens) return
    if (this.#unsubscribe) { this.#unsubscribe(); this.#unsubscribe = null }
    this.#lens = lens
    if (lens && this.#host) {
      this.#unsubscribe = lens.onEvent((event) => {
        if (event && event.type === SurfaceEvent.TOOLBAR_CHANGED.type) this.render()
        else this.refresh()
      })
    }
    this.render()
  }

  /**
   * Asks the lens for its items again and draws them. Keyboard focus on a
   * toolbar item is kept on the item of the same id in the new answer.
   */
  render() {
    const host = this.#host
    if (!host) return
    const active = typeof document !== 'undefined' ? document.activeElement : null
    const focusedId = active && host.contains(active) ? active.id : ''
    this.#items = this.#lens ? this.#lens.toolbarContents() : []
    host.replaceChildren(...this.#places())
    this.refresh()
    if (focusedId) {
      const again = [...host.querySelectorAll('[id]')].find((el) => el.id === focusedId)
      if (again) /** @type {HTMLElement} */ (again).focus()
    }
  }

  /** @returns {HTMLElement[]} a `.tb-place` for each place, holding its items in order;
   *  the start's alone while no item is placed elsewhere, none while there are no items */
  #places() {
    if (!this.#items.length) return []
    /** @type {Map<string, HTMLElement>} */
    const places = new Map()
    const placed = this.#items.some((item) => (item.place ?? ToolbarPlace.START) !== ToolbarPlace.START)
    for (const place of placed ? Object.values(ToolbarPlace) : [ToolbarPlace.START]) {
      const el = document.createElement('div')
      el.className = 'tb-place tb-place--' + place
      places.set(place, el)
    }
    for (const item of this.#items) {
      const place = places.get(item.place ?? ToolbarPlace.START) || /** @type {HTMLElement} */ (places.get(ToolbarPlace.START))
      place.appendChild(item.el)
    }
    return [...places.values()]
  }

  /** Re-reads every drawn item's state. */
  refresh() {
    for (const item of this.#items) item.refresh()
  }
}
