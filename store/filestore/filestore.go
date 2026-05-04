// Package filestore implements the store.Store interface backed by the local
// filesystem.
//
// # Directory layout
//
//	{root}/store/                          Library notes (Shared)
//	{root}/store/{note-name}/              Document directory
//	{root}/store/{note-name}/.meta         JSON metadata
//	{root}/store/{note-name}/{uuid}.md     Pure markdown body
//	{root}/store/{note-name}/.history/     Body-only snapshots
//	{root}/store/{note-name}/.cache/       Derived data (sessions, links)
//	{root}/{hostname}/buffers/             WorkingCopy buffers (Isolated)
//	{root}/{hostname}/config/              State — settings, session (Isolated)
//	{root}/.sieve                          Store marker / migration state
//
// # Keys
//
// A key is the directory name relative to its category directory. Documents no
// longer carry a .md extension — the extension lives only on the content file
// inside the document directory.
//
//	Library      "sub/my-note"      → {root}/store/sub/my-note/
//	WorkingCopy  "buf-20240102-1504" → {root}/{hostname}/buffers/buf-20240102-1504/
//	State        "settings.json"    → {root}/{hostname}/config/settings.json  (plain file)
//
// # ExternalRef
//
// ExternalRef is the store-root relative path of a document directory:
//
//	Library note  → "store/sub/my-note"
//	WorkingCopy   → "{hostname}/buffers/buf-20240102-1504"
//
// # Assets
//
// Assets are co-located inside the document directory and served via a
// UUID-stable URL:  /sieve/{uuid}/{filename}
package filestore

import (
	"bytes"
	"crypto/rand"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"sync"
	"time"

	"sieve/logger"
	"sieve/store"
)

// FileStore is a filesystem-backed implementation of store.Store.
// Create one with NewFileStore — do not construct directly.
type FileStore struct {
	root        string
	hostname    string
	maxVersions int

	indexMu   sync.RWMutex
	uuidIndex map[string]store.Storable // uuid → cached Storable
}

// NewFileStore initialises a FileStore rooted at root for the given hostname.
func NewFileStore(root, hostname string) (*FileStore, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("filestore: resolve root: %w", err)
	}
	fs := &FileStore{
		root:        abs,
		hostname:    hostname,
		maxVersions: 200,
		uuidIndex:   make(map[string]store.Storable),
	}
	if err := fs.ensureStoreMarker(); err != nil {
		return nil, err
	}
	return fs, nil
}

// SetMaxVersions overrides the snapshot retention limit. 0 = keep all.
func (fs *FileStore) SetMaxVersions(n int) { fs.maxVersions = n }

// ── Store interface ───────────────────────────────────────────────────────────

func (fs *FileStore) CreateMetaText(cat store.Category, key string, body []byte) (store.MetaStorable, error) {
	if key == "" {
		key = fs.generateKey(cat)
	}
	key = strings.TrimSuffix(key, ".md")
	return fs.createMeta(cat, key, body)
}

