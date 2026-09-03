// @ts-check
// spell-marks.test.js — the layers of placing a text mark and acting on one: the
// pure anchor resolution (QuoteAnchor), the document walk that resolves anchors
// against a real document (SpellDecorations.hits), the plugin built on that walk
// (its `apply()` dispatch and its per-block REPLACE/CLEAR state, exercised the
// way mention-decoration.test.js exercises MentionDecorations: a small fake
// vendor bag standing in for Plugin/PluginKey/Decoration/DecorationSet), the
// read back out of it — which marks a selection sits on — and the verb a reader
// who picked a suggestion fires.
//
// NEW FILE because both units are new. It is one file rather than two for the
// reason mention-decoration.test.js is: a resolution rule and the walk that
// applies it are read together, and the walk's cases are stated as "what got
// underlined", which only means anything against the resolution above it.
//
// The walk runs against REAL ProseMirror documents. The whole reason a mark is
// anchored by quote rather than by the offsets it carries is a document fact —
// the server counted bytes of markdown and the surface draws the parse of them —
// and the multi-textblock cases (a list, a prose group) only exist in a real doc.

import { describe, it, expect, vi } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import { QuoteAnchor, TextGrain } from '../src/static/renderers/quote-anchor.js'
import { SpellDecorations, SPELL_MARK_CLASS, SPELL_FEATURE } from '../src/static/lens/document-editor/surfaces/spell-decoration.js'
import { FindDecorations, FIND_MARK_CLASS, FIND_CURRENT_CLASS, FIND_SETTLE_CLASS, FIND_FEATURE } from '../src/static/lens/document-editor/surfaces/find-decoration.js'
import { Feature } from '../src/static/generated/protocol.js'
import { AbstractEditor } from '../src/static/lens/abstract-editor.js'
import { AbstractSurface } from '../src/static/lens/document-editor/surfaces/abstract-surface.js'
import { EditorMode } from '../src/static/lens/document-editor/editor-mode.js'

// The last layer — the lens verb that asks for a correction — pulls in
// AbstractEditor, and with it the four owner modules that run vendor calls at
// IMPORT time and would crash against the bare test/setup.js TipTap seed.
// Nothing here mounts a real surface, so inert mocks satisfy the imports (the
// lens-capabilities.test.js pattern).
vi.mock('../src/static/lens/extensions.js', () => ({
  SelectionHighlight: {}, HighlightMark: {},
  AiShortcuts: { configure: () => ({}) },
  buildAiContext: vi.fn(), applyTargetHighlight: vi.fn(),
}))
vi.mock('../src/static/lens/document-editor/block-chrome.js', () => ({
  BlockChrome: {}, getBlockSelectionRange: vi.fn(),
}))
vi.mock('../src/static/lens/document-editor/surfaces/ai-target-decoration.js', () => ({ AiTargetDecoration: {} }))
vi.mock('../src/static/lens/document-editor/surfaces/prose-block.js', () => ({ BlockId: {} }))

// The lens cannot import the generated wire module (the firewall), so it states
// the feature word it draws for itself — and a test CAN import both, which is
// what keeps the two halves of that word from drifting apart in silence.
describe('the feature this lens draws', () => {
  it('is the word the wire pushes spelling marks under', () => {
    expect(SPELL_FEATURE).toBe(Feature.SPELL_CHECK)
  })
})

describe('QuoteAnchor.words — the runs an occurrence counts over', () => {
  /** @type {Array<[string, string, string[]]>} */
  const cases = [
    ['splits on whitespace and punctuation', 'the cat, sat.', ['the', 'cat', 'sat']],
    ['keeps an internal apostrophe', "it isn't there", ['it', "isn't", 'there']],
    ['keeps the typographic apostrophe too', 'it isn’t there', ['it', 'isn’t', 'there']],
    ['trims apostrophes at the edges of a run', "a 'quoted' word", ['a', 'quoted', 'word']],
    ['drops a run that is nothing but apostrophes', "a ' b", ['a', 'b']],
    ['keeps digits inside a run, so an identifier is ONE run', 'utf8 x2 plain', ['utf8', 'x2', 'plain']],
    ['breaks a run on a dot, so a filename is several', 'see main.go now', ['see', 'main', 'go', 'now']],
    ['reads non-Latin letters as words', 'ein groß Wort', ['ein', 'groß', 'Wort']],
    ['reads nothing out of empty text', '', []],
  ]

  for (const [name, text, words] of cases) {
    it(name, () => {
      expect(QuoteAnchor.words(text).map((run) => run.word)).toEqual(words)
    })
  }

  it('reports each run where it sits', () => {
    expect(QuoteAnchor.words('the cat')).toEqual([
      { word: 'the', start: 0, end: 3 },
      { word: 'cat', start: 4, end: 7 },
    ])
  })

  it('reports a trimmed run at the trimmed offsets, not the run they came from', () => {
    expect(QuoteAnchor.words("'cat'")).toEqual([{ word: 'cat', start: 1, end: 4 }])
  })
})

