package filestore

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"time"

	"sieve/store"
)

var snapshotRe = regexp.MustCompile(`^(.+)\.(\d+)\.md$`)

// historyDir returns the absolute path of the .history directory for a
// document. History is now co-located inside the document directory.
func (fs *FileStore) historyDir(cat store.Category, key string) string {
	return filepath.Join(fs.docDir(cat, key), ".history")
}

// snapshotPath returns the path for a specific version snapshot.
// Format: {docDir}/.history/{uuid}.{version}.md
func (fs *FileStore) snapshotPath(cat store.Category, key string, uuid string, version int) string {
	name := fmt.Sprintf("%s.%d.md", uuid, version)
	return filepath.Join(fs.historyDir(cat, key), name)
}

// writeSnapshot persists a body-only snapshot for the given document.
func (fs *FileStore) writeSnapshot(cat store.Category, key string, uuid string, version int, body []byte) error {
	dir := fs.historyDir(cat, key)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("filestore: create history dir: %w", err)
	}
	path := fs.snapshotPath(cat, key, uuid, version)
	if err := os.WriteFile(path, body, 0o644); err != nil {
		return fmt.Errorf("filestore: write snapshot: %w", err)
	}
	return nil
}

// loadVersions scans the document's .history directory and returns VersionRef
// values newest-first.
func (fs *FileStore) loadVersions(uuid string, cat store.Category, key string) []store.VersionRef {
	if uuid == "" {
		return []store.VersionRef{}
	}
	dir := fs.historyDir(cat, key)
	pattern := filepath.Join(dir, uuid+".*.md")
	matches, err := filepath.Glob(pattern)
	if err != nil || len(matches) == 0 {
		return []store.VersionRef{}
	}
	type entry struct {
		version int
		ref     store.VersionRef
	}
	entries := make([]entry, 0, len(matches))
	for _, m := range matches {
		base := filepath.Base(m)
		sub := snapshotRe.FindStringSubmatch(base)
		if sub == nil {
			continue
		}
		ver, err := strconv.Atoi(sub[2])
		if err != nil {
			continue
		}
		info, err := os.Stat(m)
		if err != nil {
			continue
		}
		entries = append(entries, entry{
			version: ver,
			ref: store.VersionRef{
				ID:      strconv.Itoa(ver),
				Created: info.ModTime(),
				Size:    info.Size(),
			},
		})
	}

	sort.Slice(entries, func(i, j int) bool {
		return entries[i].version > entries[j].version
	})

	refs := make([]store.VersionRef, len(entries))
	for i, e := range entries {
		refs[i] = e.ref
	}
	return refs
}

// pruneVersions deletes the oldest snapshots for uuid, keeping the newest
// maxVersions entries. No-op if maxVersions <= 0.
func (fs *FileStore) pruneVersions(cat store.Category, key string, uuid string, maxVersions int) {
	if maxVersions <= 0 || uuid == "" {
		return
	}
	dir := fs.historyDir(cat, key)
	pattern := filepath.Join(dir, uuid+".*.md")
	matches, err := filepath.Glob(pattern)
	if err != nil || len(matches) <= maxVersions {
		return
	}

	type entry struct {
		version int
		path    string
	}
	entries := make([]entry, 0, len(matches))
	for _, m := range matches {
		base := filepath.Base(m)
		sub := snapshotRe.FindStringSubmatch(base)
		if sub == nil {
			continue
		}
		ver, err := strconv.Atoi(sub[2])
		if err != nil {
			continue
		}
		entries = append(entries, entry{version: ver, path: m})
	}

	sort.Slice(entries, func(i, j int) bool {
		return entries[i].version < entries[j].version
	})

	deleteCount := len(entries) - maxVersions
	for i := range deleteCount {
		os.Remove(entries[i].path)
	}
}

// retrieveVersion reads a body-only snapshot and returns a VersionedStorable.
func (fs *FileStore) retrieveVersion(cat store.Category, key string, uuid string, ref store.VersionRef) (store.VersionedStorable, error) {
	ver, err := strconv.Atoi(ref.ID)
	if err != nil {
		return store.VersionedStorable{}, fmt.Errorf("filestore: invalid version ref %q: %w", ref.ID, err)
	}

	path := fs.snapshotPath(cat, key, uuid, ver)
	body, err := os.ReadFile(path)
	if err != nil {
		return store.VersionedStorable{}, fmt.Errorf("filestore: read snapshot %s: %w", path, err)
	}

	info, _ := os.Stat(path)
	created := ref.Created
	if created.IsZero() {
		if info != nil {
			created = info.ModTime()
		} else {
			created = time.Now()
		}
	}

	// Load current meta for the VersionedStorable.
	var meta map[string]string
	if dm, err := readMetaJSONFromPath(fs.metaPath(cat, key)); err == nil {
		meta = docMetaToMap(dm)
	}

	return store.VersionedStorable{
		Ref:  store.VersionRef{ID: ref.ID, Created: created, Size: int64(len(body))},
		Body: body,
		Meta: meta,
	}, nil
}
