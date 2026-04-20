package stash

import (
	"fmt"
	"path/filepath"
	"strings"

	"stash/store"
)

// NoteService manages filed documents (Library category) through the Store
// interface. Create one with NewNoteService — do not construct directly.
type NoteService struct {
	st         store.Store
	storeRoot  string // absolute path to the store root — used for ScanNotes and Search
	libraryDir string // absolute path to the Library directory
}

// NewNoteService creates a NoteService backed by st.
// storeRoot is the absolute path to the store root (used for path relativisation
// in List and Search). libraryDir is the absolute path to the Library directory.
func NewNoteService(st store.Store, storeRoot, libraryDir string) *NoteService {
	return &NoteService{st: st, storeRoot: storeRoot, libraryDir: libraryDir}
}

// Load retrieves a note by its store-relative path (ExternalRef), e.g.
// "store/my-note.md" or "store/sub/my-note.md".
func (ns *NoteService) Load(path string) (*Note, error) {
	key := keyFromPath(path, store.Library)
	s, err := ns.st.Load(store.Library, key)
	if err != nil {
		return nil, fmt.Errorf("note: load %s: %w", path, err)
	}
	ms, ok := s.(store.MetaStorable)
	if !ok {
		return nil, fmt.Errorf("note: load %s: not a MetaStorable", path)
	}
	return newNote(ms), nil
}

// Save persists the current state of n. The Store bumps the version and
// modified timestamp and writes a snapshot. Returns a new Note — n is stale
// after this call.
func (ns *NoteService) Save(n *Note) (*Note, error) {
	saved, err := ns.st.Save(n.s)
	if err != nil {
		return nil, fmt.Errorf("note: save: %w", err)
	}
	ms, ok := saved.(store.MetaStorable)
	if !ok {
		return nil, fmt.Errorf("note: save: not MetaStorable")
	}
	return newNote(ms), nil
}

// Delete removes the note and its entire version history from the Store.
func (ns *NoteService) Delete(n *Note) error {
	return ns.st.Delete(n.s)
}

// Move relocates a note to a different folder within the Library. folder is
// the target folder path (e.g. "ai-stuff" or "projects/go"). An empty folder
// moves the note to the Library root. The filename is preserved.
func (ns *NoteService) Move(n *Note, folder string) (*Note, error) {
	name := strings.TrimSuffix(filepath.Base(n.s.Key()), filepath.Ext(n.s.Key()))

	var targetName string
	if folder != "" {
		targetName = cleanFolderPath(folder) + "/" + name
	} else {
		targetName = name
	}

	renamed, err := ns.st.Rename(n.s, targetName)
	if err != nil {
		return nil, fmt.Errorf("note: move to %q: %w", folder, err)
	}
	ms, ok := renamed.(store.MetaStorable)
	if !ok {
		return nil, fmt.Errorf("note: move: renamed storable is not MetaStorable")
	}
	return newNote(ms), nil
}

// Rename changes the filename of a note. name is the new base name (without
// extension). The existing folder is preserved. name is converted to kebab-case.
func (ns *NoteService) Rename(n *Note, name string) (*Note, error) {
	// Preserve the existing subdirectory if any.
	dir := filepath.Dir(n.s.Key())
	kebab := toKebab(name)

	var targetName string
	if dir == "." {
		targetName = kebab
	} else {
		targetName = filepath.ToSlash(dir) + "/" + kebab
	}

	renamed, err := ns.st.Rename(n.s, targetName)
	if err != nil {
		return nil, fmt.Errorf("note: rename to %q: %w", name, err)
	}
	ms, ok := renamed.(store.MetaStorable)
	if !ok {
		return nil, fmt.Errorf("note: rename: renamed storable is not MetaStorable")
	}
	return newNote(ms), nil
}

// List returns the Library tree as a []NoteEntry (the same projection used
// by the sidebar). Backed by ScanNotes which walks the filesystem.
func (ns *NoteService) List() ([]NoteEntry, error) {
	return ScanNotes(ns.storeRoot, ns.libraryDir), nil
}

// Search performs a full-text and frontmatter search over the Library.
func (ns *NoteService) Search(query string) ([]SearchResult, error) {
	return SearchStore(ns.storeRoot, []string{ns.libraryDir}, query), nil
}

// RetrieveVersion fetches a historical snapshot of n identified by ref.
func (ns *NoteService) RetrieveVersion(n *Note, ref store.VersionRef) (store.VersionedStorable, error) {
	return ns.st.RetrieveVersion(n.s, ref)
}