func (fs *FileStore) CreateAsset(cat store.Category, parentKey string, assetID string, body []byte) (store.AssetStorable, error) {
	parentKey = strings.TrimSuffix(parentKey, ".md")
	ext := extFromBytes(body)
	filename := assetID + ext

	var assetPath string
	var docUUID string
	var resolvedKey string

	if parentKey != "" && parentKey != "new" {
		// parentKey may be a UUID or a directory key — try UUID cache first.
		if cached, ok := fs.LookupUUID(parentKey); ok {
			resolvedKey = dirKey(cached)
			docUUID = parentKey
			cat = cached.Category()
		} else {
			resolvedKey = parentKey
			if dm, err := readMetaJSONFromPath(fs.metaPath(cat, resolvedKey)); err == nil {
				docUUID = dm.UUID
			}
		}
		assetPath = filepath.Join(fs.docDir(cat, resolvedKey), filename)
	} else {
		// No parent: fall back to category-level .assets/ dir.
		assetPath = filepath.Join(fs.categoryDir(cat), ".assets", filename)
	}

	if err := os.MkdirAll(filepath.Dir(assetPath), 0o755); err != nil {
		return nil, fmt.Errorf("filestore: create asset dir: %w", err)
	}
	if err := os.WriteFile(assetPath, body, 0o644); err != nil {
		return nil, fmt.Errorf("filestore: create asset %s: %w", filename, err)
	}

	enc := inferEncoding(body)

	var extRef string
	if docUUID != "" {
		extRef = "/sieve/" + docUUID + "/" + filename
	} else {
		extRef = fs.externalRef(cat, ".assets/"+filename)
	}

	var key string
	if resolvedKey != "" {
		key = resolvedKey + "/" + filename
	} else {
		key = ".assets/" + filename
	}

	return &fileAssetStorable{
		fileStorable: fileStorable{
			key:      filename,
			path:     key,
			category: cat,
			body:     body,
			extRef:   extRef,
		},
		encoding: enc,
	}, nil
}

func (fs *FileStore) CreateText(cat store.Category, key string, body []byte) (store.Storable, error) {
	if key == "" {
		key = fs.generateKey(cat)
	}
	absPath := fs.absPath(cat, key)
	if err := os.MkdirAll(filepath.Dir(absPath), 0o755); err != nil {
		return nil, fmt.Errorf("filestore: create dir for %s: %w", key, err)
	}
	return fs.createPlain(cat, key, absPath, body)
}

func (fs *FileStore) CreateOrLoadFolder(category store.Category, name string) (store.FolderStorable, error) {
	if cached, ok := fs.LookupUUID(name); ok {
		category = cached.Category()
		name = dirKey(cached)
	}
	name = strings.TrimPrefix(name, category.Key+"/")
	logger.Debug("CreateOrLoadFolder: %s, %s", category, name)
	dir := fs.docDir(category, name)

	if _, err := os.Stat(dir); os.IsNotExist(err) {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("filestore: create folder %s: %w", name, err)
		}
		mp := filepath.Join(dir, ".meta")
		if _, statErr := os.Stat(mp); os.IsNotExist(statErr) {
			fm := &folderMeta{
				UUID:    newUUID(),
				Type:    "folder",
				Created: time.Now().Format("2006-01-02T15:04:05"),
			}
			_ = writeFolderMetaToPath(mp, fm)
		}
	}

	folder, err := fs.scanFolder(category, name)
	if err != nil {
		return nil, err
	}
	fs.indexSet(folder.Key(), folder)
	return folder, nil
}

func (fs *FileStore) LoadFolder(category store.Category, name string) (store.FolderStorable, error) {
	if cached, ok := fs.LookupUUID(name); ok {
		category = cached.Category()
		name = dirKey(cached)
	}
	name = strings.TrimPrefix(name, category.Key+"/")
	logger.Debug("LoadFolder: %s, %s", category, name)
	dir := fs.docDir(category, name)
	if _, err := os.Stat(dir); err != nil {
		return nil, err
	}
	folder, err := fs.scanFolder(category, name)
	if err != nil {
		return nil, err
	}
	fs.indexSet(folder.Key(), folder)
	return folder, nil
}

func (fs *FileStore) Save(s store.Storable) (store.Storable, error) {
	switch typed := s.(type) {
	case *fileMetaStorable:
		return fs.saveContent(typed)
	case *fileAssetStorable:
		return fs.saveAsset(typed)
	case *fileStorable:
		return fs.savePlain(typed)
	default:
		return nil, fmt.Errorf("filestore: Save: unsupported Storable type %T", s)
	}
}

