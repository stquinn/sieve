// True when the caret sits inside a raw-text fenced block, where a paste must be
// an ordinary literal text paste rather than the smart-paste pipeline. `code:
// true` is the one uniform signal every raw-text fenced block shares, so keying
// off that rather than naming kinds covers any future one for free.
export function caretInRawTextBlock(editor) {
  var sel = editor && editor.state && editor.state.selection
  var parent = sel && sel.$from && sel.$from.parent
  return !!(parent && parent.type && parent.type.spec && parent.type.spec.code)
}
