package block

import (
	"sieve/ident"
	"sieve/logger"
)

// BlockIdentityMigrator upgrades a parsed block tree from the legacy short-handle
// scheme — 2 random bytes behind a 2-3 char kind prefix, 65,536 values with no
// collision check anywhere — to global UUIDs, repairing duplicate ids on the way.
// At 300 prose blocks in one document that scheme had a ~50% chance of a
// duplicate id (#75).
//
// It is deliberately NOT part of DocumentCodec.Deserialize. Deserialize is a pure
// parse, and minting identity as a side effect of READING would have the
// read-only parse paths — findBlockByID's markdown fallback, AI context building,
// the snapshot re-parse — mint ids that nothing persists and nothing can look up.
// Migration runs only where a save can follow: the document load path (NewShadow)
// and the /migrate-ids sweep.
//
// Migration creates NO aliases. Attrs["ref"] is the complete referrer set for a
// block id — nothing outside a document persists one (domain/, StateService,
// JobTracker and JobEngine carry no block-id field, and content links are
// https-only) — so rewriting refs in-document is exhaustive and verifiable.
type BlockIdentityMigrator struct{}

// Migrate returns the tree with every id a unique UUID and every in-document ref
// pointed at the new ids, plus whether anything changed. The input is never
// mutated: undo and the caller's snapshot both depend on that.
func (m BlockIdentityMigrator) Migrate(blocks []SieveBlock) ([]SieveBlock, bool) {
	if len(blocks) == 0 {
		return blocks, false
	}
	out, rename, changed := m.assignIDs(blocks)
	if m.rewriteRefs(out, rename) {
		changed = true
	}
	return out, changed
}

// assignIDs gives every block a unique UUID, returning the rewritten tree, the
// old→new map for legacy handles, and whether any id moved.
func (m BlockIdentityMigrator) assignIDs(blocks []SieveBlock) ([]SieveBlock, map[string]string, bool) {
	out := make([]SieveBlock, len(blocks))
	rename := make(map[string]string, len(blocks))
	taken := make(map[string]bool, len(blocks))
	changed := false

	for i, b := range blocks {
		switch {
		case !ident.Valid(b.ID):
			// Legacy handle. Record old→new FIRST-WINS, so a document carrying the
			// same short handle twice binds every ref to the first block in document
			// order — the pre-migration resolution order.
			newID := ident.New()
			if _, seen := rename[b.ID]; !seen {
				rename[b.ID] = newID
			}
			logger.Info("migrate: block id upgraded", "old", b.ID, "new", newID, "kind", b.Kind)
			b = b.reidentify(newID)
			changed = true

		case taken[b.ID]:
			// Already a UUID but duplicated — corruption or a hand-edit, since the
			// odds of a genuine v7 collision are nil. Repair and log rather than
			// refusing to load: a thinking tool must not make a note unopenable over
			// one bad id. Deliberately records NO rename entry — refs naming this
			// uuid belong to the first, legitimate holder.
			newID := ident.New()
			logger.Warn("migrate: duplicate block id repaired", "duplicate", b.ID, "new", newID, "kind", b.Kind)
			b = b.reidentify(newID)
			changed = true
		}
		taken[b.ID] = true
		out[i] = b
	}
	return out, rename, changed
}

// rewriteRefs points every outgoing ref at its target's new id, in place over the
// already-copied tree. Tokens absent from rename are left VERBATIM — they name a
// block this document does not contain, and guessing is worse than preserving.
func (m BlockIdentityMigrator) rewriteRefs(blocks []SieveBlock, rename map[string]string) bool {
	if len(rename) == 0 {
		return false
	}
	changed := false
	for i, b := range blocks {
		refs := b.outgoingRefs()
		if len(refs) == 0 {
			continue
		}
		dirty := false
		rewritten := make([]string, len(refs))
		for j, r := range refs {
			if nr, ok := rename[r]; ok {
				r, dirty = nr, true
			}
			rewritten[j] = r
		}
		if dirty {
			blocks[i] = b.withRefs(rewritten)
			changed = true
		}
	}
	return changed
}
