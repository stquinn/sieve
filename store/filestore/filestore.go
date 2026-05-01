// Package filestore implements the store.Store interface backed by the local
// filesystem.
//
// # Directory layout
//
//	{root}/store/                    Library notes (Shared)
//	{root}/store/.assets/            Library assets
//	{root}/store/.history/           Library version snapshots
//	{root}/{hostname}/buffers/       WorkingCopy buffers (Isolated)
//	{root}/{hostname}/buffers/assets/ WorkingCopy buffer assets
//	{root}/{hostname}/.history/      WorkingCopy version snapshots
//	{root}/{hostname}/config/        State — settings, session (Isolated)
//
// # Keys
//
// A key is the path of a file relative to its category directory. For example:
//
//	Library      "sub/my-note.md"       → {root}/store/sub/my-note.md
//	WorkingCopy  "buf-20240102-1504.md" → {root}/{hostname}/buffers/buf-20240102-1504.md
//	State        "settings.json"        → {root}/{hostname}/config/settings.json
//
// An empty key passed to Create causes FileStore to generate a timestamped key.
//
// # ExternalRef
//
// ExternalRef is the path of a Storable relative to the store root. It is
// derived at read time by walking upward through the category path — never
// stored on disk.
//
//	Library note  → "store/sub/my-note.md"
//	WorkingCopy   → "{hostname}/buffers/buf-20240102-1504.md"
//	Buffer asset  → "{hostname}/buffers/assets/blk-xxx.png"
package filestore

import (
	"bytes"
	"crypto/rand"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"sieve/store"
)

// FileStore is a filesystem-backed implementation of store.Store.
// Create one with NewFileStore — do not construct directly.
type FileStore struct {
	root        string
	hostname    string
	maxVersions int // maximum snapshots to retain per document; 0 = unlimited
}

// NewFileStore initialises a FileStore rooted at root for the given hostname.
// Missing category directories are created. Returns an error only if the root
// path cannot be resolved or directories cannot be created.
func NewFileStore(root, hostname string) (*FileStore, error) {
	abs, err := filepath.Abs(root)
	if err != nil {
		return nil, fmt.Errorf("filestore: resolve root: %w", err)
	}
	fs := &FileStore{
		root:        abs,
		hostname:    hostname,
		maxVersions: 200,
	}
	return fs, nil
}

// SetMaxVersions overrides the snapshot retention limit. 0 = keep all.
func (fs *FileStore) SetMaxVersions(n int) { fs.maxVersions = n }

// ── Store interface ───────────────────────────────────────────────────────────

// Create makes a new Storable in category with the given key and body.
//
// If key is empty, FileStore generates a timestamped filename appropriate for
// the category. If body begins with a YAML frontmatter block, it is parsed and
// merged with the generated fields (uuid, version, timestamps). Otherwise body
// is stored as the document content and minimal frontmatter is generated.
//
// The returned Storable's type depends on the key extension and category:
//   - .md extension (or empty key generating .md)  → MetaStorable
//   - files under assets/ or .assets/              → AssetStorable
//   - State category non-.md files                 → plain Storable
func (fs *FileStore) CreateMetaText(cat store.Category, key string, body []byte) (store.MetaStorable, error) {
	if key == "" {
		key = fs.generateKey(cat)
	}

	absPath := fs.absPath(cat, key)
	if err := os.MkdirAll(filepath.Dir(absPath), 0o755); err != nil {
		return nil, fmt.Errorf("filestore: create dir for %s: %w", key, err)
	}

	return fs.createMeta(cat, key, absPath, body)
}

func (fs *FileStore) CreateAsset(cat store.Category, parentKey string, assetID string, body []byte) (store.AssetStorable, error) {
	key := fs.generateAssetKey(parentKey, assetID)

	absPath := fs.absPath(cat, key)
	if err := os.MkdirAll(filepath.Dir(absPath), 0o755); err != nil {
		return nil, fmt.Errorf("filestore: create dir for %s: %w", key, err)
	}
	return fs.createAsset(cat, key, absPath, body)
}

