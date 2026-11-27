// The thin-observer diff core (pure). computeBlockSync is an id-keyed diff over the
// top-level blocks that emits create-block / update-block / replace-block /
// delete-block ops — granular, never a whole-document markdown blob.
//
// The top-level block LIST is stated the same way whatever the kind: a block the
// editor shows that the baseline lacks is created, one the baseline holds that the
// editor no longer shows is deleted, and one whose kind changed under its id is
// replaced whole. A block Go created and the editor placed is baselined when it is
// placed, so it is never stated back.
//
// CONTENT is the observer's for PROSE only. A structured (sieve-*) block's attrs
// change through its own channels, and its change-signature is a hash of its
// attrs (the frontend never serialises it to markdown), so an attrs change emits
// no update for one.
//
// There is NO whole-document fallback: every WYSIWYG edit is a granular block-op,
// and markdown mode is a separate verbatim breakglass buffer. An id-less node is
// the trailing editing surface, not a block yet, and is simply skipped.

// blockSig is a block's change-signature, prefixed with kind so a cached entry's
// kind is recoverable. Prose hashes on content + aliases; structured hashes on its
// attrs-JSON (carried in `content` for structured — a signature, never an op body).
function blockSig(b) {
  return b.kind + '\x00' + (b.content || '') + '\x00' + ((b.aliases || []).join(','))
}

// sigKind is the kind a change-signature was taken under.
function sigKind(sig) {
  return sig.slice(0, sig.indexOf('\x00'))
}

// stateOp states a block whole under the kind it now has: prose's body is its
// markdown at attrs.content, a structured block's is its attrs. A create also
// names the block's document index.
function stateOp(type, b, index) {
  var attrs = b.kind === 'prose' ? { content: b.content || '' } : (b.attrs || {})
  var op = { type: type, blockId: b.id || '', kind: b.kind, attrs: attrs }
  if (b.aliases && b.aliases.length) op.aliases = b.aliases
  if (type === 'create-block') op.index = index
  return op
}

// curr: [{ id, kind, content, attrs?, aliases? }] in document order. For prose,
// content is markdown; for structured, content is the attrs-JSON hash (used only
// as a change-signature) and attrs the bag a replace-block carries.
// prev: { [id]: sig } from the last successful sync, or null on the first call.
// → { mode: 'ops' | 'fallback', ops: [BlockOp], next: { [id]: sig } }
// isEmptyProse reports a prose block whose content is empty — a blank paragraph.
function isEmptyProse(b) {
  return b.kind === 'prose' && !(b.content && b.content.length)
}

// isPendingEmptyProse reports a brand-new blank prose paragraph that is just the
// TRAILING editing surface — no content-bearing block follows it. That one is
// ephemeral (excluded from the baseline and from ops; create-block fires on first
// content). A blank paragraph with content AFTER it is a STRUCTURAL blank line the
// user placed deliberately: a real block, born with an id, synced through the same
// create-block path as every other block.
function isPendingEmptyProse(b, prev, hasContentAfter) {
  return isEmptyProse(b) && !hasContentAfter && !(prev && b.id && b.id in prev)
}

// seedBaseline builds the initial change-signature map from the SERVER's blocks, so
// the first diff against it produces the right verb. EVERY id'd server block is
// included — an empty one too — because Go has it: editing it must be an
// update-block, never a duplicate create-block. It must NOT be routed through
// computeBlockSync's pending-empty filter, which would drop a loaded empty prose
// block and make its first content a create-block on an id Go already had. An
// id-less block has no server origin and is skipped.
export function seedBaseline(curr) {
  var next = {}
  for (var i = 0; i < (curr || []).length; i++) {
    var b = curr[i]
    if (b && b.id) next[b.id] = blockSig(b)
  }
  return next
}

