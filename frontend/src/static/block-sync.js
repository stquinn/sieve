// block-sync.js — the thin-observer diff core (pure, D.4).
//
// The block document model syncs the editor to Go with granular block-ops, not a
// whole-document markdown blob. computeBlockSync is an id-keyed diff over the
// top-level blocks that emits create-block / update-block / delete-block ops.
//
// SCOPE: the observer owns PROSE blocks. Structured (sieve-*) blocks have their
// own sync channels — content via `sieve:block-update` ({attrs}), insertion via
// `editor:insert-block` — and their `serialisedForm` is a stable backend-sourced
// snapshot the frontend never mutates. So this observer must NOT emit content ops
// for structured blocks. A change that CREATES/DELETES/edits a structured block
// defers to the whole-document fallback this slice (unchanged from before);
// structured ops go granular in a later slice once their lifecycle is unified.
//
// The other fallback is DEFENSIVE: a block with no id can't be addressed. Prose
// identity is minted before the diff runs (server-side on Open, client-side for
// new blocks), so it should not normally fire.

// blockSig is a block's change-signature, prefixed with kind so a cached entry's
// kind is recoverable. Prose hashes on content + aliases; structured hashes on
// its stable serialisedForm content (carried in `content` for structured).
function blockSig(b) {
  return b.kind + '\x00' + (b.content || '') + '\x00' + ((b.aliases || []).join(','))
}

function sigKind(sig) {
  return sig.split('\x00', 1)[0]
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
// is markdown; for structured, content is the stable serialisedForm (used only as
// a change-signature, never emitted as an op here).
// prev: { [id]: sig } from the last successful sync, or null on the first call.
// → { mode: 'ops' | 'fallback', ops: [BlockOp], next: { [id]: sig } }
// isPendingEmptyProse reports a brand-new prose block with no content — the empty
// editing surface of a new doc. It is not a real block until the user types, so
// it is excluded from the baseline + ops; create-block fires on first content.
function isPendingEmptyProse(b, prev) {
  return b.kind === 'prose' && !(b.content && b.content.length) && !(prev && b.id in prev)
}

export function computeBlockSync(curr, prev) {
  var next = {}
  var anyEmptyId = false
  for (var i = 0; i < curr.length; i++) {
    var cb = curr[i]
    if (!cb.id) { anyEmptyId = true; continue }
    if (isPendingEmptyProse(cb, prev)) continue
    next[cb.id] = blockSig(cb)
  }

  // Can't address a block without an id → defensive whole-document fallback.
  if (anyEmptyId) return { mode: 'fallback', ops: [], next: next }

  // First call: just seed the baseline, never emit ops.
  if (!prev) return { mode: 'ops', ops: [], next: next }

  // Any structured (non-prose) block created, deleted, or changed → fall back to
  // a whole-document update this slice (structured sync is not granular yet).
  for (var c = 0; c < curr.length; c++) {
    var b = curr[c]
    if (b.kind === 'prose') continue
    if (!(b.id in prev) || prev[b.id] !== next[b.id]) {
      return { mode: 'fallback', ops: [], next: next }
    }
  }
  for (var pid in prev) {
    if (sigKind(prev[pid]) !== 'prose' && !(pid in next)) {
      return { mode: 'fallback', ops: [], next: next }
    }
  }

  // Structured blocks are stable → emit granular PROSE create/update/delete.
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
  for (var id in prev) {
    if (sigKind(prev[id]) === 'prose' && !(id in next)) {
      ops.push({ type: 'delete-block', blockId: id })
    }
  }
  return { mode: 'ops', ops: ops, next: next }
}

if (typeof window !== 'undefined') {
  window.TipTap = window.TipTap || {}
  window.TipTap.computeBlockSync = computeBlockSync
}
