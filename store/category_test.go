package store_test

import (
	"testing"

	"sieve/store"
)

func TestIsolationLevelValues(t *testing.T) {
	if store.Shared != 0 {
		t.Errorf("Shared = %d, want 0", store.Shared)
	}
	if store.Isolated != 1 {
		t.Errorf("Isolated = %d, want 1", store.Isolated)
	}
	if store.Shared == store.Isolated {
		t.Error("Shared and Isolated must be distinct")
	}
}

func TestCategoryIsValueType(t *testing.T) {
	// Modifying a copy must not affect the original.
	original := store.Category{Key: "test", DisplayName: "Test", Isolation: store.Shared}
	copy := original
	copy.Key = "mutated"
	if original.Key != "test" {
		t.Error("mutating a Category copy affected the original")
	}
}
