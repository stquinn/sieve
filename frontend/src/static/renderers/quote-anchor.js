// @ts-check
// Where a quote-and-occurrence anchor sits in a piece of text.
//
// A text mark names the characters it flags and WHICH of the identical ones it
// means. It does not name a range: the offsets that came with it are into the
// bytes the server read — a block's stored markdown — and a lens draws the
// parsed reading of those bytes, with the markup gone. Resolving by name is what
// lets one anchor land in both readings.
//
// WHAT THE COUNT IS OVER IS THE ANCHOR'S OWN GRAIN, and it is dispatched on,
// never assumed. A `word` anchor counts among WORD RUNS — letters, digits and
// apostrophes, with the apostrophes at its edges trimmed off — so `the` inside
// `there` is no occurrence of it. A `literal` anchor counts among the
// NON-OVERLAPPING, left-to-right literal matches of the quote, so `aa` occurs
// twice in `aaaa` and a phrase may cross a word boundary. The two disagree by
// design, which is why the mint declares one.
//
// An anchor that does not resolve is ABSENT from the answer, and an anchor whose
// grain nothing counts in resolves nowhere. A mark is derived from text that has
// since moved on, and staleness is its absence rather than a state anything has
// to represent.

/** The grains an anchor may be counted at. The words are the wire's. */
export const TextGrain = Object.freeze({
  WORD: 'word',
  LITERAL: 'literal',
})

/** One resolved run of a reading. @typedef {object} WordRun
 *  @property {string} word  the run itself
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
   * Occurrence `occurrence` of `quote` among the NON-OVERLAPPING, left-to-right
   * literal matches of it in `text`, or null where the text holds no such
   * match. After a match the scan resumes past its end, so `aa` matches `aaaa`
   * at 0 and 2 and not at 1 — the same counting Go's LocateLiteral does, and
   * the two must agree for a mark minted on one side to name the same
   * characters on the other.
   * @param {string} text
   * @param {string} quote
   * @param {number} occurrence
   * @returns {WordRun | null}
   */
  static literalRun(text, quote, occurrence) {
    if (!quote || occurrence < 0) return null
    let seen = 0
    for (let at = text.indexOf(quote); at >= 0; at = text.indexOf(quote, at + quote.length)) {
      if (seen === occurrence) return { word: quote, start: at, end: at + quote.length }
      seen++
    }
    return null
  }

  /**
   * Where each of `marks` sits in `text`, in the order the marks were given.
   * Each mark is resolved AT ITS OWN GRAIN. One whose quote does not occur in
   * `text` as many times as its `occurrence` demands is left out, and so is one
   * whose grain names no counting this knows.
   * @template {{quote?: string, occurrence?: number, grain?: string}} M
   * @param {string} text
   * @param {ReadonlyArray<M>} marks
   * @returns {Array<{mark: M, start: number, end: number}>}
   */
  static spansFor(text, marks) {
    /** @type {Array<{mark: M, start: number, end: number}>} */ const out = []
    if (!marks || !marks.length) return out
    const reading = String(text || '')

    /** @type {Map<string, WordRun[]>} */ const byWord = new Map()
    for (const run of QuoteAnchor.words(reading)) {
      const held = byWord.get(run.word)
      if (held) held.push(run)
      else byWord.set(run.word, [run])
    }

    for (const mark of marks) {
      const quote = String((mark && mark.quote) || '')
      const occurrence = Number((mark && mark.occurrence) || 0)
      const grain = mark && mark.grain
      let at = null
      if (grain === TextGrain.WORD) {
        const held = byWord.get(quote)
        at = (held && held[occurrence]) || null
      } else if (grain === TextGrain.LITERAL) {
        at = QuoteAnchor.literalRun(reading, quote, occurrence)
      }
      if (at) out.push({ mark: mark, start: at.start, end: at.end })
    }
    return out
  }
}