func (fs *FileStore) SaveMeta(s store.MetaStorable) (store.MetaStorable, error) {
	ms, ok := s.(*fileMetaStorable)
	if !ok {
		return nil, fmt.Errorf("filestore: SaveMeta: unsupported type %T", s)
	}
	path := ms.path

	// Read current .meta to preserve names and other non-map fields.
	existingDM, _ := readMetaJSONFromPath(fs.metaPath(ms.category, path))

	newDM := mapToDocMeta(ms.meta)
	newDM.Type = "document"
	if existingDM != nil {
		newDM.Names = existingDM.Names
	}

	if err := writeMetaJSONToPath(fs.metaPath(ms.Category(), path), newDM); err != nil {
		return nil, fmt.Errorf("filestore: SaveMeta %s: %w", path, err)
	}

	saved := &fileMetaStorable{
		fileStorable: fileStorable{
			key:      ms.Key(),
			path:     ms.path,
			category: ms.Category(),
			body:     ms.Body(),
			extRef:   ms.ExternalRef(),
			versions: ms.Versions(),
		},
		meta: docMetaToMap(newDM),
	}
	fs.indexSet(ms.Key(), saved)
	return saved, nil
}

func (fs *FileStore) LoadByUUID(uuid string) (store.Storable, error) {
	cached, ok := fs.LookupUUID(uuid)
	if !ok {
		return nil, fmt.Errorf("filestore: UUID %s not found", uuid)
	}
	return cached, nil
}

