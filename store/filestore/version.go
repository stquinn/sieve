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

// historyDir returns the absolute path of the history directory for a category.
// The layout mirrors the existing on-disk structure:
//
//	Shared   (Library)      → {root}/store/.history/
//	Isolated (WorkingCopy)  → {root}/{hostname}/.history/
//	Isolated (State)        → {root}/{hostname}/.history/
func (fs *FileStore) historyDir(cat store.Category) string {
	if cat.Isolation == store.Isolated {
		return filepath.Join(fs.root, fs.hostname, ".history")
	}
	return filepath.Join(fs.root, cat.Key, ".history")
}

// snapshotPath returns the path for a specific version snapshot.
// Format: {historyDir}/{uuid}.{version}.md
func (fs *FileStore) snapshotPath(cat store.Category, uuid string, version int) string {
	name := fmt.Sprintf("%s.%d.md", uuid, version)
	return filepath.Join(fs.historyDir(cat), name)
}

// writeSnapshot persists a full-content snapshot (frontmatter + body) for the
// given UUID and version number. The snapshot dir is created if missing.
func (fs *FileStore) writeSnapshot(cat store.Category, uuid string, version int, content []byte) error {
	dir := fs.historyDir(cat)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("filestore: create history dir: %w", err)
	}
	path := fs.snapshotPath(cat, uuid, version)
	if err := os.WriteFile(path, content, 0o644); err != nil {
		return fmt.Errorf("filestore: write snapshot: %w", err)
	}
	return nil
}

// loadVersions scans the history directory for snapshots belonging to uuid
// and returns them as VersionRef values, newest-first.
// Returns nil (not an error) if the history dir does not exist.
func (fs *FileStore) loadVersions(uuid string, cat store.Category) []store.VersionRef {
	if uuid == "" {
		return nil
	}
	dir := fs.historyDir(cat)
	pattern := filepath.Join(dir, uuid+".*.md")
	matches, err := filepath.Glob(pattern)
	if err != nil || len(matches) == 0 {
		return nil
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

	// Sort newest (highest version number) first.
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].version > entries[j].version
	})

	refs := make([]store.VersionRef, len(entries))
	for i, e := range entries {
		refs[i] = e.ref
	}
	return refs
}

// pruneVersions deletes the oldest snapshots for uuid, keeping only the
// newest maxVersions entries. If maxVersions <= 0 nothing is deleted.
func (fs *FileStore) pruneVersions(cat store.Category, uuid string, maxVersions int) {
	if maxVersions <= 0 || uuid == "" {
		return
	}
	dir := fs.historyDir(cat)
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

	// Sort oldest first so we can trim from the front.
	sort.Slice(entries, func(i, j int) bool {
		return entries[i].version < entries[j].version
	})

	deleteCount := len(entries) - maxVersions
	for i := range deleteCount {
		os.Remove(entries[i].path)
	}
}

// deleteAllVersions removes every snapshot file for uuid in any history dir.
// Called by FileStore.Delete.
func (fs *FileStore) deleteAllVersions(cat store.Category, uuid string) {
	if uuid == "" {
		return
	}
	// Shared categories keep history in their own directory; Isolated categories
	// share a single .history dir per host. Delete from whichever dir applies.
	dir := fs.historyDir(cat)
	pattern := filepath.Join(dir, uuid+".*.md")
	matches, _ := filepath.Glob(pattern)
	for _, m := range matches {
		os.Remove(m)
	}
}

// retrieveVersion reads the snapshot identified by ref and returns a
// VersionedStorable. The snapshot file contains a full document
// (frontmatter + body) written by writeSnapshot.
func (fs *FileStore) retrieveVersion(cat store.Category, uuid string, ref store.VersionRef) (store.VersionedStorable, error) {
	ver, err := strconv.Atoi(ref.ID)
	if err != nil {
		return store.VersionedStorable{}, fmt.Errorf("filestore: invalid version ref %q: %w", ref.ID, err)
	}

	path := fs.snapshotPath(cat, uuid, ver)
	data, err := os.ReadFile(path)
	if err != nil {
		return store.VersionedStorable{}, fmt.Errorf("filestore: read snapshot %s: %w", path, err)
	}

	meta, body, err := parseFrontmatter(data)
	if err != nil {
		return store.VersionedStorable{}, fmt.Errorf("filestore: parse snapshot %s: %w", path, err)
	}

	info, _ := os.Stat(path)
	created := ref.Created
	if !created.IsZero() {
		// use the ref timestamp if available; otherwise fall back to file mtime
	} else if info != nil {
		created = info.ModTime()
	} else {
		created = time.Now()
	}

	return store.VersionedStorable{
		Ref:  store.VersionRef{ID: ref.ID, Created: created, Size: int64(len(data))},
		Body: body,
		Meta: meta,
	}, nil
}
