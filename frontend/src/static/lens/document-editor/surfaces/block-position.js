// Pure PM doc position helpers. Every function takes a `doc` (PM Node), never
// the editor object, so they are testable without a live editor.

// The top-level block index for inserting at doc position `pos` — the number of
// top-level nodes that end at or before `pos`; pos == null → doc.childCount
// (append). `pos` may be a number or an object with a `.from` field.
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

// The top-level block index immediately AFTER the top-level node whose
// attrs.id === blockId; -1 if there is none. Considers only DIRECT children of
// doc, and is the insert position for an extract or paste following that block.
export function blockIndexAfter(doc, blockId) {
  if (!blockId) return -1
  for (var i = 0; i < doc.childCount; i++) {
    var child = doc.child(i)
    if (child.attrs && child.attrs.id === blockId) return i + 1
  }
  return -1
}

// The index of the TOP-LEVEL block whose range [offset, offset+nodeSize) contains
// doc position `pos`; -1 when none does. The position-native counterpart of
// blockIndexAfter, for when the source is a range inside a block rather than a
// block with an id.
export function blockIndexAt(doc, pos) {
  var offset = 0
  for (var i = 0; i < doc.childCount; i++) {
    var end = offset + doc.child(i).nodeSize
    if (pos >= offset && pos < end) return i
    offset = end
  }
  return -1
}

// The id of the TOP-LEVEL block containing doc position `pos`, for atom nodes and
// containers alike. '' when no top-level block owns the position, or when the
// node it finds has no id.
export function enclosingBlockId(doc, pos) {
  var i = blockIndexAt(doc, pos)
  if (i < 0) return ''
  var child = doc.child(i)
  return (child.attrs && child.attrs.id) ? child.attrs.id : ''
}

// blockOffsetOf(doc, pos): `pos` restated as an offset WITHIN the top-level block
// that owns it — { id, offset }, where offset is pos minus the position before
// that block. null when no top-level block owns the position, or when the one
// that does carries no id: such a node is nameless, so nothing about it survives
// a permute of the doc's children.
export function blockOffsetOf(doc, pos) {
  var i = blockIndexAt(doc, pos)
  if (i < 0) return null
  var child = doc.child(i)
  var id = child.attrs && child.attrs.id
  if (!id) return null
  return { id: id, offset: pos - docPosForBlockIndex(doc, i) }
}

// posForBlockOffset(doc, ref): the absolute position a blockOffsetOf reading names
// in `doc`, wherever that block now sits. The offset is CLAMPED to the block, so a
// reading taken before an edit shrank it still lands inside. -1 when `doc` holds no
// block of that id.
export function posForBlockOffset(doc, ref) {
  if (!ref || !ref.id) return -1
  var start = 0
  for (var i = 0; i < doc.childCount; i++) {
    var child = doc.child(i)
    if (child.attrs && child.attrs.id === ref.id) {
      var last = child.nodeSize - 1
      return start + (ref.offset > 0 ? Math.min(ref.offset, last) : 0)
    }
    start += child.nodeSize
  }
  return -1
}

// The top-level node anchoring insert position `pos` (a blockInsertPos result —
// the boundary AFTER the caret's block), IF that node is a bare empty paragraph.
// Contract rule "Block insertion placement": an empty paragraph is a placement
// TARGET, not an anchor — the new block takes its index and consumes it. Bare =
// type 'paragraph' with no content or whitespace only; empty headings and list
// items never match, because their emptiness carries chosen structure. Returns
// { from, to, index }, or null — including for the {from,to} replace-range form
// and doc-level gap positions, which anchor no node.
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
