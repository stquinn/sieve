// @ts-check
// The editor's text node, and the markdown a run of prose text is stored as.
//
// The stored markdown reads back as the same text. Markdown syntax characters
// are backslash-escaped where they would take effect; `<` and `&` only where
// the parser (html enabled) would read a tag, comment, autolink or entity;
// every other `<`, `>` and `&` is written as itself. "Line start" is the start
// of a block or of a line after a hard break, because a list, heading or
// blockquote marker there interrupts the paragraph; a no-break space there is
// written `&#160;`, which the parser would otherwise trim.

import { T } from './tiptap-vendor.js'

export class ProseText {
  /** Writes one text node as markdown.
   *  @param {any} state a prosemirror-markdown serializer state
   *  @param {any} node */
  static serialize(state, node) {
    const lineStart = state.atBlockStart || /\n$/.test(state.out)
    let md = ProseText.escape(node.text, lineStart)
    if (lineStart) md = md.replace(/^ +/, (run) => '&#160;'.repeat(run.length))
    state.text(md, false)
  }

  /** `text` as inline markdown that reads back as `text`.
   *  @param {string} text
   *  @param {boolean} lineStart whether `text` begins a line
   *  @returns {string} */
  static escape(text, lineStart) {
    let md = text
      .replace(/[`*\\~[\]_]/g, (ch, i) => (ch === '_' && ProseText.#alnum(text[i - 1]) && ProseText.#alnum(text[i + 1]) ? ch : '\\' + ch))
      .replace(/<(?=[A-Za-z/!?])/g, '\\<')
      .replace(/&(?=#?\w+;)/g, '\\&')
    if (lineStart) {
      md = md.replace(/^([ \t]*)(\+(?=[ \t]|$)|[-*>])/, '$1\\$2')
        .replace(/^([ \t]*)(#{1,6})(?=\s|$)/, '$1\\$2')
        .replace(/^([ \t]*\d+)([.)])(?=\s|$)/, '$1\\$2')
    }
    return md
  }

  /** @param {string|undefined} ch @returns {boolean} */
  static #alnum(ch) {
    return !!ch && /[A-Za-z0-9]/.test(ch)
  }

  /** The shipping text node: StarterKit's, with this markdown serializer.
   *  @returns {any} */
  static node() {
    return T.Node.create({
      name: 'text',
      group: 'inline',
      addStorage() {
        return { markdown: { serialize: ProseText.serialize } }
      },
    })
  }
}
