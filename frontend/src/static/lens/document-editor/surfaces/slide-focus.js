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
//
// While presenting, PageDown/PageUp and Mod+ArrowDown/Mod+ArrowUp turn the
// slide, and Mod+Home/Mod+End go to the first or last: the caret moves to the
// first position of that slide. An empty slide holds no caret, so it is skipped
// and not counted. A counter in the corner reads the slide's place in the deck.
//
// While editing, every marker that starts a counted slide carries that slide's
// number as `data-slide`, read off the same slide list, so the label on a marker
// and the counter while presenting always agree.

import { T } from './tiptap-vendor.js'
import { SlideMarker } from './slide-marker.js'

/** The decoration attrs every node outside the current slide wears. */
const HIDDEN = Object.freeze({ class: 'slide-hidden' })

/** The keys that turn the slide while presenting, unmodified or with Mod alone. */
const TURN_KEYS = Object.freeze({
  plain: Object.freeze({ PageDown: 1, PageUp: -1 }),
  mod: Object.freeze({ ArrowDown: 1, ArrowUp: -1, End: Infinity, Home: -Infinity }),
})

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

  /** The direction `event` turns the slide, or 0 when it is not a turn key.
   *  @param {{key: string, shiftKey: boolean, altKey: boolean, ctrlKey: boolean, metaKey: boolean}} event
   *  @returns {number} slides to move by: ±1, ±Infinity for the last or first, or 0 */
  static turnStep(event) {
    if (event.shiftKey || event.altKey) return 0
    const mods = (event.ctrlKey ? 1 : 0) + (event.metaKey ? 1 : 0)
    const table = mods === 0 ? TURN_KEYS.plain : mods === 1 ? TURN_KEYS.mod : null
    return (table && /** @type {Record<string, number>} */ (table)[event.key]) || 0
  }

  /** The non-empty slides of `doc`, in order, as `[start, end]` ranges.
   *  @param {any} doc a ProseMirror document
   *  @returns {Array<{start: number, end: number}>} */
  static slides(doc) {
    /** @type {Array<{start: number, end: number}>} */
    const out = []
    let start = 0
    for (const { node, pos } of SlideFocus.#units(doc)) {
      if (!SlideFocus.#isMarker(node)) continue
      out.push({ start, end: pos })
      start = pos + node.nodeSize
    }
    out.push({ start, end: doc.content.size })
    return out.filter((s) => s.end > s.start)
  }

  /** The 0-based index in `slides` of the slide holding `head`, or -1.
   *  @param {Array<{start: number, end: number}>} slides @param {number} head
   *  @returns {number} */
  static #indexOf(slides, head) {
    return slides.findIndex((s) => s.start <= head && head <= s.end)
  }

  /** The number each marker that starts a counted slide gives that slide,
   *  1-based like the counter; a nested marker or one before an empty slide has
   *  none.
   *  @param {any} doc a ProseMirror document
   *  @returns {Array<{from: number, to: number, number: number}>} */
  static numberedMarkers(doc) {
    const starts = new Map(SlideFocus.slides(doc).map((s, i) => [s.start, i + 1]))
    /** @type {Array<{from: number, to: number, number: number}>} */
    const out = []
    for (const { node, pos } of SlideFocus.#units(doc)) {
      const number = SlideFocus.#isMarker(node) && starts.get(pos + node.nodeSize)
      if (number) out.push({ from: pos, to: pos + node.nodeSize, number })
    }
    return out
  }

  /** The editing view's marker numbers as node decorations.
   *  @param {any} doc @returns {any} a DecorationSet */
  static #numbers(doc) {
    return T.DecorationSet.create(doc, SlideFocus.numberedMarkers(doc)
      .map((m) => T.Decoration.node(m.from, m.to, { 'data-slide': String(m.number) })))
  }

  /** Where the caret's slide sits in the deck, 1-based, or null when the caret
   *  is in no slide.
   *  @param {any} state an EditorState
   *  @returns {{index: number, count: number}|null} */
  static place(state) {
    const slides = SlideFocus.slides(state.doc)
    const at = SlideFocus.#indexOf(slides, state.selection.head)
    return at < 0 ? null : { index: at + 1, count: slides.length }
  }

  /** The selection at the first position of the slide `step` away from the one
   *  holding `state`'s caret, clamped to the deck, or null when that is the
   *  caret's own slide.
   *  @param {any} state
   *  @param {number} step ±1, or ±Infinity for the last or first slide
   *  @returns {any|null} */
  static turn(state, step) {
    const slides = SlideFocus.slides(state.doc)
    const at = SlideFocus.#indexOf(slides, state.selection.head)
    const to = Math.max(0, Math.min(slides.length - 1, at + step))
    if (at < 0 || to === at) return null
    return T.Selection.findFrom(state.doc.resolve(slides[to].start), 1)
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
            init: (/** @type {any} */ _config, /** @type {any} */ state) => ({ presenting: false, numbers: SlideFocus.#numbers(state.doc) }),
            apply: (/** @type {any} */ tr, /** @type {any} */ prev) => {
              const meta = tr.getMeta(key)
              return {
                presenting: meta ? !!meta.presenting : prev.presenting,
                numbers: tr.docChanged ? SlideFocus.#numbers(tr.doc) : prev.numbers,
              }
            },
          },
          appendTransaction: (/** @type {any[]} */ _trs, /** @type {any} */ oldState, /** @type {any} */ newState) => {
            if (!SlideFocus.isPresenting(newState)) return null
            const next = SlideFocus.#offMarker(newState, oldState.selection.head)
            return next ? newState.tr.setSelection(next) : null
          },
          view: (/** @type {any} */ view) => new SlideCounter(view),
          props: {
            handleKeyDown: (/** @type {any} */ view, /** @type {KeyboardEvent} */ event) => {
              if (!SlideFocus.isPresenting(view.state)) return false
              const step = SlideFocus.turnStep(event)
              if (!step) return false
              const next = SlideFocus.turn(view.state, step)
              if (next) view.dispatch(view.state.tr.setSelection(next).scrollIntoView())
              return true
            },
            decorations: (/** @type {any} */ state) => {
              if (!SlideFocus.isPresenting(state)) return key.getState(state).numbers
              return T.DecorationSet.create(state.doc, SlideFocus.hiddenRanges(state.doc, state.selection.head)
                .map((r) => T.Decoration.node(r.from, r.to, HIDDEN)))
            },
          },
        })]
      },
    })
  }
}

/** The deck counter drawn in the corner of the editor while presenting: the
 *  caret's slide and the deck's length, e.g. `3 / 12`. A ProseMirror plugin view;
 *  it lives beside the editable DOM, never in it. */
class SlideCounter {
  /** @type {HTMLElement} */ #el

  /** @param {any} view an EditorView */
  constructor(view) {
    this.#el = document.createElement('div')
    this.#el.className = 'slide-counter'
    this.#el.setAttribute('aria-hidden', 'true')
    view.dom.parentNode?.appendChild(this.#el)
    this.update(view)
  }

  /** @param {any} view an EditorView */
  update(view) {
    const place = SlideFocus.isPresenting(view.state) ? SlideFocus.place(view.state) : null
    this.#el.hidden = !place
    if (place) this.#el.textContent = `${place.index} / ${place.count}`
  }

  destroy() { this.#el.remove() }
}
