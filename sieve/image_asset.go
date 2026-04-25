package sieve

import "sieve/store"

// ImageAsset is a binary asset (image, voice note) stored in the Store.
// It wraps an AssetStorable returned by the Store — never constructed directly.
type ImageAsset struct {
	S store.AssetStorable
}

// ExternalRef is the path used to reference this asset from outside the
// Store — in editor markdown, AI CLI calls, etc. Derived by the Store from
// the ownership graph; never stored on disk.
func (a *ImageAsset) ExternalRef() string      { return a.S.ExternalRef() }

// Encoding is the inferred encoding of the asset bytes (Raw, Base64, etc).
// Inferred by the Store from magic bytes at Create time.
func (a *ImageAsset) Encoding() store.Encoding { return a.S.Encoding() }

// Storable returns the underlying AssetStorable for Store operations.
func (a *ImageAsset) Storable() store.AssetStorable { return a.S }
