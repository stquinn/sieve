// @ts-check
// ClipboardText: the clipboard's text/plain view of document content — readable
// plain text with its structure kept, never markup. Every text/plain the editor
// writes is rendered here: ProseMirror's native copy (as the interaction policy's
// `clipboardTextSerializer`) and every view `ClipboardSlice` composes.
//
//   table         rows on their own line, cells separated by a tab
//   list          `- ` / `1. ` (numbered from the list's start) / `- [x] ` / `- [ ] `
//                 per item; a nested list indented two spaces per level
//   textblock     its text; a hard break is a newline; marks and links are their text
//   code          its source
//   sieve block   covered whole: its kind's own `text/plain` view, else its content,
//                 else the address its `text/uri-list` view names; never the chrome
//                 the node view draws. Covered in part: the covered characters.
//   blocks        separated by one blank line; a block with no text adds none

import { rendererFor } from './surfaces/sieve-block-extension.js'

const SIEVE_PREFIX = 'sieve-'
const BLOCK_SEPARATOR = '\n\n'
const NESTED_INDENT = '  '
const LIST_TYPES = Object.freeze(['bulletList', 'orderedList', 'taskList'])
/** The separator written BEFORE a sibling, by that sibling's table role. */
const SEPARATOR_BY_ROLE = Object.freeze({ row: '\n', cell: '\t', header_cell: '\t' })

export class ClipboardText {
  /**
   * The text of a slice. A node the slice is OPEN on is covered only in part.
   * @param {any} slice a ProseMirror Slice
   * @returns {string}
   */
  static ofSlice(slice) {
    return ClipboardText.#blocks(slice.content, slice.openStart, slice.openEnd, '')
  }

  /**
   * The text of one node covered whole.
   * @param {any} node a ProseMirror node
   * @returns {string}
   */
  static ofNode(node) {
    return ClipboardText.#block(node, 0, 0, '')
  }

  /**
   * Sibling nodes joined by the separator their table role names, one blank line
   * otherwise. `openStart` / `openEnd` > 0 says the first / last sibling is cut.
   * @param {any} fragment @param {number} openStart @param {number} openEnd
   * @param {string} indent the list indentation the content sits at
   * @returns {string}
   */
  static #blocks(fragment, openStart, openEnd, indent) {
    if (fragment.childCount && fragment.firstChild.isInline) return ClipboardText.#inline(fragment)
    let out = ''
    let wrote = false
    ClipboardText.#eachChild(fragment, openStart, openEnd, (child, start, end) => {
      const text = ClipboardText.#block(child, start, end, indent)
      const separator = /** @type {Record<string, string>} */ (SEPARATOR_BY_ROLE)[child.type.spec.tableRole]
      if (separator !== undefined) {
        out += (wrote ? separator : '') + text
        wrote = true
        return
      }
      if (!text) return
      out += (wrote ? BLOCK_SEPARATOR : '') + text
      wrote = true
    })
    return out
  }

  /**
   * @param {any} node @param {number} openStart @param {number} openEnd
   * @param {string} indent
   * @returns {string}
   */
  static #block(node, openStart, openEnd, indent) {
    if (String(node.type.name).indexOf(SIEVE_PREFIX) === 0 && openStart <= 0 && openEnd <= 0) {
      return ClipboardText.#sieveView(node)
    }
    const role = node.type.spec.tableRole
    if (role === 'cell' || role === 'header_cell') {
      return ClipboardText.#blocks(node.content, openStart - 1, openEnd - 1, '').replace(/\s*[\n\t]+\s*/g, ' ')
    }
    if (LIST_TYPES.indexOf(node.type.name) >= 0) return ClipboardText.#list(node, openStart, openEnd, indent)
    if (node.isTextblock) return node.type.spec.code ? node.textContent : ClipboardText.#inline(node.content)
    if (node.isLeaf) return ClipboardText.#leaf(node)
    return ClipboardText.#blocks(node.content, openStart - 1, openEnd - 1, indent)
  }

  /**
   * One line per item, its marker first; an item's later blocks and nested lists
   * sit one level deeper.
   * @param {any} list @param {number} openStart @param {number} openEnd
   * @param {string} indent
   * @returns {string}
   */
  static #list(list, openStart, openEnd, indent) {
    /** @type {string[]} */ const lines = []
    const deeper = indent + NESTED_INDENT
    ClipboardText.#eachChild(list.content, openStart - 1, openEnd - 1, (item, start, end, index) => {
      let head = indent + ClipboardText.#marker(list, item, index)
      ClipboardText.#eachChild(item.content, start - 1, end - 1, (child, childStart, childEnd) => {
        if (LIST_TYPES.indexOf(child.type.name) >= 0) {
          lines.push(ClipboardText.#list(child, childStart, childEnd, deeper))
          return
        }
        const text = ClipboardText.#block(child, childStart, childEnd, deeper)
        lines.push(head + text.split('\n').join('\n' + deeper))
        head = deeper
      })
    })
    return lines.join('\n')
  }

  /** @param {any} list @param {any} item @param {number} index @returns {string} */
  static #marker(list, item, index) {
    if (list.type.name === 'orderedList') return ((Number(list.attrs.start) || 1) + index) + '. '
    if (item.type.name === 'taskItem') return item.attrs.checked ? '- [x] ' : '- [ ] '
    return '- '
  }

  /** @param {any} fragment inline content @returns {string} */
  static #inline(fragment) {
    return fragment.textBetween(0, fragment.size, '', (/** @type {any} */ leaf) => ClipboardText.#leaf(leaf))
  }

  /** @param {any} leaf @returns {string} */
  static #leaf(leaf) {
    if (leaf.type.name === 'hardBreak') return '\n'
    const leafText = leaf.type.spec.leafText
    return typeof leafText === 'function' ? leafText(leaf) : ''
  }

  /** A whole sieve block's text. @param {any} node @returns {string} */
  static #sieveView(node) {
    const renderer = rendererFor(node.attrs.kind)
    const entries = (renderer && typeof renderer.asContentEntry === 'function' && renderer.asContentEntry(node)) || []
    const plain = ClipboardText.#entry(entries, 'text/plain')
    if (plain) return plain
    if (node.content.size) return node.isTextblock ? node.textContent : ClipboardText.#blocks(node.content, 0, 0, '')
    const uris = ClipboardText.#entry(entries, 'text/uri-list').split(/\r?\n/)
    return uris.find((line) => line && line.charAt(0) !== '#') || ''
  }

  /** @param {any[]} entries @param {string} mime @returns {string} */
  static #entry(entries, mime) {
    const hit = entries.find((entry) => entry && entry.mimeType === mime && entry.content)
    return hit ? String(hit.content) : ''
  }

  /**
   * Visit each child with the open depths it inherits: only the first child can be
   * open at its start, only the last at its end.
   * @param {any} fragment @param {number} openStart @param {number} openEnd
   * @param {(child: any, openStart: number, openEnd: number, index: number) => void} visit
   */
  static #eachChild(fragment, openStart, openEnd, visit) {
    const last = fragment.childCount - 1
    fragment.forEach((/** @type {any} */ child, /** @type {number} */ _offset, /** @type {number} */ index) => {
      visit(child, index === 0 ? openStart : 0, index === last ? openEnd : 0, index)
    })
  }
}
