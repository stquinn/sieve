// @ts-check
// BlockSelection: the pure decisions that reconcile a NATIVE DOM Selection with a
// sieve block's ProseMirror NodeSelection.
//
// A sieve block is a NodeView atom: PM's position-based selection knows only the
// whole block, while the browser's DOM Selection can land inside the block's own
// read-only regions (a log Explore table, an ai-block question title) that PM does
// not own. These three decisions — who claims a click, and what a visible highlight
// actually covers — are pure functions of the DOM selection plus the block's DOM/PM
// coordinates.

// BLOCK_CLICK_SKIP lists what a click must NOT claim the block for: interactive
// controls + the header/chrome own their own clicks.
const BLOCK_CLICK_SKIP = 'input, textarea, button, select, option, a[href], ' +
  '.sieve-block__header, .block-chrome-host, .block-chrome-handle, .drag-handle'

export class BlockSelection {
  /**
   * The click decision (pure). A plain click claims the whole block UNLESS it
   * lands on an interactive control/chrome, inside the block's editable text
   * (contentDOM — PM places a text caret there, which IS caret ownership), or
   * while a real text selection sits inside the block (a drag-select for copy,
   * e.g. a log table — leave it alone).
   * @param {any} target @param {any} blockDom @param {any} contentDOM @param {Selection|null} domSelection
   * @returns {boolean}
   */
  static shouldClaim(target, blockDom, contentDOM, domSelection) {
    if (!target || !blockDom || !blockDom.contains(target)) return false
    if (target.closest && target.closest(BLOCK_CLICK_SKIP)) return false
    if (contentDOM && contentDOM.contains(target)) return false
    if (domSelection && !domSelection.isCollapsed && domSelection.anchorNode &&
        blockDom.contains(domSelection.anchorNode)) return false
    return true
  }

  /**
   * The highlighted text of a native DOM selection IF it sits inside blockDom,
   * else '' (pure). A block's custom region (e.g. the log Explore table) holds
   * text PM does not own, so a highlight there is invisible to PM's
   * position-based selection — on copy PM sees a whole-block NodeSelection and a
   * rich copy would grab the ENTIRE block. The copy handler uses this so
   * text/plain + text/html follow the DOM highlight while sieve/slice +
   * sieve/<kind> still carry the whole block (a block is only meaningful whole).
   * @param {Selection|null} domSelection @param {any} blockDom @returns {string}
   */
  static textInside(domSelection, blockDom) {
    if (!domSelection || domSelection.isCollapsed || !blockDom) return ''
    const text = domSelection.toString()
    if (!text || !text.trim()) return ''
    const a = domSelection.anchorNode
    const el = a ? (a.nodeType === 1 ? a : a.parentElement) : null
    return (el && blockDom.contains(el)) ? text : ''
  }

  /**
   * The {from,to} PM range of the block a visible DOM highlight actually lives in,
   * IF that block is NOT already covered by the PM selection `er` (else null). Pure.
   *
   * A block's READ-ONLY region (contentEditable=false DOM PM does not own) can hold
   * a highlight PM knows nothing about: PM's selection stays on whatever block last
   * held the caret, so driving the copy off `er` alone would serialize the WRONG
   * block. The copy handler calls this to re-target the range it visits onto the
   * block the user actually highlighted. When `er` already covers the matched block,
   * PM owns that text — return null and leave `er` alone.
   * @param {Selection|null} domSelection
   * @param {{from: number, to: number}|null} er   the PM selection range
   * @param {{from: number, to: number, dom: any}[]} blocks   ordered top-level sieve-block descriptors
   * @returns {{from: number, to: number}|null}
   */
  static blockRange(domSelection, er, blocks) {
    if (!domSelection || domSelection.isCollapsed) return null
    const text = domSelection.toString()
    if (!text || !text.trim()) return null
    for (let i = 0; i < (blocks || []).length; i++) {
      const blk = blocks[i]
      if (!BlockSelection.textInside(domSelection, blk.dom)) continue
      const erCovers = !!(er && er.to > blk.from && er.from < blk.to)
      return erCovers ? null : { from: blk.from, to: blk.to }
    }
    return null
  }
}