describe('QuoteAnchor.spansFor — placing marks by name', () => {
  /** @param {string} quote @param {number} [occurrence] */
  const mark = (quote, occurrence) => ({ quote: quote, occurrence: occurrence || 0, grain: TextGrain.WORD })

  /** The text each resolved span names, so an assertion reads as what got placed.
   *  @param {string} text @param {Array<any>} marks */
  const placed = (text, marks) =>
    QuoteAnchor.spansFor(text, marks).map((hit) => text.slice(hit.start, hit.end))

  it('places the first occurrence at its own offsets', () => {
    expect(QuoteAnchor.spansFor('a teh b', [mark('teh')])).toEqual([
      { mark: mark('teh'), start: 2, end: 5 },
    ])
  })

  it('counts occurrences of the SAME quote, not of every word', () => {
    const text = 'teh cat teh dog teh'
    expect(QuoteAnchor.spansFor(text, [mark('teh', 2)])).toEqual([
      { mark: mark('teh', 2), start: 16, end: 19 },
    ])
  })

  it('counts WORD RUNS, so a quote inside a longer word is not an occurrence', () => {
    // A substring count would find `the` in `there` first and place occurrence 0
    // there instead — every later occurrence one place out.
    expect(placed('there is the answer', [mark('the')])).toEqual(['the'])
    expect(QuoteAnchor.spansFor('there is the answer', [mark('the')])[0].start).toBe(9)
  })

  it('DROPS a mark whose quote is gone — staleness is absence', () => {
    expect(QuoteAnchor.spansFor('the cat sat', [mark('teh')])).toEqual([])
  })

  it('DROPS a mark whose occurrence the text no longer reaches', () => {
    expect(QuoteAnchor.spansFor('teh cat', [mark('teh', 1)])).toEqual([])
  })

  it('drops only the mark that does not resolve, keeping its neighbours', () => {
    expect(placed('teh cat sat', [mark('teh'), mark('gone'), mark('sat')])).toEqual(['teh', 'sat'])
  })

  it('answers nothing for an empty mark set and for a quote-less mark', () => {
    expect(QuoteAnchor.spansFor('teh cat', [])).toEqual([])
    expect(QuoteAnchor.spansFor('teh cat', [{ occurrence: 0, grain: TextGrain.WORD }])).toEqual([])
  })

  it('resolves the apostrophe form the anchor was minted as', () => {
    expect(placed("it isn't so", [mark("isn't")])).toEqual(["isn't"])
  })
})

// The client half of the grain contract, and it must count what Go counts: the
// rows below are the ones sieve/domain/text_segment_test.go drives, asserted as
// the offset each grain resolves to (-1 meaning "this grain does not resolve
// it"). A resolver that quietly stood in for the other one disagrees with the
// server about which characters a mark names.
//
// THE OFFSETS ARE NOT THE SAME NUMBERS ON BOTH SIDES and are not meant to be:
// Go counts bytes and JavaScript counts UTF-16 units, so the multi-byte rows
// resolve to different integers here than there. What must agree is the
// ORDINAL — which match a given occurrence names — because that is what
// crosses the wire. The rows are the same texts asked the same questions.
describe('QuoteAnchor.spansFor — the grain says how the occurrence is counted', () => {
  /** @param {string} quote @param {number} occurrence @param {string} grain */
  const at = (quote, occurrence, grain) => ({ quote: quote, occurrence: occurrence, grain: grain })
  /** The offsets a grain resolves to, so an unresolved mark reads as [].
   *  @param {string} text @param {string} quote @param {number} occurrence @param {string} grain */
  const starts = (text, quote, occurrence, grain) =>
    QuoteAnchor.spansFor(text, [at(quote, occurrence, grain)]).map((hit) => hit.start)

  /** name, text, quote, occurrence, where the word grain lands, where the literal grain lands
   *  @type {Array<[string, string, string, number, number, number]>} */
  const cases = [
    ['a whole word both grains agree on', 'teh cat sat', 'teh', 0, 0, 0],
    ['`the` in `the other there` is ONE word run and THREE literal matches: the first', 'the other there', 'the', 0, 0, 0],
    ['…the second, inside `other`, which is no word run', 'the other there', 'the', 1, -1, 5],
    ['…the third, inside `there`', 'the other there', 'the', 2, -1, 10],
    ['an occurrence past the last match resolves in neither grain', 'the other there', 'the', 3, -1, -1],
    ['literal matches do not overlap: `aa` in `aaaa` is the one at 0…', 'aaaa', 'aa', 0, -1, 0],
    ['…and the one at 2, the overlapping match at 1 having been skipped', 'aaaa', 'aa', 1, -1, 2],
    ['…and there is no third', 'aaaa', 'aa', 2, -1, -1],
    ['a single letter inside a word is literal only', 'FIVE', 'V', 0, -1, 2],
    // The reading the server numbers this in holds the address too — a surface
    // draws it — so both sides count through it and land on the same match.
    ['an address is counted through, not over', 'a https://x.example/a a', 'a', 1, 20, 14],
    ['a run crossing a word boundary is literal only', 'get along', 'et alon', 0, -1, 1],
    ['a multi-byte letter is a literal match like any other', 'café au café', 'é', 1, -1, 11],
    ['a word run containing a multi-byte letter is still one run', 'café au café', 'café', 1, 8, 8],
    ['a quote containing a non-BMP character counts as one match', 'a 🎉 b 🎉 c', '🎉', 1, -1, 7],
    ['a quote spanning a non-BMP character resolves at its own offsets', 'say 🎉 now', 'y 🎉 n', 0, -1, 2],
    ['an empty quote names nothing in either grain', 'the cat', '', 0, -1, -1],
    ['a negative occurrence names nothing in either grain', 'the cat', 'the', -1, -1, -1],
  ]

  for (const [name, text, quote, occurrence, wordAt, literalAt] of cases) {
    it(name, () => {
      expect(starts(text, quote, occurrence, TextGrain.WORD)).toEqual(wordAt < 0 ? [] : [wordAt])
      expect(starts(text, quote, occurrence, TextGrain.LITERAL)).toEqual(literalAt < 0 ? [] : [literalAt])
    })
  }

  it('names the WHOLE quote a literal match covers, not the word around it', () => {
    expect(QuoteAnchor.spansFor('get along', [at('et alon', 0, TextGrain.LITERAL)]))
      .toEqual([{ mark: at('et alon', 0, TextGrain.LITERAL), start: 1, end: 8 }])
  })

  it('DROPS a mark whose grain nothing counts in — an unresolved mark is absent, never thrown', () => {
    expect(QuoteAnchor.spansFor('teh cat', [at('teh', 0, 'sentence')])).toEqual([])
    expect(QuoteAnchor.spansFor('teh cat', [at('teh', 0, '')])).toEqual([])
    expect(QuoteAnchor.spansFor('teh cat', [/** @type {any} */ ({ quote: 'teh', occurrence: 0 })])).toEqual([])
  })

  it('drops only the grain-less mark, keeping the marks either side of it', () => {
    const marks = [at('teh', 0, TextGrain.WORD), at('cat', 0, 'sentence'), at('sat', 0, TextGrain.LITERAL)]
    expect(QuoteAnchor.spansFor('teh cat sat', marks).map((hit) => hit.mark.quote)).toEqual(['teh', 'sat'])
  })
})

