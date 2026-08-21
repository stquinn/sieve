// block-sync.js — the thin-observer diff core (pure, D.4).
//
// The block document model syncs the editor to Go with granular block-ops, not a
// whole-document markdown blob. computeBlockSync is an id-keyed diff over the
// top-level blocks that emits create-block / update-block / delete-block ops.
//
// SCOPE: the observer owns PROSE block content. Structured (sieve-*) blocks have
// their own sync channels — content via BlockService.updateAttributes (an
// update-block op built here by updateBlockOp, framed by the service), insertion
// via the `insert-block` render-back (surface applyServerOp) — and their change-signature is a hash of their attrs
// (the frontend never serialises them to markdown). So this observer emits no
// create/update content op for a structured block; it tracks them only for the
// baseline and for DELETE detection (a delete-block is kind-agnostic).
//
// There is NO whole-document fallback. Every WYSIWYG edit is a granular block-op
// over the WS — that is the only channel. (Markdown mode is a separate, verbatim
// breakglass buffer, also over the WS, handled in editor.js.) An id-less node is a
// pending editing surface (the minting plugin fills its id before the next sync)
// and is simply skipped — never a fallback.

// blockSig is a block's change-signature, prefixed with kind so a cached entry's
// kind is recoverable. Prose hashes on content + aliases; structured hashes on its
// attrs-JSON (carried in `content` for structured — a signature, never an op body).
function blockSig(b) {
  return b.kind + '\x00' + (b.content || '') + '\x00' + ((b.aliases || []).join(','))
}

// blockOp is the single block-op constructor. EVERY kind's payload rides in
// `attrs` (prose's body at attrs.content, exactly as code's at attrs.source) —
// there is no kind-special-cased top-level field on the wire. aliases are an
// optional field; create-block carries its document index. Both the prose
// observer (proseOp) and the service verbs (updateBlockOp inside
// BlockService.updateAttributes; DocumentService's explicit-index create)
// build through here, so prose and structured updates emit a byte-identical
// shape. Exported for DocumentService, which must reproduce proseOp's exact
// key order for the wysiwyg observer's prose creates.
export function blockOp(type, blockId, kind, attrs, aliases, index) {
  var op = { type: type, blockId: blockId, kind: kind, attrs: attrs || {} }
  if (aliases && aliases.length) op.aliases = aliases
  if (type === 'create-block') op.index = index
  return op
}

// proseOp builds a create/update op for a prose block. Prose's body rides in
// attrs.content. A pending CREATE carries a transient correlation TOKEN (not a
// durable id) and an empty blockId, so Go mints the durable id and echoes the
// token back (insert-block). update/loaded nodes carry their durable id.
export function proseOp(type, b, index) {
  var op = blockOp(type, b.id || '', 'prose', { content: b.content || '' }, b.aliases, index)
  if (type === 'create-block' && b.token) op.token = b.token
  return op
}

// updateBlockOp maps a structured block edit detail ({ id, kind, attrs,
// aliases? }, built by BlockService.updateAttributes from its blockId→kind
// index) to an update-block block-op — the same shape proseOp emits. Both
// rides converge on ONE wire op, retiring the bespoke block-update message:
// every block update, prose or structured, is a block-op
// {update-block, blockId, kind, attrs, aliases?}.
export function updateBlockOp(detail) {
  return blockOp('update-block', detail.id, detail.kind, detail.attrs, detail.aliases)
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
// user placed deliberately — it is a real block, so it acquires a token and syncs
// through the SAME create-block path as every other block (no special case), and
// round-trips as its own delimited prose block. Keyed by id || token: a real block
// in flight is addressed by its transient token until the backend id acks (B-A).
function isPendingEmptyProse(b, prev, hasContentAfter) {
  var key = b.id || b.token
  return isEmptyProse(b) && !hasContentAfter && !(prev && key && key in prev)
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

// dedupeActions is the split-defense decision: given the identity values (ids or
// tokens) of the top-level prose nodes in document order, return the INDICES of
// the 2nd-and-later occurrences of any NON-EMPTY value. ProseMirror's Enter copies
// the split node's attrs, so the new half is born carrying the original's id/token;
// the first occurrence keeps it, every later duplicate is CLEARED (not re-minted —
// the frontend never invents durable identity). Empty values are left untouched:
// an id-less node is legitimately pending (it acquires a token, then a backend id).
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
    var key = cb.id || cb.token   // durable id once acked, else the in-flight token
    if (!key) continue            // an id-less, token-less surface — not addressable
    if (isPendingEmptyProse(cb, prev, i < lastContentIdx)) continue
    // While a prose create is IN FLIGHT (token already baselined, awaiting the backend
    // id), PIN its baseline to what Go received (prev[token]) — do NOT advance it to the
    // current editor content. Otherwise an edit made during the flight is masked:
    // reconcilePendingToken copies this baseline onto the real id, and if it already held
    // the latest content the post-ack diff would emit no update-block → silent prose loss.
    if (!cb.id && cb.token && prev && (cb.token in prev)) {
      next[key] = prev[key]
    } else {
      next[key] = blockSig(cb)
    }
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
    if (p.id) {
      // A node with a durable id: created already (in prev) → update on change.
      if (!(p.id in next)) continue
      if (!(p.id in prev)) ops.push(proseOp('create-block', p, k))
      else if (prev[p.id] !== next[p.id]) ops.push(proseOp('update-block', p, k))
    } else if (p.token) {
      // Pending: emit ONE create carrying the token; skip while it is in flight.
      if (!(p.token in next)) continue       // empty pending surface, not baselined
      if (!(p.token in prev)) ops.push(proseOp('create-block', p, k))
      // p.token in prev → in flight, awaiting the backend id → SKIP.
    }
  }
  // Deletes are kind-agnostic, BUT an in-flight token (tok-…) is not a backend id —
  // deleting it would 404. A node deleted while its create is in flight is handled
  // by the insert-block ack (it deletes by the real id once known).
  for (var id in prev) {
    if (id.indexOf('tok-') === 0) continue
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
 *   - some node is id-less / in flight (Go mints ids; a token is not one).
 *
 * In both cases the baseline is left STALE deliberately, so the next quiet tick
 * still sees a difference and sends the order then.
 *
 * @param {Array<{id?: string, token?: string}>} curr top-level blocks in document order
 * @param {string[]|null} prevIds the id order as of the last reported sync; null seeds
 * @param {Array<{type: string}>} ops the batch computeBlockSync produced this same tick
 * @returns {{op: {type: string, order: string[]}|null, next: string[]|null}}
 */
export function computeOrderOp(curr, prevIds, ops) {
  var blocks = curr || []
  var ids = []
  for (var i = 0; i < blocks.length; i++) {
    var b = blocks[i]
    if (!b || !b.id) return { op: null, next: prevIds }   // id-less / in flight
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
