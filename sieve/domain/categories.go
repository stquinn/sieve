package domain

import "sieve/store"

// The three categories that define where Sieve data lives.
//
//	Constant     Isolation  Key       FileStore resolved path
//	──────────   ─────────  ───       ──────────────────────────────────
//	Library      Shared     "store"   {root}/store/
//	WorkingCopy  Isolated   "buffers" {root}/{hostname}/buffers/
//	State        Isolated   "config"  {root}/{hostname}/config/
//
// Note: Library uses Key "store" rather than "library" to match the existing
// on-disk layout. Renaming requires a storage migration — decision deferred.
var (
	// LibraryCategory holds filed notes. Shared across all hosts.
	LibraryCategory = store.Category{Key: "store", DisplayName: "Library", MetaEnabled: true, Isolation: store.Shared}
	// WorkingCopy holds in-progress buffers. Scoped to the current host.
	WorkingCopy = store.Category{Key: "buffers", DisplayName: "Working Copy", MetaEnabled: true, Isolation: store.Isolated}
	// State holds application state (settings, session). Scoped to the current host.
	State = store.Category{Key: "config", DisplayName: "State", MetaEnabled: false, Isolation: store.Isolated}
	// Prompts holds prompt template overrides. Scoped to the current host.
	Prompts = store.Category{Key: "prompts", DisplayName: "Prompts", MetaEnabled: false, Isolation: store.Isolated}
)
