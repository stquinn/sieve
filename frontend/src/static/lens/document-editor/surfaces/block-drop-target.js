// @ts-check
// Where a drop lands between top-level blocks, and the insertion line that shows
// it. A drop never lands inside a block: the pointer picks the top-level block it
// is over, and the half of that block it is in picks the boundary before or after
// it. The line is a widget decoration at that boundary, held in plugin state and
// drawn nowhere else; while it shows, the editor root carries ACTIVE_CLASS so the
// stock drop cursor can be hidden.

import { T } from './tiptap-vendor.js'
import { blockIndexAt, docPosForBlockIndex } from './block-position.js'

/**
 * A drop boundary: the document position between two top-level blocks, and the
 * block a placement there follows — null for the front of the document.
 * @typedef {{pos: number, afterBlockId: string|null}} DropBoundary
 */

export class BlockDropTarget {
  /** The class the editor root carries while the insertion line shows. */
  static ACTIVE_CLASS = 'sieve-drop-target-active'

  /** The insertion line's class. */
  static LINE_CLASS = 'sieve-drop-line'

  /** @type {any} the plugin key, built on first use so the vendor bag is live */
  static #key = null

  /** @returns {any} */
  static get key() {
    if (!BlockDropTarget.#key) BlockDropTarget.#key = new T.PluginKey('blockDropTarget')
    return BlockDropTarget.#key
  }

  /**
   * The boundary before (`before`) or after the top-level block holding `pos`. A
   * position past the last block is the end of the document.
   * @param {any} doc a ProseMirror document
   * @param {number} pos
   * @param {boolean} before
   * @returns {DropBoundary}
   */
  static boundary(doc, pos, before) {
    const at = blockIndexAt(doc, pos)
    const index = at < 0 ? doc.childCount : (before ? at : at + 1)
    let afterBlockId = null
    for (let i = Math.min(index, doc.childCount) - 1; i >= 0 && afterBlockId === null; i--) {
      afterBlockId = (doc.child(i).attrs && doc.child(i).attrs.id) || null
    }
    return { pos: docPosForBlockIndex(doc, index), afterBlockId }
  }

  /**
   * The boundary nearest viewport point (x, y) in `view`, or null when the point
   * is over no document position.
   * @param {any} view an EditorView
   * @param {number} x
   * @param {number} y
   * @returns {DropBoundary|null}
   */
  static boundaryAtCoords(view, x, y) {
    const coords = view.posAtCoords({ left: x, top: y })
    if (!coords) return null
    const doc = view.state.doc
    const at = blockIndexAt(doc, coords.pos)
    const dom = at < 0 ? null : view.nodeDOM(docPosForBlockIndex(doc, at))
    const rect = dom && dom.getBoundingClientRect ? dom.getBoundingClientRect() : null
    const before = rect ? y < rect.top + rect.height / 2 : false
    return BlockDropTarget.boundary(doc, coords.pos, before)
  }

  /** Shows the insertion line at `pos`, or hides it for null.
   *  @param {any} view @param {number|null} pos */
  static show(view, pos) {
    if (BlockDropTarget.lineAt(view.state) === pos) return
    view.dispatch(view.state.tr.setMeta(BlockDropTarget.key, { pos }).setMeta('addToHistory', false))
  }

  /** Where the insertion line shows in `state`, or null.
   *  @param {any} state @returns {number|null} */
  static lineAt(state) {
    const ps = BlockDropTarget.key.getState(state)
    return ps ? ps.pos : null
  }

  /** The TipTap extension carrying the plugin.
   *  @returns {any} */
  static extension() {
    const key = BlockDropTarget.key
    return T.Extension.create({
      name: 'blockDropTarget',
      addProseMirrorPlugins() {
        return [new T.Plugin({
          key,
          state: {
            init: () => ({ pos: null }),
            apply: (/** @type {any} */ tr, /** @type {any} */ prev) => {
              const meta = tr.getMeta(key)
              if (meta) return { pos: meta.pos }
              return prev.pos === null || !tr.docChanged ? prev : { pos: null }
            },
          },
          props: {
            decorations: (/** @type {any} */ state) => {
              const pos = BlockDropTarget.lineAt(state)
              if (pos === null) return T.DecorationSet.empty
              return T.DecorationSet.create(state.doc, [T.Decoration.widget(pos, () => {
                const line = document.createElement('div')
                line.className = BlockDropTarget.LINE_CLASS
                return line
              }, { key: BlockDropTarget.LINE_CLASS, side: -1 })])
            },
            attributes: (/** @type {any} */ state) =>
              BlockDropTarget.lineAt(state) === null ? {} : { class: BlockDropTarget.ACTIVE_CLASS },
          },
        })]
      },
    })
  }
}