// The document vocabulary a prose block actually takes: one textblock, a list of
// them, and the proseGroup that carries ONE block id over several.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', attrs: { id: { default: '' } }, toDOM: () => ['p', 0] },
    proseGroup: { group: 'block', content: 'block+', attrs: { id: { default: '' } }, toDOM: () => ['div', 0] },
    bulletList: { group: 'block', content: 'listItem+', attrs: { id: { default: '' } }, toDOM: () => ['ul', 0] },
    listItem: { content: 'paragraph+', toDOM: () => ['li', 0] },
    codeBlock: { group: 'block', content: 'text*', code: true, attrs: { id: { default: '' } }, toDOM: () => ['pre', 0] },
    hardBreak: { group: 'inline', inline: true, selectable: false, toDOM: () => ['br'] },
    text: { group: 'inline' },
  },
})

const n = schema.nodes
/** @param {string} s */
const t = (s) => schema.text(s)
/** @param {string} id @param {string} text */
const para = (id, text) => n.paragraph.create({ id: id }, text ? t(text) : null)
/** @param {...any} blocks */
const doc = (...blocks) => n.doc.create(null, blocks)
/** @param {string} quote @param {number} [occurrence] */
const mark = (quote, occurrence) =>
  ({ quote: quote, occurrence: occurrence || 0, grain: TextGrain.WORD, locator: 'content', class: 'prose' })
/** @param {Array<[string, Array<any>]>} entries */
const table = (entries) => new Map(entries)
/** The text each range names. @param {any} d @param {Array<{from: number, to: number}>} ranges */
const underlined = (d, ranges) => ranges.map((r) => d.textBetween(r.from, r.to))
/** Every resolved range in document order — what the plugin decorates.
 *  @param {any} d @param {any} marksByBlock */
const rangesOf = (d, marksByBlock) =>
  SpellDecorations.hits(d, marksByBlock).flatMap((hit) => hit.ranges)