// generateAssetKey returns a structurally appropriate key for an asset.
// Unifying the .assets prefix within FileStore explicitly.
func (fs *FileStore) generateAssetKey(parentKey, assetID string) string {
	if parentKey == "" || parentKey == "new" {
		return fmt.Sprintf(".assets/%s.png", assetID)
	}
	// For files (e.g., Library), prefix the asset ID with the document name.
	noteName := strings.TrimSuffix(filepath.Base(parentKey), filepath.Ext(parentKey))
	return fmt.Sprintf(".assets/%s-%s.png", noteName, assetID)
}

func (fs *FileStore) CreateText(cat store.Category, key string, body []byte) (store.Storable, error) {
	if key == "" {
		key = fs.generateKey(cat)
	}

	absPath := fs.absPath(cat, key)
	if err := os.MkdirAll(filepath.Dir(absPath), 0o755); err != nil {
		return nil, fmt.Errorf("filestore: create dir for %s: %w", key, err)
	}
	// Plain file (e.g. settings.json, session.json for State category).
	return fs.createPlain(cat, key, absPath, body)
}

func (fs *FileStore) CreateOrLoadFolder(category store.Category, name string) (store.FolderStorable, error) {

	absPath := fs.absPath(category, name)
	_, err := os.ReadDir(absPath)
	if err != nil {
		err = os.MkdirAll(filepath.Dir(absPath), 0o755)
	}
	if err != nil {
		return nil, fmt.Errorf("filestore: create dir for %s: %w", absPath, err)
	}
	return fs.scanFolder(category, name)

}

func (fs *FileStore) LoadFolder(category store.Category, name string) (store.FolderStorable, error) {
	absPath := fs.absPath(category, name)
	_, err := os.ReadDir(absPath)
	if err != nil {
		return nil, err
	}
	return fs.scanFolder(category, name)

}

// Save persists the current state of s. It:
//  1. Reads the current file to check the optimistic lock.
//  2. Returns ErrStaleStorable if s.Meta["version"] is behind the stored version.
//  3. Increments the version, updates the modified timestamp.
//  4. Writes the file atomically via a .tmp rename.
//  5. Writes a version snapshot to the history directory.
//  6. Prunes snapshots beyond maxVersions.
//
// The returned Storable reflects the on-disk state after the write.
// The input s is stale once Save returns.
func (fs *FileStore) Save(s store.Storable) (store.Storable, error) {
	switch typed := s.(type) {
	case *fileMetaStorable:
		return fs.saveMeta(typed)
	case *fileAssetStorable:
		return fs.saveAsset(typed)
	case *fileStorable:
		return fs.savePlain(typed)
	default:
		return nil, fmt.Errorf("filestore: Save: unsupported Storable type %T", s)
	}
}

// Load retrieves the Storable identified by category and key.
func (fs *FileStore) Load(cat store.Category, key string) (store.Storable, error) {
	absPath := fs.absPath(cat, key)
	data, err := os.ReadFile(absPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, fmt.Errorf("filestore: %s: not found", key)
		}
		return nil, fmt.Errorf("filestore: load %s: %w", key, err)
	}

	s := fs.buildStorable(cat, key, fs.categoryDir(cat), true)
	if s == nil {
		// Fallback: return a plain storable with raw bytes.
		extRef := fs.externalRef(cat, key)
		return &fileStorable{
			key:      key,
			category: cat,
			body:     data,
			extRef:   extRef,
		}, nil
	}
	return s, nil
}

// Delete removes s and its entire version history from the Store.
func (fs *FileStore) Delete(s store.Storable) error {
	absPath := fs.absPath(s.Category(), s.Key())
	if err := os.Remove(absPath); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("filestore: delete %s: %w", s.Key(), err)
	}

	// Remove version history if this is a MetaStorable.
	if ms, ok := s.(store.MetaStorable); ok {
		uuid := ms.Meta()["uuid"]
		fs.deleteAllVersions(s.Category(), uuid)
	}
	return nil
}

// List returns all Storables in category whose key begins with prefix.
// Pass an empty prefix to list the entire category.
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

