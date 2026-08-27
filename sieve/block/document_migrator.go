package block

// DocumentMigrator is the one load-time migration pipeline: the document load
// path (NewShadow) and the /migrate-ids sweep both run it, and a new migration is
// added here rather than at each caller.
//
// It runs on the parsed tree, never inside DocumentCodec.Deserialize, which is a
// pure parse: rewriting persisted content is a side effect only a
// load-that-can-save path may take.
type DocumentMigrator struct{}

// Migrate runs every load-time migration in order and reports whether any of
// them changed the tree. documentUUID is the container ReferenceMigrator mints
// against when folding a relative or src-only reference to its absolute form. The
// input is never mutated.
//
// ORDER IS LOAD-BEARING at both ends: identity runs first so every later step
// sees canonical ids, and AIBlockMigrator runs last so the addresses it copies
// into question elements have already been rewritten to their current spelling.
func (m DocumentMigrator) Migrate(blocks []SieveBlock, documentUUID string) ([]SieveBlock, bool) {
	blocks, idsChanged := BlockIdentityMigrator{}.Migrate(blocks)
	blocks, urlsChanged := AssetURLMigrator{}.Migrate(blocks)
	blocks, urisChanged := ReferenceMigrator{}.Migrate(blocks, documentUUID)
	blocks, questionsChanged := AIBlockMigrator{}.Migrate(blocks, documentUUID)
	return blocks, idsChanged || urlsChanged || urisChanged || questionsChanged
}
