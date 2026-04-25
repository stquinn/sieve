package sieve

import (
	"fmt"
	"testing"
	"sieve/store"
)

type mockStorable struct {
	key      string
	category store.Category
	body     []byte
}

func (m *mockStorable) Key() string                { return m.key }
func (m *mockStorable) Category() store.Category   { return m.category }
func (m *mockStorable) Body() []byte               { return m.body }
func (m *mockStorable) ExternalRef() string        { return "" }
func (m *mockStorable) Versions() []store.VersionRef { return nil }
func (m *mockStorable) IsModified() bool             { return false }

type mockStore struct {
	files map[string]*mockStorable
}

func newMockStore() *mockStore {
	return &mockStore{files: make(map[string]*mockStorable)}
}

func (m *mockStore) CreateText(cat store.Category, key string, body []byte) (store.Storable, error) {
	s := &mockStorable{key: key, category: cat, body: body}
	m.files[cat.Key+":"+key] = s
	return s, nil
}

func (m *mockStore) Load(cat store.Category, key string) (store.Storable, error) {
	s, ok := m.files[cat.Key+":"+key]
	if !ok {
		return nil, fmt.Errorf("not found")
	}
	return s, nil
}

func (m *mockStore) Delete(s store.Storable) error {
	delete(m.files, s.Category().Key+":"+s.Key())
	return nil
}

func (m *mockStore) PrepareCategory(cat store.Category) error { return nil }

// Unimplemented methods to satisfy Store interface
func (m *mockStore) CreateMetaText(cat store.Category, key string, body []byte) (store.MetaStorable, error) { return nil, nil }
func (m *mockStore) CreateAsset(cat store.Category, parentKey, assetID string, body []byte) (store.AssetStorable, error) { return nil, nil }
func (m *mockStore) Save(s store.Storable) (store.Storable, error) { return nil, nil }
func (m *mockStore) List(cat store.Category, prefix string) ([]store.Storable, error) { return nil, nil }
func (m *mockStore) Move(s store.Storable, cat store.Category) (store.Storable, error) { return nil, nil }
func (m *mockStore) Reparent(s store.Storable, folder store.FolderStorable) (store.Storable, error) { return nil, nil }
func (m *mockStore) Rename(s store.Storable, newKey string) (store.Storable, error) { return nil, nil }
func (m *mockStore) MoveToKey(s store.Storable, newKey string) (store.Storable, error) { return nil, nil }
func (m *mockStore) RetrieveVersion(s store.Storable, ref store.VersionRef) (store.VersionedStorable, error) { return store.VersionedStorable{}, nil }

func TestPromptService(t *testing.T) {
	st := newMockStore()
	ps, _ := NewPromptService(st)

	t.Run("Fallback to default", func(t *testing.T) {
		content, err := ps.GetPromptContent("file")
		if err != nil {
			t.Fatalf("expected no error, got %v", err)
		}
		if content != DefaultFilingPrompt {
			t.Error("expected DefaultFilingPrompt")
		}
	})

	t.Run("Save and load override", func(t *testing.T) {
		override := "custom prompt"
		if err := ps.SavePrompt("file", override); err != nil {
			t.Fatalf("save failed: %v", err)
		}

		content, err := ps.GetPromptContent("file")
		if err != nil {
			t.Fatalf("load failed: %v", err)
		}
		if content != override {
			t.Errorf("expected %q, got %q", override, content)
		}

		list := ps.ListPrompts()
		found := false
		for _, p := range list {
			if p.Name == "file" {
				if p.IsVirtual {
					t.Error("expected IsVirtual to be false for override")
				}
				found = true
			}
		}
		if !found {
			t.Error("file prompt not in list")
		}
	})

	t.Run("Delete and fallback", func(t *testing.T) {
		if err := ps.DeletePrompt("file"); err != nil {
			t.Fatalf("delete failed: %v", err)
		}

		content, err := ps.GetPromptContent("file")
		if err != nil {
			t.Fatalf("load failed: %v", err)
		}
		if content != DefaultFilingPrompt {
			t.Error("expected fallback to default after delete")
		}
	})
}
