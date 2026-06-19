package sieve

// Stage B.4 — handle / ref garbage collection (spec §7).
//
// Refs are best-effort pointers: resolution, not referential integrity. On save
// the GC enforces two rules from spec §7:
//   - dangling outgoing refs are stripped (a ref to a handle nothing answers to)
//   - alias handles nothing points to are dropped (a block stops answering to a
//     handle once no ref targets it; its primary ID always persists as identity)
//
// These are pure transforms. The live ref-producer that supplies the
// "resolvable" / "referenced" sets is wired in later stages (E/F); here the
// rules are proven in isolation, consistent with the Stage A/B testability bar.

// collectHandles returns the set of every handle present — each block's primary
// ID plus its aliases. This is the resolution index: a ref resolves iff its
// target is in this set. (Also the basis for the Stage F structured-facet search
// index.) Flat today; Stage E containers re-introduce a tree walk via the Node
// interface.
func collectHandles(blocks []DocBlock) map[string]bool {
	out := map[string]bool{}
	for _, b := range blocks {
		for _, h := range b.answersTo() {
			out[h] = true
		}
	}
	return out
}

// gcRefs strips outgoing refs that do not resolve against the given set, and
// dedupes while preserving first-seen order.
func gcRefs(refs []string, resolvable map[string]bool) []string {
	var out []string
	seen := map[string]bool{}
	for _, r := range refs {
		if resolvable[r] && !seen[r] {
			seen[r] = true
			out = append(out, r)
		}
	}
	return out
}

// gcAliases returns a copy of the tree with each block's alias handles filtered
// to those that something still references. Primary IDs are never dropped. The
// input doc is not mutated, so undo can restore the prior assignment.
func gcAliases(blocks []DocBlock, referenced map[string]bool) []DocBlock {
	return gcAliasesBlocks(blocks, referenced)
}

func gcAliasesBlocks(blocks []DocBlock, referenced map[string]bool) []DocBlock {
	if blocks == nil {
		return nil
	}
	out := make([]DocBlock, len(blocks))
	for i, b := range blocks {
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
