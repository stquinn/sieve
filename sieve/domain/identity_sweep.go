package domain

// IdentitySweepResult reports what a library-wide block-id migration did (#75).
//
// It lives in domain because the two halves of that operation sit in packages
// that cannot import each other: the sweep itself needs block/ (the codec and
// the migrator) and services/ (documents), which only editor/ has; the
// /migrate-ids command that drives it lives in command/, and command/ cannot
// import block/ — block → ai → command is an existing edge. A shared leaf type
// lets the port between them be typed without a new package dependency.
type IdentitySweepResult struct {
	// Scanned is every document the sweep read.
	Scanned int
	// Migrated is the documents that carried at least one legacy or duplicate id
	// and were rewritten. A document with nothing to upgrade is never rewritten,
	// so a clean library produces no version churn.
	Migrated int
	// BlocksReidentified is the total blocks given a new id across all documents.
	BlocksReidentified int
	// Failures describe documents the sweep could not process, one line each. A
	// failure is counted and skipped — one bad document must not abort the sweep.
	Failures []string
}
