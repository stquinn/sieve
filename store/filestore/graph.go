package filestore

import (
	"os"
	"path/filepath"
	"sort"
	"strings"

	"sieve/store"
)

// scanCategory walks the category directory and returns a flat list of all
// Sieve-managed nodes. A directory is a node if it contains a .meta file.
// Directories without .meta are ignored. Dot-prefixed entries are skipped.
// Folders surface their children in the flat list for caller convenience.
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
		if !info.IsDir() {
			continue
		}
		name := info.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		if prefix != "" && !strings.HasPrefix(name, prefix) {
			continue
		}

		metaPath := filepath.Join(root, name, ".meta")
		metaType, err := readMetaType(metaPath)
		if err != nil {
			continue // no .meta = not a Sieve node
		}

		switch metaType {
		case "folder":
			folder, err := fs.scanFolderNode(cat, name)
			if err != nil {
				continue
			}
			results = append(results, folder)
			results = append(results, folder.Owns()...)
		case "document":
			dm, err := readMetaJSONFromPath(metaPath)
			if err != nil {
				continue
			}
			s := fs.buildDocStorable(cat, name, dm, false)
			if s != nil {
				results = append(results, s)
			}
		}
	}

	sort.Slice(results, func(i, j int) bool {
		return results[i].Key() < results[j].Key()
	})
	return results, nil
}

// scanFolderNode reads a folder directory and returns a fileFolderStorable
// whose Owns list contains every child Sieve node (recursive).
func (fs *FileStore) scanFolderNode(cat store.Category, dirKey string) (*fileFolderStorable, error) {
	dirPath := filepath.Join(fs.categoryDir(cat), dirKey)
	infos, err := os.ReadDir(dirPath)
	if err != nil {
		return nil, err
	}

	var folderUUID string
	if meta, err := readFolderMetaJSONFromPath(filepath.Join(dirPath, ".meta")); err == nil {
		folderUUID = meta.UUID
	}

	var owns []store.Storable
	for _, info := range infos {
		if !info.IsDir() {
			continue
		}
		name := info.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}

		childKey := dirKey + "/" + name
		childMetaPath := filepath.Join(dirPath, name, ".meta")
		metaType, err := readMetaType(childMetaPath)
		if err != nil {
			continue
		}

		switch metaType {
		case "document":
			dm, err := readMetaJSONFromPath(childMetaPath)
			if err != nil {
				continue
			}
			s := fs.buildDocStorable(cat, childKey, dm, false)
			if s != nil {
				owns = append(owns, s)
			}
		case "folder":
			sub, err := fs.scanFolderNode(cat, childKey)
			if err == nil && sub != nil {
				owns = append(owns, sub)
			}
		}
	}

	return &fileFolderStorable{
		fileStorable: fileStorable{
			key:      folderUUID,
			path:     dirKey,
			category: cat,
			extRef:   fs.externalRef(cat, dirKey),
		},
		owns: owns,
	}, nil
}

// buildDocStorable constructs a fileMetaStorable from a pre-read docMeta.
// withVersions controls whether .history is scanned (false for bulk List calls).
func (fs *FileStore) buildDocStorable(cat store.Category, key string, dm *docMeta, withVersions bool) store.Storable {
	body, _ := os.ReadFile(fs.contentPath(cat, key, dm.UUID))

	var versions []store.VersionRef
	if withVersions {
		versions = fs.loadVersions(dm.UUID, cat, key)
	}

	fs.indexSet(dm.UUID, uuidEntry{cat: cat, dirKey: key})
	owns := fs.scanDocAssets(cat, key, dm.UUID)

	return &fileMetaStorable{
		fileStorable: fileStorable{
			key:      dm.UUID,
			path:     key,
			category: cat,
			body:     body,
			extRef:   fs.externalRef(cat, key),
			versions: versions,
		},
		meta: docMetaToMap(dm),
		owns: owns,
	}
}

// scanDocAssets scans a document directory for co-located asset files and
// returns them as AssetStorables. Skips .meta, {uuid}.md, dot-dirs, and
// any directory entries.
func (fs *FileStore) scanDocAssets(cat store.Category, key string, uuid string) []store.Storable {
	dir := fs.docDir(cat, key)
	entries, err := os.ReadDir(dir)
	if err != nil {
		return nil
	}
	contentFile := uuid + ".md"
	var assets []store.Storable
	for _, e := range entries {
		if e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		if e.Name() == ".meta" || e.Name() == contentFile {
			continue
		}
		// Any remaining file is treated as an asset.
		assetPath := filepath.Join(dir, e.Name())
		data, err := os.ReadFile(assetPath)
		if err != nil {
			continue
		}
		assetExtRef := "/sieve/" + uuid + "/" + e.Name()
		assets = append(assets, &fileAssetStorable{
			fileStorable: fileStorable{
				key:      e.Name(),
				path:     e.Name(),
				category: cat,
				body:     data,
				extRef:   assetExtRef,
			},
			encoding: inferEncoding(data),
		})
	}
	return assets
}

// scanFolder is the legacy folder scan used by CreateOrLoadFolder and
// LoadFolder. It reads a single-level directory and returns a folder storable.
func (fs *FileStore) scanFolder(cat store.Category, dirKey string) (*fileFolderStorable, error) {
	return fs.scanFolderNode(cat, dirKey)
}
