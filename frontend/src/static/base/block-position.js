// block-position.js — pure PM doc position helpers, testable without the editor.
// Every function takes a `doc` (PM Node), not the editor object.

// blockIndexForInsert(doc, pos): the top-level block index for inserting at doc
// position `pos` — the number of top-level nodes that end at or before `pos`.
// pos == null → doc.childCount (append).
// `pos` may be a number or an object with a `.from` field (sieveInsertPos range form).
export function blockIndexForInsert(doc, pos) {
  if (pos == null) return doc.childCount
  var p = (typeof pos === 'object') ? pos.from : pos
  var idx = 0, offset = 0
  for (var i = 0; i < doc.childCount; i++) {
    offset += doc.child(i).nodeSize
    if (offset <= p) idx = i + 1
    else break
  }
  return idx
}

// docPosForBlockIndex(doc, idx): the doc position at the start of top-level block
// `idx`. idx >= childCount or null → doc.content.size (end of doc).
export function docPosForBlockIndex(doc, idx) {
  // null / negative (e.g. a missed blockIndexAfter lookup) / out-of-range → end of doc.
  // Without the `< 0` guard a negative idx skips the loop and returns 0 (doc START).
  if (idx == null || idx < 0 || idx >= doc.childCount) return doc.content.size
  var pos = 0
  for (var i = 0; i < idx && i < doc.childCount; i++) pos += doc.child(i).nodeSize
  return pos
}

// blockIndexAfter(doc, blockId): the top-level block index immediately AFTER the
// top-level node whose attrs.id === blockId; -1 if no such node found.
// Only considers DIRECT children of doc — not nested descendants.
// This is the correct insert position for an extract/paste following a given block.
export function blockIndexAfter(doc, blockId) {
  if (!blockId) return -1
  for (var i = 0; i < doc.childCount; i++) {
    var child = doc.child(i)
    if (child.attrs && child.attrs.id === blockId) return i + 1
  }
  return -1
}

// enclosingBlockId(doc, pos): the id of the TOP-LEVEL block containing doc
// position `pos`. Iterates direct children to find the one whose range
// [offset, offset+nodeSize) contains pos, then returns its attrs.id.
// Works for both atom nodes (leaf, no interior positions) and containers.
// Returns '' when no top-level block owns the position or when the node has no id.
export function enclosingBlockId(doc, pos) {
  var offset = 0
  for (var i = 0; i < doc.childCount; i++) {
    var child = doc.child(i)
    var end = offset + child.nodeSize
    if (pos >= offset && pos < end) {
      return (child.attrs && child.attrs.id) ? child.attrs.id : ''
    }
    offset = end
  }
  return ''
}

// emptyParagraphAnchor(doc, pos): the top-level node that anchors insert
// position `pos` (a blockInsertPos result — the boundary AFTER the caret's
// block), IF that node is a bare empty paragraph. Contract rule ("Block
// insertion placement"): an empty paragraph is a placement TARGET, not an
// anchor — the new block takes its index and the paragraph is consumed.
// Bare = type 'paragraph', no content or whitespace-only. Empty headings/list
// items never match: their emptiness carries chosen structure. Returns
// { from, to, index } or null (incl. for the {from,to} replace-range form and
// doc-level gap positions, which anchor no node).
export function emptyParagraphAnchor(doc, pos) {
  if (pos == null || typeof pos === 'object') return null
  var offset = 0
  for (var i = 0; i < doc.childCount; i++) {
    var child = doc.child(i)
    var end = offset + child.nodeSize
    if (pos > offset && pos <= end) {
      if (child.type.name !== 'paragraph') return null
      if (child.textContent.trim() !== '') return null
      return { from: offset, to: end, index: i }
    }
    offset = end
  }
  return null
}
