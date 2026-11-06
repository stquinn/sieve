package filestore

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"time"

	"sieve/logger"
	"sieve/store"
)

// RunMigrationIfNeeded checks whether any .md files at the category root level
// need to be migrated to the document-as-directory format and runs the migration
// if so. Idempotent: already-migrated directories are skipped.
//
// Migration marker write-fence:
//  1. Write marker with migration="partial" before touching any files.
//  2. Migrate all documents.
//  3. Write marker with migration="complete".
//
// If the process crashes during migration, the next startup will refuse to
// open the store (ensureStoreMarker returns an error for "partial").
func (fs *FileStore) RunMigrationIfNeeded(categories []store.Category) error {
	needsMigration := false

	// Re-run if a previous migration was interrupted.
	if m, err := fs.readStoreMarker(); err == nil && m.Migration == "partial" {
		needsMigration = true
	}

	if !needsMigration {
		for _, cat := range categories {
			if fs.categoryHasLegacyFiles(cat) {
				needsMigration = true
				break
			}
		}
	}
	if !needsMigration {
		return nil
	}

	logger.Info("filestore: running document-as-directory migration")

	if err := fs.writeStoreMarker(storeMeta{
		Version:   currentStoreVersion,
		Migration: "partial",
	}); err != nil {
		return err
	}

	for _, cat := range categories {
		if err := fs.migrateCategory(cat); err != nil {
			logger.Error("filestore: migration failed for category %s: %v", cat.Key, err)
			// Leave marker as "partial" — startup will refuse and surface the error.
			return err
		}
	}

	logger.Info("filestore: migration complete")
	return fs.writeStoreMarker(storeMeta{
		Version:   currentStoreVersion,
		Migration: "complete",
	})
}

func (fs *FileStore) categoryHasLegacyFiles(cat store.Category) bool {
	catDir := fs.categoryDir(cat)
	pattern := filepath.Join(catDir, "*.md")
	matches, _ := filepath.Glob(pattern)
	if len(matches) > 0 {
		return true
	}
	// Also check one level deep (sub-folders).
	entries, _ := os.ReadDir(catDir)
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		hasMeta := filepath.Join(catDir, e.Name(), ".meta")
		metaMatches, _ := filepath.Glob(hasMeta)
		if len(metaMatches) > 0 {
			logger.Debug("Already a Document Folder Format", "folder", e.Name())
			continue
		}
		subPattern := filepath.Join(catDir, e.Name(), "*.md")
		subMatches, _ := filepath.Glob(subPattern)
		if len(subMatches) > 0 {
			return true
		}
	}
	return false
}

func (fs *FileStore) migrateCategory(cat store.Category) error {
	catDir := fs.categoryDir(cat)

	// Migrate top-level .md files.
	topMatches, _ := filepath.Glob(filepath.Join(catDir, "*.md"))
	for _, mdPath := range topMatches {
		if err := fs.migrateDocument(cat, mdPath); err != nil {
			logger.Error("filestore: migrate %s: %v", mdPath, err)
		}
	}

	// Migrate one level of sub-folders.
	entries, _ := os.ReadDir(catDir)
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		subDir := filepath.Join(catDir, e.Name())

		if err := fs.ensureFolderMeta(cat, e.Name()); err != nil {
			logger.Error("filestore: migrate ensure folder meta %s: %v", e.Name(), err)
		}

		subMatches, _ := filepath.Glob(filepath.Join(subDir, "*.md"))
		for _, mdPath := range subMatches {
			if err := fs.migrateDocument(cat, mdPath); err != nil {
				logger.Error("filestore: migrate %s: %v", mdPath, err)
			}
		}
	}

	return nil
}

