package block

// Handle / ref resolution helpers.
//
// Refs are best-effort pointers: resolution, not referential integrity. A
// dangling outgoing ref — one naming a handle nothing answers to — may be
// stripped on save; that is gcRefs. No live ref-producer supplies the
// "resolvable" set yet.
//
// These helpers return a new list and write no ref back, but they are NOT
// side-effect-free. gcRefs reads a block's edges through outgoingRefs, which
// consults the processor registry — a kind whose processor is not registered
// shows none of the element edges it holds — and reading a parent's elements
// mints an id into any stored entry that arrived without one. Whoever wires the
// producer must run the GC over a tree whose kinds are registered, and where a
// save can follow.
//
// There is deliberately NO alias GC. Aliases are durable by intent: one is only
// ever GIVEN to a block by a deliberate act (a declared name, a domain-meaningful
// handle), never accumulated — the prose-merge path that once accumulated them
// was cut 2026-06-19, and identity migration creates none (#75). A declared name
// has no referrers BY DEFINITION — that is the point of it — so collecting
// unreferenced aliases would drop exactly the ones worth keeping.

// collectHandles builds the resolution index over this document's blocks: every
// block's primary ID plus its aliases. A ref resolves iff its target is here.
func (s *ShadowDocument) collectHandles() map[string]bool {
	out := map[string]bool{}
	for _, b := range s.Blocks {
		for _, h := range b.answersTo() {
			out[h] = true
		}
	}
	return out
}

// gcRefs returns this block's outgoing refs filtered to those that resolve
// against the index, deduped in first-seen order. container is the document the
// block lives in, which outgoingRefs needs to recognise a local element edge.
func (b SieveBlock) gcRefs(container string, resolvable map[string]bool) []string {
	var out []string
	seen := map[string]bool{}
	for _, r := range b.outgoingRefs(container) {
		if resolvable[r] && !seen[r] {
			seen[r] = true
			out = append(out, r)
		}
	}
	return out
}
