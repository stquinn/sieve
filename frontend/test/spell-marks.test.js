// @ts-check
// spell-marks.test.js — the layers of placing a text mark and acting on one: the
// pure anchor resolution (QuoteAnchor), the document walk that resolves anchors
// against a real document (SpellDecorations.hits), the plugin built on that walk
// (its `apply()` dispatch and its per-block REPLACE/CLEAR state, exercised the
// way mention-decoration.test.js exercises MentionDecorations: a small fake
// vendor bag standing in for Plugin/PluginKey/Decoration/DecorationSet), the
// read back out of it — which marks a coordinate sits on — and the verb a reader
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
import { QuoteAnchor } from '../src/static/renderers/quote-anchor.js'
import { SpellDecorations, SPELL_MARK_CLASS } from '../src/static/lens/document-editor/surfaces/spell-decoration.js'
import { AbstractEditor } from '../src/static/lens/abstract-editor.js'
import { AbstractSurface } from '../src/static/lens/document-editor/surfaces/abstract-surface.js'
import { EditorMode } from '../src/static/lens/document-editor/editor-mode.js'

// The last layer — the lens verb that asks for a correction — pulls in
// AbstractEditor, and with it the four owner modules that run vendor calls at
// IMPORT time and would crash against the bare test/setup.js TipTap seed.
// Nothing here mounts a real surface, so inert mocks satisfy the imports (the
// lens-capabilities.test.js pattern).
vi.mock('../src/static/lens/extensions.js', () => ({
  Search: {}, SelectionHighlight: {}, HighlightMark: {},
  AiShortcuts: { configure: () => ({}) },
  buildAiContext: vi.fn(), applyTargetHighlight: vi.fn(),
}))
vi.mock('../src/static/lens/document-editor/block-chrome.js', () => ({
  BlockChrome: {}, getBlockSelectionRange: vi.fn(),
}))
vi.mock('../src/static/lens/document-editor/surfaces/ai-target-decoration.js', () => ({ AiTargetDecoration: {} }))
vi.mock('../src/static/lens/document-editor/surfaces/prose-block.js', () => ({ BlockId: {} }))

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
  const mark = (quote, occurrence) => ({ quote: quote, occurrence: occurrence || 0 })

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
    expect(QuoteAnchor.spansFor('teh cat', [{ occurrence: 0 }])).toEqual([])
  })

  it('resolves the apostrophe form the anchor was minted as', () => {
    expect(placed("it isn't so", [mark("isn't")])).toEqual(["isn't"])
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
const mark = (quote, occurrence) => ({ quote: quote, occurrence: occurrence || 0, locator: 'content', class: 'prose' })
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

function vendor() {
  const T = {
    Extension: { create: (/** @type {any} */ cfg) => cfg },
    Plugin: function (/** @type {any} */ cfg) { Object.assign(this, cfg) },
    // A real PluginKey reads its plugin's own state out of the editor state; this
    // one reads the slot a test puts it in, which is the same relationship.
    PluginKey: function (/** @type {any} */ name) {
      this.name = name
      this.getState = (/** @type {any} */ state) => state && state.spell
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
    expect(plugin.state.init()).toEqual({ marks: new Map(), hits: [], decos: 'EMPTY' })
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
// The read half: the same held marks, asked about a coordinate instead of drawn.
// `teh` occupies [3, 6) of `a teh word`, so 3..6 is inside the word (its trailing
// edge included) and 2 and 7 are the characters either side of it.

describe('SpellDecorations#marksAt — the marks a coordinate sits on', () => {
  /** One surface that has been pushed `marks` for `blockId`, and the editor state
   *  its plugin then holds — built by the plugin's own `apply`, so what `marksAt`
   *  reads is what the surface really resolved.
   *  @param {any} d @param {string} blockId @param {Array<any>} marks */
  const pushedInto = (d, blockId, marks) => {
    const { T } = vendor()
    const spell = new SpellDecorations(T)
    const init = /** @type {any} */ (spell.extension).addProseMirrorPlugins()[0].state.init()
    return { spell: spell, state: { doc: d, spell: pushed(spell, init, d, blockId, marks) } }
  }

  const oneMarkedWord = () => pushedInto(doc(para('b1', 'a teh word')), 'b1', [mark('teh')])

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

  for (const [name, from, to, quotes] of cases) {
    it(name, () => {
      const { spell, state } = oneMarkedWord()
      expect(spell.marksAt(state, from, to).map((m) => m.quote)).toEqual(quotes)
    })
  }

  it('hands back the WHOLE mark, with the block it belongs to on it', () => {
    const { spell, state } = oneMarkedWord()
    expect(spell.marksAt(state, 4, 4)).toEqual([
      { blockId: 'b1', quote: 'teh', occurrence: 0, locator: 'content', class: 'prose' },
    ])
  })

  it('answers only the mark under the coordinate, not the block\'s others', () => {
    const { spell, state } = pushedInto(doc(para('b1', 'teh cat adn dog')), 'b1', [mark('teh'), mark('adn')])
    expect(spell.marksAt(state, 2, 2).map((m) => m.quote)).toEqual(['teh'])
    expect(spell.marksAt(state, 10, 10).map((m) => m.quote)).toEqual(['adn'])
  })

  it('answers nothing where nothing has been pushed, and without a state at all', () => {
    const { spell, state } = pushedInto(doc(para('b1', 'a teh word')), 'b1', [])
    expect(spell.marksAt(state, 4, 4)).toEqual([])
    expect(spell.marksAt({ doc: state.doc }, 4, 4)).toEqual([])
    expect(spell.marksAt(null, 4, 4)).toEqual([])
  })

  it('answers nothing for a mark the block no longer bears, though it is still held', () => {
    const { spell, state } = pushedInto(doc(para('b1', 'a the word')), 'b1', [mark('teh')])
    expect(state.spell.marks.get('b1')).toEqual([mark('teh')])
    expect(spell.marksAt(state, 4, 4)).toEqual([])
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

  const aMark = { blockId: 'b1', quote: 'helllo', occurrence: 0, start: 2, end: 8 }

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
