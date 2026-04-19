package store_test

import (
	"testing"

	"stash/store"
)

func TestIsolationLevelValues(t *testing.T) {
	if store.Shared != 0 {
		t.Errorf("Shared = %d, want 0", store.Shared)
	}
	if store.Isolated != 1 {
		t.Errorf("Isolated = %d, want 1", store.Isolated)
	}
	// Distinct values — no accidental aliasing.
	if store.Shared == store.Isolated {
		t.Error("Shared and Isolated must be distinct")
	}
}

func TestLibraryCategory(t *testing.T) {
	c := store.Library
	if c.Key != "store" {
		t.Errorf("Library.Key = %q, want %q", c.Key, "store")
	}
	if c.DisplayName != "Library" {
		t.Errorf("Library.DisplayName = %q, want %q", c.DisplayName, "Library")
	}
	if c.Isolation != store.Shared {
		t.Errorf("Library.Isolation = %v, want Shared", c.Isolation)
	}
}

func TestWorkingCopyCategory(t *testing.T) {
	c := store.WorkingCopy
	if c.Key != "buffers" {
		t.Errorf("WorkingCopy.Key = %q, want %q", c.Key, "buffers")
	}
	if c.DisplayName != "Working Copy" {
		t.Errorf("WorkingCopy.DisplayName = %q, want %q", c.DisplayName, "Working Copy")
	}
	if c.Isolation != store.Isolated {
		t.Errorf("WorkingCopy.Isolation = %v, want Isolated", c.Isolation)
	}
}

func TestStateCategory(t *testing.T) {
	c := store.State
	if c.Key != "config" {
		t.Errorf("State.Key = %q, want %q", c.Key, "config")
	}
	if c.DisplayName != "State" {
		t.Errorf("State.DisplayName = %q, want %q", c.DisplayName, "State")
	}
	if c.Isolation != store.Isolated {
		t.Errorf("State.Isolation = %v, want Isolated", c.Isolation)
	}
}

func TestCategoryKeysAreDistinct(t *testing.T) {
	keys := []string{store.Library.Key, store.WorkingCopy.Key, store.State.Key}
	seen := make(map[string]bool)
	for _, k := range keys {
		if seen[k] {
			t.Errorf("duplicate category key %q", k)
		}
		seen[k] = true
	}
}

func TestCategoryDisplayNamesAreDistinct(t *testing.T) {
	names := []string{store.Library.DisplayName, store.WorkingCopy.DisplayName, store.State.DisplayName}
	seen := make(map[string]bool)
	for _, n := range names {
		if seen[n] {
			t.Errorf("duplicate category display name %q", n)
		}
		seen[n] = true
	}
}

func TestCategoryIsValueType(t *testing.T) {
	// Modifying a copy must not affect the package-level variable.
	c := store.Library
	c.Key = "mutated"
	if store.Library.Key != "store" {
		t.Error("mutating a Category copy affected the package-level variable")
	}
}
