import { isReadOnlyRegion } from './interaction-policy.js'

// True when the caret sits inside a raw-text fenced block, where a paste must be
// an ordinary literal text paste rather than the smart-paste pipeline. `code:
// true` is the one uniform signal every raw-text fenced block shares, so keying
// off that rather than naming kinds covers any future one for free.
export function caretInRawTextBlock(editor) {
  var sel = editor && editor.state && editor.state.selection
  var parent = sel && sel.$from && sel.$from.parent
  return !!(parent && parent.type && parent.type.spec && parent.type.spec.code)
}

// True when the caret sits inside a table cell (body or header). A cell takes
// inline text but no blocks, so a paste there is the native text paste that
// prosemirror-tables merges into the cell, never a smart-paste.
export function caretInTableCell(editor) {
  var sel = editor && editor.state && editor.state.selection
  var $from = sel && sel.$from
  if (!$from) return false
  for (var d = $from.depth; d > 0; d--) {
    var name = $from.node(d).type.name
    if (name === 'tableCell' || name === 'tableHeader') return true
  }
  return false
}

// True when the caret sits inside a read-only region (a web-clip or ai-block
// body, a log). Nothing pasted there lands: the region's node view consumes the
// paste, so it is never a smart-paste.
export function caretInReadOnlyRegion(editor) {
  var sel = editor && editor.state && editor.state.selection
  var $from = sel && sel.$from
  if (!$from) return false
  for (var d = $from.depth; d > 0; d--) {
    if (isReadOnlyRegion($from.node(d).type.name)) return true
  }
  return false
}