describe('SpellDecorations.hits — where the squiggles go', () => {
  it('underlines the quote inside the block that was marked', () => {
    const d = doc(para('b1', 'a teh word'))
    const ranges = rangesOf(d, table([['b1', [mark('teh')]]]))
    expect(ranges).toEqual([{ from: 3, to: 6 }])
    expect(underlined(d, ranges)).toEqual(['teh'])
  })

  it('marks are per BLOCK: a quote in a block nobody marked is left alone', () => {
    const d = doc(para('b1', 'teh cat'), para('b2', 'teh dog'))
    expect(underlined(d, rangesOf(d, table([['b2', [mark('teh')]]])))).toEqual(['teh'])
    expect(rangesOf(d, table([['b2', [mark('teh')]]]))[0].from).toBe(10)
  })

  it('counts occurrences WITHIN the block, restarting at each one', () => {
    const d = doc(para('b1', 'teh cat'), para('b2', 'teh dog teh'))
    const ranges = rangesOf(d, table([['b2', [mark('teh', 1)]]]))
    expect(underlined(d, ranges)).toEqual(['teh'])
    expect(ranges[0].from).toBe(18)
  })

  it('reads a multi-textblock block as ONE reading, so occurrence spans its items', () => {
    const d = doc(n.bulletList.create({ id: 'b1' }, [
      n.listItem.create(null, [para('', 'teh first')]),
      n.listItem.create(null, [para('', 'teh second')]),
    ]))
    const ranges = rangesOf(d, table([['b1', [mark('teh', 1)]]]))
    expect(underlined(d, ranges)).toEqual(['teh'])
    // The second item's, not the first's — one reading across both.
    expect(ranges[0].from).toBeGreaterThan(10)
  })

  it('reads a prose group the same way — the group carries the id, its children the text', () => {
    const d = doc(n.proseGroup.create({ id: 'b1' }, [para('', 'a heading'), para('', 'teh body')]))
    expect(underlined(d, rangesOf(d, table([['b1', [mark('teh')]]])))).toEqual(['teh'])
  })

  it('AFTER A HARD BREAK the range is still exact — the break costs a position and no character', () => {
    const d = doc(n.paragraph.create({ id: 'b1' }, [t('first line'), n.hardBreak.create(), t('teh word')]))
    const ranges = rangesOf(d, table([['b1', [mark('teh')]]]))
    expect(underlined(d, ranges)).toEqual(['teh'])
    // A flat-textContent reading would have landed one early, on `eteh`.
    expect(ranges[0].from).toBe(12)
  })

  it('DROPS a mark the block no longer bears — the word was corrected', () => {
    const d = doc(para('b1', 'a the word'))
    expect(rangesOf(d, table([['b1', [mark('teh')]]]))).toEqual([])
  })

  it('DROPS marks for a block id the document does not hold', () => {
    const d = doc(para('b1', 'teh cat'))
    expect(rangesOf(d, table([['gone', [mark('teh')]]]))).toEqual([])
  })

  it('draws nothing for an empty table, an absent one and an empty mark list', () => {
    const d = doc(para('b1', 'teh cat'))
    expect(rangesOf(d, new Map())).toEqual([])
    expect(rangesOf(d, /** @type {any} */ (null))).toEqual([])
    expect(rangesOf(/** @type {any} */ (null), table([['b1', [mark('teh')]]]))).toEqual([])
    expect(rangesOf(d, table([['b1', []]]))).toEqual([])
  })

  it('places several marks in one block, in the order they were given', () => {
    const d = doc(para('b1', 'teh cat adn a dog'))
    expect(underlined(d, rangesOf(d, table([['b1', [mark('teh'), mark('adn')]]])))).toEqual(['teh', 'adn'])
  })
})

describe('SpellDecorations.hits — the block and the mark each range came from', () => {
  it('names the block a resolved mark belongs to, and the mark itself', () => {
    const d = doc(para('b1', 'teh cat'), para('b2', 'adn dog'))
    const hits = SpellDecorations.hits(d, table([['b1', [mark('teh')]], ['b2', [mark('adn')]]]))
    expect(hits.map((h) => h.blockId)).toEqual(['b1', 'b2'])
    expect(hits.map((h) => h.mark.quote)).toEqual(['teh', 'adn'])
    expect(hits.map((h) => h.ranges)).toEqual([[{ from: 1, to: 4 }], [{ from: 10, to: 13 }]])
  })

  it('attributes a hit to the block that CARRIES the id, not the textblock holding the text', () => {
    const d = doc(n.proseGroup.create({ id: 'b1' }, [para('', 'a heading'), para('', 'teh body')]))
    expect(SpellDecorations.hits(d, table([['b1', [mark('teh')]]])).map((h) => h.blockId)).toEqual(['b1'])
  })

  it('is no hit at all where the quote does not resolve — nothing to draw and nothing to act on', () => {
    const d = doc(para('b1', 'the cat'))
    expect(SpellDecorations.hits(d, table([['b1', [mark('teh')]]]))).toEqual([])
  })
})

// ── The plugin around SpellDecorations.hits ─────────────────────────────────
// A recording vendor bag: enough of Plugin/PluginKey/Decoration to run the
// plugin's own `state.apply`, which is the half that turns a push into the
// per-block REPLACE/CLEAR semantic and rebuilds decorations from the walk
// above.

function vendor(slot = 'spell') {
  const T = {
    Extension: { create: (/** @type {any} */ cfg) => cfg },
    Plugin: function (/** @type {any} */ cfg) { Object.assign(this, cfg) },
    // A real PluginKey reads its plugin's own state out of the editor state; this
    // one reads the slot a test puts it in, which is the same relationship.
    PluginKey: function (/** @type {any} */ name) {
      this.name = name
      this.getState = (/** @type {any} */ state) => state && state[slot]
    },
    Decoration: {
      inline: (/** @type {number} */ from, /** @type {number} */ to, /** @type {any} */ attrs) =>
        ({ from, to, attrs }),
    },
    DecorationSet: {
      empty: 'EMPTY',
      create: (/** @type {any} */ d, /** @type {any[]} */ decos) => decos,
    },
  }
  return { T }
}

