// block-sync.js — Stage D.3 thin-observer diff logic (pure).
//
// The block document model syncs the editor to Go with granular block-ops, not
// a whole-document markdown blob. computeBlockSync is the decision core: given
// the current top-level blocks and the content cache from the last sync, it
// decides whether granular `update-block` ops are safe and, if so, which blocks
// actually changed.
//
// It deliberately FALLS BACK to a whole-document doc-update for the two cases
// granular ops can't yet express (both land in D.4):
//   1. a changed block has no id — identity isn't minted until D.4, so it can't
//      be addressed; and
//   2. the set of top-level block ids changed — a split/merge, handled in D.4.
// Falling back keeps the app lossless and runnable while D.3 ships in isolation.

// curr: [{ id, kind, content }] in document order (content already serialized).
// prev: { [id]: content } from the last successful sync, or null on first call.
// → { mode: 'ops' | 'fallback', ops: [BlockOp], next: { [id]: content } }
export function computeBlockSync(curr, prev) {
  var next = {}
  var anyEmptyId = false
  for (var i = 0; i < curr.length; i++) {
    var b = curr[i]
    if (!b.id) anyEmptyId = true
    next[b.id] = b.content
  }

  // Can't address a block without an id → whole-document fallback.
  if (anyEmptyId) return { mode: 'fallback', ops: [], next: next }

  // First call: just seed the baseline, never emit ops.
  if (!prev) return { mode: 'ops', ops: [], next: next }

  // Structure change (split/merge / create / delete) → fallback until D.4.
  var prevIds = Object.keys(prev)
  if (prevIds.length !== curr.length) return { mode: 'fallback', ops: [], next: next }
  for (var j = 0; j < curr.length; j++) {
    if (!(curr[j].id in prev)) return { mode: 'fallback', ops: [], next: next }
  }

  // Same id set → emit an update-block for each prose block whose content
  // changed. A CHANGED structured block defers to doc-update: the Go
  // update-block contract for structured kinds carries parsed Attrs, which the
  // client (holding only the fence string) can't faithfully build yet.
  var ops = []
  for (var k = 0; k < curr.length; k++) {
    var c = curr[k]
    if (prev[c.id] === c.content) continue
    if (c.kind !== 'prose') return { mode: 'fallback', ops: [], next: next }
    ops.push({ type: 'update-block', blockId: c.id, kind: c.kind, content: c.content })
  }
  return { mode: 'ops', ops: ops, next: next }
}

if (typeof window !== 'undefined') {
  window.TipTap = window.TipTap || {}
  window.TipTap.computeBlockSync = computeBlockSync
}