func (fs *FileStore) Load(cat store.Category, key string) (store.Storable, error) {
	if cached, ok := fs.LookupUUID(key); ok {
		cat = cached.Category()
		key = dirKey(cached)
	}
	if cat.MetaEnabled {
		key = strings.TrimSuffix(key, ".md")
	}

	absPath := fs.absPath(cat, key)
	if info, err := os.Stat(absPath); err == nil && !info.IsDir() {
		data, err := os.ReadFile(absPath)
		if err != nil {
			return nil, fmt.Errorf("filestore: load %s: %w", key, err)
		}
		return &fileStorable{
			key:      key,
			path:     key,
			category: cat,
			body:     data,
			extRef:   fs.externalRef(cat, key),
		}, nil
	}

	metaPath := fs.metaPath(cat, key)
	dm, err := readMetaJSONFromPath(metaPath)
	if err != nil {
		if os.IsNotExist(err) {
			// Fall back to plain file check again in case stat failed earlier
			data, ferr := os.ReadFile(absPath)
			if ferr != nil {
				return nil, fmt.Errorf("filestore: %s: not found", key)
			}
			return &fileStorable{
				key:      key,
				path:     key,
				category: cat,
				body:     data,
				extRef:   fs.externalRef(cat, key),
			}, nil
		}
		return nil, fmt.Errorf("filestore: load .meta for %s: %w", key, err)
	}

	if dm.Type != "document" {
		return nil, fmt.Errorf("filestore: %s is not a document (type=%s)", key, dm.Type)
	}

	body, _ := os.ReadFile(fs.contentPath(cat, key, dm.UUID))
	versions := fs.loadVersions(dm.UUID, cat, key)
	owns := fs.scanDocAssets(cat, key, dm.UUID)

	s := &fileMetaStorable{
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
	fs.indexSet(dm.UUID, s)
	return s, nil
}

func (fs *FileStore) LoadAsset(cat store.Category, uuid string, assetKey string) (store.AssetStorable, error) {
	cached, ok := fs.LookupUUID(uuid)
	if !ok {
		return nil, fmt.Errorf("filestore: LoadAsset: UUID %s not found", uuid)
	}
	ms, ok := cached.(store.MetaStorable)
	if !ok {
		return nil, fmt.Errorf("filestore: LoadAsset: %s is not a MetaStorable", uuid)
	}
	for _, asset := range ms.Owns() {
		if asset.Key() == assetKey {
			if as, ok := asset.(store.AssetStorable); ok {
				return as, nil
			}
		}
	}
	return nil, fmt.Errorf("filestore: LoadAsset: asset %s not found in %s", assetKey, uuid)
}

func (fs *FileStore) Delete(s store.Storable) error {
	path := dirKey(s)
	logger.Debug("Deleting: %s", s.ExternalRef())

	dir := fs.docDir(s.Category(), path)
	if err := os.RemoveAll(dir); err != nil {
		return fmt.Errorf("filestore: delete %s: %w", path, err)
	}

	if ms, ok := s.(store.MetaStorable); ok {
		if uuid := ms.Meta()["uuid"]; uuid != "" {
			fs.indexDel(uuid)
		}
	}
	return nil
}

func (fs *FileStore) List(cat store.Category, prefix string) ([]store.Storable, error) {
	return fs.scanCategory(cat, prefix)
}

func (fs *FileStore) ListFrom(categories []store.Category, prefix string) ([]store.Storable, error) {
	var items []store.Storable
	for _, cat := range categories {
		newItems, err := fs.scanCategory(cat, prefix)
		if err != nil {
			return nil, err
		}
		items = append(items, newItems...)
	}
	return items, nil
}

// Move transfers s to a different category via a directory rename.
// History and assets travel with the document directory automatically.
func (fs *FileStore) Move(s store.Storable, to store.Category) (store.Storable, error) {
	path := dirKey(s)
	srcDir := fs.docDir(s.Category(), path)
	dstDir := fs.docDir(to, path)

	if err := os.MkdirAll(filepath.Dir(dstDir), 0o755); err != nil {
		return nil, fmt.Errorf("filestore: Move mkdir: %w", err)
	}
	if err := os.Rename(srcDir, dstDir); err != nil {
		return nil, fmt.Errorf("filestore: Move %s: %w", s.Key(), err)
	}

	return fs.Load(to, path) // Load updates the cache with the new location.
}

// Reparent moves s under folder by directory rename.
func (fs *FileStore) Reparent(s store.Storable, folder store.FolderStorable) (store.Storable, error) {
	ff := folder.(*fileFolderStorable)
	newKey := ff.path + "/" + filepath.Base(s.(*fileMetaStorable).path)
	return fs.renameKey(s, newKey)
}

// Rename changes the basename of s's key. Appends to the names history in
// .meta and performs a single atomic directory rename.
func (fs *FileStore) Rename(s store.Storable, name string) (store.Storable, error) {
	path := dirKey(s)
	dir := filepath.Dir(path)
	var newKey string
	if dir == "." {
		newKey = name
	} else {
		newKey = dir + "/" + name
	}
	return fs.renameKey(s, newKey)
}

func (fs *FileStore) RetrieveVersion(s store.Storable, ref store.VersionRef) (store.VersionedStorable, error) {
	ms, ok := s.(store.MetaStorable)
	if !ok {
		return store.VersionedStorable{}, fmt.Errorf("filestore: RetrieveVersion: storable has no metadata")
	}
	uuid := ms.Meta()["uuid"]
	if uuid == "" {
		return store.VersionedStorable{}, fmt.Errorf("filestore: RetrieveVersion: storable has no uuid")
	}
	path := dirKey(s)
	return fs.retrieveVersion(s.Category(), path, uuid, ref)
}

// ── Path helpers ──────────────────────────────────────────────────────────────

// categoryDir returns the absolute path for the root directory of cat.
func (fs *FileStore) categoryDir(cat store.Category) string {
	if cat.Isolation == store.Isolated {
		return filepath.Join(fs.root, fs.hostname, cat.Key)
	}
	return filepath.Join(fs.root, cat.Key)
}

// docDir returns the absolute path to the document or folder directory.
func (fs *FileStore) docDir(cat store.Category, key string) string {
	return filepath.Join(fs.categoryDir(cat), filepath.FromSlash(key))
}

// absPath returns the absolute filesystem path for a key, used for plain files
// (State category) and backward-compat lookups.
func (fs *FileStore) absPath(cat store.Category, key string) string {
	return filepath.Join(fs.categoryDir(cat), filepath.FromSlash(key))
}

// metaPath returns the path to the .meta file inside a document directory.
func (fs *FileStore) metaPath(cat store.Category, key string) string {
	return filepath.Join(fs.docDir(cat, key), ".meta")
}

// contentPath returns the path to the {uuid}.md content file.
func (fs *FileStore) contentPath(cat store.Category, key string, uuid string) string {
	return filepath.Join(fs.docDir(cat, key), uuid+".md")
}

// externalRef returns the ExternalRef for a Storable — store-root relative.
func (fs *FileStore) externalRef(cat store.Category, key string) string {
	key = filepath.ToSlash(key)
	if cat.Isolation == store.Isolated {
		return fs.hostname + "/" + cat.Key + "/" + key
	}
	return cat.Key + "/" + key
}

// ── UUID index ────────────────────────────────────────────────────────────────

// indexSet stores s under its UUID. Overwrites any existing entry so the cache
// always reflects the most recently written Storable (newest version, updated
// meta). No-op when uuid is empty or s is nil.
func (fs *FileStore) indexSet(uuid string, s store.Storable) {
	if uuid == "" || s == nil {
		return
	}
	fs.indexMu.Lock()
	fs.uuidIndex[uuid] = s
	fs.indexMu.Unlock()
}

func (fs *FileStore) indexDel(uuid string) {
	fs.indexMu.Lock()
	delete(fs.uuidIndex, uuid)
	fs.indexMu.Unlock()
}

// LookupUUID returns the cached Storable for uuid. On a cache miss it rebuilds
// the index from disk (should not happen in normal operation — every write path
// calls indexSet). Returns nil, false when the UUID genuinely does not exist.
func (fs *FileStore) LookupUUID(uuid string) (store.Storable, bool) {
	fs.indexMu.RLock()
	s, ok := fs.uuidIndex[uuid]
	fs.indexMu.RUnlock()
	if ok {
		return s, true
	}

	// Only UUID-shaped strings are stored in the index; skip the scan for anything else.
	if !looksLikeUUID(uuid) {
		return nil, false
	}

	logger.Warn("filestore: UUID index miss for %s — scanning", uuid)
	fs.rebuildIndex()

	fs.indexMu.RLock()
	s, ok = fs.uuidIndex[uuid]
	fs.indexMu.RUnlock()
	return s, ok
}

// DocDirByUUID returns the absolute filesystem path to the document directory
// for uuid. O(1) after the first List warms the cache.
func (fs *FileStore) DocDirByUUID(uuid string) (string, bool) {
	cached, ok := fs.LookupUUID(uuid)
	if !ok {
		return "", false
	}
	return fs.docDir(cached.Category(), dirKey(cached)), true
}

func (fs *FileStore) rebuildIndex() {
	// Scan all known categories. The service_provider defines which categories
	// exist; FileStore doesn't have that list. Scan the store root for directories
	// that look like category dirs and walk their contents.
	rootEntries, err := os.ReadDir(fs.root)
	if err != nil {
		return
	}
	for _, entry := range rootEntries {
		if !entry.IsDir() || strings.HasPrefix(entry.Name(), ".") {
			continue
		}
		// Walk the top-level dir looking for .meta files.
		topDir := filepath.Join(fs.root, entry.Name())
		fs.walkIndexDir(topDir)
	}
}

func (fs *FileStore) walkIndexDir(dir string) {
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	for _, e := range entries {
		if !e.IsDir() || strings.HasPrefix(e.Name(), ".") {
			continue
		}
		subDir := filepath.Join(dir, e.Name())
		metaPath := filepath.Join(subDir, ".meta")
		dm, err := readMetaJSONFromPath(metaPath)
		if err != nil {
			// No .meta or unparseable — recurse in case it's a category or
			// hostname dir containing category subdirs.
			fs.walkIndexDir(subDir)
			continue
		}
		if dm.UUID != "" {
			// Reconstruct category + dirKey from the filesystem path.
			rel, err := filepath.Rel(fs.root, subDir)
			if err == nil {
				rel = filepath.ToSlash(rel)
				parts := strings.SplitN(rel, "/", 3)
				var cat store.Category
				var dk string
				switch {
				case len(parts) >= 2 && parts[0] == fs.hostname:
					cat = store.Category{Key: parts[1], Isolation: store.Isolated}
					dk = strings.Join(parts[2:], "/")
				case len(parts) >= 1:
					cat = store.Category{Key: parts[0], Isolation: store.Shared}
					dk = strings.Join(parts[1:], "/")
				}
				if dk != "" {
					switch dm.Type {
					case "document":
						fs.buildDocStorable(cat, dk, dm) // registers in index
					case "folder":
						if folder, err := fs.scanFolder(cat, dk); err == nil {
							fs.indexSet(dm.UUID, folder)
						}
					}
				}
			}
		}
		// Recurse for nested folders (folders don't get indexed but their
		// children do).
		if dm.Type == "folder" {
			fs.walkIndexDir(subDir)
		}
	}
}

// ── Internal create helpers ───────────────────────────────────────────────────

func (fs *FileStore) createMeta(cat store.Category, key string, body []byte) (store.MetaStorable, error) {
	// Parse optional frontmatter from the seed body.
	initialMeta, pureBody, err := parseFrontmatter(body)
	if err != nil {
		return nil, fmt.Errorf("filestore: create %s: %w", key, err)
	}

	fs.stampCreate(initialMeta)

	dm := mapToDocMeta(initialMeta)
	dm.Type = "document"
	dm.Names = []nameEntry{{Name: filepath.Base(key), From: initialMeta["created"]}}

	dir := fs.docDir(cat, key)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, fmt.Errorf("filestore: create dir %s: %w", key, err)
	}

	if err := writeMetaJSONToPath(fs.metaPath(cat, key), dm); err != nil {
		return nil, fmt.Errorf("filestore: write .meta for %s: %w", key, err)
	}

	if err := writeAtomic(fs.contentPath(cat, key, dm.UUID), pureBody); err != nil {
		return nil, fmt.Errorf("filestore: write content for %s: %w", key, err)
	}

	s := &fileMetaStorable{
		fileStorable: fileStorable{
			key:      dm.UUID,
			path:     key,
			category: cat,
			body:     pureBody,
			extRef:   fs.externalRef(cat, key),
			versions: fs.loadVersions(dm.UUID, cat, key),
		},
		meta: docMetaToMap(dm),
	}
	fs.indexSet(dm.UUID, s)
	return s, nil
}

