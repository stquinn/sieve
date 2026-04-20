package stash

import (
	"fmt"
	"strconv"
	"strings"
	"time"

	"stash/store"
)

// BufferService manages working-copy buffers through the Store interface.
// Create one with NewBufferService — do not construct directly.
type BufferService struct {
	st store.Store
}

// NewBufferService creates a BufferService backed by st.
func NewBufferService(st store.Store) *BufferService {
	return &BufferService{st: st}
}

// New creates a new empty buffer in the WorkingCopy category with an
// "Untitled N" display name. The Store generates a timestamped key and stamps
// uuid, version, created, and modified.
func (bs *BufferService) New() (*Buffer, error) {
	n := bs.nextUntitledNumber()
	body := bs.defaultMetaBody(n)

	s, err := bs.st.CreateMetaText(WorkingCopy, "", []byte(body))
	if err != nil {
		return nil, fmt.Errorf("buffer: new: %w", err)
	}
	ms, ok := s.(store.MetaStorable)
	if !ok {
		return nil, fmt.Errorf("buffer: new: created storable is not MetaStorable")
	}
	return newBuffer(ms), nil
}

// Load retrieves a buffer by its store-relative path (ExternalRef), e.g.
// "{hostname}/buffers/buf-20240102-1504.md".
func (bs *BufferService) Load(path string) (*Buffer, error) {
	key := keyFromPath(path, WorkingCopy)
	s, err := bs.st.Load(WorkingCopy, key)
	if err != nil {
		return nil, fmt.Errorf("buffer: load %s: %w", path, err)
	}
	ms, ok := s.(store.MetaStorable)
	if !ok {
		return nil, fmt.Errorf("buffer: load %s: not a MetaStorable", path)
	}
	return newBuffer(ms), nil
}

// Save persists the current state of b. The Store bumps the version and
// modified timestamp and writes a snapshot. Returns a new Buffer — b is stale
// after this call. Returns ErrStaleStorable if b is based on an outdated version.
func (bs *BufferService) Save(b *Buffer) (*Buffer, error) {
	saved, err := bs.st.Save(b.s)
	if err != nil {
		return nil, fmt.Errorf("buffer: save: %w", err)
	}
	ms, ok := saved.(store.MetaStorable)
	if !ok {
		return nil, fmt.Errorf("buffer: save: saved storable is not MetaStorable")
	}
	return newBuffer(ms), nil
}

// Discard deletes the buffer and its entire version history from the Store.
// Any assets owned by the buffer are left in place — the Store's ownership
// graph no longer references them.
func (bs *BufferService) Discard(b *Buffer) error {
	return bs.st.Delete(b.s)
}

// File promotes a buffer from WorkingCopy to the Library category. It derives
// the target filename from the meta (filename > user_suggested_name > first
// heading > timestamp) and the target folder from ai_folder_suggestion. Sets
// status = "filed" for backward compat with external editors. Returns the
// resulting Note; the original buffer no longer exists after a successful call.
func (bs *BufferService) File(b *Buffer) (*Note, error) {
	return bs.doFile(b, "")
}

// FileWithName is like File but overrides user_suggested_name in the meta
// before deriving the filename.
func (bs *BufferService) FileWithName(b *Buffer, name string) (*Note, error) {
	return bs.doFile(b, name)
}

func (bs *BufferService) doFile(b *Buffer, overrideName string) (*Note, error) {
	// Update meta before renaming.
	raw := b.s.Meta()
	raw["status"] = "filed"
	if overrideName != "" {
		raw["user_suggested_name"] = overrideName
	}
	b.s.SetMeta(raw)

	// Derive target path (may include folder prefix).
	folder := deriveFolderFromMeta(b.Meta())
	kebab := deriveKebabNameFromMeta(b.Meta(), b.Body())

	targetName := kebab
	if folder != "" {
		targetName = folder + "/" + kebab
	}

	// Rename within WorkingCopy (FileStore creates intermediate dirs via MkdirAll).
	renamed, err := bs.st.Rename(b.s, targetName)
	if err != nil {
		return nil, fmt.Errorf("buffer: file: rename to %q: %w", targetName, err)
	}

	// Move to Library category (FileStore migrates version history automatically).
	moved, err := bs.st.Move(renamed, Library)
	if err != nil {
		return nil, fmt.Errorf("buffer: file: move to Library: %w", err)
	}

	ms, ok := moved.(store.MetaStorable)
	if !ok {
		return nil, fmt.Errorf("buffer: file: moved storable is not MetaStorable")
	}
	return newNote(ms), nil
}

// List returns all buffers in the WorkingCopy category. Non-MetaStorable
// entries (e.g. asset files, folders) are silently skipped.
func (bs *BufferService) List() ([]*Buffer, error) {
	storables, err := bs.st.List(WorkingCopy, "")
	if err != nil {
		return nil, fmt.Errorf("buffer: list: %w", err)
	}
	var buffers []*Buffer
	for _, s := range storables {
		ms, ok := s.(store.MetaStorable)
		if !ok {
			continue
		}
		buffers = append(buffers, newBuffer(ms))
	}
	return buffers, nil
}

// RetrieveVersion fetches a historical snapshot of b identified by ref.
func (bs *BufferService) RetrieveVersion(b *Buffer, ref store.VersionRef) (store.VersionedStorable, error) {
	return bs.st.RetrieveVersion(b.s, ref)
}

// ── Internal helpers ──────────────────────────────────────────────────────────

// nextUntitledNumber scans existing WorkingCopy buffers to find the highest
// "Untitled N" display_name and returns N+1.
//TODO Store creates the Buffer - why isnt it telling you the name?
func (bs *BufferService) nextUntitledNumber() int {
	storables, err := bs.st.List(WorkingCopy, "")
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
func (bs *BufferService) defaultMetaBody(untitledN int) string {
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

// keyFromPath extracts the Store key (category-relative path) from a
// store-relative ExternalRef. For example:
//
//	WorkingCopy: "{hostname}/buffers/buf-xxx.md" → "buf-xxx.md"
//	Library:     "store/my-note.md"             → "my-note.md"
//	Library:     "store/sub/my-note.md"         → "sub/my-note.md"
func keyFromPath(path string, cat store.Category) string {
	marker := "/" + cat.Key + "/"
	if idx := strings.Index(path, marker); idx >= 0 {
		return path[idx+len(marker):]
	}
	// Library (Shared) paths start directly with the category key.
	prefix := cat.Key + "/"
	if strings.HasPrefix(path, prefix) {
		return path[len(prefix):]
	}
	return path
}
