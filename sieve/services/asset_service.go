package services

import (
	"bytes"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"sieve/sieve/domain"
	"sieve/store"
)

// AssetService manages binary assets (images, voice notes) through the Store
// interface. Create one with NewAssetService — do not construct directly.
//
// ImageAsset is a first-class Storable — it exists independently of any
// document. Ownership (which document contains it) is a graph relationship
// derived from the filesystem layout by FileStore. It is not a precondition
// for the asset to exist or be valid.
type AssetService struct {
	st       store.Store
	rootPath string
}

// NewAssetService creates an AssetService backed by st. rootPath is the library
// root; it bounds ServeStoreFile. An empty rootPath disables that method — the
// service is otherwise fully usable.
func NewAssetService(st store.Store, rootPath string) *AssetService {
	return &AssetService{st: st, rootPath: rootPath}
}

// ServeAssetData returns the raw bytes of the asset identified by (docUUID,
// filename). Bypasses the Document layer entirely so concurrent asset requests
// for the same UUID do not race on shared in-memory state.
//
// On a cache miss it forces a fresh document load (which re-scans the doc
// directory) before retrying. This handles the web-clip case where image files
// are written to disk after the document was last loaded into cache.
func (as *AssetService) ServeAssetData(docUUID, filename string) ([]byte, error) {
	cats := []store.Category{domain.WorkingCopy, domain.LibraryCategory}
	for _, cat := range cats {
		if a, err := as.st.LoadAsset(cat, docUUID, filename); err == nil {
			return a.Body(), nil
		}
	}
	// Asset not in cached owns — force a fresh load to re-scan the doc directory.
	for _, cat := range cats {
		if _, err := as.st.Load(cat, docUUID); err == nil {
			if a, err2 := as.st.LoadAsset(cat, docUUID, filename); err2 == nil {
				return a.Body(), nil
			}
		}
	}
	return nil, fmt.Errorf("asset not found: %s/%s", docUUID, filename)
}

// Save stores binary data as an asset and returns the resulting ImageAsset.
// category must be WorkingCopy (for buffer pastes) or LibraryCategory (for note
// pastes). parentContext is the document logically owning the asset, and assetID
// is the specific ID for this asset.
// The Encoding is inferred from magic bytes by the Store.
//
// The returned ImageAsset.ExternalRef() is the opaque reference suitable for
// direct insertion into editor markdown:
//
//	asset, err := svc.Save(store.WorkingCopy, "buf.md", "blk-abc", data)
//	editor.InsertContent("![](" + asset.ExternalRef() + ")")
func (as *AssetService) Save(category store.Category, parentContext string, assetID string, data []byte) (*domain.ImageAsset, error) {
	s, err := as.st.CreateAsset(category, parentContext, assetID, data)
	if err != nil {
		return nil, fmt.Errorf("asset: save %s for %s: %w", assetID, parentContext, err)
	}
	return &domain.ImageAsset{S: s}, nil
}

// ServeStoreFile reads a file addressed relative to the library root. It backs
// relative markdown image sources, which name a path on disk rather than a
// stored asset, so it reads the filesystem directly instead of going through
// the Store.
//
// relPath is attacker-controlled (it arrives from a URL), so the resolved path
// is required to stay inside the root: cleaning alone is not enough, because
// Clean preserves leading "..".
func (as *AssetService) ServeStoreFile(relPath string) ([]byte, error) {
	if as.rootPath == "" {
		return nil, fmt.Errorf("asset: store not initialised")
	}
	root, err := filepath.Abs(as.rootPath)
	if err != nil {
		return nil, fmt.Errorf("asset: resolve store root: %w", err)
	}
	full := filepath.Join(root, filepath.Clean(filepath.FromSlash(relPath)))
	if !strings.HasPrefix(full+string(filepath.Separator), root+string(filepath.Separator)) {
		return nil, fmt.Errorf("asset: %q escapes the store root", relPath)
	}
	info, err := os.Stat(full)
	if err != nil {
		return nil, fmt.Errorf("asset: stat %q: %w", relPath, err)
	}
	if info.IsDir() {
		return nil, fmt.Errorf("asset: %q is a directory", relPath)
	}
	return os.ReadFile(full)
}

// DetectContentType names the media type of asset bytes. It corrects the one
// case http.DetectContentType gets wrong for us: an SVG sniffs as text/xml or
// text/plain, and a browser will not render it as an image under either.
func (as *AssetService) DetectContentType(data []byte) string {
	ct := http.DetectContentType(data)
	if strings.HasPrefix(ct, "text/xml") || strings.HasPrefix(ct, "text/plain") {
		if bytes.Contains(data, []byte("<svg")) {
			return "image/svg+xml"
		}
	}
	return ct
}
