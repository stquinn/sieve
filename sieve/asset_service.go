package sieve

import (
	"fmt"

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
	st store.Store
}

// NewAssetService creates an AssetService backed by st.
func NewAssetService(st store.Store) *AssetService {
	return &AssetService{st: st}
}

// ServeAssetData returns the raw bytes of the asset identified by (docUUID,
// filename). Bypasses the Document layer entirely so concurrent asset requests
// for the same UUID do not race on shared in-memory state.
//
// On a cache miss it forces a fresh document load (which re-scans the doc
// directory) before retrying. This handles the web-clip case where image files
// are written to disk after the document was last loaded into cache.
func (as *AssetService) ServeAssetData(docUUID, filename string) ([]byte, error) {
	cats := []store.Category{WorkingCopy, Library}
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
// category must be WorkingCopy (for buffer pastes) or Library (for note
// pastes). parentContext is the document logically owning the asset, and assetID
// is the specific ID for this asset.
// The Encoding is inferred from magic bytes by the Store.
//
// The returned ImageAsset.ExternalRef() is the opaque reference suitable for
// direct insertion into editor markdown:
//
//	asset, err := svc.Save(store.WorkingCopy, "buf.md", "blk-abc", data)
//	editor.InsertContent("![](" + asset.ExternalRef() + ")")
func (as *AssetService) Save(category store.Category, parentContext string, assetID string, data []byte) (*ImageAsset, error) {
	s, err := as.st.CreateAsset(category, parentContext, assetID, data)
	if err != nil {
		return nil, fmt.Errorf("asset: save %s for %s: %w", assetID, parentContext, err)
	}
	return &ImageAsset{S: s}, nil
}