func (fs *FileStore) migrateDocument(cat store.Category, mdPath string) error {
	// 1. Read and parse the legacy .md file.
	data, err := os.ReadFile(mdPath)
	if err != nil {
		return err
	}
	meta, body, err := parseFrontmatter(data)
	if err != nil {
		// Best-effort: treat entire file as body with empty meta.
		meta = map[string]string{}
		body = data
	}

	if meta["uuid"] == "" {
		meta["uuid"] = newUUID()
	}
	if meta["created"] == "" {
		meta["created"] = time.Now().Format("2006-01-02T15:04:05")
	}
	if meta["modified"] == "" {
		meta["modified"] = time.Now().Format("2006-01-02T15:04:05")
	}

	uuid := meta["uuid"]
	name := strings.TrimSuffix(filepath.Base(mdPath), ".md")
	docDir := filepath.Join(filepath.Dir(mdPath), name)

	// Skip if already migrated.
	if _, err := os.Stat(filepath.Join(docDir, ".meta")); err == nil {
		return nil
	}

	// 2. Create document directory.
	if err := os.MkdirAll(docDir, 0o755); err != nil {
		return err
	}

	// 3. Write .meta.
	dm := mapToDocMeta(meta)
	dm.Type = store.TypeDocument
	dm.Names = []nameEntry{{Name: name, From: meta["created"]}}
	if err := writeMetaJSONToPath(filepath.Join(docDir, ".meta"), dm); err != nil {
		return err
	}

	// 4. Write {uuid}.md (body only).
	newBody := body

	// 5. Find and move assets from shared .assets/ to the document directory.
	catDir := filepath.Dir(mdPath)
	if filepath.Base(catDir) != cat.Key {
		// We're in a sub-folder; assets are in catDir/../.assets/
		catDir = filepath.Dir(catDir)
	}
	assetsDir := filepath.Join(catDir, ".assets")
	assetPattern := filepath.Join(assetsDir, name+"-*")
	assetMatches, _ := filepath.Glob(assetPattern)
	for _, assetPath := range assetMatches {
		base := filepath.Base(assetPath)
		suffix := strings.TrimPrefix(base, name+"-")
		newFilename := uuid + "-" + suffix
		destPath := filepath.Join(docDir, newFilename)
		if err := os.Rename(assetPath, destPath); err != nil {
			logger.Error("filestore: migrate asset %s: %v", assetPath, err)
			continue
		}
		// Update body references.
		oldRef := cat.Key + "/.assets/" + base
		newRef := store.AssetURL(uuid, newFilename)
		newBody = bytes.ReplaceAll(newBody, []byte(oldRef), []byte(newRef))
	}

	if err := writeAtomic(filepath.Join(docDir, uuid+".md"), newBody); err != nil {
		return err
	}

	// 6. Move snapshots from category .history/ to docDir/.history/.
	histSrc := filepath.Join(catDir, ".history")
	histDst := filepath.Join(docDir, ".history")
	_ = os.MkdirAll(histDst, 0o755)
	snapPattern := filepath.Join(histSrc, uuid+".*.md")
	snapMatches, _ := filepath.Glob(snapPattern)
	for _, snap := range snapMatches {
		snapData, err := os.ReadFile(snap)
		if err != nil {
			continue
		}
		// Strip frontmatter from snapshot; store body only.
		_, snapBody, err := parseFrontmatter(snapData)
		if err != nil {
			snapBody = snapData
		}
		dst := filepath.Join(histDst, filepath.Base(snap))
		_ = os.WriteFile(dst, snapBody, 0o644)
		// Remove old snapshot from shared history.
		_ = os.Remove(snap)
	}

	// 7. Remove original .md file.
	return os.Remove(mdPath)
}

// MoveFromMachineFolder moves what this host's machine folder holds for cat,
// {root}/{hostname}/{cat.Key}/, to where a Shared cat lays it out, and returns how
// many storables it moved. It is for a category that was Isolated and is Shared
// now; for an Isolated cat the machine folder is its directory and nothing moves.
//
// Each storable directory moves whole, by one rename, with its assets and
// history, to the directory it would be created in under cat (a block onto the
// shelf of its kind). A directory whose .meta cannot be read, that holds no
// content, whose place cannot be derived or whose target already exists stays
// where it is and is logged; nothing is deleted or overwritten, and one failure
// does not stop the rest. The machine folder of cat is removed once it is empty.
// Another host's machine folder is never read.
func (fs *FileStore) MoveFromMachineFolder(cat store.Category) int {
	if cat.Isolation != store.Shared {
		return 0
	}
	machineDir := filepath.Join(fs.root, fs.hostname, cat.Key)
	entries, err := os.ReadDir(machineDir)
	if err != nil {
		if !os.IsNotExist(err) {
			logger.Warn("filestore: cannot read machine folder", "dir", machineDir, "err", err)
		}
		return 0
	}
	moved := 0
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		if fs.moveOutOfMachineFolder(cat, machineDir, e.Name()) {
			moved++
		}
	}
	if err := os.Remove(machineDir); err == nil {
		logger.Info("filestore: machine folder emptied", "dir", machineDir)
	}
	if moved > 0 {
		logger.Info("filestore: moved out of the machine folder", "category", cat.Key, "moved", moved)
	}
	return moved
}

// moveOutOfMachineFolder moves the storable directory name in machineDir into
// cat, reporting whether it moved.
func (fs *FileStore) moveOutOfMachineFolder(cat store.Category, machineDir, name string) bool {
	src := filepath.Join(machineDir, name)
	dm, err := readMetaJSONFromPath(filepath.Join(src, ".meta"))
	if err != nil {
		logger.Warn("filestore: left in machine folder: unreadable .meta", "dir", src, "err", err)
		return false
	}
	if !fs.holdsContent(dm.Type) {
		logger.Warn("filestore: left in machine folder: holds no content", "dir", src, "type", dm.Type)
		return false
	}
	key, err := fs.contentDirKey(name, dm.Type, dm.Kind)
	if err != nil {
		logger.Warn("filestore: left in machine folder", "dir", src, "err", err)
		return false
	}
	dst := fs.docDir(cat, key)
	if _, err := os.Lstat(dst); !os.IsNotExist(err) {
		logger.Warn("filestore: left in machine folder: target exists", "dir", src, "target", dst, "err", err)
		return false
	}
	if err := os.MkdirAll(filepath.Dir(dst), 0o755); err != nil {
		logger.Warn("filestore: left in machine folder", "dir", src, "err", err)
		return false
	}
	if err := os.Rename(src, dst); err != nil {
		logger.Warn("filestore: left in machine folder", "dir", src, "err", err)
		return false
	}
	fs.indexDel(dm.UUID)
	return true
}