// dedupeActions is the split-defense decision: given the ids of the top-level prose
// nodes in document order, return the INDICES of the 2nd-and-later occurrences of
// any NON-EMPTY id. ProseMirror's Enter copies the split node's attrs, so the new
// half is born carrying the original's id; the first occurrence keeps it and every
// later duplicate is RE-MINTED into a block of its own. Empty values are left
// untouched: an id-less node is the trailing editing surface, not a block yet.
// This pass assumes ONE top-level prose node per id.
export function dedupeActions(values) {
  var seen = {}
  var dup = []
  for (var i = 0; i < (values || []).length; i++) {
    var v = values[i]
    if (!v) continue
    if (seen[v]) { dup.push(i); continue }
    seen[v] = true
  }
  return dup
}

export function computeBlockSync(curr, prev) {
  var next = {}
  // Index of the LAST content-bearing block. A blank prose block before it has
  // content after it → structural; at or after it → trailing editing surface.
  var lastContentIdx = -1
  for (var j = 0; j < curr.length; j++) {
    if (!isEmptyProse(curr[j])) lastContentIdx = j
  }
  for (var i = 0; i < curr.length; i++) {
    var cb = curr[i]
    if (!cb.id) continue          // the trailing editing surface — not a block yet
    if (isPendingEmptyProse(cb, prev, i < lastContentIdx)) continue
    next[cb.id] = blockSig(cb)
  }

  // First call: just seed the baseline, never emit ops.
  if (!prev) return { ops: [], next: next }

  var ops = []
  for (var k = 0; k < curr.length; k++) {
    var p = curr[k]
    if (!p.id) continue                      // the trailing editing surface
    if (!(p.id in next)) continue            // ephemeral blank, not baselined
    if (!(p.id in prev)) { ops.push(stateOp('create-block', p, k)); continue }
    if (sigKind(prev[p.id]) !== p.kind) { ops.push(stateOp('replace-block', p, k)); continue }
    if (p.kind === 'prose' && prev[p.id] !== next[p.id]) ops.push(stateOp('update-block', p, k))
  }
  // Deletes are kind-agnostic. Every id here is one Go was told about — a block
  // reaches the baseline only by being loaded or created.
  for (var id in prev) {
    if (!(id in next)) {
      ops.push({ type: 'delete-block', blockId: id })
    }
  }
  return { ops: ops, next: next }
}

/**
 * computeOrderOp is the ORDER half of the observer. computeBlockSync is an id-keyed
 * diff and nothing in a signature is positional, so a drag-handle reorder changes no
 * signature and adds or removes no id: order is its own fact and needs its own op.
 *
 * It names the ID-BEARING top-level nodes, all of them, in document order: an
 * id-less node is an editing surface rather than a block, Go was never told about
 * one, and so it is SKIPPED — the statement is complete over the population both
 * sides share. Stating a whole order rather than a sequence of moves is what makes
 * it idempotent: a duplicated or late frame lands the document in the same place.
 *
 * It holds off for the one case where that population is still moving — the same
 * tick creates or deletes — leaving the baseline STALE deliberately, so the next
 * quiet tick still sees a difference and sends the order then.
 *
 * @param {Array<{id?: string}>} curr top-level blocks in document order
 * @param {string[]|null} prevIds the id order as of the last reported sync; null seeds
 * @param {Array<{type: string}>} ops the batch computeBlockSync produced this same tick
 * @returns {{op: {type: string, order: string[]}|null, next: string[]|null}}
 */
export function computeOrderOp(curr, prevIds, ops) {
  var blocks = curr || []
  var ids = []
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i]
    if (b && b.id) ids.push(b.id)
  }
  for (var j = 0; j < (ops || []).length; j++) {
    var t = ops[j] && ops[j].type
    if (t === 'create-block' || t === 'delete-block') return { op: null, next: prevIds }
  }
  if (!prevIds) return { op: null, next: ids }            // first call: seed only
  if (prevIds.length === ids.length) {
    var same = true
    for (var k = 0; k < ids.length; k++) {
      if (ids[k] !== prevIds[k]) { same = false; break }
    }
    if (same) return { op: null, next: ids }
  }
  return { op: { type: 'set-order', order: ids }, next: ids }
}
