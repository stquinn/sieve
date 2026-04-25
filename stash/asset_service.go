package stash

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
	asset, ok := s.(store.AssetStorable)
	if !ok {
		return nil, fmt.Errorf("asset: save %s: created storable is not AssetStorable", assetID)
	}
	return &ImageAsset{S: asset}, nil
}
