package filestore

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"stash/store"
)

// scanCategory walks the category directory and returns a flat list of all
// Storables found (MetaStorable for .md files, AssetStorable for binary files
// in assets subdirectories). Directories are returned as FolderStorable values
// with their Owns list populated.
//
// Hidden entries (dot-prefixed names other than recognised asset dirs) are
// skipped. The .history directory is always skipped.
//
// prefix restricts results to entries whose key begins with prefix. An empty
// prefix returns all entries.
func (fs *FileStore) scanCategory(cat store.Category, prefix string) ([]store.Storable, error) {
	root := fs.categoryDir(cat)
	infos, err := os.ReadDir(root)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, err
	}

	var results []store.Storable
	for _, info := range infos {
		name := info.Name()
		// Skip hidden entries except .assets (the canonical asset directory).
		if strings.HasPrefix(name, ".") && name != ".assets" {
			continue
		}

		key := name
		if prefix != "" && !strings.HasPrefix(key, prefix) {
			continue
		}

		if info.IsDir() {
			folder, err := fs.scanFolder(cat, key)
			if err != nil {
				continue
			}
			results = append(results, folder)
			// Also surface the folder's children in the flat list so callers
			// can iterate all leaf nodes without recursion.
			results = append(results, folder.Owns()...)
		} else {
			s := fs.buildStorable(cat, key, root)
			if s != nil {
				results = append(results, s)
			}
		}
	}

	// Sort by key for deterministic ordering.
	sort.Slice(results, func(i, j int) bool {
		return results[i].Key() < results[j].Key()
	})
	return results, nil
}

// scanFolder reads a subdirectory and returns a fileFolderStorable whose Owns
// list contains every Storable in that directory (non-recursive: one level).
func (fs *FileStore) scanFolder(cat store.Category, dirKey string) (*fileFolderStorable, error) {
	dirPath := filepath.Join(fs.categoryDir(cat), dirKey)
	infos, err := os.ReadDir(dirPath)
	if err != nil {
		return nil, err
	}

	var owns []store.Storable
	for _, info := range infos {
		if info.IsDir() {
			continue // only one level of folders for now
		}
		name := info.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		childKey := dirKey + "/" + name
		s := fs.buildStorable(cat, childKey, fs.categoryDir(cat))
		if s != nil {
			owns = append(owns, s)
		}
	}

	extRef := fs.externalRef(cat, dirKey)
	return &fileFolderStorable{
		fileStorable: fileStorable{
			key:      dirKey,
			category: cat,
			extRef:   extRef,
		},
		owns: owns,
	}, nil
}

// buildStorable reads a single file by key within the category directory and
// returns the appropriate Storable type:
//
//   - .md files                → fileMetaStorable (with parsed frontmatter)
//   - files in an assets/ dir  → fileAssetStorable (encoding inferred)
//   - other files              → fileStorable (plain bytes, e.g. JSON)
//
// Returns nil if the file cannot be read or is not relevant (e.g. a .tmp file).
func (fs *FileStore) buildStorable(cat store.Category, key string, catDir string) store.Storable {
	if strings.HasSuffix(key, ".tmp") {
		return nil
	}

	absPath := filepath.Join(catDir, key)
	data, err := os.ReadFile(absPath)
	if err != nil {
		return nil
	}

	extRef := fs.externalRef(cat, key)

	// Asset files: any file whose key contains an assets segment.
	if isAssetKey(key) {
		enc := inferEncoding(data)
		return &fileAssetStorable{
			fileStorable: fileStorable{
				key:      key,
				category: cat,
				body:     data,
				extRef:   extRef,
			},
			encoding: enc,
		}
	}

	// Markdown documents.
	if strings.HasSuffix(key, ".md") {
		meta, body, err := parseFrontmatter(data)
		if err != nil {
			// Unreadable frontmatter — return as MetaStorable in an error state
			// so it still appears in the UI (with a warning) instead of disappearing.
			return &fileMetaStorable{
				fileStorable: fileStorable{
					key:      key,
					category: cat,
					body:     data, // Provide the raw unparsed data for manual repair.
					extRef:   extRef,
				},
				meta: map[string]string{
					"status":       "error",
					"display_name": "⚠️ ERROR: " + filepath.Base(key),
				},
			}
		}
		uuid := meta["uuid"]
		versions := fs.loadVersions(uuid, cat)

		var owns []store.Storable
		if assetsStr := meta["assets"]; assetsStr != "" && assetsStr != "[]" {
			assetsStr = strings.TrimPrefix(assetsStr, "[")
			assetsStr = strings.TrimSuffix(assetsStr, "]")

			for _, part := range strings.Split(assetsStr, ",") {
				link := strings.TrimSpace(part)
				if link == "" {
					continue
				}

				// Resolve absolute store-root references or markdown-relative paths
				var assetKey string
				if strings.HasPrefix(link, "store/") || strings.Contains(link, "/buffers/") {
					// It's an ExternalRef. We need the true Category-relative Key.
					if strings.HasPrefix(link, cat.Key+"/") {
						assetKey = strings.TrimPrefix(link, cat.Key+"/")
					} else if cat.Isolation == store.Isolated && strings.HasPrefix(link, fs.hostname+"/"+cat.Key+"/") {
						assetKey = strings.TrimPrefix(link, fs.hostname+"/"+cat.Key+"/")
					} else {
						// Link belongs to another category; skip ownership graph inclusion.
						continue
					}
				} else {
					assetKey = filepath.Join(filepath.Dir(key), link)
				}

				assetKey = filepath.ToSlash(filepath.Clean(assetKey))
				if isAssetKey(assetKey) {
					child := fs.buildStorable(cat, assetKey, catDir)
					if child != nil {
						owns = append(owns, child)
					}
				}
			}
		}

		return &fileMetaStorable{
			fileStorable: fileStorable{
				key:      key,
				category: cat,
				body:     body,
				extRef:   extRef,
				versions: versions,
			},
			meta: meta,
			owns: owns,
		}
	}

	// Plain files (JSON, text — used for State category).
	return &fileStorable{
		key:      key,
		category: cat,
		body:     data,
		extRef:   extRef,
	}
}

// isAssetKey reports whether key refers to a file inside an assets subdirectory.
// The recognised patterns are:
//
//	.assets/...     — Universal asset storage
func isAssetKey(key string) bool {
	return strings.HasPrefix(key, ".assets/") ||
		strings.Contains(key, "/.assets/")
}
