package store_test

import "stash/store"

// Compile-time interface conformance checks. The stubs below exist solely to
// verify that the interface signatures are self-consistent and implementable.
// They exercise every method so that a signature change causes a compile error.
var (
	_ store.Storable       = (*stubStorable)(nil)
	_ store.MetaStorable   = (*stubMetaStorable)(nil)
	_ store.AssetStorable  = (*stubAssetStorable)(nil)
	_ store.FolderStorable = (*stubFolderStorable)(nil)
	_ store.Store          = (*stubStore)(nil)
)

// stubStorable satisfies the Storable interface.
type stubStorable struct{}

func (s *stubStorable) Key() string                { return "" }
func (s *stubStorable) Category() store.Category   { return store.Category{} }
func (s *stubStorable) Body() []byte               { return nil }
func (s *stubStorable) ExternalRef() string        { return "" }
func (s *stubStorable) Versions() []store.VersionRef { return nil }

// stubMetaStorable satisfies the MetaStorable interface.
type stubMetaStorable struct{ stubStorable }

func (s *stubMetaStorable) Meta() map[string]string { return nil }
func (s *stubMetaStorable) SetBody(_ []byte)        {}
func (s *stubMetaStorable) SetMeta(_ map[string]string) {}

// stubAssetStorable satisfies the AssetStorable interface.
type stubAssetStorable struct{ stubStorable }

func (s *stubAssetStorable) Encoding() store.Encoding { return store.Raw }

// stubFolderStorable satisfies the FolderStorable interface.
type stubFolderStorable struct{ stubStorable }

func (s *stubFolderStorable) Owns() []store.Storable { return nil }

// stubStore satisfies the Store interface.
type stubStore struct{}

func (s *stubStore) Create(_ store.Category, _ string, _ []byte) (store.Storable, error) {
	return nil, nil
}
func (s *stubStore) Save(_ store.Storable) (store.Storable, error) { return nil, nil }
func (s *stubStore) Load(_ store.Category, _ string) (store.Storable, error) {
	return nil, nil
}
func (s *stubStore) Delete(_ store.Storable) error { return nil }
func (s *stubStore) List(_ store.Category, _ string) ([]store.Storable, error) {
	return nil, nil
}
func (s *stubStore) Move(_ store.Storable, _ store.Category) (store.Storable, error) {
	return nil, nil
}
func (s *stubStore) Reparent(_ store.Storable, _ store.FolderStorable) (store.Storable, error) {
	return nil, nil
}
func (s *stubStore) Rename(_ store.Storable, _ string) (store.Storable, error) {
	return nil, nil
}
func (s *stubStore) RetrieveVersion(_ store.Storable, _ store.VersionRef) (store.VersionedStorable, error) {
	return store.VersionedStorable{}, nil
}
