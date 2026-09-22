// @ts-check
// emoji-picker.test.js — the `:` trigger (#157): the curated catalog's matching,
// and the provider traits that make it a GRID with a floor on how much must be
// typed. The popover's grid drawing and 2-D arrow model are pinned where the
// popover is, in trigger-popover.test.js; the scanner's minPrefixLength rule is
// pinned where the scan is, in trigger-host.test.js.
import { describe, it, expect } from 'vitest'
import { Emoji, EmojiCatalog } from '../src/static/shell/emoji-catalog.js'
import { EmojiProvider, TriggerProvider } from '../src/static/shell/trigger-providers.js'
import { ContractViolation } from '../src/static/contract/sieve-block.js'

/** A tiny table, so a ranking assertion is about ranking and not about whichever
 *  entries the real one happens to carry. */
const TABLE = /** @type {import('../src/static/shell/emoji-catalog.js').EmojiSpec[]} */ ([
  ['😀', 'grinning', 'happy', 'd'],
  ['🐶', 'dog', 'puppy'],
  ['🎉', 'party popper', 'tada'],
  ['🙂', 'slight smile', ')'],
])

describe('EmojiCatalog — the curated table', () => {
  it('matches a name prefix', () => {
    expect(new EmojiCatalog(TABLE).search('grin').map((e) => e.glyph)).toEqual(['😀'])
  })

  it('matches a keyword as readily as a name', () => {
    expect(new EmojiCatalog(TABLE).search('tada').map((e) => e.glyph)).toEqual(['🎉'])
  })

  it('is case-insensitive in both directions', () => {
    expect(new EmojiCatalog(TABLE).search('DOG').map((e) => e.glyph)).toEqual(['🐶'])
  })

  // THE OLD-SCHOOL SEQUENCES, which is how the issue's original ask survives
  // inside the picker: `:D` is the trigger and the prefix `d`.
  it('puts an EXACT term ahead of a mere prefix — `:D` selects the grin, not the dog', () => {
    expect(new EmojiCatalog(TABLE).search('d').map((e) => e.glyph)).toEqual(['😀', '🐶'])
  })

  it('answers the ASCII smiley `)` as a keyword', () => {
    expect(new EmojiCatalog(TABLE).search(')').map((e) => e.glyph)).toEqual(['🙂'])
  })

  it('answers a blank prefix with nothing — a bare colon is punctuation', () => {
    expect(new EmojiCatalog(TABLE).search('')).toEqual([])
  })

  it('answers an unknown prefix with nothing', () => {
    expect(new EmojiCatalog(TABLE).search('zzzz')).toEqual([])
  })

  it('answers synchronously — the table is local', () => {
    expect(Array.isArray(new EmojiCatalog(TABLE).search('d'))).toBe(true)
  })

  it('refuses an entry with no glyph or no name', () => {
    expect(() => new Emoji(/** @type {any} */ (['', 'nameless']))).toThrow(ContractViolation)
    expect(() => new Emoji(/** @type {any} */ (['😀']))).toThrow(ContractViolation)
  })

  describe('the shipped table', () => {
    const catalog = new EmojiCatalog()

    it('carries enough entries to be worth a picker', () => {
      expect(catalog.all.length).toBeGreaterThan(150)
    })

    it('stores LITERAL UNICODE CHARACTERS, not codepoints or markup', () => {
      for (const emoji of catalog.all) {
        expect(emoji.glyph).not.toMatch(/[<&\\]|U\+/)
        expect(emoji.glyph.length).toBeLessThan(12)
      }
    })

    it('mints one glyph per entry', () => {
      expect(new Set(catalog.all.map((e) => e.glyph)).size).toBe(catalog.all.length)
    })

    it('answers the sequences the issue opened with', () => {
      for (const prefix of [')', 'd', '(', 'p']) {
        expect(catalog.search(prefix).length).toBeGreaterThan(0)
      }
    })
  })
})

describe('EmojiProvider — a fourth trigger', () => {
  const provider = () => new EmojiProvider(new EmojiCatalog(TABLE))

  it('claims `:`', () => {
    expect(provider().trigger).toBe(':')
  })

  it('declares a GRID with a caption, and says how wide', () => {
    const layout = provider().layout
    expect(layout.isGrid).toBe(true)
    expect(layout.columns).toBe(9)
    expect(layout.rows).toBe(8)
    expect(layout.hasCaption).toBe(true)
  })

  it('requires a character past the colon before it opens at all', () => {
    expect(provider().minPrefixLength).toBe(1)
  })

  it('keeps the DEFAULT boundary, so a colon inside a word is punctuation', () => {
    const p = provider()
    expect(p.acceptsBoundary('', 0)).toBe(true)
    expect(p.acceptsBoundary(' ', 5)).toBe(true)
    expect(p.acceptsBoundary('e', 4)).toBe(false)   // "Note: this"
    expect(p.acceptsBoundary('0', 2)).toBe(false)   // "10:30"
  })

  it('captions the selected candidate with its name', () => {
    expect(provider().caption(new Emoji(TABLE[2]))).toBe('party popper')
  })

  it('renders the glyph itself, labelled for a screen reader', () => {
    const cell = /** @type {HTMLElement} */ (/** @type {any} */ (provider().render(new Emoji(TABLE[0]))).firstChild)
    expect(cell.textContent).toBe('😀')
    expect(cell.getAttribute('aria-label')).toBe('grinning')
  })

  // AN EMOJI IS A CHARACTER IN PROSE: accepting one is the shared text
  // completion and nothing else — no block, no attrs, no round trip.
  it('accepts by replacing the token with the glyph', () => {
    /** @type {any[]} */ const writes = []
    const host = /** @type {any} */ ({
      textAfter: () => '',
      replaceRange: (/** @type {number} */ s, /** @type {number} */ e, /** @type {string} */ t) => writes.push([s, e, t]),
    })
    const p = provider()

    p.accept(new EmojiCatalog(TABLE).search('grin')[0], /** @type {any} */ ({ provider: p, start: 4, end: 9, prefix: 'grin' }), host)

    expect(writes).toEqual([[4, 9, '😀 ']])
  })

  it('brings its own catalog when none is injected', () => {
    expect(new EmojiProvider().search('rocket').length).toBeGreaterThan(0)
  })
})

// THE TRAITS ARE THE FRAMEWORK'S, not the emoji picker's: every provider answers
// them, and a provider gains a grid by declaring one.
describe('TriggerProvider — the layout and prefix-floor traits', () => {
  class Bare extends TriggerProvider {
    get trigger() { return '#' }
  }

  it('defaults to a one-column list with no caption', () => {
    const layout = new Bare().layout
    expect(layout.isGrid).toBe(false)
    expect(layout.columns).toBe(1)
    expect(layout.hasCaption).toBe(false)
  })

  it('defaults to no prefix floor — the bare trigger opens the picker', () => {
    expect(new Bare().minPrefixLength).toBe(0)
  })

  it('captions from whichever name a candidate already carries', () => {
    const p = new Bare()
    expect(p.caption({ name: 'fence' })).toBe('fence')
    expect(p.caption({ label: 'Table' })).toBe('Table')
    expect(p.caption({ title: 'Sprite Sheet' })).toBe('Sprite Sheet')
    expect(p.caption(null)).toBe('')
  })
})
