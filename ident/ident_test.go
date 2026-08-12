package ident

import (
	"testing"
	"time"
)

func TestNew_MintsValidUUID(t *testing.T) {
	id := New()
	if !Valid(id) {
		t.Fatalf("New() minted an invalid uuid: %q", id)
	}
	if len(id) != 36 {
		t.Fatalf("New() = %q, want canonical 36-char form", id)
	}
}

func TestNew_IsVersion7(t *testing.T) {
	// Version nibble is the first char of the third group: 8-4-4-4-12.
	if got := New()[14]; got != '7' {
		t.Fatalf("version nibble = %q, want '7' (UUIDv7 is time-ordered)", got)
	}
}

func TestNew_IsUnique(t *testing.T) {
	seen := make(map[string]bool, 1000)
	for i := 0; i < 1000; i++ {
		id := New()
		if seen[id] {
			t.Fatalf("New() repeated %q after %d mints", id, i)
		}
		seen[id] = true
	}
}

func TestNew_SortsChronologically(t *testing.T) {
	// UUIDv7 leads with a millisecond timestamp, so lexical order is time order.
	// Same-millisecond mints are ordered by the random tail, so compare across a
	// deliberate tick rather than asserting on two back-to-back calls.
	first := New()
	time.Sleep(2 * time.Millisecond)
	second := New()
	if !(first < second) {
		t.Fatalf("v7 ids not chronologically sortable: %q >= %q", first, second)
	}
}

func TestValid(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want bool
	}{
		{"v7 canonical", "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", true},
		{"v4 canonical", "f47ac10b-58cc-4372-a567-0e02b2c3d479", true},
		{"legacy short handle", "pr-3f2a", false},
		{"empty", "", false},
		{"no hyphens", "f47ac10b58cc4372a5670e02b2c3d479", false},
		{"urn form", "urn:uuid:f47ac10b-58cc-4372-a567-0e02b2c3d479", false},
		{"braced form", "{f47ac10b-58cc-4372-a567-0e02b2c3d479}", false},
		{"trailing junk", "f47ac10b-58cc-4372-a567-0e02b2c3d479x", false},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Valid(tc.in); got != tc.want {
				t.Fatalf("Valid(%q) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}
