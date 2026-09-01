// @ts-check
// Where a quote-and-occurrence anchor sits in a piece of text.
//
// A text mark names the characters it flags and WHICH of the identical ones it
// means. It does not name a range: the offsets that came with it are into the
// bytes the server read — a block's stored markdown — and a lens draws the
// parsed reading of those bytes, with the markup gone. Resolving by name is what
// lets one anchor land in both readings.
//
// THE COUNT IS OVER WORD RUNS. A run is letters, digits and apostrophes, with
// the apostrophes at its edges trimmed off, which is the tokenisation the
// anchor was minted under. Counting substrings instead would number `the`
// inside `there` and put every later occurrence one place out.
//
// An anchor that does not resolve is ABSENT from the answer. A mark is derived
// from text that has since moved on, and staleness is its absence rather than a
// state anything has to represent.

/** One word run of a reading. @typedef {object} WordRun
 *  @property {string} word  the run with its edge apostrophes trimmed
 *  @property {number} start where it begins in the reading
 *  @property {number} end   one past where it ends */

/** Letters, digits and apostrophes — both the typewriter and the typographic
 *  one. Everything else breaks a run. */
const WORD_RUN = /[\p{L}\p{N}'’]+/gu
const LEADING_APOSTROPHES = /^['’]+/
const TRAILING_APOSTROPHES = /['’]+$/

export class QuoteAnchor {
  /**
   * The word runs of `text`, in reading order. A run of nothing but
   * apostrophes contributes none.
   * @param {string} text
   * @returns {WordRun[]}
   */
  static words(text) {
    /** @type {WordRun[]} */ const runs = []
    for (const match of String(text || '').matchAll(WORD_RUN)) {
      const run = match[0]
      const lead = run.length - run.replace(LEADING_APOSTROPHES, '').length
      const word = run.slice(lead).replace(TRAILING_APOSTROPHES, '')
      if (!word) continue
      const start = (match.index || 0) + lead
      runs.push({ word: word, start: start, end: start + word.length })
    }
    return runs
  }

  /**
   * Where each of `marks` sits in `text`, in the order the marks were given.
   * A mark whose quote does not occur in `text` as many times as its
   * `occurrence` demands is left out.
   * @template {{quote?: string, occurrence?: number}} M
   * @param {string} text
   * @param {ReadonlyArray<M>} marks
   * @returns {Array<{mark: M, start: number, end: number}>}
   */
  static spansFor(text, marks) {
    /** @type {Array<{mark: M, start: number, end: number}>} */ const out = []
    if (!marks || !marks.length) return out

    /** @type {Map<string, WordRun[]>} */ const byWord = new Map()
    for (const run of QuoteAnchor.words(text)) {
      const held = byWord.get(run.word)
      if (held) held.push(run)
      else byWord.set(run.word, [run])
    }

    for (const mark of marks) {
      const held = byWord.get(String((mark && mark.quote) || ''))
      const at = held && held[Number((mark && mark.occurrence) || 0)]
      if (at) out.push({ mark: mark, start: at.start, end: at.end })
    }
    return out
  }
}
