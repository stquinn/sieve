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

// proseOp builds a create/update op for a prose block; aliases ride along when
// present, and create carries its document index.
function proseOp(type, b, index) {
  var op = { type: type, blockId: b.id, kind: 'prose', content: b.content || '' }
  if (b.aliases && b.aliases.length) op.aliases = b.aliases
  if (type === 'create-block') op.index = index
  return op
}

// curr: [{ id, kind, content, aliases? }] in document order. For prose, content
// is markdown; for structured, content is the attrs-JSON hash (used only as a
// change-signature, never emitted as an op here).
// prev: { [id]: sig } from the last successful sync, or null on the first call.
// → { mode: 'ops' | 'fallback', ops: [BlockOp], next: { [id]: sig } }
// isPendingEmptyProse reports a brand-new prose block with no content — the empty
// editing surface of a new doc. It is not a real block until the user types, so
// it is excluded from the baseline + ops; create-block fires on first content.
function isPendingEmptyProse(b, prev) {
  return b.kind === 'prose' && !(b.content && b.content.length) && !(prev && b.id in prev)
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

export function computeBlockSync(curr, prev) {
  var next = {}
  for (var i = 0; i < curr.length; i++) {
    var cb = curr[i]
    if (!cb.id) {
      // An id-less node is not yet addressable, so it is SKIPPED (emits nothing,
      // not baselined). For PROSE that is a pending editing surface — the minting
      // plugin fills its id before the next sync. A STRUCTURED block should always
      // carry a backend-authoritative id; if one ever arrives id-less it simply
      // waits. There is NO whole-document fallback — every edit is a block-op.
      continue
    }
    if (isPendingEmptyProse(cb, prev)) continue
    next[cb.id] = blockSig(cb)
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
    if (!(p.id in next)) continue // pending empty surface — not a real block yet
    if (!(p.id in prev)) {
      ops.push(proseOp('create-block', p, k))
    } else if (prev[p.id] !== next[p.id]) {
      ops.push(proseOp('update-block', p, k))
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
}
