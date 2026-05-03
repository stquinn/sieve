// Package store defines the persistence boundary for Sieve.
//
// One place touches storage — everything else uses the results.
//
// Nothing in the business layer, UI, or editor constructs paths, reads files,
// or writes to disk directly. The Store interface is the single boundary, and
// it holds regardless of whether the backend is a filesystem, a database, or
// an HTTP API.
//
// # Abstraction layers
//
//	store/          — interfaces and value types only; no I/O
//	store/filestore — FileStore implementation backed by the local filesystem
//	sieve/          — business layer: Buffer, Note, DocumentMeta, services
//	app.go          — thin Wails bridge: calls a service, converts to DTO
//
// # Ownership graph
//
// Every Storable belongs to a Category. FolderStorables own MetaStorables,
// which own AssetStorables. The Store walks this graph to derive ExternalRef
// at read time — nothing is stored.
//
// # Immutability
//
// Every Store mutation returns a new Storable. The input is stale the moment
// the call returns. Callers must replace their reference with the returned
// value. The only in-place mutations are the three editor surfaces on
// MetaStorable: SetBody, SetMeta, and the Owns list.
package store

// IsolationLevel determines whether a Category's data is shared across all
// contexts or scoped to the current host and user.
type IsolationLevel int

const (
	// Shared data is accessible from all hosts — e.g. the note library.
	Shared IsolationLevel = iota
	// Isolated data is scoped to the current host and user — e.g. working
	// buffers and application state.
	Isolated
)

// Category classifies a Storable and tells the Store how to resolve its
// physical location. Each backend interprets Key in its natural way:
//
//   - FileStore   — directory name
//   - SQLiteStore — table scope or partition key
//   - HTTPStore   — URL path segment
//
// Category has three distinct identifiers that must not be conflated:
//   - Go constant  (Library, WorkingCopy, State) — how code references it
//   - Key          ("store", "buffers", "config") — backend-facing identifier
//   - DisplayName  ("Library", "Working Copy", "State") — user-facing label
type Category struct {
	// Key is the backend-facing identifier. FileStore uses it as a directory
	// name with no translation. Keep Key values stable across releases —
	// changing them requires a storage migration.
	Key string
	// DisplayName is the user-facing label for the category.
	DisplayName string

	//INdicator that the category is for Storeables that Contain Meta Blocks
	MetaEnabled bool
	// Isolation determines whether data is shared across hosts or scoped to
	// the current host and user.
	Isolation IsolationLevel
}

// The concrete Category values (Library, WorkingCopy, State) are defined in the
// business layer (sieve package) — they are application concepts, not store
// infrastructure. The store package only defines the Category type and the
// IsolationLevel constants that govern how data is partitioned.
