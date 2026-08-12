package block

// Handle / ref resolution helpers.
//
// Refs are best-effort pointers: resolution, not referential integrity. A
// dangling outgoing ref — one naming a handle nothing answers to — may be
// stripped on save; that is gcRefs. These are pure transforms; the live
// ref-producer that supplies the "resolvable" set is not wired yet.
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

// gcRefs returns this block's outgoing refs (Attrs["ref"]) filtered to those
// that resolve against the index, deduped in first-seen order.
func (b SieveBlock) gcRefs(resolvable map[string]bool) []string {
	var out []string
	seen := map[string]bool{}
	for _, r := range b.outgoingRefs() {
		if resolvable[r] && !seen[r] {
			seen[r] = true
			out = append(out, r)
		}
	}
	return out
}
