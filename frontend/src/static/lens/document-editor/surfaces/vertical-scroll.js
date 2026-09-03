// @ts-check
// Bringing something into view WITHOUT moving the reader sideways.
//
// `scrollIntoView` scrolls BOTH axes, and the editor's pane scrolls
// horizontally whether or not anyone meant it to: a box that scrolls vertically
// computes its other axis to `auto`, and prose that cannot wrap — a long
// address, a wide table — gives it something to scroll. So a call meant to move
// down the document can slide the text left as well, where nothing puts it back
// and everything drawn beside the text is left out of true.
//
// Here only the vertical position is ever written, and the horizontal one is
// passed back exactly as it was found: where the reader has scrolled to
// sideways is the reader's business, and nothing that wants to show them a
// match has an opinion about it.

export class VerticalScroll {
  /**
   * Scrolls the nearest vertically-scrolling ancestor until `el` is in view.
   * Silent when there is no such ancestor — an element nothing scrolls is
   * already as visible as it will be.
   * @param {Element|null} el
   * @param {'center'|'nearest'} place
   */
  static into(el, place) {
    const scroller = VerticalScroll.#scrollerOf(el)
    if (!el || !scroller) return
    const delta = VerticalScroll.deltaFor(el.getBoundingClientRect(), scroller.getBoundingClientRect(), place)
    if (!delta) return
    const top = scroller.scrollTop + delta
    if (typeof scroller.scrollTo === 'function') {
      scroller.scrollTo({ top: top, left: scroller.scrollLeft, behavior: 'smooth' })
    } else {
      scroller.scrollTop = top
    }
  }

  /**
   * How far the scroller must move for `box` to be in view inside `frame`.
   *
   * `center` puts the box in the middle, wherever it started. `nearest` moves
   * only as far as it must and answers 0 for a box already in view; a box
   * taller than the frame is brought to the frame's top, which is where reading
   * it starts.
   * @param {{top: number, bottom: number, height: number}} box
   * @param {{top: number, bottom: number, height: number}} frame
   * @param {'center'|'nearest'} place
   * @returns {number} pixels to add to the scroller's vertical position
   */
  static deltaFor(box, frame, place) {
    const above = box.top - frame.top
    if (place === 'center') return above - (frame.height - box.height) / 2
    const below = box.bottom - frame.bottom
    if (above < 0) return above
    if (below > 0) return Math.min(below, above)
    return 0
  }

  /**
   * The nearest ancestor that actually scrolls vertically.
   * @param {Element|null} el
   * @returns {any}
   */
  static #scrollerOf(el) {
    const view = (el && el.ownerDocument && el.ownerDocument.defaultView) || null
    if (!view) return null
    for (let node = el ? el.parentElement : null; node; node = node.parentElement) {
      const overflow = view.getComputedStyle(node).overflowY
      if ((overflow === 'auto' || overflow === 'scroll') && node.scrollHeight > node.clientHeight) return node
    }
    return null
  }
}