/** Runs the plugin's own `state.apply` over one push, as the view's dispatch would. */
function pushed(spell, prev, d, blockId, marks) {
  const plugin = /** @type {any} */ (spell.extension).addProseMirrorPlugins()[0]
  const tr = { getMeta: () => ({ blockId, marks }), docChanged: false }
  return plugin.state.apply(tr, prev, null, { doc: d })
}

describe('SpellDecorations — the plugin', () => {
  it('init draws nothing — a mount that never hears from the checker, without a gate', () => {
    const { T } = vendor()
    const spell = new SpellDecorations(T)
    const plugin = /** @type {any} */ (spell.extension).addProseMirrorPlugins()[0]
    expect(plugin.state.init()).toEqual({ marks: new Map(), hits: [], cursor: null, decos: 'EMPTY' })
  })

  it('a push with marks decorates the quote it resolves', () => {
    const { T } = vendor()
    const spell = new SpellDecorations(T)
    const init = /** @type {any} */ (spell.extension).addProseMirrorPlugins()[0].state.init()
    const d = doc(para('b1', 'a teh word'))
    const state = pushed(spell, init, d, 'b1', [mark('teh')])
    expect(state.decos).toEqual([{ from: 3, to: 6, attrs: { class: SPELL_MARK_CLASS } }])
  })

  it('a second push for the SAME block REPLACES what it held, not merges', () => {
    const { T } = vendor()
    const spell = new SpellDecorations(T)
    const init = /** @type {any} */ (spell.extension).addProseMirrorPlugins()[0].state.init()
    const d = doc(para('b1', 'teh cat adn dog'))
    const first = pushed(spell, init, d, 'b1', [mark('teh'), mark('adn')])
    expect(underlined(d, first.decos)).toEqual(['teh', 'adn'])
    const second = pushed(spell, first, d, 'b1', [mark('dog')])
    expect(underlined(d, second.decos)).toEqual(['dog'])
    expect(second.marks.get('b1')).toEqual([mark('dog')])
  })

  it('an EMPTY push CLEARS the block — the corrected word loses its squiggle', () => {
    const { T } = vendor()
    const spell = new SpellDecorations(T)
    const init = /** @type {any} */ (spell.extension).addProseMirrorPlugins()[0].state.init()
    const d = doc(para('b1', 'teh cat'))
    const first = pushed(spell, init, d, 'b1', [mark('teh')])
    expect(first.decos.length).toBe(1)
    const cleared = pushed(spell, first, d, 'b1', [])
    expect(cleared.decos).toBe('EMPTY')
    expect(cleared.marks.has('b1')).toBe(false)
  })

  it('a mark whose quote does not resolve draws nothing, though the mark is still held', () => {
    const { T } = vendor()
    const spell = new SpellDecorations(T)
    const init = /** @type {any} */ (spell.extension).addProseMirrorPlugins()[0].state.init()
    const d = doc(para('b1', 'the cat sat'))
    const state = pushed(spell, init, d, 'b1', [mark('teh')])
    expect(state.decos).toBe('EMPTY')
    expect(state.marks.get('b1')).toEqual([mark('teh')])
  })

  it('a transaction carrying no meta and no doc change LEAVES the state standing', () => {
    const { T } = vendor()
    const spell = new SpellDecorations(T)
    const plugin = /** @type {any} */ (spell.extension).addProseMirrorPlugins()[0]
    const prev = { marks: table([['b1', [mark('teh')]]]), decos: 'PREVIOUS' }
    const tr = { getMeta: () => undefined, docChanged: false }
    expect(plugin.state.apply(tr, prev, null, { doc: doc(para('b1', 'teh cat')) })).toBe(prev)
  })

  it('TWO SURFACES DO NOT SHARE STATE: each instance owns its own plugin key', () => {
    const { T } = vendor()
    const a = new SpellDecorations(T)
    const b = new SpellDecorations(T)
    const keyOf = (/** @type {any} */ s) => /** @type {any} */ (s.extension).addProseMirrorPlugins()[0].key
    expect(keyOf(a)).not.toBe(keyOf(b))
  })
})

describe('SpellDecorations#apply — pushing one block\'s marks to the view', () => {
  it('dispatches a META-ONLY transaction naming the block and its marks', () => {
    const { T } = vendor()
    const spell = new SpellDecorations(T)
    /** @type {any[]} */ const metas = []
    const tr = { setMeta: (/** @type {any} */ k, /** @type {any} */ v) => { metas.push({ k, v }); return tr } }
    /** @type {any[]} */ const dispatched = []
    spell.apply({ state: { tr }, dispatch: (/** @type {any} */ x) => dispatched.push(x) }, 'b1', [mark('teh')])
    expect(metas.length).toBe(1)
    expect(metas[0].v).toEqual({ blockId: 'b1', marks: [mark('teh')] })
    expect(dispatched).toEqual([tr])
  })

  it('does nothing without a view or a block id', () => {
    const { T } = vendor()
    const spell = new SpellDecorations(T)
    expect(() => spell.apply(null, 'b1', [mark('teh')])).not.toThrow()
    expect(() => spell.apply({ state: { tr: {} }, dispatch: () => {} }, '', [mark('teh')])).not.toThrow()
  })
})

