package domain

import (
	"errors"
	"testing"
)

const (
	cUUID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
	bUUID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a99"
)

func TestParseAddress_RoundTrip(t *testing.T) {
	for _, s := range []string{
		"container:" + cUUID,
		"container:" + cUUID + "@v7",
		"block:" + bUUID,
		"block:" + cUUID + "/" + bUUID,
		"block:" + cUUID + "@v7/" + bUUID,
		"block:" + cUUID + "/the-retry-loop",
		"block:" + cUUID + "@v3/the-retry-loop",
	} {
		t.Run(s, func(t *testing.T) {
			a, err := ParseAddress(s)
			if err != nil {
				t.Fatalf("ParseAddress(%q): %v", s, err)
			}
			if got := a.String(); got != s {
				t.Fatalf("round trip: %q -> %q", s, got)
			}
		})
	}
}

func TestParseAddress_Fields(t *testing.T) {
	a, err := ParseAddress("block:" + cUUID + "@v7/the-retry-loop")
	if err != nil {
		t.Fatal(err)
	}
	if a.Scheme != SchemeBlock || a.Container != cUUID || a.Block != "the-retry-loop" || a.Version != 7 {
		t.Fatalf("fields: %+v", a)
	}
	if !a.IsPinned() {
		t.Fatal("IsPinned() false for @v7")
	}
	if !a.IsAlias() {
		t.Fatal("IsAlias() false for a non-uuid handle")
	}
}

func TestParseAddress_LiveBlockIsNotPinnedAndIsNotAnAlias(t *testing.T) {
	a, err := ParseAddress("block:" + bUUID)
	if err != nil {
		t.Fatal(err)
	}
	if a.IsPinned() {
		t.Fatal("bare block address reported as pinned")
	}
	if a.IsAlias() {
		t.Fatal("uuid handle reported as an alias")
	}
	if a.Container != "" {
		t.Fatalf("bare block address invented a container: %q", a.Container)
	}
}

func TestParseAddress_Rejects(t *testing.T) {
	for _, s := range []string{
		"",
		"block:",
		"container:",
		"block:the-retry-loop",             // bare alias — an alias may never leave its container
		"block:" + bUUID + "@v7",           // versions belong to containers, not blocks
		"container:" + cUUID + "/" + bUUID, // a container address names no block
		"container:not-a-uuid",
		"block:not-a-uuid/x",
		"thing:" + cUUID, // the scheme names shape, not service
		"https://example.com",
		"block:" + cUUID + "@v0/" + bUUID, // versions are 1-based
		"block:" + cUUID + "@vx/" + bUUID,
		"block:" + cUUID + "@7/" + bUUID, // missing the v
		"block:" + cUUID + "/a/b",
		"block:" + cUUID + "/",
		"container:" + cUUID + "@v-1",
	} {
		t.Run(s, func(t *testing.T) {
			a, err := ParseAddress(s)
			if err == nil {
				t.Fatalf("ParseAddress(%q) accepted: %+v", s, a)
			}
			// Every refusal is the one typed sentinel: a caller distinguishing
			// "this is not an address" from a store failure must not parse strings.
			if !errors.Is(err, ErrBadAddress) {
				t.Fatalf("ParseAddress(%q) err = %v, want it to wrap ErrBadAddress", s, err)
			}
		})
	}
}

func TestNewContainerAddress_EmitsTheLiveContainerForm(t *testing.T) {
	got := NewContainerAddress("  " + cUUID + "  ").String()
	if got != "container:"+cUUID {
		t.Fatalf("String() = %q, want the bare container form", got)
	}
	if _, err := ParseAddress(got); err != nil {
		t.Fatalf("the constructor emitted something the grammar rejects: %v", err)
	}
}

func TestAddress_Equal(t *testing.T) {
	live, _ := ParseAddress("block:" + bUUID)
	qualified, _ := ParseAddress("block:" + cUUID + "/" + bUUID)
	frozen, _ := ParseAddress("block:" + cUUID + "@v7/" + bUUID)
	otherFrozen, _ := ParseAddress("block:" + cUUID + "@v3/" + bUUID)
	aliased, _ := ParseAddress("block:" + cUUID + "/the-retry-loop")

	if !live.Equal(qualified) {
		t.Fatal("same uuid, both live — want equal (the container segment is a locator hint)")
	}
	if live.Equal(frozen) {
		t.Fatal("live and frozen must not be equal")
	}
	if frozen.Equal(otherFrozen) {
		t.Fatal("different pins must not be equal")
	}
	if aliased.Equal(aliased) {
		t.Fatal("an unresolved alias cannot be compared — want false")
	}
	if live.Equal(aliased) || aliased.Equal(live) {
		t.Fatal("comparison against an unresolved alias must be false in both directions")
	}
}

func TestAddress_EqualAcrossSchemes(t *testing.T) {
	container, _ := ParseAddress("container:" + cUUID)
	blk, _ := ParseAddress("block:" + cUUID)
	if container.Equal(blk) {
		t.Fatal("a container and a block with the same uuid are not the same thing")
	}

	same, _ := ParseAddress("container:" + cUUID)
	if !container.Equal(same) {
		t.Fatal("identical container addresses must be equal")
	}
}
