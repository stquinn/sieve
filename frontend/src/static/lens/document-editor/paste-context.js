// paste-context.js — predicate for the editor's smart-paste handler.
//
// Code, diagram and log blocks are raw-text fenced blocks: their node is
// declared `code: true` with `content: 'text*'`, and editing happens inside a
// PM-native contentDOM (<pre class="sieve-block__edit"><code>…). When the caret
// sits inside one of these, a paste must be an ordinary literal text paste into
// that block — NOT the smart-paste pipeline (which resolves a clipboard payload
// to a brand-new block and inserts it). `code: true` is the one uniform signal
// shared by every raw-text fenced block, so we key off that rather than naming
// individual kinds — any future raw-text block is covered for free.
//
// caretInRawTextBlock — true when the editor's selection anchor is inside a
// code:true node. Defensive: returns false for a null/partial editor.
export function caretInRawTextBlock(editor) {
  var sel = editor && editor.state && editor.state.selection
  var parent = sel && sel.$from && sel.$from.parent
  return !!(parent && parent.type && parent.type.spec && parent.type.spec.code)
}