// Move transfers s to a different category. The source file is removed and a
// new file is created at the destination. Version history follows the UUID.
// It also cascades the move to any owned children automatically.
func (fs *FileStore) Move(s store.Storable, to store.Category) (store.Storable, error) {
	newKey := s.Key()
	destPath := fs.absPath(to, newKey)
	if err := os.MkdirAll(filepath.Dir(destPath), 0o755); err != nil {
		return nil, fmt.Errorf("filestore: Move mkdir: %w", err)
	}

	if ms, ok := s.(store.MetaStorable); ok {
		// New logic: Use centralized cascade helper to move assets and update body links
		newOwns, newBody, err := fs.cascadeAssetUpdates(ms, s.Key(), newKey, s.Category(), to)
		if err != nil {
			return nil, err
		}

		// Clear and reset Owns with moved assets so meta['assets'] is written correctly
		ms.ClearOwns()
		for _, a := range newOwns {
			ms.AttachAsset(a)
		}

		meta := ms.Meta()
		syncOwnsToMeta(newKey, newOwns, meta)
		ms.SetMeta(meta)
		ms.SetBody(newBody)

		content := serialiseFrontmatter(ms.Meta(), ms.Body())
		if err := os.WriteFile(destPath, content, 0o644); err != nil {
			return nil, fmt.Errorf("filestore: Move write: %w", err)
		}

		// Move version history between history dirs.
		uuid := ms.Meta()["uuid"]
		if uuid != "" {
			fs.migrateHistory(s.Category(), to, uuid)
		}
	} else if _, ok := s.(store.AssetStorable); ok {
		if err := os.Rename(fs.absPath(s.Category(), s.Key()), destPath); err != nil {
			return nil, fmt.Errorf("filestore: Move asset rename: %w", err)
		}
	} else {
		return nil, fmt.Errorf("filestore: Move: unsupported storable type %T", s)
	}

	// Remove source if we wrote a new file (MetaStorable)
	if _, ok := s.(store.MetaStorable); ok {
		os.Remove(fs.absPath(s.Category(), s.Key()))
	}

	// Return a fresh Storable from the new location.
	return fs.Load(to, newKey)
}

// Reparent moves s under folder. For FileStore this physically relocates the
// file into the folder's directory. ExternalRefs are correct on next read.
func (fs *FileStore) Reparent(s store.Storable, folder store.FolderStorable) (store.Storable, error) {
	base := filepath.Base(s.Key())
	newKey := folder.Key() + "/" + base
	return fs.renameKey(s, newKey)
}

// MoveToKey relocates s to newKey within the same category. newKey is a full
// category-relative path (e.g. "target-folder/my-note.md").
func (fs *FileStore) MoveToKey(s store.Storable, newKey string) (store.Storable, error) {
	return fs.renameKey(s, newKey)
}

// Rename changes the name component of s's key. Returns a new Storable with
// the updated key and a corrected ExternalRef.
func (fs *FileStore) Rename(s store.Storable, name string) (store.Storable, error) {
	dir := filepath.Dir(s.Key())
	ext := filepath.Ext(s.Key())
	var newKey string
	if dir == "." {
		newKey = name + ext
	} else {
		newKey = dir + "/" + name + ext
	}
	return fs.renameKey(s, newKey)
}

// RetrieveVersion fetches the snapshot identified by ref. Returns a
// VersionedStorable — it cannot be passed back to Save.
func (fs *FileStore) RetrieveVersion(s store.Storable, ref store.VersionRef) (store.VersionedStorable, error) {
	var uuid string
	if ms, ok := s.(store.MetaStorable); ok {
		uuid = ms.Meta()["uuid"]
	}
	if uuid == "" {
		return store.VersionedStorable{}, fmt.Errorf("filestore: RetrieveVersion: storable has no uuid")
	}
	return fs.retrieveVersion(s.Category(), uuid, ref)
}

// ── Path helpers ──────────────────────────────────────────────────────────────

// categoryDir returns the absolute path for the root directory of cat.
func (fs *FileStore) categoryDir(cat store.Category) string {
	if cat.Isolation == store.Isolated {
		return filepath.Join(fs.root, fs.hostname, cat.Key)
	}
	return filepath.Join(fs.root, cat.Key)
}

// absPath returns the absolute path for a Storable with the given key in cat.
func (fs *FileStore) absPath(cat store.Category, key string) string {
	return filepath.Join(fs.categoryDir(cat), filepath.FromSlash(key))
}

