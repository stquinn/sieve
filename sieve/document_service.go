package sieve

import (
	"fmt"
	"path/filepath"
	"sieve/store"
	"strconv"
	"strings"
	"time"
)

type DocumentService struct {
	store store.Store
}

func NewDocumentService(st store.Store) (*DocumentService, error) {
	if err := st.PrepareCategory(Library); err != nil {
		return nil, err
	}
	if err := st.PrepareCategory(WorkingCopy); err != nil {
		return nil, err
	}
	return &DocumentService{store: st}, nil
}

func (ds *DocumentService) documentFromStoreable(item store.MetaStorable) (Document, error) {
	if item == nil {
		return nil, fmt.Errorf("Nill MetaStoreable not allowed")
	}
	if item.Category().Key == Library.Key {
		result := newNote(item)
		return result, nil
	}
	if item.Category().Key == WorkingCopy.Key {
		result := newBuffer(item)
		return result, nil
	}
	return nil, fmt.Errorf("Unsupported MetaStoreable type %s", item.Category().Key)
}

// LoadByUUID retrieves a document by its UUID metadata field. This is O(n)
// over both categories — use sparingly (bridge operations, not hot paths).
// The scan skips version loading for performance; a targeted Load is issued
// only for the matched document so Versions() returns the full history.
func (ds *DocumentService) LoadByUUID(uuid string) (Document, error) {
	storables, err := ds.store.ListFrom([]store.Category{Library, WorkingCopy}, "")
	if err != nil {
		return nil, fmt.Errorf("document: LoadByUUID %s: list failed: %w", uuid, err)
	}
	for _, s := range storables {
		ms, ok := s.(store.MetaStorable)
		if ok && ms.Meta()["uuid"] == uuid {
			return ds.documentFromStoreable(ms)
		}
	}
	return nil, fmt.Errorf("document: LoadByUUID: document not found by uuid %q", uuid)
}

// Save persists the current state of n. The Store bumps the version and
// modified timestamp and writes a snapshot. Returns a new Note — n is stale
// after this call.
func (ds *DocumentService) Save(n Document) (Document, error) {
	saved, err := ds.store.Save(n.Storable())
	if err != nil {
		return nil, fmt.Errorf("document: save: %w", err)
	}
	ms, ok := saved.(store.MetaStorable)
	if !ok {
		return nil, fmt.Errorf("document: save: not MetaStorable")
	}
	doc, err := ds.documentFromStoreable(ms)
	if err != nil {
		return nil, err
	}
	return doc, nil
}

// Delete removes the note and its entire version history from the Store.
func (ns *DocumentService) Delete(n Document) error {
	return ns.store.Delete(n.Storable())
}

// Delete removes the note and its entire version history from the Store.
func (ns *DocumentService) DeleteFolder(folderName string) error {
	folder, err := ns.store.LoadFolder(Library, folderName)
	if err == nil {
		return ns.store.Delete(folder)
	}
	return err
}

// Delete removes the note and its entire version history from the Store.
func (ns *DocumentService) RenameFolder(folderName string, newName string) error {
	folder, err := ns.store.LoadFolder(Library, folderName)
	if err == nil {
		_, err := ns.store.Rename(folder, newName)
		return err
	}
	return err
}

// SetIntent writes user_intent to the buffer's metadata and saves it.
// intent must be "keep", "trash", or "" (clears the field).
func (ds *DocumentService) SetIntent(d Document, intent string) (Document, error) {
	meta := d.Storable().Meta()
	if intent == "" {
		delete(meta, "user_intent")
	} else {
		meta["user_intent"] = intent
	}
	d.Storable().SetMeta(meta)
	return ds.Save(d)
}

// AttachAsset attaches an asset Storable to the note and saves it.
func (ds *DocumentService) AttachAsset(n Document, a store.AssetStorable) error {
	n.Storable().AttachAsset(a)
	_, err := ds.store.Save(n.Storable())
	return err
}

// RetrieveVersion fetches a historical snapshot of n identified by ref.
func (ds *DocumentService) RetrieveVersion(n Document, ref store.VersionRef) (store.VersionedStorable, error) {
	return ds.store.RetrieveVersion(n.Storable(), ref)
}

