// @ts-check
// A ProseMirror document read as ONE flat string, together with the map from
// every character of it back to the document position that holds it.
//
// IT WALKS INLINE CHILDREN, NOT A TEXTBLOCK'S `textContent`. A hard break
// contributes no character to `textContent` and one position to the document, so
// a coordinate computed off the flat string drifts one place per break. Here a
// break — any non-text inline child — is a NEWLINE in the reading and its own
// position in the document, so the two coordinate spaces advance together and a
// span means the same characters in both.
//
// A LITERAL IS STILL TEXT. A code block, and a run carrying the `code` mark,
// hold characters the author quoted; they are part of the message and so part of
// the flat reading, but they are marked `literal` so a consumer deciding what is
// PROSE — what may be a mention, say — can pass over them.

/**
 * One stretch of the flat reading that maps onto one stretch of the document.
 * @typedef {object} FlatRun
 * @property {string}  text    the characters this run contributes
 * @property {number}  start   where they begin in the flat text
 * @property {number}  pmStart the document position of the first character, or
 *                             -1 for the newline BETWEEN two blocks, which the
 *                             reading invents and no position holds
 * @property {number}  pmEnd   one past the document position of the last
 *                             character; equal to `pmStart + text.length` for
 *                             text, and the node's size for an inline child
 * @property {boolean} literal whether these are characters the author QUOTED
 */

export class FlatText {
  /** @type {string} */ #text
  /** @type {ReadonlyArray<FlatRun>} */ #runs
  /** @type {number} the position an EMPTY reading maps to — a document reads
   *  from 0, a single block from its own content start */ #base

  /** The flat reading of a document. A missing document reads as empty.
   *  @param {any} doc a ProseMirror document node */
  constructor(doc) {
    this.#runs = FlatText.#walk(doc, 0)
    this.#text = this.#runs.map((run) => run.text).join('')
    this.#base = 0
  }

  /**
   * The flat reading of ONE textblock — the caret's own, for a consumer whose
   * coordinates are block-local. No block joins, so every run maps to a real
   * document position.
   * @param {any} block a ProseMirror textblock node
   * @param {number} contentStart the document position of its first character
   * @returns {FlatText}
   */
  static ofBlock(block, contentStart) {
    const flat = new FlatText(null)
    /** @type {FlatRun[]} */ const runs = []
    if (block) FlatText.#blockRuns(block, contentStart, 0, runs)
    flat.#runs = runs
    flat.#text = runs.map((run) => run.text).join('')
    flat.#base = contentStart
    return flat
  }

  /**
   * The flat reading of ONE node of a document and everything under it, for a
   * consumer whose coordinates are that node's. A node holding other blocks —
   * a list, a table, a prose group — reads as its textblocks joined by the same
   * newline the whole-document reading joins blocks with, so the reading of a
   * block is the reading of the document restricted to it.
   * @param {any} node a ProseMirror node
   * @param {number} nodePos the node's own document position
   * @returns {FlatText}
   */
  static ofNode(node, nodePos) {
    if (!node) return new FlatText(null)
    if (node.isTextblock) return FlatText.ofBlock(node, nodePos + 1)
    const flat = new FlatText(null)
    flat.#runs = FlatText.#walk(node, nodePos + 1)
    flat.#text = flat.#runs.map((run) => run.text).join('')
    flat.#base = nodePos + 1
    return flat
  }

  /**
   * The flat offset holding the document position `pmPos` — the caret's place
   * in the reading. A position past the reading answers its length.
   * @param {number} pmPos @returns {number}
   */
  flatOffsetOf(pmPos) {
    for (const run of this.#runs) {
      if (run.pmStart < 0) continue
      if (pmPos <= run.pmStart) return run.start
      if (pmPos <= run.pmEnd) {
        return run.start + Math.min(pmPos - run.pmStart, run.text.length)
      }
    }
    return this.#text.length
  }