// externalRef returns the ExternalRef for a Storable — the path relative to
// the store root used to reference it from editor content and AI prompts.
//
// For Isolated categories the hostname is included:
//
//	{hostname}/{categoryKey}/{key}
//
// For Shared categories:
//
//	{categoryKey}/{key}
func (fs *FileStore) externalRef(cat store.Category, key string) string {
	key = filepath.ToSlash(key)
	if cat.Isolation == store.Isolated {
		return fs.hostname + "/" + cat.Key + "/" + key
	}
	return cat.Key + "/" + key
}

// ── Internal create helpers ───────────────────────────────────────────────────

func (fs *FileStore) createMeta(cat store.Category, key, absPath string, body []byte) (store.MetaStorable, error) {
	// If body contains frontmatter, parse it; otherwise start with an empty map.
	meta, pureBody, err := parseFrontmatter(body)
	if err != nil {
		return nil, fmt.Errorf("filestore: create %s: %w", key, err)
	}

	fs.stampCreate(meta)

	content := serialiseFrontmatter(meta, pureBody)
	if err := writeAtomic(absPath, content); err != nil {
		return nil, fmt.Errorf("filestore: create %s: %w", key, err)
	}

	extRef := fs.externalRef(cat, key)
	uuid := meta["uuid"]
	versions := fs.loadVersions(uuid, cat)

	return &fileMetaStorable{
		fileStorable: fileStorable{
			key:      key,
			category: cat,
			body:     pureBody,
			extRef:   extRef,
			versions: versions,
		},
		meta: meta,
	}, nil
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
			category: cat,
			body:     body,
			extRef:   extRef,
		},
		encoding: enc,
	}, nil
}

func (fs *FileStore) createPlain(cat store.Category, key, absPath string, body []byte) (store.Storable, error) {
	if err := os.WriteFile(absPath, body, 0o644); err != nil {
		return nil, fmt.Errorf("filestore: create %s: %w", key, err)
	}
	extRef := fs.externalRef(cat, key)
	return &fileStorable{
		key:      key,
		category: cat,
		body:     body,
		extRef:   extRef,
	}, nil
}

// ── Internal save helpers ─────────────────────────────────────────────────────