func (fs *FileStore) createAsset(cat store.Category, key, absPath string, body []byte) (store.AssetStorable, error) {
	if err := os.WriteFile(absPath, body, 0o644); err != nil {
		return nil, fmt.Errorf("filestore: create asset %s: %w", key, err)
	}
	enc := inferEncoding(body)
	extRef := fs.externalRef(cat, key)
	return &fileAssetStorable{
		fileStorable: fileStorable{
			key:      key,
			path:     key,
			category: cat,
			body:     body,
			extRef:   extRef,
		},
		encoding: enc,
	}, nil
}

func (fs *FileStore) createPlain(cat store.Category, key, absPath string, body []byte) (store.Storable, error) {

	logger.Info("Before Write", "absPath", absPath)
	if err := os.WriteFile(absPath, body, 0o644); err != nil {
		return nil, fmt.Errorf("filestore: create %s: %w", key, err)
	}

	extRef := fs.externalRef(cat, key)

	return &fileStorable{
		key:      key,
		path:     key,
		category: cat,
		body:     body,
		extRef:   extRef,
	}, nil
}

// ── Internal save helpers ─────────────────────────────────────────────────────

func (fs *FileStore) saveContent(s *fileMetaStorable) (store.Storable, error) {
	path := s.path
	key := s.key

	onDisk, err := fs.Load(s.category, path)
	if err == nil && onDisk != nil {
		onDiskSaved, ok := onDisk.(*fileMetaStorable)
		if ok && bytes.Equal(s.body, onDiskSaved.body) && reflect.DeepEqual(s.meta, onDiskSaved.meta) {
			logger.Info("No change", "key", key)
			return s, nil
		}
	}

	// Optimistic lock: compare version against on-disk .meta.
	if existingDM, err := readMetaJSONFromPath(fs.metaPath(s.category, path)); err == nil {
		incoming := metaVersionInt(s.meta)
		if existingDM.Version > incoming {
			return nil, fmt.Errorf("%w (disk=%d incoming=%d)", store.ErrStaleStorable, existingDM.Version, incoming)
		}
	}

	meta := cloneMeta(s.meta)
	nextVer := metaVersionInt(meta) + 1
	meta["version"] = strconv.Itoa(nextVer)
	meta["modified"] = time.Now().Format("2006-01-02T15:04:05")

	uuid := meta["uuid"]

	// Write content file.
	if err := writeAtomic(fs.contentPath(s.category, path, uuid), s.body); err != nil {
		return nil, fmt.Errorf("filestore: save content %s: %w", path, err)
	}

	// Write .meta, preserving names from disk.
	newDM := mapToDocMeta(meta)
	newDM.Type = "document"
	if existingDM, err := readMetaJSONFromPath(fs.metaPath(s.category, path)); err == nil {
		newDM.Names = existingDM.Names
	}
	if err := writeMetaJSONToPath(fs.metaPath(s.category, path), newDM); err != nil {
		return nil, fmt.Errorf("filestore: save .meta %s: %w", path, err)
	}

	// Write body-only snapshot.
	if uuid != "" {
		_ = fs.writeSnapshot(s.category, path, uuid, nextVer, s.body)
		fs.pruneVersions(s.category, path, uuid, fs.maxVersions)
	}

	versions := fs.loadVersions(uuid, s.category, path)
	saved := &fileMetaStorable{
		fileStorable: fileStorable{
			key:      uuid,
			path:     path,
			category: s.category,
			body:     s.body,
			extRef:   s.extRef,
			versions: versions,
		},
		meta: docMetaToMap(newDM),
		owns: s.owns,
	}
	fs.indexSet(uuid, saved)
	return saved, nil
}