  /**
   * The document position holding the flat offset — where an insertion at
   * `offset` lands. An inline node standing in for one character answers its
   * own start. The inverse of `flatOffsetOf` over this reading's runs.
   * @param {number} offset @returns {number}
   */
  pmOf(offset) {
    let lastEnd = this.#base
    for (const run of this.#runs) {
      if (run.pmStart < 0) continue
      if (offset < run.start) return run.pmStart
      if (offset < run.start + run.text.length) {
        if (run.pmEnd - run.pmStart !== run.text.length) return run.pmStart
        return run.pmStart + (offset - run.start)
      }
      lastEnd = run.pmEnd
    }
    return lastEnd
  }

  /** @returns {string} the whole document as one string, blocks joined by newlines */
  get text() { return this.#text }

  /** @returns {ReadonlyArray<FlatRun>} the runs, in document order */
  get runs() { return this.#runs }

  /**
   * The document ranges the flat span `[start, end)` names, in document order.
   * The newline between two blocks names none: it is a boundary the reading
   * invented, and cutting it would join blocks nobody asked to join.
   * @param {number} start @param {number} end
   * @returns {Array<{from: number, to: number}>}
   */
  ranges(start, end) {
    /** @type {Array<{from: number, to: number}>} */ const out = []
    for (const run of this.#runs) {
      if (run.pmStart < 0) continue
      const from = Math.max(start, run.start)
      const to = Math.min(end, run.start + run.text.length)
      if (to <= from) continue
      // A run whose document size differs from its character count is an inline
      // node standing in for one character: it goes whole or not at all.
      if (run.pmEnd - run.pmStart !== run.text.length) {
        out.push({ from: run.pmStart, to: run.pmEnd })
        continue
      }
      out.push({ from: run.pmStart + (from - run.start), to: run.pmStart + (to - run.start) })
    }
    return out
  }

  /**
   * The character preceding `run` in the flat reading — '' where it opens the
   * document. What a token rule needs to decide whether a run's first character
   * sits at a word boundary.
   * @param {FlatRun} run
   * @returns {string}
   */
  before(run) { return run.start > 0 ? this.#text.charAt(run.start - 1) : '' }

  /**
   * @param {any} root the node whose textblocks are read
   * @param {number} contentStart the document position of `root`'s first child
   * @returns {ReadonlyArray<FlatRun>}
   */
  static #walk(root, contentStart) {
    /** @type {FlatRun[]} */ const runs = []
    if (!root || typeof root.descendants !== 'function') return runs
    let offset = 0
    let first = true
    root.descendants((/** @type {any} */ node, /** @type {number} */ pos) => {
      if (!node.isTextblock) return true
      if (!first) {
        runs.push({ text: '\n', start: offset, pmStart: -1, pmEnd: -1, literal: false })
        offset += 1
      }
      first = false
      offset = FlatText.#blockRuns(node, contentStart + pos + 1, offset, runs)
      return false
    })
    return runs
  }

  /**
   * Appends one textblock's runs to `runs` and returns the flat offset after
   * them — the shared half of the whole-document walk and `ofBlock`.
   * @param {any} node @param {number} contentStart @param {number} offset
   * @param {FlatRun[]} runs @returns {number}
   */
  static #blockRuns(node, contentStart, offset, runs) {
    const quoted = !!(node.type && node.type.spec && node.type.spec.code)
    node.forEach((/** @type {any} */ child, /** @type {number} */ childOffset) => {
      const pmStart = contentStart + childOffset
      const text = child.isText ? (child.text || '') : '\n'
      if (!text) return
      runs.push({
        text: text,
        start: offset,
        pmStart: pmStart,
        pmEnd: pmStart + child.nodeSize,
        literal: quoted || FlatText.#isLiteral(child),
      })
      offset += text.length
    })
    return offset
  }

  /** @param {any} child @returns {boolean} whether this run carries the code mark */
  static #isLiteral(child) {
    const marks = (child && child.marks) || []
    return marks.some((/** @type {any} */ mark) => mark && mark.type && mark.type.name === 'code')
  }
}