// ── What the selection sits on ───────────────────────────────────────────────
// The read half: the same held marks, asked about a selection instead of drawn.
// It belongs to the BASE — every producer's marks are read the same way, and the
// advertisement carries all of them at once — so the rows below run against BOTH
// concrete sets, and each mark comes back stamped with the feature that drew it.
//
// `teh` occupies [3, 6) of `a teh word`, so 3..6 is inside the word (its trailing
// edge included) and 2 and 7 are the characters either side of it.

describe('TextMarkDecorations#marksAt — the marks a selection sits on', () => {
  /** One set of `make`'s kind, pushed `marks` for `blockId`, and the editor state
   *  its plugin then holds — built by the plugin's own `apply`, so what `marksAt`
   *  reads is what the surface really resolved.
   *  @param {(T: any) => any} make @param {any} d @param {string} blockId @param {Array<any>} marks */
  const pushedInto = (make, d, blockId, marks) => {
    const { T } = vendor('slot')
    const set = make(T)
    const init = /** @type {any} */ (set.extension).addProseMirrorPlugins()[0].state.init()
    return { set: set, state: { doc: d, slot: pushed(set, init, d, blockId, marks) } }
  }

  /** Both concrete sets: neither overrides the read, and the stamp differs.
   *  @type {Array<[string, (T: any) => any, string]>} */
  const sets = [
    ['spelling', (/** @type {any} */ T) => new SpellDecorations(T), SPELL_FEATURE],
    ['find', (/** @type {any} */ T) => new FindDecorations(T), FIND_FEATURE],
  ]
  const aSpellSet = sets[0][1]

  /** @param {(T: any) => any} make */
  const oneMarkedWord = (make) => pushedInto(make, doc(para('b1', 'a teh word')), 'b1', [mark('teh')])

  /** @type {Array<[string, number, number, string[]]>} */
  const cases = [
    ['a caret inside the word is on it', 4, 4, ['teh']],
    ['a caret at the word\'s first character is on it', 3, 3, ['teh']],
    ['a caret at its trailing edge is still on it — a click lands anywhere in the word', 6, 6, ['teh']],
    ['a caret before the word is on nothing', 2, 2, []],
    ['a caret after the word is on nothing', 7, 7, []],
    ['a selection overlapping the word is on it', 1, 4, ['teh']],
    ['a selection ENDING where the word starts is on nothing — a range must overlap', 1, 3, []],
    ['a selection spanning the whole block is on it', 1, 11, ['teh']],
    ['a BACKWARDS selection reads the same as its forward twin', 4, 1, ['teh']],
  ]

  for (const [setName, make, feature] of sets) {
    for (const [name, from, to, quotes] of cases) {
      it(setName + ': ' + name, () => {
        const { set, state } = oneMarkedWord(make)
        expect(set.marksAt(state, from, to).map((/** @type {any} */ m) => m.quote)).toEqual(quotes)
      })
    }

    it(setName + ': hands back the WHOLE mark, with its block and the feature that drew it', () => {
      const { set, state } = oneMarkedWord(make)
      expect(set.marksAt(state, 4, 4)).toEqual([
        { blockId: 'b1', feature: feature, quote: 'teh', occurrence: 0, grain: TextGrain.WORD, locator: 'content', class: 'prose' },
      ])
    })
  }

  it('answers only the mark under the selection, not the block\'s others', () => {
    const { set, state } = pushedInto(aSpellSet, doc(para('b1', 'teh cat adn dog')), 'b1', [mark('teh'), mark('adn')])
    expect(set.marksAt(state, 2, 2).map((/** @type {any} */ m) => m.quote)).toEqual(['teh'])
    expect(set.marksAt(state, 10, 10).map((/** @type {any} */ m) => m.quote)).toEqual(['adn'])
  })

  it('answers nothing where nothing has been pushed, and without a state at all', () => {
    const { set, state } = pushedInto(aSpellSet, doc(para('b1', 'a teh word')), 'b1', [])
    expect(set.marksAt(state, 4, 4)).toEqual([])
    expect(set.marksAt({ doc: state.doc }, 4, 4)).toEqual([])
    expect(set.marksAt(null, 4, 4)).toEqual([])
  })

  it('answers nothing for a mark the block no longer bears, though it is still held', () => {
    const { set, state } = pushedInto(aSpellSet, doc(para('b1', 'a the word')), 'b1', [mark('teh')])
    expect(state.slot.marks.get('b1')).toEqual([mark('teh')])
    expect(set.marksAt(state, 4, 4)).toEqual([])
  })
})