func (fs *FileStore) saveAsset(s *fileAssetStorable) (store.Storable, error) {
	absPath := fs.absPath(s.category, s.key)
	if err := os.WriteFile(absPath, s.body, 0o644); err != nil {
		return nil, fmt.Errorf("filestore: save asset %s: %w", s.key, err)
	}
	enc := inferEncoding(s.body)
	return &fileAssetStorable{
		fileStorable: fileStorable{
			key:      s.key,
			category: s.category,
			body:     s.body,
			extRef:   s.extRef,
		},
		encoding: enc,
	}, nil
}

func (fs *FileStore) savePlain(s *fileStorable) (store.Storable, error) {
	absPath := fs.absPath(s.category, s.key)
	if err := os.WriteFile(absPath, s.body, 0o644); err != nil {
		return nil, fmt.Errorf("filestore: save %s: %w", s.key, err)
	}
	return &fileStorable{
		key:      s.key,
		category: s.category,
		body:     s.body,
		extRef:   s.extRef,
	}, nil
}

// ── Internal helpers ──────────────────────────────────────────────────────────

// dirKey extracts the category-relative filesystem path from a Storable created
// by this FileStore. Path() was removed from store.Storable to keep the business
// layer free of filesystem concepts; within the filestore package we use this.
func dirKey(s store.Storable) string {
	switch v := s.(type) {
	case *fileMetaStorable:
		return v.path
	case *fileFolderStorable:
		return v.path
	case *fileAssetStorable:
		return v.path
	case *fileStorable:
		return v.path
	}
	panic("filestore: dirKey: unknown Storable type")
}

