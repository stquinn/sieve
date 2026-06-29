package block

// Stage B.4 — handle / ref garbage collection (spec §7).
//
// Refs are best-effort pointers: resolution, not referential integrity. On save
// the GC enforces two rules from spec §7:
//   - dangling outgoing refs are stripped (a ref to a handle nothing answers to)
//   - alias handles nothing points to are dropped (a block stops answering to a
//     handle once no ref targets it; its primary ID always persists as identity)
//
// These are pure transforms. The live ref-producer that supplies the
// "resolvable" / "referenced" sets is wired in later stages (E/F); the Stage E/F
// orchestrator will be a ShadowDocument method that chains these.

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

// gcAliases returns a copy of this document's block tree with each block's alias
// handles filtered to those still referenced. Primary IDs are never dropped. The
// live tree is not mutated, so undo can restore the prior assignment.
func (s *ShadowDocument) gcAliases(referenced map[string]bool) []SieveBlock {
	if s.Blocks == nil {
		return nil
	}
	out := make([]SieveBlock, len(s.Blocks))
	for i, b := range s.Blocks {
		var kept []string
		for _, a := range b.Aliases {
			if referenced[a] {
				kept = append(kept, a)
			}
		}
		b.Aliases = kept
		out[i] = b
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
