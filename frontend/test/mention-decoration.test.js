// @ts-check
// mention-decoration.test.js — the `@Title` mark inside a draft (#118 item 5).
//
// The walk is exercised against REAL ProseMirror documents, because the whole
// reason it walks inline children rather than a block's flat `textContent` is a
// document fact: a hard break costs a position and contributes no character, so
// a flat-string range lands early after every Alt+Enter. A fake node could not
// show that.
//
// THE INERT CASE IS A FIRST-CLASS TEST. A note editor keeps no attachment
// manifest, so it never publishes a title, so it decorates nothing — and that
// must hold without any mount-shaped gate anywhere in the walk.

import { describe, it, expect } from 'vitest'
import { Schema } from '@tiptap/pm/model'
import { MentionRanges } from '../src/static/lens/document-editor/surfaces/mention-ranges.js'
import { MentionDecorations, MENTION_CLASS } from '../src/static/lens/document-editor/surfaces/mention-decoration.js'

// A draft's own vocabulary: paragraphs, the hard break Alt+Enter inserts, a code
// block and the inline `code` mark — the two ways text in a message is a literal
// somebody quoted rather than prose.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    codeBlock: { group: 'block', content: 'text*', code: true, toDOM: () => ['pre', ['code', 0]] },
    hardBreak: { group: 'inline', inline: true, selectable: false, toDOM: () => ['br'] },
    text: { group: 'inline' },
  },
  marks: {
    code: { toDOM: () => ['code', 0] },
    em: { toDOM: () => ['em', 0] },
  },
})

const n = schema.nodes
const m = schema.marks
/** @param {string} s @param {any[]} [marks] */
const t = (s, marks) => schema.text(s, marks)
/** @param {...any} content */
const p = (...content) => n.paragraph.create(null, content)
/** @param {...any} blocks */
const doc = (...blocks) => n.doc.create(null, blocks)

/** The text `[from, to)` names, so a range assertion reads as what got marked.
 *  @param {any} d @param {Array<{from: number, to: number}>} ranges */
const marked = (d, ranges) => ranges.map((r) => d.textBetween(r.from, r.to))

describe('MentionRanges.of — where the @Title tokens are', () => {
  it('marks a token in the middle of a paragraph, at the document positions it occupies', () => {
    const d = doc(p(t('see @Auth Design now')))
    const ranges = MentionRanges.of(d, ['Auth Design'])
    expect(ranges).toEqual([{ from: 5, to: 17 }])
    expect(marked(d, ranges)).toEqual(['@Auth Design'])
  })

  it('marks a token opening a paragraph — the start of a block is a boundary', () => {
    const d = doc(p(t('@Auth Design is where')))
    expect(marked(d, MentionRanges.of(d, ['Auth Design']))).toEqual(['@Auth Design'])
  })

  it('AFTER A HARD BREAK the range is still exact — the break costs a position and no character', () => {
    const d = doc(p(t('first line'), n.hardBreak.create(), t('@Auth Design')))
    const ranges = MentionRanges.of(d, ['Auth Design'])
    expect(marked(d, ranges)).toEqual(['@Auth Design'])
    // …and a flat-textContent walk would have landed one early, on the `n@Auth Desig`.
    expect(ranges[0].from).toBe(12)
  })

  it('a break also OPENS a line: a token first on the second line is a token', () => {
    const d = doc(p(t('ask'), n.hardBreak.create(), t('@Auth Design')))
    expect(marked(d, MentionRanges.of(d, ['Auth Design']))).toEqual(['@Auth Design'])
  })

  it('walks every block, in document order', () => {
    const d = doc(p(t('@Retry RFC opens')), p(t('and @Auth Design closes')))
    expect(marked(d, MentionRanges.of(d, ['Auth Design', 'Retry RFC'])))
      .toEqual(['@Retry RFC', '@Auth Design'])
  })

  it('marks EVERY occurrence of a title — a name repeated is a mention repeated', () => {
    const d = doc(p(t('@Notes and @Notes')))
    expect(MentionRanges.of(d, ['Notes']).length).toBe(2)
  })

  it('is not fooled by an address: me@Auth Design is mail, not a mention', () => {
    const d = doc(p(t('mail me@Auth Design about it')))
    expect(MentionRanges.of(d, ['Auth Design'])).toEqual([])
  })

  it('the LONGER title wins where two attachments overlap', () => {
    const d = doc(p(t('@Auth Design here')))
    expect(marked(d, MentionRanges.of(d, ['Auth', 'Auth Design']))).toEqual(['@Auth Design'])
  })

  it('a run carrying the `code` mark is a LITERAL — nothing in it is a mention', () => {
    const d = doc(p(t('see '), t('@Auth Design', [m.code.create()])))
    expect(MentionRanges.of(d, ['Auth Design'])).toEqual([])
  })

  it('a code block is a literal too', () => {
    const d = doc(n.codeBlock.create(null, t('@Auth Design')))
    expect(MentionRanges.of(d, ['Auth Design'])).toEqual([])
  })

  it('an ordinary mark does NOT make text a literal — emphasis is still prose', () => {
    const d = doc(p(t('@Auth Design', [m.em.create()])))
    expect(marked(d, MentionRanges.of(d, ['Auth Design']))).toEqual(['@Auth Design'])
  })

  it('INERT WITHOUT TITLES: the note arrangement publishes none and marks nothing', () => {
    const d = doc(p(t('@Auth Design and @Retry RFC everywhere')))
    expect(MentionRanges.of(d, [])).toEqual([])
    expect(MentionRanges.of(d, /** @type {any} */ (null))).toEqual([])
    expect(MentionRanges.of(d, ['', '   ', undefined])).toEqual([])
  })

  it('a title nobody wrote yields nothing', () => {
    const d = doc(p(t('nothing attached here')))
    expect(MentionRanges.of(d, ['Auth Design'])).toEqual([])
  })
})