// ── Rename / Move helpers ─────────────────────────────────────────────────────

func (fs *FileStore) renameKey(s store.Storable, newKey string) (store.Storable, error) {
	oldPath := dirKey(s)
	if s.Category().MetaEnabled {
		newKey = strings.TrimSuffix(newKey, ".md")
	}

	if oldPath == newKey {
		return s, nil
	}

	srcDir := fs.docDir(s.Category(), oldPath)
	dstDir := fs.docDir(s.Category(), newKey)

	if err := os.MkdirAll(filepath.Dir(dstDir), 0o755); err != nil {
		return nil, fmt.Errorf("filestore: rename mkdir: %w", err)
	}
	if err := os.Rename(srcDir, dstDir); err != nil {
		return nil, fmt.Errorf("filestore: rename %s → %s: %w", oldPath, newKey, err)
	}

	// Append new name to .meta names log.
	newMetaPath := filepath.Join(dstDir, ".meta")
	if dm, err := readMetaJSONFromPath(newMetaPath); err == nil {
		dm.Names = append(dm.Names, nameEntry{
			Name: filepath.Base(newKey),
			From: time.Now().Format("2006-01-02T15:04:05"),
		})
		_ = writeMetaJSONToPath(newMetaPath, dm)

	}

	return fs.Load(s.Category(), newKey) // Load updates the cache with the new key.
}

