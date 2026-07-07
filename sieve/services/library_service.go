package services

import (
	"path/filepath"
	"strings"
	"unicode"
)

// Library identifies a knowledge base by an opaque reference and a human-readable name.
// The Ref is treated as opaque by all callers above the service layer — the current
// file-backed implementation uses a filesystem path, but a future backend may use
// a connection string, UUID, or URL.
type Library struct {
	Ref  string `json:"ref"`
	Name string `json:"name"`
}

// LibraryService is the single abstraction for all library-level operations:
// discovery (which library to open on startup), recents, validation, naming, AND
// the lifecycle of opening, switching and initialising a library. Everything
// above this layer — App, handlers, menus — talks only to LibraryService.
// Swapping the backing store means a new implementation, not rewired callers.
//
// There is exactly ONE implementation: sieve.FileLibraryService (the file-backed
// store). It lives in package sieve rather than here because Open must call
// ServiceProvider.Init and construct a concrete filestore.FileStore, which
// package services cannot import without a cycle. The narrow collaborator
// contracts it depends on (LibraryNamer, LibraryRecorder, Library) and the
// LibraryDisplayName helper stay here so the config package can reuse them.
//
// Path/layout knowledge (notes dir, resolve, theme override) is deliberately NOT
// on this interface — that is file-backend specific and would break the "Ref is
// opaque" contract for a future S3/URL backend. The concrete implementation
// exposes those as extra methods that only App (composition-root adjacent) holds.
type LibraryService interface {
	// BestOnStartup returns the ID of the best library to open given optional
	// CLI arg and environment variable overrides. It checks those, then recents,
	// then falls back to cwd. Returns "" if no valid library is found.
	BestOnStartup(cliArg, envVar string) string

	// Attach binds the service to the active store after it has been opened.
	// Must be called after the store is created so Current() can read the name.
	Attach(id string, namer LibraryNamer)

	// Current returns the active library. Requires Attach to have been called.
	Current() Library

	// Recent returns the machine-level recents list, newest first.
	Recent() []Library

	// Validate reports whether id is a valid library that can be opened.
	Validate(id string) error

	// RecordSwitch updates the recents list after a successful switch.
	// Call this after Attach completes.
	RecordSwitch(id string)

	// DisplayName derives a human-readable name from an opaque library ID.
	DisplayName(id string) string

	// Open resolves, validates and opens the library at path, wiring services
	// and broadcasting library:changed on success. Returns the resolved library
	// ID, or "" if it fell back to bootstrap mode (no valid library). The
	// isFirstStartup flag enables the recents/cwd fallback used on cold start.
	Open(path string, isFirstStartup bool) (string, error)

	// Switch closes the active editor then opens the library at path. Returns the
	// resolved ID, or an error if path is invalid or fails to load.
	Switch(path string) (string, error)

	// InitAt creates the directory at path (expanding a leading ~), opens it as a
	// library, and records it as the last-used store in global config.
	InitAt(path string) error
}

// LibraryNamer is the narrow store-layer contract required by LibraryService.
// filestore.FileStore satisfies it by reading the .sieve marker.
type LibraryNamer interface {
	LibraryName() string
}

// LibraryRecorder persists the machine-level recents list.
// The concrete implementation (config.Recorder) reads and writes
// GlobalConfig on every call — no state is held in memory.
type LibraryRecorder interface {
	Recent() []Library
	AddRecent(lib Library)
	LastUsed() string      // last-used library ID, for startup fallback
	SetLastUsed(id string) // persisted alongside recents
}

// LibraryDisplayName converts an opaque library ID to a human-readable name.
// For file-based stores the ID is a path: the basename is split on hyphens,
// underscores, and camelCase word boundaries, then title-cased.
// Exported so the config package can call it for the recents recorder.
func LibraryDisplayName(id string) string {
	base := filepath.Base(id)
	var runes []rune
	prev := rune(0)
	for _, r := range base {
		if unicode.IsUpper(r) && unicode.IsLower(prev) {
			runes = append(runes, ' ')
		}
		runes = append(runes, r)
		prev = r
	}
	s := strings.NewReplacer("-", " ", "_", " ").Replace(string(runes))
	words := strings.Fields(s)
	for i, w := range words {
		if len(w) > 0 {
			words[i] = strings.ToUpper(w[:1]) + strings.ToLower(w[1:])
		}
	}
	return strings.Join(words, " ")
}
