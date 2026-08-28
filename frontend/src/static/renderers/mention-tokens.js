// @ts-check
// MentionTokens — THE rule for what counts as an `@Title` mention token, and
// the marking of those tokens inside prose that has already been rendered. The
// composer (deciding what a token IS) and the ai-block (deciding what to MARK)
// both call it, so a chip and its inline mention always describe the same text.
//
// THE DATA IS THE MATCHER, NEVER A REGEX. `@\w+` would mark an email address, a
// code sample and a stray `@` in prose. A block carries the list of documents it
// actually attached, so only THOSE titles are matched, and every occurrence of
// one is a mention (duplicate titles are legal — two notes may both be "Notes").
//
// TITLES ARE USER-AUTHORED TEXT. This module never concatenates a title into an
// HTML string: it splits existing TEXT NODES and puts the matched characters
// back through `textContent`, so an HTML-shaped title can only ever render as
// inert text. There is no innerHTML here on purpose — do not add one.

export class MentionTokens {
  /**
   * Tags whose text FLOWS with the text around it. Everything else is treated
   * as a block: its text starts a new line, so a token opening it is at a
   * boundary.
   * @type {ReadonlySet<string>}
   */
  static #INLINE = Object.freeze(new Set([
    'A', 'ABBR', 'B', 'BDI', 'BDO', 'CITE', 'CODE', 'DEL', 'EM', 'I', 'INS', 'KBD',
    'MARK', 'Q', 'S', 'SAMP', 'SMALL', 'SPAN', 'STRONG', 'SUB', 'SUP', 'TIME', 'U', 'VAR',
  ]))

  /**
   * Tags whose text is a LITERAL the user quoted, not prose — `@Auth Design`
   * inside one is a code sample being talked about, so it is never marked.
   * @type {ReadonlySet<string>}
   */
  static #OPAQUE = Object.freeze(new Set(['CODE', 'PRE', 'KBD', 'SAMP', 'VAR']))

  /**
   * Every place `@title` appears in `text` AS A TOKEN — at the start of the line
   * or after whitespace, so "mail me@Auth Design" is an address and not a
   * mention. The same boundary predicate the `@` trigger provider accepts on.
   * @param {string} text
   * @param {string} [title]
   * @param {string} [before] the character preceding `text` ('' = start of line)
   * @returns {Array<{start: number, end: number}>} in text order
   */
  static spans(text, title, before) {
    /** @type {Array<{start: number, end: number}>} */ const spans = []
    const needle = '@' + String(title || '')
    if (needle.length < 2) return spans
    const haystack = String(text || '')
    const lead = String(before || '')
    let idx = haystack.indexOf(needle)
    while (idx !== -1) {
      const prev = idx > 0 ? haystack.charAt(idx - 1) : lead
      if (prev === '' || /\s/.test(prev)) spans.push({ start: idx, end: idx + needle.length })
      idx = haystack.indexOf(needle, idx + needle.length)
    }
    return spans
  }

  /**
   * Marks every token of every title in `el`'s rendered prose by wrapping it in
   * a `<span class="…">`. Operates on the RENDERED DOM rather than the markdown
   * source, so the markdown rendering that produced it is left exactly as it is.
   * @param {Element|null} el the already-rendered prose
   * @param {Array<string|undefined>} titles the attached documents' titles
   * @param {string} className the mark's class (the kind owns its look)
   * @returns {number} how many tokens were marked
   */
  static mark(el, titles, className) {
    const wanted = Array.from(new Set((titles || []).map((t) => String(t || '').trim()).filter(Boolean)))
    if (!el || wanted.length === 0) return 0
    let marked = 0
    for (const { node, before } of MentionTokens.#textNodes(el)) {
      const spans = MentionTokens.claim(node.data, wanted, before)
      if (spans.length === 0) continue
      MentionTokens.#wrap(node, spans, className)
      marked += spans.length
    }
    return marked
  }

  /**
   * The text nodes of `el` in document order, each with the character that
   * precedes it in the rendered flow ('' when it opens a line). Collected up
   * front because marking replaces nodes as it goes.
   * @param {Element} el
   * @returns {Array<{node: Text, before: string}>}
   */
  static #textNodes(el) {
    /** @type {Array<{node: Text, before: string}>} */ const found = []
    let before = ''
    /** @param {Node} parent */
    const visit = (parent) => {
      for (const child of Array.from(parent.childNodes)) {
        if (child.nodeType === 3) {
          const text = /** @type {Text} */ (child)
          found.push({ node: text, before: before })
          if (text.data) before = text.data.charAt(text.data.length - 1)
          continue
        }
        if (child.nodeType !== 1) continue
        const tag = /** @type {Element} */ (child).tagName
        if (tag === 'BR') { before = ''; continue }
        const inline = MentionTokens.#INLINE.has(tag)
        if (MentionTokens.#OPAQUE.has(tag)) {
          // Never descended into — but its text still SEPARATES what follows.
          const literal = child.textContent || ''
          before = inline && literal ? literal.charAt(literal.length - 1) : ''
          continue
        }
        if (!inline) before = ''
        visit(child)
        if (!inline) before = ''
      }
    }
    visit(el)
    return found
  }

  /**
   * The non-overlapping spans one run of text yields for all the titles, in text
   * order. Where two attached titles overlap ("Auth" and "Auth Design" against
   * `@Auth Design`) the LONGER one wins: it is the more specific attachment, and
   * marking half a token would read as a typo.
   *
   * The multi-title half of the rule, for a caller that has its own way of
   * reaching the marked characters — `mark` puts them in the rendered DOM, a
   * ProseMirror decoration puts them at document positions.
   * @param {string} text
   * @param {ReadonlyArray<string>} titles
   * @param {string} [before] the character preceding `text` ('' = start of line)
   * @returns {Array<{start: number, end: number}>}
   */
  static claim(text, titles, before) {
    /** @type {Array<{start: number, end: number}>} */ const all = []
    for (const title of titles || []) {
      for (const span of MentionTokens.spans(text, title, before)) all.push(span)
    }
    all.sort((a, b) => a.start - b.start || b.end - a.end)
    /** @type {Array<{start: number, end: number}>} */ const kept = []
    let end = 0
    for (const span of all) {
      if (span.start < end) continue
      kept.push(span)
      end = span.end
    }
    return kept
  }

  /**
   * Replaces one text node with [text · mark · text · …]. The marked characters
   * are set with `textContent` — the SEC-B invariant this module exists to hold.
   * @param {Text} node @param {Array<{start: number, end: number}>} spans @param {string} className
   */
  static #wrap(node, spans, className) {
    const data = node.data
    const frag = document.createDocumentFragment()
    let cursor = 0
    for (const span of spans) {
      if (span.start > cursor) frag.appendChild(document.createTextNode(data.slice(cursor, span.start)))
      const mark = document.createElement('span')
      mark.className = className
      mark.textContent = data.slice(span.start, span.end)   // TEXT, never markup
      frag.appendChild(mark)
      cursor = span.end
    }
    if (cursor < data.length) frag.appendChild(document.createTextNode(data.slice(cursor)))
    if (node.parentNode) node.parentNode.replaceChild(frag, node)
  }
}
