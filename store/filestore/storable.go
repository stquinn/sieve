package filestore

import (
	"os"
	"path/filepath"
	"strings"
	"sync"

	"sieve/store"
)

// fileStorable is the base concrete type that satisfies store.Storable.
// It is a pure value object — no I/O, no business logic.
// Identity fields (key/path/category/extRef/versions) are stamped by FileStore
// at creation time and immutable after the Storable is returned. body/meta are
// NOT immutable (SetBody/SetMeta mutate in place) and the store hands back a
// SHARED storable per uuid — so mutable-field access is mutex-guarded: a
// reconnect-overlap teardown flush (SetBody) races the successor's Open
// (Body) otherwise (caught by go test -race via ws_takeover_test.go).
type fileStorable struct {
	key      string // logical identity (UUID for docs/folders, filename for assets)
	path     string // filesystem identity (category-relative directory key)
	category store.Category
	extRef   string
	versions []store.VersionRef

	mu         sync.RWMutex // guards body, isModified (and meta/owns in embedders)
	body       []byte
	isModified bool
}

func (s *fileStorable) Key() string                  { return s.key }
func (s *fileStorable) Path() string                 { return s.path }
func (s *fileStorable) Category() store.Category     { return s.category }
func (s *fileStorable) ExternalRef() string          { return s.extRef }
func (s *fileStorable) Versions() []store.VersionRef { return s.versions }

func (s *fileStorable) Body() []byte {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.body
}

func (s *fileStorable) IsModified() bool {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.isModified
}

// fileMetaStorable extends fileStorable with a structured metadata map.
// It satisfies store.MetaStorable.
//
// SetBody and SetMeta are the only in-place mutations. Changes are local until
// FileStore.Save is called, which returns a new Storable with updated version
// and modified timestamps. The input is stale after Save returns.
type fileMetaStorable struct {
	fileStorable
	contentType string // the .meta type; immutable, and the source of truth over meta["type"]
	meta        map[string]string
	owns        []store.Storable
}

func (s *fileMetaStorable) Type() string { return s.contentType }

func (s *fileMetaStorable) Meta() map[string]string {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.meta
}

func (s *fileMetaStorable) SetBody(body []byte) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.body = body
	s.isModified = true
}

func (s *fileMetaStorable) SetMeta(m map[string]string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.meta = m
	s.isModified = true
}

func (s *fileMetaStorable) Owns() []store.Storable {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.owns
}

func (s *fileMetaStorable) AttachAsset(a store.Storable) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.owns = append(s.owns, a)
	s.isModified = true
}

func (s *fileMetaStorable) ClearOwns() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.owns = nil
	s.isModified = true
}

// fileAssetStorable is an asset named by the file that holds it. It keeps no
// bytes: Body reads the file when called, so a handle always reads the file as
// it is now, and a listing of assets reads none of their content.
// It satisfies store.AssetStorable.
type fileAssetStorable struct {
	fileStorable
	encoding store.Encoding
	blkId    string
	file     string // absolute path of the asset's file
}

func (s *fileAssetStorable) Encoding() store.Encoding { return s.encoding }
func (s *fileAssetStorable) BlkID() string            { return s.blkId }

// Size is the file's current length; 0 when the file cannot be stat'd.
func (s *fileAssetStorable) Size() int64 {
	info, err := os.Stat(s.file)
	if err != nil {
		return 0
	}
	return info.Size()
}

// Body is the file's current bytes; nil when the file cannot be read. A nil
// Body means "unreadable", never "empty asset": an empty file yields a non-nil
// empty slice.
func (s *fileAssetStorable) Body() []byte {
	data, err := os.ReadFile(s.file)
	if err != nil {
		return nil
	}
	return data
}

// newFileAssetStorable is the asset at file, with its encoding already inferred.
func newFileAssetStorable(key, path string, cat store.Category, file, extRef string, enc store.Encoding) *fileAssetStorable {
	blkId := key
	if dot := strings.LastIndex(key, "."); dot > 0 {
		blkId = key[:dot]
	}
	return &fileAssetStorable{
		fileStorable: fileStorable{key: key, path: path, category: cat, extRef: extRef},
		encoding:     enc,
		blkId:        blkId,
		file:         file,
	}
}

// fileFolderStorable extends fileStorable for directory nodes in the ownership
// graph. Owns is populated by FileStore.List when scanning the tree.
// It satisfies store.FolderStorable.
type fileFolderStorable struct {
	fileStorable
	owns []store.Storable
}

func (s *fileFolderStorable) Name() string           { return filepath.Base(s.path) }
func (s *fileFolderStorable) Owns() []store.Storable { return s.owns }