// Rename changes the filename of a note. name is the new base name (without
// extension). The existing folder is preserved. name is converted to kebab-case.
func (ds *DocumentService) Rename(d Document, name string) (Document, error) {
	// Update display_name so the UI reflects the new name even when the old
	// one was set by AI. Write back via SetMeta so it's persisted.
	meta := d.Storable().Meta()
	meta["display_name"] = name
	d.Storable().SetMeta(meta)

	n, ok := d.(*Note)
	// renames only move files on disk IF its a note.  Buffers just stay where
	// they are and get a change of display name - purely cosmetic
	if ok {
		// FileStore.Rename preserves the current directory automatically — just
		// pass the bare kebab name; do NOT prepend dir here.
		renamed, err := ds.store.Rename(n.Storable(), toKebab(name))
		if err != nil {
			return nil, fmt.Errorf("document: rename to %q: %w", name, err)
		}
		ms, ok := renamed.(store.MetaStorable)
		if !ok {
			return nil, fmt.Errorf("note: document: renamed storable is not MetaStorable")
		}
		return newNote(ms), nil
	}
	return d, nil
}

// New creates a new empty buffer in the WorkingCopy category with an
// "Untitled N" display name. The Store generates a timestamped key and stamps
// uuid, version, created, and modified.
func (ds *DocumentService) New() (Document, error) {
	n := ds.nextUntitledNumber()
	body := ds.defaultMetaBody(n)

	s, err := ds.store.CreateMetaText(WorkingCopy, "", []byte(body))
	if err != nil {
		return nil, fmt.Errorf("document: new: %w", err)
	}
	ms, ok := s.(store.MetaStorable)
	if !ok {
		return nil, fmt.Errorf("document: new: created storable is not MetaStorable")
	}
	return newBuffer(ms), nil
}

func (ds *DocumentService) NewFolder(folderName string) error {
	_, err := ds.store.CreateOrLoadFolder(Library, folderName)
	if err != nil {
		return fmt.Errorf("document: couldnt create folder: %w", err)
	}
	return nil
}

func (ds *DocumentService) File(b Document) (Document, error) {
	// Update meta before renaming.
	raw := b.Storable().Meta()
	raw["status"] = "filed"
	b.Storable().SetMeta(raw)
	// Derive target path (may include folder prefix).
	folderName := deriveFolderFromMeta(b.Meta())
	kebab := deriveKebabNameFromMeta(b.Meta(), b.Body())
	var moved store.Storable
	var err error
	// If Buffer - Move to Library category (FileStore migrates version history automatically).
	if b.Kind() == KindBuffer {
		moved, err = ds.store.Move(b.Storable(), Library)
		if err != nil {
			return nil, fmt.Errorf("document: file: move to Library: %w", err)
		}
	} else {
		//if its was already a Note - its already moved
		moved = b.Storable()
	}

	folder, err := ds.store.CreateOrLoadFolder(moved.Category(), folderName)
	if err != nil {
		return nil, fmt.Errorf("document: file: Couldnt Create Folder")
	}
	reparented := moved
	//move to folder if specified
	if folderName != "" {
		reparented, err = ds.store.Reparent(moved, folder)
		if err != nil {
			return nil, fmt.Errorf("document: file: rename to %q: %w", kebab, err)
		}
	}
	//rename
	renamed, err := ds.store.Rename(reparented, kebab)
	if err != nil {
		return nil, fmt.Errorf("document: file: rename to %q: %w", kebab, err)
	}

	ms, ok := renamed.(store.MetaStorable)
	if !ok {
		return nil, fmt.Errorf("buffer: file: moved storable is not MetaStorable")
	}
	return newNote(ms), nil
}

// List returns the Library tree as a []NoteEntry (the same projection used
// by the sidebar). Backed by the Store — no direct filesystem access.
func (ds *DocumentService) List() ([]NoteEntry, error) {
	storables, err := ds.store.List(Library, "")
	if err != nil {
		return nil, err
	}
	return buildNoteTree(storables), nil
}

// Move relocates a note to a different folder within the Library. folder is
// the target folder path (e.g. "ai-stuff" or "projects/go"). An empty folder
// moves the note to the Library root. The filename is preserved.
func (ds *DocumentService) Move(n Document, folderName string) (Document, error) {

	folder, err := ds.store.CreateOrLoadFolder(n.Storable().Category(), folderName)
	if err != nil {
		return nil, fmt.Errorf("document: file: couldnt create folder %q: %w", folderName, err)
	}
	moved, err := ds.store.Reparent(n.Storable(), folder)
	ms, ok := moved.(store.MetaStorable)
	if !ok {
		return nil, fmt.Errorf("buffer: file: moved storable is not MetaStorable")
	}
	return newNote(ms), nil
}