func (fs *FileStore) saveMeta(s *fileMetaStorable) (store.Storable, error) {
	absPath := fs.absPath(s.category, s.key)

	// Optimistic lock check: read the current on-disk version.
	if current, err := fs.currentVersion(absPath); err == nil {
		incoming := metaVersionInt(s.meta)
		if current > incoming {
			return nil, fmt.Errorf("%w (disk=%d incoming=%d)", store.ErrStaleStorable, current, incoming)
		}
	}

	// Stamp version and modified timestamp.
	meta := cloneMeta(s.meta)

	// Derive meta["assets"] shorthand from the Owns array for next load.
	syncOwnsToMeta(s.key, s.owns, meta)

	nextVer := metaVersionInt(meta) + 1
	meta["version"] = strconv.Itoa(nextVer)
	meta["modified"] = time.Now().Format("2006-01-02T15:04:05")

	content := serialiseFrontmatter(meta, s.body)
	if err := writeAtomic(absPath, content); err != nil {
		return nil, fmt.Errorf("filestore: save %s: %w", s.key, err)
	}

	// Write snapshot.
	uuid := meta["uuid"]
	if uuid != "" {
		if err := fs.writeSnapshot(s.category, uuid, nextVer, content); err != nil {
			// Non-fatal: log but continue.
			_ = err
		}
		fs.pruneVersions(s.category, uuid, fs.maxVersions)
	}

	versions := fs.loadVersions(uuid, s.category)
	return &fileMetaStorable{
		fileStorable: fileStorable{
			key:      s.key,
			category: s.category,
			body:     s.body,
			extRef:   s.extRef,
			versions: versions,
		},
		meta: meta,
		owns: s.owns,
	}, nil
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

// ── Rename / Move helpers ─────────────────────────────────────────────────────

func (fs *FileStore) renameKey(s store.Storable, newKey string) (store.Storable, error) {
	if ms, ok := s.(store.MetaStorable); ok {
		// New logic: Use centralized cascade helper to move assets and update body links
		newOwns, newBody, err := fs.cascadeAssetUpdates(ms, s.Key(), newKey, s.Category(), s.Category())
		if err != nil {
			return nil, err
		}

		// Clear and reset Owns with moved assets so meta['assets'] is written correctly
		ms.ClearOwns()
		for _, a := range newOwns {
			ms.AttachAsset(a)
		}

		meta := ms.Meta()
		syncOwnsToMeta(newKey, newOwns, meta)
		ms.SetMeta(meta)
		ms.SetBody(newBody)

		// Physically rename the parent file
		srcPath := fs.absPath(s.Category(), s.Key())
		dstPath := fs.absPath(s.Category(), newKey)
		if err := os.MkdirAll(filepath.Dir(dstPath), 0o755); err != nil {
			return nil, fmt.Errorf("filestore: rename mkdir: %w", err)
		}

		content := serialiseFrontmatter(ms.Meta(), ms.Body())
		if err := os.WriteFile(dstPath, content, 0o644); err != nil {
			return nil, fmt.Errorf("filestore: rename write: %w", err)
		}
		os.Remove(srcPath)

		return fs.Load(s.Category(), newKey)
	}

	// Plain storable or asset storable (no body recursion)
	srcPath := fs.absPath(s.Category(), s.Key())
	dstPath := fs.absPath(s.Category(), newKey)
	if err := os.MkdirAll(filepath.Dir(dstPath), 0o755); err != nil {
		return nil, fmt.Errorf("filestore: rename mkdir: %w", err)
	}
	if err := os.Rename(srcPath, dstPath); err != nil {
		return nil, fmt.Errorf("filestore: rename %s → %s: %w", s.Key(), newKey, err)
	}
	return fs.Load(s.Category(), newKey)
}

// cascadeAssetUpdates handles the recursive moving/renaming of owned assets and
// performs body find-and-replace for both ExternalRefs and relative paths.
func (fs *FileStore) cascadeAssetUpdates(ms store.MetaStorable, oldParentKey, newParentKey string, oldCat, newCat store.Category) ([]store.Storable, []byte, error) {
	kebab := strings.TrimSuffix(filepath.Base(newParentKey), filepath.Ext(newParentKey))
	body := ms.Body()
	var newOwns []store.Storable

	for _, asset := range ms.Owns() {
		// 1. Calculate strings to replace in body
		oldExtRef := asset.ExternalRef()
		oldRel, err := filepath.Rel(filepath.Dir(oldParentKey), asset.Key())
		if err != nil {
			oldRel = asset.Key()
		}
		oldRel = filepath.ToSlash(oldRel)

		// 2. Determine new asset key
		var newAssetKey string
		if newCat.Isolation == store.Shared {
			oldDocName := strings.TrimSuffix(filepath.Base(oldParentKey), filepath.Ext(oldParentKey))
			assetBase := filepath.Base(asset.Key())
			// e.g. note-img.png -> newnote-img.png
			if strings.HasPrefix(assetBase, oldDocName+"-") {
				assetBase = kebab + "-" + strings.TrimPrefix(assetBase, oldDocName+"-")
			} else if !strings.HasPrefix(assetBase, kebab+"-") {
				assetBase = kebab + "-" + assetBase
			}
			newAssetKey = ".assets/" + assetBase
		} else {
			newAssetKey = ".assets/" + filepath.Base(asset.Key())
		}

		// 3. Physically move/rename the asset
		var movedAsset store.Storable
		if oldCat.Key != newCat.Key || oldCat.Isolation != newCat.Isolation {
			movedAsset, err = fs.Move(asset, newCat)
			if err != nil {
				return nil, nil, fmt.Errorf("filestore: cascade move asset: %w", err)
			}
		} else {
			movedAsset = asset
		}

		if movedAsset.Key() != newAssetKey {
			movedAsset, err = fs.renameKey(movedAsset, newAssetKey)
			if err != nil {
				return nil, nil, fmt.Errorf("filestore: cascade rename asset: %w", err)
			}
		}

		newOwns = append(newOwns, movedAsset)

		// 4. Calculate replacement strings
		newExtRef := movedAsset.ExternalRef()

		// 5. Perform replacement in body using a safe placeholder
		placeholder := []byte("##SIEVE_ASSET_LINK_PLACEHOLDER##")
		body = bytes.ReplaceAll(body, []byte(oldExtRef), placeholder)
		body = bytes.ReplaceAll(body, []byte(oldRel), placeholder)
		body = bytes.ReplaceAll(body, placeholder, []byte(newExtRef))
	}

	return newOwns, body, nil
}

// migrateHistory moves snapshot files from the old category's history dir to
// the new one. Used by Move to keep history consistent across category changes.
func (fs *FileStore) migrateHistory(from, to store.Category, uuid string) {
	srcDir := fs.historyDir(from)
	dstDir := fs.historyDir(to)
	if srcDir == dstDir {
		return
	}
	os.MkdirAll(dstDir, 0o755)
	pattern := filepath.Join(srcDir, uuid+".*.md")
	matches, _ := filepath.Glob(pattern)
	for _, m := range matches {
		dst := filepath.Join(dstDir, filepath.Base(m))
		os.Rename(m, dst)
	}
}

// ── Key generation ─────────────────────────────────────────────────────────────

// generateKey produces a timestamped filename for use when Create is called
// with an empty key. The prefix depends on the category.
func (fs *FileStore) generateKey(cat store.Category) string {
	now := time.Now()
	base := fmt.Sprintf("%s-%s.md", cat.Key, now.Format("20060102-1504"))
	absPath := fs.absPath(cat, base)
	if _, err := os.Stat(absPath); os.IsNotExist(err) {
		return base
	}
	// Collision: append nanoseconds suffix.
	return fmt.Sprintf("%s-%s-%d.md", cat.Key, now.Format("20060102-1504"), now.UnixNano()%10000)
}

// ── Stamp helpers ─────────────────────────────────────────────────────────────

// stampCreate ensures all required system fields are present in meta.
// Called by createMeta for every new document.
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

// newUUID generates a random UUID v4.
func newUUID() string {
	var b [16]byte
	rand.Read(b[:])
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
		b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// ── Optimistic lock helper ────────────────────────────────────────────────────

// currentVersion reads the on-disk version field for a MetaStorable file.
// Returns -1 and an error if the file cannot be read or parsed.
func (fs *FileStore) currentVersion(absPath string) (int, error) {
	data, err := os.ReadFile(absPath)
	if err != nil {
		return -1, err
	}
	meta, _, err := parseFrontmatter(data)
	if err != nil {
		return -1, err
	}
	return metaVersionInt(meta), nil
}

// metaVersionInt parses meta["version"] as an integer, returning 0 on failure.
func metaVersionInt(meta map[string]string) int {
	v, _ := strconv.Atoi(meta["version"])
	return v
}

// cloneMeta returns a shallow copy of meta so the caller's map is not mutated.
func cloneMeta(m map[string]string) map[string]string {
	out := make(map[string]string, len(m))
	for k, v := range m {
		out[k] = v
	}
	return out
}

// syncOwnsToMeta derives the meta["assets"] shorthand from the Owns array
// for the next load phase, modifying the given metadata map in-place.
func syncOwnsToMeta(key string, owns []store.Storable, meta map[string]string) {
	if len(owns) > 0 {
		var parts []string
		for _, child := range owns {
			// New standard: Use ExternalRef (absolute store-root path)
			parts = append(parts, child.ExternalRef())
		}
		meta["assets"] = "[" + strings.Join(parts, ", ") + "]"
	} else {
		delete(meta, "assets")
	}
}

// ── Atomic write ──────────────────────────────────────────────────────────────

// writeAtomic writes data to path via a .tmp sibling to avoid partial writes.
func writeAtomic(path string, data []byte) error {
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

// ── Directory setup ───────────────────────────────────────────────────────────

// Root returns the base directory where the store is persisted on disk.
func (fs *FileStore) Root() string { return fs.root }

// PrepareCategory creates the foundational directories needed for a category,
// including its root directory, its .assets folder, and its .history folder.
func (fs *FileStore) PrepareCategory(cat store.Category) error {
	dirs := []string{
		fs.categoryDir(cat),
		filepath.Join(fs.categoryDir(cat), ".assets"),
		fs.historyDir(cat),
	}
	for _, d := range dirs {
		if err := os.MkdirAll(d, 0o755); err != nil {
			return fmt.Errorf("filestore: prepare category %s: %w", cat.DisplayName, err)
		}
	}
	return nil
}
