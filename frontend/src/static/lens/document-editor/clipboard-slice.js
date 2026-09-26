// @ts-check
// The clipboard VIEWS of one selection: the `sieve/slice` ContentEntry sets the
// backend rebuilds a paste from, the `sieve/<kind>` view a single block also
// exposes, and the text/plain + text/html a foreign application receives.
//
// A BLOCK IS ONLY MEANINGFUL WHOLE, so `sieve/slice` and `sieve/<kind>` always
// carry the entire block. The text views follow the selected RANGE instead: a
// range covering only PART of a block's content is exactly those characters, a
// range covering the whole block (or a NodeSelection of it) is its whole text.
//
// A node whose content HOSTS BLOCKS is a container, and a range lying inside one
// names its ELEMENTS, not the container: each is composed as a block of its own,
// exactly as a top-level node is. A range covering the container whole names the
// one block it is.
//
// Cut is copy plus a deletion, so this also names the range a cut may remove.
// That is NOT always the range the text views were read from: a highlight in a
// region ProseMirror does not own retargets the views onto the block the user
// actually highlighted, and no transaction can delete such a highlight.

import { sieveBlockEntries, rendererFor } from './surfaces/sieve-block-extension.js'
import { getBlockKind } from '../../renderers/block-kinds.js'
import { BlockSelection } from './block-selection.js'
import { ContractViolation } from '../../contract/sieve-block.js'
import { copyImageToClipboard } from '../../ui/copy-image.js'
import { resolveImageSrc } from '../../renderers/asset-urls.js'

const SIEVE_PREFIX = 'sieve-'
// The schema group every sieve block belongs to. A node type whose content admits
// it hosts BLOCKS — the document top level, and any container kind.
const SIEVE_GROUP = 'sieveBlock'

/**
 * @typedef {object} ClipboardSliceInput
 * @property {any} view          the ProseMirror view holding the selection
 * @property {any} [editor]      the TipTap editor whose markdown serializer writes
 *   prose's ContentEntry views; without one a prose node contributes no entries
 * @property {{from: number, to: number}|null} [range]  the authoritative selection
 *   range, which spans whole blocks for the gutter gesture PM's own selection
 *   cannot express; omitted, the PM selection is used
 * @property {string} [uuid]     the document the editor is mounted on — a block's
 *   relative asset src resolves against it
 */

export class ClipboardSlice {
  /** @type {any} */ #view
  /** @type {any} */ #editor
  /** @type {string} */ #uuid
  /** @type {{from: number, to: number}} */ #range
  /** @type {{from: number, to: number}|null} */ #cutRange
  /** @type {Selection|null} */ #domSelection
  /** @type {string} */ #domHtml

  /** @param {ClipboardSliceInput} input */
  constructor(input) {
    if (!input || !input.view || !input.view.state) {
      throw new ContractViolation('ClipboardSlice requires a ProseMirror view')
    }
    this.#view = input.view
    this.#editor = input.editor || null
    this.#uuid = input.uuid || ''

    const sel = this.#view.state.selection
    const base = input.range || { from: sel.from, to: sel.to }
    this.#cutRange = base.to > base.from ? { from: base.from, to: base.to } : null

    const live = (typeof window !== 'undefined' && window.getSelection) ? window.getSelection() : null
    const highlighted = !!(live && !live.isCollapsed && live.toString() && live.toString().trim())
    this.#domSelection = highlighted ? live : null
    this.#domHtml = highlighted ? ClipboardSlice.#htmlOf(/** @type {Selection} */ (live)) : ''
    this.#range = this.#retarget(base)
  }

