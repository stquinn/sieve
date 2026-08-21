package block

// DocumentMigrator is the one load-time migration pipeline, so every call site
// gets every migration: the document load path (NewShadow) and the /migrate-ids
// sweep both run this, and a new migration is added HERE once rather than at each
// caller, where one of them would quietly be missed.
//
// Like its steps it runs on the parsed tree, never inside
// DocumentCodec.Deserialize: Deserialize is a pure parse, and rewriting persisted
// content is a side effect only a load-that-can-save path may take.
type DocumentMigrator struct{}

// Migrate runs every load-time migration in order and reports whether any of them
// changed the tree. The input is never mutated: undo and the caller's snapshot
// both depend on that.
func (m DocumentMigrator) Migrate(blocks []SieveBlock) ([]SieveBlock, bool) {
	blocks, idsChanged := BlockIdentityMigrator{}.Migrate(blocks)
	blocks, urlsChanged := AssetURLMigrator{}.Migrate(blocks)
	return blocks, idsChanged || urlsChanged
}