// ── Asking for a correction ──────────────────────────────────────────────────
// The verb a lens fires once a reader has picked a suggestion. The host rewrites
// the block it holds and echoes the whole block back, so the surface's pending
// block-sync — up to half a second of typing the observer has not sent yet —
// must reach the host BEFORE the rewrite is computed against it.

describe('AbstractEditor#replaceText — asking for a correction', () => {
  /** A surface that does nothing but record the order it was flushed in. */
  class StubSurface extends AbstractSurface {
    /** @param {string[]} log */
    constructor(log) { super(); this.log = log }
    get mode() { return EditorMode.WYSIWYG }
    mount() {}
    unmount() {}
    flushPending() { this.log.push('flush') }
  }

  /** The smallest editor there is: one stub surface, presented on demand. */
  class StubEditor extends AbstractEditor {
    /** @param {string} uuid @param {any} options @param {string[]} log */
    constructor(uuid, options, log) { super(uuid, options); this.log = log }
    _createSurface() { return new StubSurface(this.log) }
  }

  /** @param {boolean} [offersTheVerb] */
  function mounted(offersTheVerb = true) {
    /** @type {string[]} */ const log = []
    const provider = /** @type {any} */ ({
      getUuid: () => 'doc-1', getKind: () => 'note', getOrder: () => [], getBlock: () => null,
      subscribe: vi.fn(), unsubscribe: vi.fn(),
    })
    if (offersTheVerb) provider.requestReplaceText = vi.fn(() => log.push('replace'))
    const lens = new StubEditor('doc-1', { provider }, log)
    lens.presentSurface(EditorMode.WYSIWYG, document.createElement('div'), '')
    return { lens, provider, log }
  }

  const aMark = { blockId: 'b1', quote: 'helllo', occurrence: 0, grain: TextGrain.WORD, start: 2, end: 8 }

  it('FLUSHES the surface before dispatching — typing the observer still holds is not lost to the echo', () => {
    const { lens, provider, log } = mounted()
    lens.replaceText(aMark, 'hello')
    expect(log).toEqual(['flush', 'replace'])
    expect(provider.requestReplaceText).toHaveBeenCalledWith('b1', aMark, 'hello')
  })

  it('does neither for a mark that names no block', () => {
    const { lens, provider, log } = mounted()
    lens.replaceText(/** @type {any} */ ({ quote: 'helllo' }), 'hello')
    expect(log).toEqual([])
    expect(provider.requestReplaceText).not.toHaveBeenCalled()
  })

  it('does neither when the container does not offer the verb — nothing to flush for', () => {
    const { lens, log } = mounted(false)
    lens.replaceText(aMark, 'hello')
    expect(log).toEqual([])
  })
})

// ── The find decoration set ──────────────────────────────────────────────────
// The same mark machinery drawn as a highlight instead of a squiggle, plus the
// one thing find keeps that spelling does not: WHERE THE READER STANDS. That
// index is the lens's own — nothing pushed it and nothing is told it — so what
// the tests below pin is that it survives a repaint, wraps at both ends, and
// stays inside a set that shrank under it.

describe('the feature the find lens draws', () => {
  it('is the word the wire pushes find marks under', () => {
    expect(FIND_FEATURE).toBe(Feature.FIND)
  })
})

