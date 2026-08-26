package ident

import (
	"strings"
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

func TestCanonical(t *testing.T) {
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"already canonical", "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b", "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"},
		{"uppercase", "0190A1B2-C3D4-7E5F-8A9B-0C1D2E3F4A5B", "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"},
		{"mixed case", "0190a1b2-C3D4-7e5f-8A9B-0c1d2e3f4a5b", "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"},
		// Not a uuid: normalise identity, never invent it. Case may be meaningful
		// in whatever this string actually is.
		{"legacy short handle", "PR-3F2A", "PR-3F2A"},
		{"an alias", "The-Retry-Loop", "The-Retry-Loop"},
		{"a filename", "README.md", "README.md"},
		{"empty", "", ""},
		{"urn form is not a spelling we mint", "urn:uuid:F47AC10B-58CC-4372-A567-0E02B2C3D479", "urn:uuid:F47AC10B-58CC-4372-A567-0E02B2C3D479"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := Canonical(tc.in); got != tc.want {
				t.Fatalf("Canonical(%q) = %q, want %q", tc.in, got, tc.want)
			}
		})
	}
}

// What Canonical is FOR: one id has one spelling, so it compares and indexes as
// one id however it was written.
func TestCanonical_CollapsesSpellingsOfOneID(t *testing.T) {
	id := New()
	if Canonical(strings.ToUpper(id)) != Canonical(id) {
		t.Fatalf("two spellings of %q did not collapse", id)
	}
}

// Canonical output is itself canonical — nothing downstream needs a second pass.
func TestCanonical_IsIdempotentAndStaysValid(t *testing.T) {
	once := Canonical(strings.ToUpper(New()))
	if Canonical(once) != once {
		t.Fatalf("Canonical is not idempotent: %q", once)
	}
	if !Valid(once) {
		t.Fatalf("Canonical(%q) is not a valid uuid", once)
	}
}