// ── Key generation ─────────────────────────────────────────────────────────────

func (fs *FileStore) generateKey(cat store.Category) string {
	now := time.Now()
	base := fmt.Sprintf("buf-%s", now.Format("20060102-1504"))
	dir := fs.docDir(cat, base)
	if _, err := os.Stat(dir); os.IsNotExist(err) {
		return base
	}
	return fmt.Sprintf("buf-%s-%d", now.Format("20060102-1504"), now.UnixNano()%10000)
}

// ── Stamp helpers ─────────────────────────────────────────────────────────────

func (fs *FileStore) stampCreate(meta map[string]string) {
	now := time.Now().Format("2006-01-02T15:04:05")
	if meta["uuid"] == "" {
		meta["uuid"] = newUUID()
	}
	if meta["version"] == "" {
		meta["version"] = "0"
	}
	if meta["created"] == "" {
		meta["created"] = now
	}
	meta["modified"] = now
}

// looksLikeUUID returns true for strings in the 8-4-4-4-12 hex UUID format.
func looksLikeUUID(s string) bool {
	return len(s) == 36 && s[8] == '-' && s[13] == '-' && s[18] == '-' && s[23] == '-'
}

func newUUID() string {
	var b [16]byte
	rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// ── Meta helpers ──────────────────────────────────────────────────────────────

func metaVersionInt(meta map[string]string) int {
	v, _ := strconv.Atoi(meta["version"])
	return v
}

func cloneMeta(m map[string]string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// ── Atomic write ──────────────────────────────────────────────────────────────

func writeAtomic(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// ── Asset extension detection ─────────────────────────────────────────────────

// extFromBytes sniffs the MIME type from magic bytes and returns the canonical
// file extension. Falls back to ".bin" for unrecognised types.
func extFromBytes(b []byte) string {
	mime := http.DetectContentType(b)
	switch {
	case strings.HasPrefix(mime, "image/png"):
		return ".png"
	case strings.HasPrefix(mime, "image/jpeg"):
		return ".jpg"
	case strings.HasPrefix(mime, "image/gif"):
		return ".gif"
	case strings.HasPrefix(mime, "image/webp"):
		return ".webp"
	default:
		return ".bin"
	}
}

// ── Directory setup ───────────────────────────────────────────────────────────

// Root returns the base directory where the store is persisted on disk.
func (fs *FileStore) Root() string { return fs.root }

// PrepareCategory creates the category directory. Per-document .history/ and
// asset directories are created on demand; no shared subdirs needed.
func (fs *FileStore) PrepareCategory(cat store.Category) error {
	dir := fs.categoryDir(cat)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return fmt.Errorf("filestore: prepare category %s: %w", cat.DisplayName, err)
	}
	return nil
}
