package domain

import (
	"errors"
	"testing"
)

func TestParseAddress_BareContainerIsALiveEdge(t *testing.T) {
	addr, err := ParseAddress("container:9f2b3c4d-1a2b-4c5d-8e9f-a1b2c3d4e5f6")
	if err != nil {
		t.Fatalf("ParseAddress: %v", err)
	}
	if addr.Scheme != SchemeContainer {
		t.Errorf("scheme = %q, want %q", addr.Scheme, SchemeContainer)
	}
	if addr.Opaque != "9f2b3c4d-1a2b-4c5d-8e9f-a1b2c3d4e5f6" {
		t.Errorf("opaque = %q", addr.Opaque)
	}
	if addr.IsPinned() {
		t.Error("a bare address must not be pinned — it is a live edge")
	}
	if addr.URI() != "container:9f2b3c4d-1a2b-4c5d-8e9f-a1b2c3d4e5f6" {
		t.Errorf("URI() = %q, want the input back", addr.URI())
	}
}

// The @v{n} pin is #75's RESERVED form. Parsing recognises it purely so a pinned
// address can be refused honestly rather than silently resolved live.
func TestParseAddress_RecognisesTheReservedVersionPin(t *testing.T) {
	addr, err := ParseAddress("container:9f2b@v3")
	if err != nil {
		t.Fatalf("ParseAddress: %v", err)
	}
	if addr.Opaque != "9f2b" || addr.Version != "v3" {
		t.Fatalf("opaque/version = %q/%q, want 9f2b/v3", addr.Opaque, addr.Version)
	}
	if !addr.IsPinned() {
		t.Error("a @v-suffixed address must report as pinned")
	}
	if addr.URI() != "container:9f2b@v3" {
		t.Errorf("URI() = %q, want the input back", addr.URI())
	}
}

func TestParseAddress_MalformedIsATypedError(t *testing.T) {
	for _, uri := range []string{"", "   ", "9f2b", ":9f2b", "container:"} {
		if _, err := ParseAddress(uri); !errors.Is(err, ErrMalformedAddress) {
			t.Errorf("ParseAddress(%q) err = %v, want ErrMalformedAddress", uri, err)
		}
	}
}

// An unknown scheme parses fine — shape is the grammar's business, resolvability
// is the Router's.
func TestParseAddress_UnknownSchemeParsesButIsNotContainer(t *testing.T) {
	addr, err := ParseAddress("block:9f2b/co-1")
	if err != nil {
		t.Fatalf("ParseAddress: %v", err)
	}
	if addr.Scheme == SchemeContainer {
		t.Errorf("scheme = %q, want a non-container scheme", addr.Scheme)
	}
	if addr.Opaque != "9f2b/co-1" {
		t.Errorf("opaque = %q, want the whole scheme-owned part", addr.Opaque)
	}
}

func TestNewContainerAddress_EmitsTheBareForm(t *testing.T) {
	got := NewContainerAddress("9f2b").URI()
	if got != "container:9f2b" {
		t.Errorf("URI() = %q, want container:9f2b", got)
	}
}
