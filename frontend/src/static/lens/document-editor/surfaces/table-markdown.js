// @ts-check
// How a `table` node is written to markdown, and the shipping table node that
// carries it.
//
// THE FILE FORM IS CHOSEN BY THE CONTENT. A table whose every cell is exactly one
// paragraph, under a header row, with no merged cells, is a GFM pipe table — the
// form markdown readers expect. Any other table is written as an HTML skeleton
// whose cell CONTENT is still markdown,
// separated from its tags by blank lines:
//
//     <table>
//     <tr><td>
//
//     ```json
//     {"id": 1}
//     ```
//
//     </td></tr>
//     </table>
//
// The blank lines are load-bearing: they are what returns a CommonMark parser to
// markdown inside an HTML block, so a fence in a cell stays a real fence in the
// file and reads as code to a human and to GitHub.
//
// A pipe row can hold nothing but inline text, so anything block-level in a cell —
// a fence, a list, a heading, a blockquote, a second paragraph — decides the form
// for the whole table.

import { T } from './tiptap-vendor.js'

/** The span attributes, in the order they are written. @type {readonly string[]} */
const SPANS = Object.freeze(['colspan', 'rowspan'])

export class TableMarkdown {
  /** @type {any} the `table` node being written */ #node

  /** @param {any} node a `table` node */
  constructor(node) { this.#node = node }

  /** The shipping `table` node: TipTap's table with this serialiser in place of
   *  tiptap-markdown's. `getMarkdownSpec` merges `{...builtIn, ...storage.markdown}`,
   *  so a node's own `serialize` wins.
   *  @param {object} [options] passed to the table extension's `configure`
   *  @returns {any} */
  static node(options) {
    return T.Table.extend({
      addStorage() {
        const parent = (this.parent && this.parent()) || {}
        return {
          ...parent,
          markdown: {
            /** @param {any} state @param {any} node */
            serialize(state, node) { new TableMarkdown(node).writeTo(state) },
          },
        }
      },
    }).configure(options)
  }

  /** Whether this table is writable as a GFM pipe table: a header row, every cell
   *  exactly one paragraph, and no merged cells.
   *  @returns {boolean} */
  get isSimple() {
    let simple = true
    this.#node.forEach((/** @type {any} */ row, /** @type {number} */ _p, /** @type {number} */ i) => {
      const wanted = i === 0 ? 'tableHeader' : 'tableCell'
      row.forEach((/** @type {any} */ cell) => {
        if (cell.type.name !== wanted) simple = false
        if (cell.childCount !== 1 || cell.firstChild.type.name !== 'paragraph') simple = false
        if (TableMarkdown.#span(cell, 'colspan') > 1 || TableMarkdown.#span(cell, 'rowspan') > 1) simple = false
      })
    })
    return simple
  }

  /** Writes this table to `state` in whichever form its content allows.
   *  @param {any} state a tiptap-markdown MarkdownSerializerState */
  writeTo(state) {
    if (this.isSimple) this.#writePipeTable(state)
    else this.#writeHtmlSkeleton(state)
  }

  /** The GFM pipe table, byte-for-byte what tiptap-markdown's built-in writes —
   *  `state.inTable` included, which is how a hard break in a cell knows to write
   *  itself as HTML rather than a trailing backslash.
   *  @param {any} state */
  #writePipeTable(state) {
    state.inTable = true
    this.#node.forEach((/** @type {any} */ row, /** @type {number} */ _p, /** @type {number} */ i) => {
      state.write('| ')
      row.forEach((/** @type {any} */ cell, /** @type {number} */ _cp, /** @type {number} */ j) => {
        if (j) state.write(' | ')
        const content = cell.firstChild
        if (content.textContent.trim()) state.renderInline(content)
      })
      state.write(' |')
      state.ensureNewLine()
      if (!i) {
        const delimiters = Array.from({ length: row.childCount }).map(() => '---').join(' | ')
        state.write(`| ${delimiters} |`)
        state.ensureNewLine()
      }
    })
    state.closeBlock(this.#node)
    state.inTable = false
  }

  /** The HTML skeleton with markdown cell content.
   *
   *  `closeBlock` on either side of a cell's content is what puts the blank lines
   *  in: it defers a paragraph break that the next `write` flushes, so the tags
   *  never end up on the content's own line. Every cell is written in this block
   *  form, headers included — verbose, but markdown inside an INLINE html element
   *  is not parsed, so a plain cell shortened to `<td>Req</td>` would lose its
   *  emphasis and links on the next load.
   *  @param {any} state */
  #writeHtmlSkeleton(state) {
    state.write('<table>')
    state.ensureNewLine()
    this.#node.forEach((/** @type {any} */ row) => {
      state.write('<tr>')
      row.forEach((/** @type {any} */ cell) => {
        const tag = cell.type.name === 'tableHeader' ? 'th' : 'td'
        state.write(`<${tag}${TableMarkdown.#spanAttrs(cell)}>`)
        state.closeBlock(cell)
        state.renderContent(cell)
        state.closeBlock(cell)
        state.write(`</${tag}>`)
      })
      state.write('</tr>')
      state.ensureNewLine()
    })
    state.write('</table>')
    state.closeBlock(this.#node)
  }

  /** `colspan`/`rowspan` attributes, present only where they say something.
   *  @param {any} cell @returns {string} */
  static #spanAttrs(cell) {
    let out = ''
    for (const name of SPANS) {
      const span = TableMarkdown.#span(cell, name)
      if (span > 1) out += ` ${name}="${span}"`
    }
    return out
  }

  /** @param {any} cell @param {string} name @returns {number} */
  static #span(cell, name) {
    const value = cell.attrs && cell.attrs[name]
    return typeof value === 'number' && value > 0 ? value : 1
  }
}
