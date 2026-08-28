// @ts-check
// mention-tokens.test.js — MentionTokens: the ONE rule for what counts as an
// `@Title` mention token (#74), and the marking of those tokens inside already-
// rendered prose.
//
// The rule is DATA-DRIVEN, never a `@\w+` regex: only the titles a block
// actually attached are marked, so an email address, a code sample or a stray
// `@` in prose stays prose.
import { describe, it, expect, afterEach } from 'vitest'
import { MentionTokens } from '../src/static/renderers/mention-tokens.js'

/** @param {string} html */
function el(html) {
  const div = document.createElement('div')
  div.innerHTML = html
  document.body.appendChild(div)
  return div
}

/** @param {Element} root */
function marks(root) {
  return Array.from(root.querySelectorAll('.mention')).map((m) => m.textContent)
}

afterEach(() => { document.body.innerHTML = '' })

describe('MentionTokens.spans — the token rule', () => {
  it('accepts a token at the start of the text and after whitespace', () => {
    expect(MentionTokens.spans('@Auth Design is it', 'Auth Design')).toEqual([{ start: 0, end: 12 }])
    expect(MentionTokens.spans('see @Auth Design now', 'Auth Design')).toEqual([{ start: 4, end: 16 }])
    expect(MentionTokens.spans('see\n@Auth Design', 'Auth Design')).toEqual([{ start: 4, end: 16 }])
  })

  it('rejects a title glued to a preceding character — that is an address, not a mention', () => {
    expect(MentionTokens.spans('mail me@Auth Design', 'Auth Design')).toEqual([])
    expect(MentionTokens.spans('stephen@example.com', 'example.com')).toEqual([])
  })

  it('finds every occurrence, in text order', () => {
    expect(MentionTokens.spans('@Notes and @Notes', 'Notes')).toEqual([
      { start: 0, end: 6 }, { start: 11, end: 17 },
    ])
  })

  it('an empty title is not a token (a bare @ never matches)', () => {
    expect(MentionTokens.spans('@ nothing', '')).toEqual([])
    expect(MentionTokens.spans('@ nothing', undefined)).toEqual([])
  })

  it('takes the preceding character from the caller when the text does not start the line', () => {
    expect(MentionTokens.spans('@Notes', 'Notes', 'd')).toEqual([])
    expect(MentionTokens.spans('@Notes', 'Notes', ' ')).toEqual([{ start: 0, end: 6 }])
  })
})

// The multi-title half of the rule, shared with the ProseMirror decoration that
// marks the same tokens inside a draft. `mark` reaches the characters through
// the rendered DOM and the decoration through document positions — the answer to
// "which characters" must be the same one, or a chip and its inline mark would
// describe different text.
describe('MentionTokens.claim — the spans one run of text yields for a SET of titles', () => {
  it('returns every title\'s tokens, in text order', () => {
    expect(MentionTokens.claim('@Retry RFC then @Notes', ['Notes', 'Retry RFC'])).toEqual([
      { start: 0, end: 10 }, { start: 16, end: 22 },
    ])
  })

  it('the LONGER title wins where two overlap — marking half a token reads as a typo', () => {
    expect(MentionTokens.claim('@Auth Design here', ['Auth', 'Auth Design']))
      .toEqual([{ start: 0, end: 12 }])
  })

  it('honours the preceding character, so an address is not claimed', () => {
    expect(MentionTokens.claim('@Notes', ['Notes'], 'd')).toEqual([])
    expect(MentionTokens.claim('@Notes', ['Notes'], ' ')).toEqual([{ start: 0, end: 6 }])
  })

  it('no titles, no spans — the answer for anything holding no manifest', () => {
    expect(MentionTokens.claim('@Notes everywhere', [])).toEqual([])
    expect(MentionTokens.claim('@Notes everywhere', /** @type {any} */ (null))).toEqual([])
  })
})

describe('MentionTokens.mark — marking rendered prose', () => {
  it('wraps each token in a span carrying the caller\'s class, leaving the prose intact', () => {
    const root = el('<p>How does @Auth Design handle retries?</p>')
    expect(MentionTokens.mark(root, ['Auth Design'], 'mention')).toBe(1)
    expect(marks(root)).toEqual(['@Auth Design'])
    expect(root.textContent).toBe('How does @Auth Design handle retries?')
  })

  it('marks EVERY occurrence of an attached title, duplicates included', () => {
    const root = el('<p>@Notes versus @Notes</p>')
    expect(MentionTokens.mark(root, ['Notes', 'Notes'], 'mention')).toBe(2)
    expect(marks(root)).toEqual(['@Notes', '@Notes'])
  })

  it('marks nothing that is not an attached title — an address, an unattached name, a bare @', () => {
    const root = el('<p>Mail stephen@example.com, ask @Retry RFC, mind the @ sign</p>')
    expect(MentionTokens.mark(root, ['Auth Design'], 'mention')).toBe(0)
    expect(marks(root)).toEqual([])
  })

  it('leaves a token inside a code span alone — that is a quoted literal, not a mention', () => {
    const root = el('<p>type <code>@Auth Design</code> then say @Auth Design</p>')
    expect(MentionTokens.mark(root, ['Auth Design'], 'mention')).toBe(1)
    expect(marks(root)).toEqual(['@Auth Design'])
    expect(root.querySelector('code')?.querySelector('.mention')).toBeNull()
  })

  it('an inline element before the token still separates it — the character before is what counts', () => {
    const root = el('<p><strong>bold</strong>@Auth Design and <strong>bold</strong> @Auth Design</p>')
    expect(MentionTokens.mark(root, ['Auth Design'], 'mention')).toBe(1)
  })

  it('a new block starts a new line, so a token opening one is at a boundary', () => {
    const root = el('<p>compare these</p><p>@Auth Design wins</p>')
    expect(MentionTokens.mark(root, ['Auth Design'], 'mention')).toBe(1)
    expect(marks(root)).toEqual(['@Auth Design'])
  })

  it('the longest attached title wins where two titles overlap', () => {
    const root = el('<p>see @Auth Design here</p>')
    expect(MentionTokens.mark(root, ['Auth', 'Auth Design'], 'mention')).toBe(1)
    expect(marks(root)).toEqual(['@Auth Design'])
  })

  it('a title is TEXT, never markup — an HTML-shaped title renders inert (SEC-B #48)', () => {
    const evil = '<img src=x onerror="alert(1)">'
    const root = document.createElement('div')
    // textContent, so the element holds the literal characters — exactly what a
    // sanctioned-markdown render of the same question produces.
    root.textContent = 'see @' + evil + ' please'
    document.body.appendChild(root)

    expect(MentionTokens.mark(root, [evil], 'mention')).toBe(1)
    expect(root.querySelector('img')).toBeNull()
    expect(document.querySelectorAll('img').length).toBe(0)
    expect(marks(root)).toEqual(['@' + evil])
    expect(root.textContent).toBe('see @' + evil + ' please')
  })

  it('no titles, no work — the DOM is left byte-identical', () => {
    const root = el('<p>see @Auth Design</p>')
    const before = root.innerHTML
    expect(MentionTokens.mark(root, [], 'mention')).toBe(0)
    expect(MentionTokens.mark(root, ['', '   '], 'mention')).toBe(0)
    expect(root.innerHTML).toBe(before)
  })
})
