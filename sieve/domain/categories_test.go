package domain_test

import (
	"testing"

	"sieve/sieve/domain"
	"sieve/store"
)

var categories = []store.Category{domain.LibraryCategory, domain.WorkingCopy, domain.State, domain.Blocks}

func TestCategories(t *testing.T) {
	for _, tc := range []struct {
		cat         store.Category
		key, name   string
		isolation   store.IsolationLevel
		metaEnabled bool
	}{
		{domain.LibraryCategory, "store", "Library", store.Shared, true},
		{domain.WorkingCopy, "buffers", "Working Copy", store.Isolated, true},
		{domain.State, "config", "State", store.Isolated, false},
		{domain.Blocks, "blocks", "Blocks", store.Shared, true},
	} {
		c := tc.cat
		if c.Key != tc.key || c.DisplayName != tc.name || c.Isolation != tc.isolation || c.MetaEnabled != tc.metaEnabled {
			t.Errorf("%s = %+v, want key %q, name %q, isolation %v, meta %v", tc.name, c, tc.key, tc.name, tc.isolation, tc.metaEnabled)
		}
	}
}

func TestCategoryKeysAndDisplayNamesAreDistinct(t *testing.T) {
	keys, names := map[string]bool{}, map[string]bool{}
	for _, c := range categories {
		if keys[c.Key] || names[c.DisplayName] {
			t.Errorf("duplicate category %+v", c)
		}
		keys[c.Key], names[c.DisplayName] = true, true
	}
}
