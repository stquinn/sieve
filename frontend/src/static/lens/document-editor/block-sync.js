// block-sync.js — the thin-observer diff core (pure, D.4).
//
// The block document model syncs the editor to Go with granular block-ops, not a
// whole-document markdown blob. computeBlockSync is an id-keyed diff over the
// top-level blocks that emits create-block / update-block / delete-block ops.
//
// SCOPE: the observer owns PROSE block content. Structured (sieve-*) blocks have
// their own sync channels — content via the container provider's own verbs (an
// update-block op built here by updateBlockOp, framed by the host), arrival via
// the container cue — and their change-signature is a hash of their attrs
// (the frontend never serialises them to markdown). So this observer emits no
// create/update content op for a structured block; it tracks them only for the
// baseline and for DELETE detection (a delete-block is kind-agnostic).
//
// There is NO whole-document fallback. Every WYSIWYG edit is a granular block-op
// over the WS — that is the only channel. (Markdown mode is a separate, verbatim
// breakglass buffer, also over the WS.) An id-less node is the trailing editing
// surface, not a block yet, and is simply skipped — never a fallback.

// blockSig is a block's change-signature, prefixed with kind so a cached entry's
// kind is recoverable. Prose hashes on content + aliases; structured hashes on its
// attrs-JSON (carried in `content` for structured — a signature, never an op body).
function blockSig(b) {
  return b.kind + '\x00' + (b.content || '') + '\x00' + ((b.aliases || []).join(','))
}

// proseOp builds a create/update entry for a prose block, the batch's only
// content-bearing shape. Prose's body rides in attrs.content. A CREATE states
// the id the LENS minted (issue #96): a UUIDv7 is unique without coordination,
// so the block is born with the name Go will know it by and there is no handle
// to correlate or swap afterwards. Go validates the name and adopts it.
//
// The batch is the observer's INTERNAL result — WysiwygSurface turns each entry
// into a facade verb (#submitOps) and nothing here reaches the wire, so this
// deliberately does not reuse container/block-ops.js: reaching across for that
// constructor would put the host's wire vocabulary inside a lens.
export function proseOp(type, b, index) {
  var op = { type: type, blockId: b.id || '', kind: 'prose', attrs: { content: b.content || '' } }
  if (b.aliases && b.aliases.length) op.aliases = b.aliases
  if (type === 'create-block') op.index = index
  return op
}

// curr: [{ id, kind, content, aliases? }] in document order. For prose, content
// is markdown; for structured, content is the attrs-JSON hash (used only as a
// change-signature, never emitted as an op here).
// prev: { [id]: sig } from the last successful sync, or null on the first call.
// → { mode: 'ops' | 'fallback', ops: [BlockOp], next: { [id]: sig } }
// isEmptyProse reports a prose block whose content is empty — a blank paragraph.
function isEmptyProse(b) {
  return b.kind === 'prose' && !(b.content && b.content.length)
}

// isPendingEmptyProse reports a brand-new blank prose paragraph that is just the
// TRAILING editing surface — no content-bearing block of any kind follows it. That
// one is ephemeral (excluded from the baseline + ops; create-block fires on first
// content). A blank paragraph with content AFTER it is a STRUCTURAL blank line the
// user placed deliberately — it is a real block, so it is born with an id and syncs
// through the SAME create-block path as every other block (no special case), and
// round-trips as its own delimited prose block.
function isPendingEmptyProse(b, prev, hasContentAfter) {
  return isEmptyProse(b) && !hasContentAfter && !(prev && b.id && b.id in prev)
}

// seedBaseline builds the initial change-signature map directly from the SERVER's
// blocks (what Go already holds), so the first diff against it produces the right
// verb. EVERY id'd server block is included — including an empty one — because Go
// has it: editing it must be an update-block, never a duplicate create-block. (We
// must NOT route this through computeBlockSync's pending-empty filter, which would
// drop a loaded empty prose block from the baseline and make its first content
// create-block an id Go already had → two blocks with one id on disk.) An id-less
// block (a fresh client surface with no server origin) is skipped — it becomes a
// real block, via create-block, once it has an id + content.
export function seedBaseline(curr) {
  var next = {}
  for (var i = 0; i < (curr || []).length; i++) {
    var b = curr[i]
    if (b && b.id) next[b.id] = blockSig(b)
  }
  return next
}

// dedupeActions is the split-defense decision: given the ids of the top-level
// prose nodes in document order, return the INDICES of the 2nd-and-later
// occurrences of any NON-EMPTY id. ProseMirror's Enter copies the split node's
// attrs, so the new half is born carrying the original's id; the first occurrence
// keeps it and every later duplicate is RE-MINTED into a block of its own (issue
// #96). Empty values are left untouched: an id-less node is the trailing editing
// surface, which is not a block yet.
// NOTE (E-1 forward): this pass assumes ONE top-level prose node per id. If E-1's
// proseGroup is ever represented as several top-level nodes sharing one backend id,
// this clears all-but-first; keep a proseGroup as a single top-level node instead.
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
  // Index of the LAST content-bearing block (any kind that is not a blank prose
  // paragraph). A blank prose block before this index has content after it →
  // structural; at or after it → trailing editing surface.
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

  // Creates + updates in document order. PROSE is observed here; STRUCTURED
  // creates/changes emit NOTHING — they sync through their own channels
  // (ctx.updateAttributes for edits, the `insert-block` render-back for creation). The
  // observer tracks structured blocks only for the baseline + delete detection.
  var ops = []
  for (var k = 0; k < curr.length; k++) {
    var p = curr[k]
    if (p.kind !== 'prose') continue
    if (!p.id) continue                      // the trailing editing surface
    if (!(p.id in next)) continue            // ephemeral blank, not baselined
    if (!(p.id in prev)) ops.push(proseOp('create-block', p, k))
    else if (prev[p.id] !== next[p.id]) ops.push(proseOp('update-block', p, k))
  }
  // Deletes are kind-agnostic. Every id here is one Go was told about, because a
  // block reaches the baseline only by being loaded or created — so a delete
  // always names something the server can find.
  for (var id in prev) {
    if (!(id in next)) {
      ops.push({ type: 'delete-block', blockId: id })
    }
  }
  return { ops: ops, next: next }
}

/**
 * computeOrderOp is the ORDER half of the observer (#94). computeBlockSync is an
 * id-keyed diff — a block's signature is kind + content + aliases, and nothing in
 * it is positional — so a drag-handle reorder changed no signature, added no id
 * and removed none. The batch came out empty and the reorder was lost on the next
 * load. Order is its own fact and needs its own op.
 *
 * It reports the COMPLETE id order rather than a sequence of moves, because
 * installing a whole order is idempotent: a duplicated or late frame lands the
 * document in the same place. Go refuses anything that is not a permutation of
 * what it holds (ShadowDocument.setOrder), since a list missing one id is
 * indistinguishable from a mass delete — which is why this holds off whenever the
 * client cannot yet name every block the server has:
 *
 *   - the same tick creates or deletes (the sets are still moving), or
 *   - some node is id-less (the trailing editing surface is not a block yet).
 *
 * In both cases the baseline is left STALE deliberately, so the next quiet tick
 * still sees a difference and sends the order then.
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
    if (!b || !b.id) return { op: null, next: prevIds }   // id-less trailing surface
    ids.push(b.id)
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
