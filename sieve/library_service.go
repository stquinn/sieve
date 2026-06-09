package sieve

import (
	"os"
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

// LibraryService is the single abstraction for all library-level operations.
// It owns discovery (which library to open on startup), recents, validation,
// and naming. Everything above this layer — App, handlers, menus — talks only
// to LibraryService. Swapping the backing store means a new implementation, not
// rewired callers.
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
}

// LibraryNamer is the narrow store-layer contract required by LibraryService.
// filestore.FileStore satisfies it by reading the .sieve marker.
type LibraryNamer interface {
	LibraryName() string
}

// LibraryRecorder persists the machine-level recents list.
// The concrete implementation in main (configRecorder) reads and writes
// GlobalConfig on every call — no state is held in memory.
type LibraryRecorder interface {
	Recent() []Library
	AddRecent(lib Library)
	LastUsed() string        // last-used library ID, for startup fallback
	SetLastUsed(id string)   // persisted alongside recents
}

// LibraryDisplayName converts an opaque library ID to a human-readable name.
// For file-based stores the ID is a path: the basename is split on hyphens,
// underscores, and camelCase word boundaries, then title-cased.
// Exported so config.go (package main) can call it for the recents recorder.
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

// NewLibraryService constructs the LibraryService.
//   - recorder: persists the machine-level recents list (GlobalConfig in main)
//   - validate:  reports whether an ID can be opened (ValidateStore in main)
//
// Call Attach after opening the store so Current() can read the library name.
func NewLibraryService(recorder LibraryRecorder, validate func(string) error) LibraryService {
	return &fileLibraryService{
		recorder: recorder,
		validate: validate,
	}
}

type fileLibraryService struct {
	currentID string
	namer     LibraryNamer // nil until Attach is called
	recorder  LibraryRecorder
	validate  func(string) error
}

func (s *fileLibraryService) BestOnStartup(cliArg, envVar string) string {
	if cliArg != "" {
		return cliArg
	}
	if envVar != "" {
		if s.validate == nil || s.validate(envVar) == nil {
			return envVar
		}
	}
	// Walk recents — return first one that still validates.
	for _, lib := range s.recorder.Recent() {
		if s.validate == nil || s.validate(lib.Ref) == nil {
			return lib.Ref
		}
	}
	// Legacy fallback: last-used path from older config format.
	if last := s.recorder.LastUsed(); last != "" {
		if s.validate == nil || s.validate(last) == nil {
			return last
		}
	}
	// Final fallback: current working directory.
	if cwd, err := os.Getwd(); err == nil {
		if s.validate == nil || s.validate(cwd) == nil {
			return cwd
		}
	}
	return ""
}

func (s *fileLibraryService) Attach(id string, namer LibraryNamer) {
	s.currentID = id
	s.namer = namer
}

func (s *fileLibraryService) Current() Library {
	name := ""
	if s.namer != nil {
		name = s.namer.LibraryName()
	}
	if name == "" {
		name = LibraryDisplayName(s.currentID)
	}
	return Library{Ref:s.currentID, Name: name}
}

func (s *fileLibraryService) Recent() []Library {
	return s.recorder.Recent()
}

func (s *fileLibraryService) Validate(id string) error {
	if s.validate != nil {
		return s.validate(id)
	}
	return nil
}

func (s *fileLibraryService) RecordSwitch(id string) {
	s.recorder.SetLastUsed(id)
	name := ""
	if s.namer != nil {
		name = s.namer.LibraryName()
	}
	if name == "" {
		name = LibraryDisplayName(id)
	}
	s.recorder.AddRecent(Library{Ref:id, Name: name})
}

func (s *fileLibraryService) DisplayName(id string) string {
	return LibraryDisplayName(id)
}
