package store_test

import (
	"errors"
	"fmt"
	"testing"
	"time"

	"sieve/store"
)

func TestErrStaleStorableIsNotNil(t *testing.T) {
	if store.ErrStaleStorable == nil {
		t.Fatal("ErrStaleStorable must not be nil")
	}
}

func TestErrStaleStorableMessage(t *testing.T) {
	if store.ErrStaleStorable.Error() == "" {
		t.Error("ErrStaleStorable must have a non-empty message")
	}
}

func TestErrStaleStorableUnwrap(t *testing.T) {
	wrapped := fmt.Errorf("save failed: %w", store.ErrStaleStorable)
	if !errors.Is(wrapped, store.ErrStaleStorable) {
		t.Error("errors.Is must match ErrStaleStorable through a wrapped error")
	}
}

func TestVersionRefZeroValue(t *testing.T) {
	var ref store.VersionRef
	if ref.ID != "" {
		t.Errorf("zero VersionRef.ID = %q, want empty string", ref.ID)
	}
	if !ref.Created.IsZero() {
		t.Errorf("zero VersionRef.Created = %v, want zero time", ref.Created)
	}
	if ref.Size != 0 {
		t.Errorf("zero VersionRef.Size = %d, want 0", ref.Size)
	}
}

func TestVersionRefFields(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	ref := store.VersionRef{
		ID:      "v42",
		Created: now,
		Size:    2048,
	}
	if ref.ID != "v42" {
		t.Errorf("VersionRef.ID = %q, want %q", ref.ID, "v42")
	}
	if !ref.Created.Equal(now) {
		t.Errorf("VersionRef.Created = %v, want %v", ref.Created, now)
	}
	if ref.Size != 2048 {
		t.Errorf("VersionRef.Size = %d, want 2048", ref.Size)
	}
}

func TestVersionedStorableZeroValue(t *testing.T) {
	var vs store.VersionedStorable
	if vs.Body != nil {
		t.Error("zero VersionedStorable.Body must be nil")
	}
	if vs.Meta != nil {
		t.Error("zero VersionedStorable.Meta must be nil")
	}
	if vs.Owns != nil {
		t.Error("zero VersionedStorable.Owns must be nil")
	}
}

func TestVersionedStorableFields(t *testing.T) {
	now := time.Now().UTC().Truncate(time.Second)
	ref := store.VersionRef{ID: "v1", Created: now, Size: 100}
	body := []byte("# Hello")
	meta := map[string]string{"status": "unfiled"}

	vs := store.VersionedStorable{
		Ref:  ref,
		Body: body,
		Meta: meta,
	}

	if vs.Ref.ID != "v1" {
		t.Errorf("VersionedStorable.Ref.ID = %q, want %q", vs.Ref.ID, "v1")
	}
	if string(vs.Body) != "# Hello" {
		t.Errorf("VersionedStorable.Body = %q, want %q", vs.Body, "# Hello")
	}
	if vs.Meta["status"] != "unfiled" {
		t.Errorf("VersionedStorable.Meta[status] = %q, want %q", vs.Meta["status"], "unfiled")
	}
}