// ── The plugin around the walk ───────────────────────────────────────────────
// A recording vendor bag: enough of Plugin/PluginKey/Decoration to run the
// plugin's own `decorations` prop, which is the half that turns ranges into a
// decoration set and the half that must be inert when nothing is attached.

function vendor() {
  const T = {
    Extension: { create: (/** @type {any} */ cfg) => cfg },
    Plugin: function (/** @type {any} */ cfg) { Object.assign(this, cfg) },
    PluginKey: function (/** @type {any} */ name) {
      this.name = name
      /** @type {any} */ this.state = { titles: [] }
      this.getState = () => this.state
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

/** The plugin's `decorations` prop, over a doc and a titles state. */
function decorationsOf(mentions, T, d, titles) {
  const plugin = /** @type {any} */ (mentions.extension).addProseMirrorPlugins()[0]
  plugin.key.state = { titles }
  return plugin.props.decorations({ doc: d })
}

/** What `titleAt` answers at `pos`, over a view whose plugin state holds `titles`. */
function titleAtOf(mentions, d, titles, pos) {
  const plugin = /** @type {any} */ (mentions.extension).addProseMirrorPlugins()[0]
  plugin.key.state = { titles }
  return mentions.titleAt({ state: { doc: d } }, pos)
}

describe('MentionDecorations — the plugin', () => {
  it('turns each range into an INLINE decoration carrying the mark class', () => {
    const { T } = vendor()
    const mentions = new MentionDecorations(T)
    const d = doc(p(t('see @Auth Design now')))
    expect(decorationsOf(mentions, T, d, ['Auth Design']))
      .toEqual([{ from: 5, to: 17, attrs: { class: MENTION_CLASS } }])
  })

  it('DRAWS NOTHING with no titles — the note mount, without a gate to remember', () => {
    const { T } = vendor()
    const mentions = new MentionDecorations(T)
    const d = doc(p(t('see @Auth Design now')))
    expect(decorationsOf(mentions, T, d, [])).toBe('EMPTY')
  })

  it('draws nothing when the titles name text the draft does not hold', () => {
    const { T } = vendor()
    const mentions = new MentionDecorations(T)
    expect(decorationsOf(mentions, T, doc(p(t('nothing here'))), ['Auth Design'])).toBe('EMPTY')
  })

  it('apply() pushes the titles as a META-ONLY transaction — no doc change, no history', () => {
    const { T } = vendor()
    const mentions = new MentionDecorations(T)
    /** @type {any[]} */ const metas = []
    const tr = { setMeta: (/** @type {any} */ k, /** @type {any} */ v) => { metas.push({ k, v }); return tr } }
    /** @type {any[]} */ const dispatched = []
    mentions.apply({ state: { tr }, dispatch: (/** @type {any} */ x) => dispatched.push(x) }, ['Auth Design'])
    expect(metas.length).toBe(1)
    expect(metas[0].v).toEqual({ titles: ['Auth Design'] })
    expect(dispatched).toEqual([tr])
  })

  it('TWO SURFACES DO NOT SHARE STATE: each instance owns its own plugin key', () => {
    const { T } = vendor()
    const a = new MentionDecorations(T)
    const b = new MentionDecorations(T)
    const keyOf = (/** @type {any} */ m) => /** @type {any} */ (m.extension).addProseMirrorPlugins()[0].key
    expect(keyOf(a)).not.toBe(keyOf(b))
  })

  // titleAt is the READ half: a menu raised over a token asks what it names, and
  // the answer comes from the titles the marks are drawn from — so what can be
  // acted on is exactly what is marked, and nothing else has to agree.
  describe('titleAt — what the token under a position names', () => {
    const d = doc(p(t('see @Auth Design now')))   // token occupies [5, 17)

    it('names the title anywhere inside the token, and at both its edges', () => {
      const { T } = vendor()
      const mentions = new MentionDecorations(T)
      for (const pos of [5, 9, 17]) {
        expect(titleAtOf(mentions, d, ['Auth Design'], pos)).toBe('Auth Design')
      }
    })

    it('answers null outside it', () => {
      const { T } = vendor()
      const mentions = new MentionDecorations(T)
      expect(titleAtOf(mentions, d, ['Auth Design'], 2)).toBeNull()
      expect(titleAtOf(mentions, d, ['Auth Design'], 19)).toBeNull()
    })

    it('answers null everywhere with nothing attached — the note mount, again', () => {
      const { T } = vendor()
      const mentions = new MentionDecorations(T)
      expect(titleAtOf(mentions, d, [], 9)).toBeNull()
    })

    it('names the LONGER of two overlapping attachments, as the mark draws it', () => {
      const { T } = vendor()
      const mentions = new MentionDecorations(T)
      expect(titleAtOf(mentions, d, ['Auth', 'Auth Design'], 9)).toBe('Auth Design')
    })
  })

  it('a transaction carrying no titles meta LEAVES the state standing', () => {
    const { T } = vendor()
    const plugin = /** @type {any} */ (new MentionDecorations(T).extension).addProseMirrorPlugins()[0]
    const prev = { titles: ['Auth Design'] }
    expect(plugin.state.init()).toEqual({ titles: [] })
    expect(plugin.state.apply({ getMeta: () => undefined }, prev)).toBe(prev)
    expect(plugin.state.apply({ getMeta: () => ({ titles: ['Retry RFC'] }) }, prev))
      .toEqual({ titles: ['Retry RFC'] })
  })
})
