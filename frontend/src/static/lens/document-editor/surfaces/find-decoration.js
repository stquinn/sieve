// @ts-check
// Find matches as inline decorations: every match the server found highlighted,
// and the one the reader is standing on emphasised. The mark machinery is
// `TextMarkDecorations`; what is here is the highlight, the current match, and
// walking between them.
//
// THE CURRENT MATCH IS A LENS'S OWN BUSINESS. Which of a document's matches a
// reader is looking at is nothing the server was told and nothing another mount
// shares, so it lives in this plugin's state and never on the wire.
//
// IT IS AN INDEX INTO THE RESOLVED HITS, held across rebuilds and taken modulo
// however many there now are. Marks arrive per block and the set is rebuilt on
// every change, so an index is the only thing that survives a repaint. The
// modulo is both rules at once: stepping past either end wraps to the other, and
// a set that shrank under the reader lands them on the match that took their
// place rather than on nothing.

import { TextMarkDecorations } from './text-mark-decorations.js'
import { VerticalScroll } from './vertical-scroll.js'

/** The class every match carries. */
export const FIND_MARK_CLASS = 'sieve-find-mark'

/** The class the match the reader is standing on carries, in addition. */
export const FIND_CURRENT_CLASS = 'sieve-find-mark--current'

/** The class a match carries on the ONE repaint that made it current, and on no
 *  other — a walk, or the first match after a set arrived. Its presence is the
 *  whole one-shot: the next rebuild drops it, so the settle animation it names
 *  runs once per arrival rather than on every keystroke that repaints the set. */
export const FIND_SETTLE_CLASS = 'sieve-find-mark--settling'

/** The producer whose marks this draws. A lens may not import the generated wire
 *  module, so this states the word the contract's `feature` is compared against;
 *  `find-marks` rows in `spell-marks.test.js` pin it to the Go-side vocabulary. */
export const FIND_FEATURE = 'find'

export class FindDecorations extends TextMarkDecorations {
  /** @param {any} T the TipTap/ProseMirror vendor bag */
  constructor(T) {
    super(T, 'sieveFindDecoration', FIND_FEATURE)
  }

  /**
   * @override — every resolved match is highlighted; the current one is
   * highlighted AND emphasised; and the one that just BECAME current is settled
   * in on top of both. The classes compose rather than replacing each other.
   *
   * The cursor is the current match's index, clamped into the hits that now
   * exist. A `step` message moves it and wraps at either end; anything else —
   * a marks push, an edit — keeps where the reader was, which is what makes
   * typing next to a match leave the reader where they stood. NO hits means NO
   * cursor, so the match a set arrives with is one the reader arrives at.
   * @param {ReadonlyArray<import('./text-mark-decorations.js').MarkHit>} hits
   * @param {any} meta @param {any} cursor @param {any} Decoration
   * @returns {{cursor: any, decorations: any[]}}
   */
  paintHits(hits, meta, cursor, Decoration) {
    const total = hits.length
    if (!total) return { cursor: null, decorations: [] }
    const step = (meta && typeof meta.step === 'number') ? meta.step : null
    const from = (typeof cursor === 'number' && cursor >= 0) ? cursor : 0
    const at = (((from + (step || 0)) % total) + total) % total
    // A walk, or the first hits a set arrived with: the match BECAME current on
    // this repaint, and settles in. Every other repaint leaves it standing.
    const current = (step !== null || typeof cursor !== 'number')
      ? FIND_MARK_CLASS + ' ' + FIND_CURRENT_CLASS + ' ' + FIND_SETTLE_CLASS
      : FIND_MARK_CLASS + ' ' + FIND_CURRENT_CLASS

    /** @type {any[]} */ const decorations = []
    hits.forEach((hit, index) => {
      const className = index === at ? current : FIND_MARK_CLASS
      for (const range of hit.ranges) {
        decorations.push(Decoration.inline(range.from, range.to, { class: className }))
      }
    })
    return { cursor: at, decorations: decorations }
  }

  /**
   * Where the reader stands among the matches, as a reader counts: 1-based, and
   * `0 of 0` when there is nothing to stand on.
   * @param {any} state a ProseMirror editor state
   * @returns {{current: number, total: number}}
   */
  position(state) {
    const total = this.heldHits(state).length
    if (!total) return { current: 0, total: 0 }
    const cursor = this.heldCursor(state)
    return { current: (typeof cursor === 'number' ? cursor : 0) + 1, total: total }
  }

  /**
   * The match the reader is standing on, carrying the block it was pushed for —
   * the anchor a replace is spent through. Null when there is no match to stand
   * on.
   * @param {any} state a ProseMirror editor state
   * @returns {Record<string, any>|null}
   */
  current(state) {
    const hits = this.heldHits(state)
    if (!hits.length) return null
    const cursor = this.heldCursor(state)
    const hit = hits[typeof cursor === 'number' ? cursor : 0]
    return hit ? Object.assign({ blockId: hit.blockId }, hit.mark) : null
  }

  /**
   * Moves to the next (`+1`) or previous (`-1`) match, wrapping at either end,
   * and scrolls what it landed on into view.
   * @param {any} view a ProseMirror view
   * @param {number} delta
   * @returns {{current: number, total: number}} where the reader now stands
   */
  step(view, delta) {
    if (!view) return { current: 0, total: 0 }
    this.signal(view, { step: delta })
    this.scrollToCurrent(view)
    return this.position(view.state)
  }

  /**
   * Scrolls the current match to the vertical MIDDLE of the editor's viewport,
   * so a match found near an edge is read in its surroundings rather than
   * clipped against them. Vertically and never sideways: a run of replaces is a
   * run of these, and each one that moved the text left would leave it further
   * from where the reader put it.
   * @param {any} view a ProseMirror view
   */
  scrollToCurrent(view) {
    VerticalScroll.into(this.#currentElement(view), 'center')
  }

  /**
   * What to scroll for the current match.
   *
   * THE DRAWN DECORATION WHERE THERE IS ONE: it is the match itself, where a
   * document position names the whole block around it — and centring a block
   * taller than the viewport leaves the match off screen.
   *
   * Otherwise the block the match sits in, because the decoration can be
   * unreachable from the view's DOM: a diagram in render mode orphans its
   * `<code>` contentDOM, and everything drawn inside it with it. `nodeDOM(pos)`
   * resolves only when pos sits exactly on a child's start boundary, and then
   * yields a raw text node with no `scrollIntoView`; `domAtPos` resolves any
   * position, so this climbs from there to the nearest element and falls back to
   * the top-level block's NodeView wrapper when that element has no geometry.
   * @param {any} view a ProseMirror view
   * @returns {any}
   */
  #currentElement(view) {
    const drawn = (view.dom && view.dom.querySelector) ? view.dom.querySelector('.' + FIND_CURRENT_CLASS) : null
    if (drawn) return drawn

    const hits = this.heldHits(view.state)
    if (!hits.length) return null
    const cursor = this.heldCursor(view.state)
    const hit = hits[typeof cursor === 'number' ? cursor : 0]
    if (!hit || !hit.ranges.length) return null
    const at = hit.ranges[0].from

    const located = view.domAtPos(at)
    let dom = located && located.node
    while (dom && dom.nodeType !== 1) dom = dom.parentNode
    const box = dom && dom.getBoundingClientRect ? dom.getBoundingClientRect() : null
    if (dom && document.contains(dom) && box && (box.width || box.height)) return dom
    const $pos = view.state.doc.resolve(at)
    return $pos.depth >= 1 ? view.nodeDOM($pos.before(1)) : null
  }
}