describe('FindDecorations — highlights and the current match', () => {
  /** @param {string} quote @param {number} [occurrence] */
  const hit = (quote, occurrence) => ({ locator: 'content', quote: quote, occurrence: occurrence || 0, grain: TextGrain.LITERAL, class: 'prose' })

  /**
   * A find set with one block's marks pushed into it, over a fake view whose
   * dispatch runs the plugin's own `apply` — so stepping goes through exactly
   * the transaction the surface would send.
   * @param {any} d @param {string} blockId @param {Array<any>} marks
   */
  function pushedFind(d, blockId, marks) {
    const { T } = vendor('find')
    const find = new FindDecorations(T)
    const plugin = /** @type {any} */ (find.extension).addProseMirrorPlugins()[0]
    let slot = plugin.state.init()
    // What the surface has DRAWN for the current match, which is what a scroll
    // goes to: the decoration itself, reachable from the view's own DOM — and
    // the pane around it, because a scroll is written on the SCROLLER.
    const drawn = document.createElement('span')
    drawn.className = FIND_MARK_CLASS + ' ' + FIND_CURRENT_CLASS
    drawn.getBoundingClientRect = () => /** @type {any} */ ({ top: 400, bottom: 420, height: 20 })
    const dom = document.createElement('div')
    dom.appendChild(drawn)
    const pane = document.createElement('div')
    pane.style.overflowY = 'auto'
    Object.defineProperty(pane, 'scrollHeight', { value: 2000 })
    Object.defineProperty(pane, 'clientHeight', { value: 200 })
    pane.getBoundingClientRect = () => /** @type {any} */ ({ top: 0, bottom: 200, height: 200 })
    pane.scrollTop = 0
    pane.scrollLeft = 64
    pane.scrollTo = vi.fn()
    pane.appendChild(dom)
    // On the page: what scrolls is decided from COMPUTED style, which a detached
    // element has none of.
    document.body.appendChild(pane)
    const view = {
      dom: dom,
      get state() { return { doc: d, find: slot, tr: { setMeta: (/** @type {any} */ _k, /** @type {any} */ m) => ({ meta: m }) } } },
      dispatch: (/** @type {any} */ tr) => {
        slot = plugin.state.apply({ getMeta: () => tr.meta, docChanged: false }, slot, null, { doc: d })
      },
      domAtPos: () => ({ node: null }),
      nodeDOM: () => null,
    }
    find.apply(view, blockId, marks)
    return { find, view, pane, decos: () => slot.decos }
  }

  const threeMatches = () => pushedFind(doc(para('b1', 'the other there')), 'b1', [hit('the', 0), hit('the', 1), hit('the', 2)])

  /** The classes each match carries, in document order. @param {any[]} decos */
  const tiers = (decos) => decos.map((/** @type {any} */ d) => d.attrs.class)
  const HIGHLIGHTED = FIND_MARK_CLASS
  const CURRENT = FIND_MARK_CLASS + ' ' + FIND_CURRENT_CLASS
  const ARRIVED = CURRENT + ' ' + FIND_SETTLE_CLASS

  it('highlights every match and emphasises the one the reader stands on', () => {
    const { find, view, decos } = threeMatches()
    find.step(view, 1)
    expect(tiers(decos())).toEqual([HIGHLIGHTED, ARRIVED, HIGHLIGHTED])
  })

  it('SETTLES the first match a set arrives with — the reader arrives with it', () => {
    const { decos } = threeMatches()
    expect(tiers(decos())).toEqual([ARRIVED, HIGHLIGHTED, HIGHLIGHTED])
  })

  it('does NOT settle a repaint that moved nobody — the pulse is one-shot, not a state', () => {
    const { find, view, decos } = threeMatches()
    find.step(view, 1)
    find.apply(view, 'b1', [hit('the', 0), hit('the', 1), hit('the', 2)])
    expect(tiers(decos())).toEqual([HIGHLIGHTED, CURRENT, HIGHLIGHTED])
  })

  it('scrolls the PANE to what it drew, and only downwards', () => {
    const { find, view, pane } = threeMatches()
    find.step(view, 1)
    // The drawn match sits 400 below a 200-tall pane's top, so centring it is
    // 400 - (200 - 20) / 2. The sideways place comes back as it was found: a run
    // of replaces is a run of these, and the reader put it there.
    expect(pane.scrollTo).toHaveBeenCalledWith({ top: 310, left: 64, behavior: 'smooth' })
  })

  it('counts as a reader counts: 1-based, and nothing of nothing when there is no match', () => {
    const { find, view } = threeMatches()
    expect(find.position(view.state)).toEqual({ current: 1, total: 3 })
    const empty = pushedFind(doc(para('b1', 'the other there')), 'b1', [])
    expect(empty.find.position(empty.view.state)).toEqual({ current: 0, total: 0 })
  })

  /** @type {Array<[string, number[], {current: number, total: number}]>} */
  const walks = [
    ['forward', [1], { current: 2, total: 3 }],
    ['forward to the end', [1, 1], { current: 3, total: 3 }],
    ['forward past the end wraps to the first', [1, 1, 1], { current: 1, total: 3 }],
    ['backward from the first wraps to the last', [-1], { current: 3, total: 3 }],
    ['backward and forward again returns where it started', [-1, 1], { current: 1, total: 3 }],
  ]

  for (const [name, steps, want] of walks) {
    it('walking ' + name, () => {
      const { find, view } = threeMatches()
      let at = { current: 0, total: 0 }
      for (const delta of steps) at = find.step(view, delta)
      expect(at).toEqual(want)
      expect(find.position(view.state)).toEqual(want)
    })
  }

  it('hands back the WHOLE current mark, with the block it belongs to on it', () => {
    const { find, view } = threeMatches()
    find.step(view, 1)
    expect(find.current(view.state)).toEqual(Object.assign({ blockId: 'b1' }, hit('the', 1)))
    expect(find.current({ doc: view.state.doc })).toBeNull()
  })

  it('keeps where the reader stood across a fresh push of the same matches', () => {
    const { find, view } = threeMatches()
    find.step(view, 1)
    find.apply(view, 'b1', [hit('the', 0), hit('the', 1), hit('the', 2)])
    expect(find.position(view.state)).toEqual({ current: 2, total: 3 })
  })

  it('lands the reader inside a set that shrank under them', () => {
    const { find, view } = threeMatches()
    find.step(view, 1)
    find.step(view, 1)
    find.apply(view, 'b1', [hit('the', 0)])
    expect(find.position(view.state)).toEqual({ current: 1, total: 1 })
    expect(find.current(view.state)).toEqual(Object.assign({ blockId: 'b1' }, hit('the', 0)))
  })

  it('stands on nothing, and steps to nothing, once the marks are cleared', () => {
    const { find, view } = threeMatches()
    find.apply(view, 'b1', [])
    expect(find.step(view, 1)).toEqual({ current: 0, total: 0 })
    expect(find.current(view.state)).toBeNull()
  })
})
