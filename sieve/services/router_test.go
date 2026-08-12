package services

import (
	"errors"
	"fmt"
	"testing"

	"sieve/sieve/domain"
)

// fakeSource is a NodeSource stand-in: the Router's own behaviour (scheme
// refusal, federation order, dangling classification, limit) is what these tests
// exercise, so the source behind it is deliberately inert.
type fakeSource struct {
	name       string
	nodes      map[string]domain.Node
	candidates []domain.Candidate
	resolved   []string // every uri this source was asked to resolve
	searched   []int    // every limit this source was asked for
	failWith   error    // non-nil: Resolve returns this instead of looking up
}

func (f *fakeSource) Name() string { return f.name }

func (f *fakeSource) Search(query string, limit int) []domain.Candidate {
	f.searched = append(f.searched, limit)
	if limit < len(f.candidates) {
		return f.candidates[:limit]
	}
	return f.candidates
}

func (f *fakeSource) Resolve(uri string) (domain.Node, error) {
	f.resolved = append(f.resolved, uri)
	if f.failWith != nil {
		return domain.Node{}, f.failWith
	}
	if n, ok := f.nodes[uri]; ok {
		return n, nil
	}
	return domain.Node{}, fmt.Errorf("%w: %s", domain.ErrNodeNotFound, uri)
}

func TestRouter_ResolvesThroughTheFirstSourceThatAnswers(t *testing.T) {
	empty := &fakeSource{name: "empty"}
	notes := &fakeSource{name: "notes", nodes: map[string]domain.Node{
		"container:9f2b": {URI: "container:9f2b", UUID: "9f2b", Kind: "note", Title: "Auth Design"},
	}}
	r := NewRouter(empty, notes)

	node, err := r.Resolve("container:9f2b")
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if node.Title != "Auth Design" || node.Kind != "note" {
		t.Errorf("node = %+v, want the notes source's node", node)
	}
	if len(empty.resolved) != 1 {
		t.Errorf("the first source must be asked first, calls = %v", empty.resolved)
	}
}

// Dangling is a normal state, not a panic: the address had a shape, no source
// held it.
func TestRouter_DanglingAddressIsATypedError(t *testing.T) {
	r := NewRouter(&fakeSource{name: "notes"})

	_, err := r.Resolve("container:deleted-uuid")
	if !errors.Is(err, domain.ErrNodeNotFound) {
		t.Fatalf("err = %v, want ErrNodeNotFound", err)
	}
}

func TestRouter_UnknownSchemeIsRefusedBeforeAnySourceIsAsked(t *testing.T) {
	notes := &fakeSource{name: "notes"}
	r := NewRouter(notes)

	_, err := r.Resolve("block:9f2b/co-1")
	if !errors.Is(err, domain.ErrUnknownScheme) {
		t.Fatalf("err = %v, want ErrUnknownScheme", err)
	}
	if len(notes.resolved) != 0 {
		t.Errorf("no source may be asked about an unresolvable scheme, calls = %v", notes.resolved)
	}
}

// The pin is reserved grammar, not implemented behaviour: resolving it live
// while claiming it is a snapshot would be a lie, so it is refused.
func TestRouter_PinnedAddressIsRefused(t *testing.T) {
	notes := &fakeSource{name: "notes"}
	r := NewRouter(notes)

	_, err := r.Resolve("container:9f2b@v3")
	if !errors.Is(err, domain.ErrVersionPinUnsupported) {
		t.Fatalf("err = %v, want ErrVersionPinUnsupported", err)
	}
	if len(notes.resolved) != 0 {
		t.Errorf("a pinned address must not reach a source, calls = %v", notes.resolved)
	}
}

// A source failing for a reason OTHER than "I don't hold it" (a broken store)
// must surface, not be swallowed as a dangling address.
func TestRouter_SourceFailureIsNotSilentlyDangling(t *testing.T) {
	boom := errors.New("store unreadable")
	r := NewRouter(&fakeSource{name: "notes", failWith: boom})

	_, err := r.Resolve("container:9f2b")
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want the source's own error", err)
	}
	if errors.Is(err, domain.ErrNodeNotFound) {
		t.Error("a source failure must not be reported as a dangling address")
	}
}

func TestRouter_SearchFansOutAndCapsAtTheTotalLimit(t *testing.T) {
	a := &fakeSource{name: "a", candidates: []domain.Candidate{
		{URI: "container:1", Title: "One"},
		{URI: "container:2", Title: "Two"},
	}}
	b := &fakeSource{name: "b", candidates: []domain.Candidate{
		{URI: "container:3", Title: "Three"},
		{URI: "container:4", Title: "Four"},
	}}
	r := NewRouter(a)
	r.Register(b)

	got := r.Search("o", 3)
	if len(got) != 3 {
		t.Fatalf("got %d candidates, want the limit (3): %+v", len(got), got)
	}
	if got[0].URI != "container:1" || got[2].URI != "container:3" {
		t.Errorf("registration order not preserved: %+v", got)
	}
	if len(b.searched) != 1 || b.searched[0] != 1 {
		t.Errorf("the second source must be asked for the REMAINING budget, got %v", b.searched)
	}
}

func TestRouter_SearchIgnoresEmptyQueries(t *testing.T) {
	notes := &fakeSource{name: "notes", candidates: []domain.Candidate{{URI: "container:1"}}}
	r := NewRouter(notes)

	if got := r.Search("   ", 5); len(got) != 0 {
		t.Errorf("empty query returned %+v, want nothing", got)
	}
	if got := r.Search("auth", 0); len(got) != 0 {
		t.Errorf("zero limit returned %+v, want nothing", got)
	}
	if len(notes.searched) != 0 {
		t.Errorf("no source should have been asked, got %v", notes.searched)
	}
}
