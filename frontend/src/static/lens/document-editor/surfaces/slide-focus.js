// @ts-check
// Presentation Mode's view: while presenting, only the slide holding the caret
// is drawn. A slide is the run of top-level nodes between two slide markers;
// whatever precedes the first marker is the first slide.
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

export class SlideFocus {
  /** @type {any} the plugin key, built on first use so the vendor bag is live */
  static #key = null

  /** @returns {any} */
  static get key() {
    if (!SlideFocus.#key) SlideFocus.#key = new T.PluginKey('slideFocus')
    return SlideFocus.#key
  }

  /** Whether `doc` holds a slide marker at the top level.
   *  @param {any} doc a ProseMirror document
   *  @returns {boolean} */
  static hasMarkers(doc) {
    let found = false
    doc.forEach((/** @type {any} */ node) => { if (node.type.name === SlideMarker.NAME) found = true })
    return found
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
    doc.forEach((/** @type {any} */ node, /** @type {number} */ pos) => {
      if (node.type.name !== SlideMarker.NAME) return
      if (pos + node.nodeSize <= head) start = pos + node.nodeSize
      else if (pos >= head && end === doc.content.size) end = pos
    })
    return { start, end }
  }

  /** The positions of the top-level nodes hidden while presenting with the
   *  caret at `head`: every marker, and every node outside its slide.
   *  @param {any} doc
   *  @param {number} head
   *  @returns {Array<{from: number, to: number}>} */
  static hiddenRanges(doc, head) {
    const { start, end } = SlideFocus.slideAt(doc, head)
    /** @type {Array<{from: number, to: number}>} */
    const hidden = []
    doc.forEach((/** @type {any} */ node, /** @type {number} */ pos) => {
      const to = pos + node.nodeSize
      if (node.type.name === SlideMarker.NAME || pos < start || to > end) hidden.push({ from: pos, to })
    })
    return hidden
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
