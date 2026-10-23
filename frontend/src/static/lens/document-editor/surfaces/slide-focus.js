// @ts-check
// Presentation Mode's view: while presenting, only the slide holding the caret
// is drawn. A slide is the run of units between two slide markers; whatever
// precedes the first marker is the first slide. A unit is a top-level node, or a
// child of a `proseGroup` that holds a marker: a multi-node prose block splits
// at its markers. A marker nested deeper (a list item, a blockquote, a table
// cell) is not a boundary; it is hidden like every marker while presenting.
//
// The current slide is derived from `selection.head` on every state and stored
// nowhere, so any caret move that crosses a marker — arrows, click, find, undo —
// changes the slide. Hiding is node decorations only; the document is untouched.
//
// A hidden marker must never hold the selection: a vertical arrow NodeSelects an
// atom, which would leave the caret on something invisible. Such a selection is
// moved to the nearest text position past the marker in the direction of travel.

import { T } from './tiptap-vendor.js'
import { SlideMarker } from './slide-marker.js'

/** The decoration attrs every node outside the current slide wears. */
const HIDDEN = Object.freeze({ class: 'slide-hidden' })

/** The multi-node prose container's node name (prose-group.js). */
const PROSE_GROUP = 'proseGroup'

export class SlideFocus {
  /** @type {any} the plugin key, built on first use so the vendor bag is live */
  static #key = null

  /** @returns {any} */
  static get key() {
    if (!SlideFocus.#key) SlideFocus.#key = new T.PluginKey('slideFocus')
    return SlideFocus.#key
  }

  /** The children of `parent`, whose content starts at `offset`.
   *  @param {any} parent @param {number} offset
   *  @returns {Generator<{node: any, pos: number}>} */
  static *#children(parent, offset) {
    let pos = offset
    for (let i = 0; i < parent.childCount; i++) {
      const node = parent.child(i)
      yield { node, pos }
      pos += node.nodeSize
    }
  }

  /** @param {any} node @returns {boolean} */
  static #isMarker(node) { return node.type.name === SlideMarker.NAME }

  /** The units slides are made of, in document order.
   *  @param {any} doc
   *  @returns {Generator<{node: any, pos: number}>} */
  static *#units(doc) {
    for (const unit of SlideFocus.#children(doc, 0)) {
      const split = unit.node.type.name === PROSE_GROUP
        && [...SlideFocus.#children(unit.node, 0)].some((c) => SlideFocus.#isMarker(c.node))
      if (split) yield* SlideFocus.#children(unit.node, unit.pos + 1)
      else yield unit
    }
  }

  /** Whether `doc` holds a slide boundary.
   *  @param {any} doc a ProseMirror document
   *  @returns {boolean} */
  static hasMarkers(doc) {
    for (const { node } of SlideFocus.#units(doc)) if (SlideFocus.#isMarker(node)) return true
    return false
  }

  /** The `[start, end]` document range of the slide holding `head`: from just
   *  after the last marker before it (or 0) to the first marker at or after it
   *  (or the end of the document).
   *  @param {any} doc a ProseMirror document
   *  @param {number} head
   *  @returns {{start: number, end: number}} */
  static slideAt(doc, head) {
    let start = 0
    let end = doc.content.size
    for (const { node, pos } of SlideFocus.#units(doc)) {
      if (!SlideFocus.#isMarker(node)) continue
      if (pos + node.nodeSize <= head) start = pos + node.nodeSize
      else if (pos >= head) { end = pos; break }
    }
    return { start, end }
  }

  /** The positions of the nodes hidden while presenting with the caret at
   *  `head`: every marker at any depth, and every unit outside its slide.
   *  @param {any} doc
   *  @param {number} head
   *  @returns {Array<{from: number, to: number}>} */
  static hiddenRanges(doc, head) {
    const { start, end } = SlideFocus.slideAt(doc, head)
    /** @type {Array<{from: number, to: number}>} */
    const hidden = []
    for (const { node, pos } of SlideFocus.#units(doc)) {
      const to = pos + node.nodeSize
      if (!SlideFocus.#isMarker(node) && (pos < start || to > end)) hidden.push({ from: pos, to })
    }
    doc.descendants((/** @type {any} */ node, /** @type {number} */ pos) => {
      if (SlideFocus.#isMarker(node)) hidden.push({ from: pos, to: pos + node.nodeSize })
      return !node.isTextblock
    })
    return hidden.sort((a, b) => a.from - b.from)
  }

  /** Whether `state` is presenting.
   *  @param {any} state an EditorState
   *  @returns {boolean} */
  static isPresenting(state) {
    const ps = SlideFocus.key.getState(state)
    return !!(ps && ps.presenting)
  }

  /** Turns presenting on or off in `view`.
   *  @param {any} view an EditorView
   *  @param {boolean} presenting */
  static setPresenting(view, presenting) {
    if (!view) return
    view.dispatch(view.state.tr.setMeta(SlideFocus.key, { presenting: !!presenting }))
  }

  /** The selection to put in place of a NodeSelection on a marker, or null when
   *  `state`'s selection is not one. Travel is forward when the selection moved
   *  forward from `oldHead`.
   *  @param {any} state
   *  @param {number} oldHead
   *  @returns {any|null} */
  static #offMarker(state, oldHead) {
    const sel = state.selection
    if (!sel.node || sel.node.type.name !== SlideMarker.NAME) return null
    const forward = sel.from >= oldHead
    const $pos = state.doc.resolve(forward ? sel.to : sel.from)
    return T.Selection.findFrom($pos, forward ? 1 : -1, true)
      || T.Selection.findFrom($pos, forward ? -1 : 1, true)
  }

  /** The TipTap extension carrying the plugin.
   *  @returns {any} */
  static extension() {
    const key = SlideFocus.key
    return T.Extension.create({
      name: 'slideFocus',
      addProseMirrorPlugins() {
        return [new T.Plugin({
          key,
          state: {
            init: () => ({ presenting: false }),
            apply: (/** @type {any} */ tr, /** @type {any} */ prev) => {
              const meta = tr.getMeta(key)
              return meta ? { presenting: !!meta.presenting } : prev
            },
          },
          appendTransaction: (/** @type {any[]} */ _trs, /** @type {any} */ oldState, /** @type {any} */ newState) => {
            if (!SlideFocus.isPresenting(newState)) return null
            const next = SlideFocus.#offMarker(newState, oldState.selection.head)
            return next ? newState.tr.setSelection(next) : null
          },
          props: {
            decorations: (/** @type {any} */ state) => {
              if (!SlideFocus.isPresenting(state)) return T.DecorationSet.empty
              return T.DecorationSet.create(state.doc, SlideFocus.hiddenRanges(state.doc, state.selection.head)
                .map((r) => T.Decoration.node(r.from, r.to, HIDDEN)))
            },
          },
        })]
      },
    })
  }
}
