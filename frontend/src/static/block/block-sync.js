// block-sync.js — the thin-observer diff core (pure, D.4).
//
// The block document model syncs the editor to Go with granular block-ops, not a
// whole-document markdown blob. computeBlockSync is an id-keyed diff over the
// top-level blocks that emits create-block / update-block / delete-block ops.
//
// SCOPE: the observer owns PROSE block content. Structured (sieve-*) blocks have
// their own sync channels — content via `sieve:block-update` ({attrs}), insertion
// via `editor:insert-block` — and their change-signature is a hash of their attrs
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
// observer (proseOp) and structured NodeView edits (updateBlockOp) build through
// here, so prose and structured updates emit a byte-identical shape.
function blockOp(type, blockId, kind, attrs, aliases, index) {
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

// updateBlockOp maps a structured NodeView edit detail ({ id, kind, attrs,
// aliases? }, dispatched as `sieve:block-update`) to an update-block block-op —
// the same shape proseOp emits. Both rides converge on ONE wire op, retiring the
// bespoke block-update message: every block update, prose or structured, is a
// block-op {update-block, blockId, kind, attrs, aliases?}.
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

// mintActions is the pure minting decision (D-r.4). Given the blockIds of the
// top-level nodes in document order, it returns the INDICES that need a fresh id:
// an id that is EMPTY (a brand-new node — paste, gap-cursor paragraph) or one
// ALREADY SEEN earlier in the pass. The duplicate case is THE splitBlock trap:
// ProseMirror's Enter copies the split node's attributes, so the new half is born
// carrying the original's blockId. The first occurrence keeps the id; the later
// duplicate is re-minted, so split → original keeps its id + the new half gets a
// fresh one → exactly one create-block. Minting only FILLS ids (it creates no
// nodes), so re-running over the result flags nothing → convergent (no runaway).
export function mintActions(ids) {
  var seen = {}
  var need = []
  for (var i = 0; i < (ids || []).length; i++) {
    var id = ids[i]
    if (!id || seen[id]) { need.push(i); continue }
    seen[id] = true
  }
  return need
}

// dedupeActions is the split-defense decision: given the identity values (ids or
// tokens) of the top-level prose nodes in document order, return the INDICES of
// the 2nd-and-later occurrences of any NON-EMPTY value. ProseMirror's Enter copies
// the split node's attrs, so the new half is born carrying the original's id/token;
// the first occurrence keeps it, every later duplicate is CLEARED (not re-minted —
// the frontend never invents durable identity). Empty values are left untouched:
// an id-less node is legitimately pending (it acquires a token, then a backend id).
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
    next[key] = blockSig(cb)
  }

  // First call: just seed the baseline, never emit ops.
  if (!prev) return { ops: [], next: next }

  // Creates + updates in document order. PROSE is observed here; STRUCTURED
  // creates/changes emit NOTHING — they sync through their own channels
  // (`sieve:block-update` for edits, `editor:insert-block` for creation). The
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
  // Deletes are kind-agnostic: an id in prev that is gone → delete-block (Go's
  // delete-block op drops a block of any kind by id).
  for (var id in prev) {
    if (!(id in next)) {
      ops.push({ type: 'delete-block', blockId: id })
    }
  }
  return { ops: ops, next: next }
}

if (typeof window !== 'undefined') {
  window.TipTap = window.TipTap || {}
  window.TipTap.computeBlockSync = computeBlockSync
  window.TipTap.seedBaseline = seedBaseline
  window.TipTap.mintActions = mintActions
  window.TipTap.dedupeActions = dedupeActions
  window.TipTap.updateBlockOp = updateBlockOp
}