// Count returns the number of notes in the Library.
func (ds *DocumentService) Count() int {
	storables, err := ds.store.List(Library, "")
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
func (ds *DocumentService) Search(query string) ([]SearchResult, error) {
	if query == "" {
		return nil, nil
	}
	storables, err := ds.store.List(Library, "")
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
			ID:             meta["uuid"],
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

// nextUntitledNumber scans existing WorkingCopy buffers to find the highest
// "Untitled N" display_name and returns N+1.
// TODO Store creates the Buffer - why isnt it telling you the name?
func (bs *DocumentService) nextUntitledNumber() int {
	storables, err := bs.store.List(WorkingCopy, "")
	if err != nil {
		return 1
	}
	max := 0
	for _, s := range storables {
		ms, ok := s.(store.MetaStorable)
		if !ok {
			continue
		}
		dn := ms.Meta()["display_name"]
		if strings.HasPrefix(dn, "Untitled ") {
			if n, err := strconv.Atoi(strings.TrimPrefix(dn, "Untitled ")); err == nil && n > max {
				max = n
			}
		}
	}
	return max + 1
}

// defaultMetaBody returns the initial frontmatter body for a new buffer.
// uuid, version, created, and modified are omitted — the Store stamps them.
func (bs *DocumentService) defaultMetaBody(untitledN int) string {
	return fmt.Sprintf(`---
status: unfiled
focus_count: 0
user_intent: null
ai_eval: none
ai_last_evaluated: null
ai_folder_suggestion: null
user_suggested_name: null
display_name: Untitled %d
filename: null
summary: null
tags: []
ai_justification: null
density_signals: []
cli: null

---

`, untitledN)
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

// deriveKebabNameFromMeta extracts a kebab-case filename from meta and body.
// Priority: filename field > user_suggested_name field > first heading > timestamp.
func deriveKebabNameFromMeta(meta DocumentMeta, body []byte) string {
	if fn := meta.Filename(); fn != nil && *fn != "" {
		return toKebab(strings.TrimSuffix(*fn, ".md"))
	}
	if usn := meta.UserSuggestedName(); usn != nil && *usn != "" {
		return toKebab(*usn)
	}
	// First heading in the body.
	for _, line := range strings.SplitN(string(body), "\n", 200) {
		if strings.HasPrefix(line, "#") {
			if heading := strings.TrimSpace(strings.TrimLeft(line, "#")); heading != "" {
				return toKebab(heading)
			}
		}
	}
	return "note-" + time.Now().Format("20060102-1504")
}

// deriveFolderFromMeta returns a cleaned folder path from ai_folder_suggestion,
// or an empty string if none is set.
func deriveFolderFromMeta(meta DocumentMeta) string {
	if s := meta.AiFolderSuggestion(); s != nil && *s != "" {
		return cleanFolderPath(*s)
	}
	return ""
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

		switch s := s.(type) {
		case store.MetaStorable:
			if !strings.HasSuffix(key, ".md") {
				continue
			}
			entries = append(entries, NoteEntry{
				ID:          s.Meta()["uuid"],
				Name:        strings.TrimSuffix(key, ".md"),
				DisplayName: metaString(s.Meta(), "display_name"),
				Status:      s.Meta()["status"],
				UserIntent:  metaString(s.Meta(), "user_intent"),
				IsDir:       false,
			})
		case store.FolderStorable:
			entries = append(entries, NoteEntry{
				ID:       s.ExternalRef(),
				Name:     key,
				IsDir:    true,
				Children: buildFolderChildren(s.Owns()),
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
			ID:          ms.Meta()["uuid"],
			Name:        strings.TrimSuffix(filepath.Base(key), ".md"),
			DisplayName: metaString(ms.Meta(), "display_name"),
			Status:      ms.Meta()["status"],
			UserIntent:  metaString(ms.Meta(), "user_intent"),
			IsDir:       false,
		})
	}
	return children
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

// ── Types ─────────────────────────────────────────────────────────────────────

// NoteEntry represents a single node in the Library tree.
// Directories have IsDir=true and a Children slice; files carry a UUID ID.
type NoteEntry struct {
	ID          string      `json:"id"` // UUID for files; ExternalRef for folders (opaque to frontend)
	Name        string      `json:"name"`
	DisplayName string      `json:"displayName,omitempty"`
	Status      string      `json:"status,omitempty"`
	UserIntent  string      `json:"userIntent,omitempty"`
	IsDir       bool        `json:"isDir"`
	Children    []NoteEntry `json:"children,omitempty"`
}

type SearchResult struct {
	ID             string `json:"id"`
	Path           string `json:"path"`
	Name           string `json:"name"`
	IsTagMatch     bool   `json:"isTagMatch"`
	IsSummaryMatch bool   `json:"isSummaryMatch"`
	IsBodyMatch    bool   `json:"isBodyMatch"`
	Snippet        string `json:"snippet"`
}
