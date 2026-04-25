package filestore_test

import (
	"bytes"
	"testing"

	"sieve/store"
)

func TestExplicitCreateMetaText(t *testing.T) {
	fs := newTestStore(t)
	body := []byte("---\ntitle: Hello\n---\nBody content")
	
	ms, err := fs.CreateMetaText(testWorkingCopy, "note.md", body)
	if err != nil {
		t.Fatalf("CreateMetaText: %v", err)
	}

	if ms.Meta()["title"] != "Hello" {
		t.Errorf("expected title 'Hello', got %q", ms.Meta()["title"])
	}
	if string(ms.Body()) != "Body content" {
		t.Errorf("expected body 'Body content', got %q", string(ms.Body()))
	}
	if ms.Meta()["uuid"] == "" {
		t.Error("expected version 0 to be stamped")
	}
	if ms.Meta()["version"] != "0" {
		t.Errorf("expected version 0, got %q", ms.Meta()["version"])
	}
}

func TestExplicitCreateAsset(t *testing.T) {
	fs := newTestStore(t)
	
	t.Run("PNG_Raw", func(t *testing.T) {
		png := []byte{0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A}
		as, err := fs.CreateAsset(testWorkingCopy, "", "img.png", png)
		if err != nil {
			t.Fatalf("CreateAsset: %v", err)
		}
		if as.Encoding() != store.Raw {
			t.Errorf("expected Raw encoding for PNG, got %v", as.Encoding())
		}
	})

	t.Run("Base64_Text", func(t *testing.T) {
		b64 := []byte("aGVsbG8=") // "hello"
		as, err := fs.CreateAsset(testWorkingCopy, "", "img.txt", b64)
		if err != nil {
			t.Fatalf("CreateAsset: %v", err)
		}
		if as.Encoding() != store.Base64 {
			t.Errorf("expected Base64 encoding for text data, got %v", as.Encoding())
		}
	})
}

func TestExplicitCreateText(t *testing.T) {
	fs := newTestStore(t)
	content := []byte(`{"settings": true}`)
	
	s, err := fs.CreateText(store.Category{Key: "config", Isolation: store.Isolated}, "settings.json", content)
	if err != nil {
		t.Fatalf("CreateText: %v", err)
	}

	if !bytes.Equal(s.Body(), content) {
		t.Error("body content mismatch")
	}

	// Verify it is NOT a MetaStorable
	if _, ok := s.(store.MetaStorable); ok {
		t.Error("CreateText should not return a MetaStorable")
	}
}
