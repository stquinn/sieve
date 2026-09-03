// @ts-check
// Spelling marks as inline decorations: one squiggle per mark the server pushed
// that still resolves in what the surface draws. The mark machinery — the
// per-block table, the quote resolution, the rebuild — is
// `TextMarkDecorations`; what is here is the squiggle.

import { TextMarkDecorations } from './text-mark-decorations.js'

/** The class the squiggle carries. */
export const SPELL_MARK_CLASS = 'sieve-spell-mark'

/** The producer whose marks this draws — the word the host pushes them under.
 *  A lens may not import the generated wire module, so this states the word the
 *  contract's `feature` is compared against; `spell-marks.test.js` pins it to
 *  the Go-side vocabulary. */
export const SPELL_FEATURE = 'spell-check'

export class SpellDecorations extends TextMarkDecorations {
  /** @param {any} T the TipTap/ProseMirror vendor bag */
  constructor(T) {
    super(T, 'sieveSpellDecoration', SPELL_FEATURE)
  }

  /**
   * @override — every resolved mark gets the same squiggle. Spelling keeps
   * nothing alongside its hits: one misspelling is no more current than another.
   * @param {ReadonlyArray<import('./text-mark-decorations.js').MarkHit>} hits
   * @param {any} _meta @param {any} _cursor @param {any} Decoration
   * @returns {{cursor: any, decorations: any[]}}
   */
  paintHits(hits, _meta, _cursor, Decoration) {
    /** @type {any[]} */ const decorations = []
    for (const hit of hits) {
      for (const range of hit.ranges) {
        decorations.push(Decoration.inline(range.from, range.to, { class: SPELL_MARK_CLASS }))
      }
    }
    return { cursor: null, decorations: decorations }
  }
}
