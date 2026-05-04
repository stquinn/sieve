package sieve

import (
	"fmt"
	"sieve/logger"
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

	storable, err := ds.store.LoadByUUID(uuid)
	if err != nil {
		return nil, err
	}
	ms, ok := storable.(store.MetaStorable)
	if !ok {
		return nil, fmt.Errorf("document: LoadByUUID %s: not MetaStorable", uuid)
	}
	return ds.documentFromStoreable(ms)
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
func (ns *DocumentService) DeleteFolder(id string) error {
	folder, err := ns.store.LoadFolder(Library, id)
	if err == nil {
		return ns.store.Delete(folder)
	}
	return err
}

// Delete removes the note and its entire version history from the Store.
func (ns *DocumentService) RenameFolder(id string, newName string) error {
	folder, err := ns.store.LoadFolder(Library, id)
	if err == nil {
		_, err := ns.store.Rename(folder, newName)
		return err
	}
	return err
}

// SetUserIntent writes user_intent to the buffer's metadata and saves it.
// intent must be "keep", "trash", or "" (clears the field).
func (ds *DocumentService) SetUserIntent(d Document, intent string) (Document, error) {
	meta := d.Storable().Meta()
	if intent == "" {
		delete(meta, "user_intent")
	} else {
		meta["user_intent"] = intent
	}
	d.Storable().SetMeta(meta)
	return ds.SaveMeta(d)
}

// SaveMeta persists only the metadata of the document, avoiding a version bump.
func (ds *DocumentService) SaveMeta(n Document) (Document, error) {
	ms, err := ds.store.SaveMeta(n.Storable())
	if err != nil {
		return nil, err
	}
	return ds.documentFromStoreable(ms)
}

// AttachAsset attaches an asset Storable to the note and saves it.
func (ds *DocumentService) AttachAsset(n Document, a store.AssetStorable) error {
	n.Storable().AttachAsset(a)
	_, err := ds.store.Save(n.Storable())
	return err
}

// IncrementFocusCount increments the focus_count in metadata and saves it.
func (ds *DocumentService) IncrementFocusCount(n Document) (Document, error) {
	meta := n.Meta()
	meta.SetFocusCount(meta.FocusCount() + 1)
	return ds.SaveMeta(n)
}

// UpdateAiMetadata applies an AI filing recommendation to the document metadata and saves it.
func (ds *DocumentService) UpdateAiMetadata(d Document, rec *FilingRecommendation, cli string) (Document, error) {
	meta := d.Meta()
	now := time.Now().Format("2006-01-02T15:04:05")
	meta.SetAiEval("complete")
	meta.SetAiLastEvaluated(&now)
	keep := rec.Keep
	meta.SetAiKeep(&keep)
	if cli != "" {
		meta.SetCLI(&cli)
	}
	if rec.Title != "" {
		meta.SetDisplayName(rec.Title)
	}
	if rec.Filename != "" {
		fn := rec.Filename
		meta.SetFilename(&fn)
	}
	if rec.Folder != "" {
		folder := rec.Folder
		meta.SetAiFolderSuggestion(&folder)
	}
	if rec.Summary != "" {
		s2 := rec.Summary
		meta.SetSummary(&s2)
	}
	if len(rec.Tags) > 0 {
		meta.SetTags(rec.Tags)
	}
	if rec.AiJustification != "" {
		j := rec.AiJustification
		meta.SetAiJustification(&j)
	}
	if len(rec.DensitySignals) > 0 {
		meta.SetDensitySignals(rec.DensitySignals)
	}
	return ds.SaveMeta(d)
}

// RetrieveVersion fetches a historical snapshot of n identified by ref.
func (ds *DocumentService) RetrieveVersion(n Document, ref store.VersionRef) (store.VersionedStorable, error) {
	return ds.store.RetrieveVersion(n.Storable(), ref)
}

// ReplaceVersion replaces the current version of a document with a historical snapshot.
func (ds *DocumentService) ReplaceWithVersion(doc Document, ref store.VersionRef) (Document, error) {
	version, err := ds.store.RetrieveVersion(doc.Storable(), ref)
	if err != nil {
		return nil, err
	}
	logger.Info("version found", "version", version)
	logger.Info("old body found", "body", string(version.Body))
	logger.Info("existing body found", "body", string(doc.Body()))
	doc.SetBody(version.Body)
	newDoc, err := ds.Save(doc)
	if err != nil {
		return nil, err
	}
	logger.Info("new body found", "body", string(newDoc.Body()))
	return newDoc, nil
}

// Rename changes the display name of a document. For notes the directory is
// also renamed to its kebab form; the display_name is then written back via
// SaveMeta because store.Rename reloads from disk, discarding any in-memory
// meta changes. Buffers are purely cosmetic — only meta is updated.
func (ds *DocumentService) Rename(d Document, name string) (Document, error) {
	n, ok := d.(*Note)
	if ok {
		renamed, err := ds.store.Rename(n.Storable(), toKebab(name))
		if err != nil {
			return nil, fmt.Errorf("document: rename to %q: %w", name, err)
		}
		ms, ok := renamed.(store.MetaStorable)
		if !ok {
			return nil, fmt.Errorf("note: document: renamed storable is not MetaStorable")
		}
		renamedNote := newNote(ms)
		renamedNote.Meta().SetDisplayName(name)
		return ds.SaveMeta(renamedNote)
	}
	d.Meta().SetDisplayName(name)
	return ds.SaveMeta(d)
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
	return newBuffer(s), nil
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
	return len(flattenDocs(storables))
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

	for _, ms := range flattenDocs(storables) {

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
			Path:           ms.ExternalRef(),
			Name:           newDocumentMeta(ms.Meta(), ms.SetMeta).DisplayName(),
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
		dn := newDocumentMeta(ms.Meta(), ms.SetMeta).DisplayName()
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

// ── Helpers ───────────────────────────────────────────────────────────────────

// flattenDocs recursively collects all MetaStorable documents from a List()
// result, traversing into FolderStorable.Owns() for nested items.
func flattenDocs(storables []store.Storable) []store.MetaStorable {
	var docs []store.MetaStorable
	for _, s := range storables {
		switch s := s.(type) {
		case store.MetaStorable:
			docs = append(docs, s)
		case store.FolderStorable:
			docs = append(docs, flattenDocs(s.Owns())...)
		}
	}
	return docs
}

// ── Tree builder ──────────────────────────────────────────────────────────────

// buildNoteTree converts a []store.Storable (from Store.List, root items only)
// into the hierarchical []NoteEntry the sidebar expects. Folders carry their
// children via Owns() — no path filtering needed here.
func buildNoteTree(storables []store.Storable) []NoteEntry {
	var entries []NoteEntry
	for _, s := range storables {
		switch s := s.(type) {
		case store.MetaStorable:
			// MetaStorable before FolderStorable: fileMetaStorable satisfies both;
			// documents must not render as folders.
			dm := newDocumentMeta(s.Meta(), s.SetMeta)
			entries = append(entries, NoteEntry{
				ID:          s.Key(),
				Name:        dm.DisplayName(),
				DisplayName: dm.DisplayName(),
				Status:      s.Meta()["status"],
				UserIntent:  metaString(s.Meta(), "user_intent"),
				IsDir:       false,
			})
		case store.FolderStorable:
			entries = append(entries, NoteEntry{
				ID:       s.Key(),
				Name:     s.Name(),
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
		switch s := s.(type) {
		case store.MetaStorable:
			// MetaStorable before FolderStorable: fileMetaStorable satisfies both;
			// documents must not render as folders.
			dm := newDocumentMeta(s.Meta(), s.SetMeta)
			children = append(children, NoteEntry{
				ID:          s.Key(),
				Name:        dm.DisplayName(),
				DisplayName: dm.DisplayName(),
				Status:      s.Meta()["status"],
				UserIntent:  metaString(s.Meta(), "user_intent"),
				IsDir:       false,
			})
		case store.FolderStorable:
			children = append(children, NoteEntry{
				ID:       s.Key(),
				Name:     s.Name(),
				IsDir:    true,
				Children: buildFolderChildren(s.Owns()),
			})
		}
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