  /** The range the text views are read from, after a read-only region's highlight
   *  has retargeted it onto the block that highlight lives in.
   *  @returns {{from: number, to: number}} */
  get range() { return this.#range }

  /** The range a cut removes, or null when it must remove nothing: a highlight PM
   *  does not own names no deletable range, and tearing out the whole block the
   *  user highlighted three words in would be destructive.
   *  @returns {{from: number, to: number}|null} */
  get cutRange() { return this.#cutRange }

  /** The selection names nothing: the PM range is collapsed AND there is no live
   *  DOM highlight to fall back on. A cut against an empty selection has no
   *  content to take, so it must not touch the clipboard at all.
   *  @returns {boolean} */
  get empty() { return this.#cutRange === null && !this.#domSelection }

  /**
   * Write every view of this selection onto `clipboardData`.
   *
   * Returns false when ProseMirror's own copy must serve the selection instead —
   * pure prose, or a selected image with nothing to copy. Every sieve-involving
   * selection is served here: a slice inside a `defining`/`code` node re-wraps
   * the whole node, so native copy takes the entire block.
   * @param {DataTransfer} clipboardData
   * @returns {boolean}
   */
  write(clipboardData) {
    const image = this.#imageSrc()
    if (image !== null) {
      if (!image) return false
      copyImageToClipboard(image)
      return true
    }

    const composed = this.#compose()
    if (!composed) return false

    clipboardData.setData('text/plain', composed.plain.filter(Boolean).join('\n\n'))
    clipboardData.setData('text/html', composed.html.filter(Boolean).join('\n'))
    clipboardData.setData('sieve/slice', JSON.stringify(composed.items))
    // Single sieve block: expose every mime in its ContentEntry array too, so a
    // cross-context paste hits the same backend matchers.
    if (composed.items.length === 1 && composed.single) {
      composed.single.forEach((/** @type {{mimeType: string, content: string}} */ entry) => {
        clipboardData.setData(entry.mimeType, entry.content)
      })
    }
    return true
  }

  /** The resolved image src a selected image block puts on the OS clipboard as a
   *  bitmap — bytes no text view can express. '' when the block has no src yet,
   *  null when this is not an image selection at all. @returns {string|null} */
  #imageSrc() {
    const sel = this.#view.state.selection
    if (!sel || !sel.node || sel.node.type.name !== 'sieve-smart-image') return null
    return sel.node.attrs.src ? resolveImageSrc(sel.node.attrs.src, this.#uuid) : ''
  }

  /**
   * Walk the blocks the range touches — the top-level nodes, descending into a
   * container the range lies inside — and build every view of each.
   * Null when the selection holds no sieve block at all.
   * @returns {{items: any[], single: any[]|null, plain: string[], html: string[]}|null}
   */
  #compose() {
    const view = this.#view
    const doc = view.state.doc
    const range = this.#range
    /** @type {{items: any[], single: any[]|null, plain: string[], html: string[], hasSieve: boolean}} */
    const out = { items: [], single: null, plain: [], html: [], hasSieve: false }
    const nodeDOM = (/** @type {number} */ pos) => (view.nodeDOM ? view.nodeDOM(pos) : null)

    doc.forEach((/** @type {any} */ node, /** @type {number} */ offset) => {
      const nodeEnd = offset + node.nodeSize
      if (nodeEnd <= range.from || offset >= range.to) return
      const dom = nodeDOM(offset)
      if (this.#descendsInto(node, offset, nodeEnd, dom)) {
        node.forEach((/** @type {any} */ child, /** @type {number} */ childOffset) => {
          const from = offset + 1 + childOffset
          if (from + child.nodeSize <= range.from || from >= range.to) return
          this.#composeNode(child, from, nodeDOM(from), out)
        })
        return
      }
      this.#composeNode(node, offset, dom, out)
    })

    return out.hasSieve ? { items: out.items, single: out.single, plain: out.plain, html: out.html } : null
  }

  /**
   * Is the range INSIDE a container, so it names that container's elements rather
   * than the container itself? A block-hosting node holds a list of blocks exactly
   * as the document top level does, and each element is composed as a block of its
   * own. A highlight in a region PM does not own claims the whole node instead —
   * there is no document range under such a highlight to name any element by.
   * @param {any} node @param {number} from @param {number} to @param {any} dom
   * @returns {boolean}
   */
  #descendsInto(node, from, to, dom) {
    if (!ClipboardSlice.#hostsBlocks(node)) return false
    if (this.#range.from <= from || this.#range.to >= to) return false
    return !BlockSelection.unownedText(this.#domSelection, dom)
  }

  /**
   * Build every view of ONE block — a top-level node or a container's element —
   * and append them to `out`.
   * @param {any} node @param {number} from @param {any} dom
   * @param {{items: any[], single: any[]|null, plain: string[], html: string[], hasSieve: boolean}} out
   */
  #composeNode(node, from, dom, out) {
    const nodeEnd = from + node.nodeSize
    const range = this.#range
    const entries = this.#entriesOf(node)
    if (String(node.type.name).indexOf(SIEVE_PREFIX) === 0) {
      out.hasSieve = true
      out.single = entries
    }
    out.items.push(entries)

    // A block's custom region holds text PM does not own, so a highlight there
    // is the only reading of the selection there is.
    const highlighted = BlockSelection.unownedText(this.#domSelection, dom)
    if (highlighted) {
      out.plain.push(highlighted)
      out.html.push(this.#domHtml || ClipboardSlice.#escape(highlighted))
      return
    }
    if (this.#followsRange(node, from, nodeEnd)) {
      const text = BlockSelection.selectedText(
        this.#view.state.doc, { from: Math.max(range.from, from), to: Math.min(range.to, nodeEnd) }, null, '\n')
      out.plain.push(text)
      out.html.push(ClipboardSlice.#escape(text))
      return
    }
    out.plain.push(ClipboardSlice.#pick(entries, 'text/plain') || node.textContent || (dom ? dom.innerText : ''))
    out.html.push(ClipboardSlice.#pick(entries, 'text/html') || ClipboardSlice.#blockHTML(dom))
  }

  /** Does this sieve node's content host BLOCKS — a list of them, as the document
   *  top level does? Asked of the schema through ProseMirror's own content match,
   *  so declaring a container's content is the whole declaration and there is no
   *  second table to drift from it. @param {any} node @returns {boolean} */
  static #hostsBlocks(node) {
    if (String(node.type.name).indexOf(SIEVE_PREFIX) !== 0) return false
    const types = node.type.schema.nodes
    for (const name in types) {
      const type = types[name]
      const groups = String(type.spec.group || '').split(' ')
      if (groups.indexOf(SIEVE_GROUP) >= 0 && node.type.contentMatch.matchType(type)) return true
    }
    return false
  }

  /** Every ContentEntry describing one top-level node. @param {any} node @returns {any[]} */
  #entriesOf(node) {
    if (String(node.type.name).indexOf(SIEVE_PREFIX) === 0) {
      return sieveBlockEntries(node, rendererFor(node.attrs.kind))
    }
    const proseKind = getBlockKind ? getBlockKind('prose') : null
    return (proseKind && proseKind.asContentEntry && proseKind.asContentEntry(node, this.#editor)) || []
  }

  /** Do this node's text views follow the selection rather than describe the whole
   *  block? Only when the range is non-empty and covers PART of the node — an
   *  empty range or one spanning it in full (a NodeSelection's range always does)
   *  means the whole block.
   *  @param {any} node @param {number} from @param {number} to */
  #followsRange(node, from, to) {
    if (this.#range.to <= this.#range.from) return false
    if (this.#range.from <= from && this.#range.to >= to) return false
    return true
  }

  /**
   * The range the text views are read from. A highlight in a block's READ-ONLY
   * region leaves PM's selection on whatever block last held the caret, so the
   * walk would serialize the WRONG block; retarget it onto the highlighted one,
   * and let a cut remove nothing, since the highlight is not PM's to delete.
   * @param {{from: number, to: number}} base @returns {{from: number, to: number}}
   */
  #retarget(base) {
    if (!this.#domSelection) return base
    const view = this.#view
    /** @type {{from: number, to: number, dom: any}[]} */ const blocks = []
    view.state.doc.forEach((/** @type {any} */ node, /** @type {number} */ offset) => {
      if (String(node.type.name).indexOf(SIEVE_PREFIX) === 0) {
        blocks.push({ from: offset, to: offset + node.nodeSize, dom: view.nodeDOM ? view.nodeDOM(offset) : null })
      }
    })
    const onto = BlockSelection.blockRange(this.#domSelection, base, blocks)
    if (!onto) return base
    this.#cutRange = null
    return onto
  }

  /** The first entry offering `mime`, or ''. @param {any[]} entries @param {string} mime */
  static #pick(entries, mime) {
    for (let i = 0; i < entries.length; i++) {
      if (entries[i].mimeType === mime && entries[i].content) return entries[i].content
    }
    return ''
  }

  /** A block's rendered DOM minus the gutter chrome, which is the host's furniture
   *  rather than the block's content. @param {any} dom @returns {string} */
  static #blockHTML(dom) {
    if (!dom || !dom.cloneNode) return ''
    const clone = dom.cloneNode(true)
    const chrome = clone.querySelector ? clone.querySelector('.block-chrome-host') : null
    if (chrome) chrome.remove()
    return clone.outerHTML || ''
  }

  /** The marked-up form of a live DOM highlight. @param {Selection} selection */
  static #htmlOf(selection) {
    try {
      const frag = document.createElement('div')
      for (let i = 0; i < selection.rangeCount; i++) frag.appendChild(selection.getRangeAt(i).cloneContents())
      return frag.innerHTML
    } catch (e) {
      return ''
    }
  }

  /** @param {string} text @returns {string} */
  static #escape(text) {
    return String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }
}
