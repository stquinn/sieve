// @ts-check
// Where the `@Title` tokens of a set of titles sit in a ProseMirror document, as
// document positions.
//
// IT READS THE FLAT TEXT, WHICH IS THE SAME READING THE CHIPS PAIR AGAINST. The
// walk that maps flat characters to document positions is `FlatText`, so what
// gets marked and what a chip claims are computed from one coordinate space and
// cannot drift apart across a hard break.
//
// A LITERAL IS NOT PROSE. A code block, and a run carrying the `code` mark, hold
// text the author quoted — `@Auth Design` inside one is a sample being talked
// about, so no range is offered there. The same exclusion `MentionTokens.mark`
// makes for `<code>`/`<pre>` in rendered prose.

import { MentionTokens } from '../../../renderers/mention-tokens.js'
import { FlatText } from './flat-text.js'

export class MentionRanges {
  /**
   * Every `@Title` token of `titles` in `doc`, as half-open document ranges in
   * document order. No titles means no ranges — the inert answer, and the one a
   * lens that attaches nothing always gets.
   * @param {any} doc a ProseMirror document node
   * @param {ReadonlyArray<string|undefined>} titles the attached documents' titles
   * @returns {Array<{from: number, to: number}>}
   */
  static of(doc, titles) {
    const wanted = Array.from(new Set(
      (titles || []).map((t) => String(t || '').trim()).filter(Boolean)))
    /** @type {Array<{from: number, to: number}>} */ const ranges = []
    if (!doc || wanted.length === 0) return ranges
    const flat = new FlatText(doc)
    for (const run of flat.runs) {
      if (run.literal || run.pmStart < 0) continue
      for (const span of MentionTokens.claim(run.text, wanted, flat.before(run))) {
        ranges.push({ from: run.pmStart + span.start, to: run.pmStart + span.end })
      }
    }
    return ranges
  }
}
