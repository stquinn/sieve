package sieve_test

import (
	"testing"

	"sieve/sieve"
	"sieve/store"
)

func TestLibraryCategory(t *testing.T) {
	c := sieve.LibraryCategory
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
	c := sieve.WorkingCopy
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
	c := sieve.State
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
	keys := []string{sieve.LibraryCategory.Key, sieve.WorkingCopy.Key, sieve.State.Key}
	seen := make(map[string]bool)
	for _, k := range keys {
		if seen[k] {
			t.Errorf("duplicate category key %q", k)
		}
		seen[k] = true
	}
}

func TestCategoryDisplayNamesAreDistinct(t *testing.T) {
	names := []string{sieve.LibraryCategory.DisplayName, sieve.WorkingCopy.DisplayName, sieve.State.DisplayName}
	seen := make(map[string]bool)
	for _, n := range names {
		if seen[n] {
			t.Errorf("duplicate category display name %q", n)
		}
		seen[n] = true
	}
}
