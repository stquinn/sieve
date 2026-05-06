package filestore

import (
	"path/filepath"
	"strings"

	"sieve/store"
)

// fileStorable is the base concrete type that satisfies store.Storable.
// It is a pure value object — no I/O, no business logic.
// All fields are stamped by FileStore at creation time and are immutable
// after the Storable is returned to the caller.
type fileStorable struct {
	key        string // logical identity (UUID for docs/folders, filename for assets)
	path       string // filesystem identity (category-relative directory key)
	category   store.Category
	body       []byte
	extRef     string
	versions   []store.VersionRef
	isModified bool
}

func (s *fileStorable) Key() string                  { return s.key }
func (s *fileStorable) Path() string                 { return s.path }
func (s *fileStorable) Category() store.Category     { return s.category }
func (s *fileStorable) Body() []byte                 { return s.body }
func (s *fileStorable) ExternalRef() string          { return s.extRef }
func (s *fileStorable) Versions() []store.VersionRef { return s.versions }
func (s *fileStorable) IsModified() bool             { return s.isModified }

// fileMetaStorable extends fileStorable with a structured metadata map.
// It satisfies store.MetaStorable.
//
// SetBody and SetMeta are the only in-place mutations. Changes are local until
// FileStore.Save is called, which returns a new Storable with updated version
// and modified timestamps. The input is stale after Save returns.
type fileMetaStorable struct {
	fileStorable
	meta map[string]string
	owns []store.Storable
}

func (s *fileMetaStorable) Meta() map[string]string     { return s.meta }
func (s *fileMetaStorable) SetBody(body []byte)         { s.body = body; s.isModified = true }
func (s *fileMetaStorable) SetMeta(m map[string]string) { s.meta = m; s.isModified = true }
func (s *fileMetaStorable) Owns() []store.Storable             { return s.owns }
func (s *fileMetaStorable) AttachAsset(a store.Storable)       { s.owns = append(s.owns, a); s.isModified = true }
func (s *fileMetaStorable) ClearOwns()                         { s.owns = nil; s.isModified = true }

// fileAssetStorable extends fileStorable for binary content such as images.
// Encoding is inferred by FileStore at Create time from magic bytes — never
// declared by the caller.
// It satisfies store.AssetStorable.
type fileAssetStorable struct {
	fileStorable
	encoding store.Encoding
	blkId    string
}

func (s *fileAssetStorable) Encoding() store.Encoding { return s.encoding }
func (s *fileAssetStorable) BlkID() string            { return s.blkId }

func newFileAssetStorable(key, path string, cat store.Category, body []byte, extRef string, enc store.Encoding) *fileAssetStorable {
	blkId := key
	if dot := strings.LastIndex(key, "."); dot > 0 {
		blkId = key[:dot]
	}
	return &fileAssetStorable{
		fileStorable: fileStorable{key: key, path: path, category: cat, body: body, extRef: extRef},
		encoding:     enc,
		blkId:        blkId,
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
