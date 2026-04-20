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
	st store.Store
}

// NewNoteService creates a NoteService backed by st.
func NewNoteService(st store.Store) *NoteService {
	return &NoteService{st: st}
}

// Load retrieves a note by its store-relative path (ExternalRef), e.g.
// "store/my-note.md" or "store/sub/my-note.md".
func (ns *NoteService) Load(path string) (*Note, error) {
	key := keyFromPath(path, Library)
	s, err := ns.st.Load(Library, key)
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

// Refile applies the filing recommendation already stored in n's metadata —
// deriving the target filename and folder — and renames/moves the note within
// the Library accordingly. This is the "re-file" path for notes that are
// already in the Library: it does NOT move across categories.
func (ns *NoteService) Refile(n *Note) (*Note, error) {
	folder := deriveFolderFromMeta(n.Meta())
	kebab := deriveKebabNameFromMeta(n.Meta(), n.Body())

	var targetName string
	if folder != "" {
		targetName = cleanFolderPath(folder) + "/" + kebab
	} else {
		targetName = kebab
	}

	renamed, err := ns.st.Rename(n.s, targetName)
	if err != nil {
		return nil, fmt.Errorf("note: refile to %q: %w", targetName, err)
	}
	ms, ok := renamed.(store.MetaStorable)
	if !ok {
		return nil, fmt.Errorf("note: refile: renamed storable is not MetaStorable")
	}
	return newNote(ms), nil
}

// List returns the Library tree as a []NoteEntry (the same projection used
// by the sidebar). Backed by the Store — no direct filesystem access.
func (ns *NoteService) List() ([]NoteEntry, error) {
	storables, err := ns.st.List(Library, "")
	if err != nil {
		return nil, err
	}
	return buildNoteTree(storables), nil
}

// Count returns the number of notes in the Library.
func (ns *NoteService) Count() int {
	storables, err := ns.st.List(Library, "")
	if err != nil {
		return 0
	}
	n := 0
	for _, s := range storables {
		if _, ok := s.(store.MetaStorable); ok {
			if strings.HasSuffix(s.Key(), ".md") {
				n++
			}
		}
	}
	return n
}

// Search performs a full-text and frontmatter search over the Library.
// Backed by the Store — no direct filesystem access.
func (ns *NoteService) Search(query string) ([]SearchResult, error) {
	if query == "" {
		return nil, nil
	}
	storables, err := ns.st.List(Library, "")
	if err != nil {
		return nil, err
	}

	queryLower := strings.ToLower(query)
	var results []SearchResult

	for _, s := range storables {
		ms, ok := s.(store.MetaStorable)
		if !ok {
			continue
		}
		if !strings.HasSuffix(s.Key(), ".md") {
			continue
		}

		meta := ms.Meta()
		body := string(ms.Body())
		bodyLower := strings.ToLower(body)

		isTagMatch := strings.Contains(strings.ToLower(meta["tags"]), queryLower)
		isSummaryMatch := strings.Contains(strings.ToLower(meta["summary"]), queryLower)
		isBodyMatch := strings.Contains(bodyLower, queryLower)

		if !isTagMatch && !isSummaryMatch && !isBodyMatch {
			continue
		}

		var snippet string
		if isBodyMatch {
			idx := strings.Index(bodyLower, queryLower)
			start := max(0, idx-30)
			end := min(len(body), idx+len(query)+30)
			snippet = strings.ReplaceAll(body[start:end], "\n", " ")
			if start > 0 {
				snippet = "..." + snippet
			}
			if end < len(body) {
				snippet = snippet + "..."
			}
		} else if isSummaryMatch {
			sn := metaString(meta, "summary")
			if len(sn) > 60 {
				sn = sn[:60] + "..."
			}
			snippet = sn
		}

		results = append(results, SearchResult{
			Path:           s.ExternalRef(),
			Name:           strings.TrimSuffix(filepath.Base(s.Key()), ".md"),
			IsTagMatch:     isTagMatch,
			IsSummaryMatch: isSummaryMatch,
			IsBodyMatch:    isBodyMatch,
			Snippet:        strings.TrimSpace(snippet),
		})
	}
	return results, nil
}

// RetrieveVersion fetches a historical snapshot of n identified by ref.
func (ns *NoteService) RetrieveVersion(n *Note, ref store.VersionRef) (store.VersionedStorable, error) {
	return ns.st.RetrieveVersion(n.s, ref)
}

// ── Types ─────────────────────────────────────────────────────────────────────

// NoteEntry represents a single node in the Library tree.
// Directories have IsDir=true and a Children slice; files have a store-relative Path.
type NoteEntry struct {
	Name        string      `json:"name"`
	DisplayName string      `json:"displayName,omitempty"`
	Path        string      `json:"path,omitempty"`
	UserIntent  string      `json:"userIntent,omitempty"`
	IsDir       bool        `json:"isDir"`
	Children    []NoteEntry `json:"children,omitempty"`
}

// SearchResult represents a single Library search match.
type SearchResult struct {
	Path           string `json:"path"`
	Name           string `json:"name"`
	IsTagMatch     bool   `json:"isTagMatch"`
	IsSummaryMatch bool   `json:"isSummaryMatch"`
	IsBodyMatch    bool   `json:"isBodyMatch"`
	Snippet        string `json:"snippet"`
}

// ── Tree builder ──────────────────────────────────────────────────────────────

// buildNoteTree converts a flat []store.Storable (from Store.List) into the
// hierarchical []NoteEntry the sidebar expects. Only root-level items are
// processed; nested MetaStorables (key contains "/") are already owned by their
// parent FolderStorable and are skipped in the top-level pass.
func buildNoteTree(storables []store.Storable) []NoteEntry {
	var entries []NoteEntry
	for _, s := range storables {
		key := s.Key()
		// Only process root-level items. Nested entries (key contains "/") are
		// surfaced by their parent FolderStorable.Owns().
		if strings.Contains(key, "/") {
			continue
		}
		// Skip hidden entries (e.g. .assets directory).
		if strings.HasPrefix(key, ".") {
			continue
		}

		switch v := s.(type) {
		case store.FolderStorable:
			entries = append(entries, NoteEntry{
				Name:     key,
				IsDir:    true,
				Children: buildFolderChildren(v.Owns()),
			})
		case store.MetaStorable:
			if !strings.HasSuffix(key, ".md") {
				continue
			}
			entries = append(entries, NoteEntry{
				Name:        strings.TrimSuffix(key, ".md"),
				DisplayName: metaString(v.Meta(), "display_name"),
				Path:        s.ExternalRef(),
				UserIntent:  metaString(v.Meta(), "user_intent"),
				IsDir:       false,
			})
		}
	}
	return entries
}

func buildFolderChildren(owns []store.Storable) []NoteEntry {
	var children []NoteEntry
	for _, s := range owns {
		ms, ok := s.(store.MetaStorable)
		if !ok {
			continue
		}
		key := ms.Key()
		if !strings.HasSuffix(key, ".md") {
			continue
		}
		children = append(children, NoteEntry{
			Name:        strings.TrimSuffix(filepath.Base(key), ".md"),
			DisplayName: metaString(ms.Meta(), "display_name"),
			Path:        ms.ExternalRef(),
			UserIntent:  metaString(ms.Meta(), "user_intent"),
			IsDir:       false,
		})
	}
	return children
}

// metaString extracts a value from a raw metadata map, normalising YAML "null"
// and bare quote characters to the empty string.
func metaString(meta map[string]string, key string) string {
	v := strings.TrimSpace(meta[key])
	v = strings.Trim(v, `"'`)
	if v == "null" {
		return ""
	}
	return v
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
