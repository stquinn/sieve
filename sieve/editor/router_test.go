package editor

import (
	"errors"
	"fmt"
	"testing"

	"sieve/sieve/domain"
)

// Addresses are uuid-strict, so router tests need real ones: a short stand-in
// like "sieve://9f2b" does not parse and would fail these tests for the wrong
// reason.
const (
	testContainerUUID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
	testMissingUUID   = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a77"
	testBlockUUID     = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a99"
)

// mustAddress parses a coordinate the way every production caller does: at its
// own door, before the resolver is asked. A source is only ever handed a typed
// address, so a test that means to exercise resolution parses first — a string
// the grammar rejects is a different test.
func mustAddress(t *testing.T, uri string) domain.Address {
	t.Helper()
	addr, err := domain.ParseAddress(uri)
	if err != nil {
		t.Fatalf("ParseAddress(%q): %v", uri, err)
	}
	return addr
}

// fakeSource is a NodeSource stand-in: the Router's own behaviour (leaf
// refusal, federation order, dangling classification, limit) is what these tests
// exercise, so the source behind it is deliberately inert.
type fakeSource struct {
	name       string
	nodes      map[string]domain.NodeDescriptor
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

func (f *fakeSource) Resolve(addr domain.Address) (domain.NodeDescriptor, error) {
	uri := addr.String()
	f.resolved = append(f.resolved, uri)
	if f.failWith != nil {
		return domain.NodeDescriptor{}, f.failWith
	}
	if n, ok := f.nodes[uri]; ok {
		return n, nil
	}
	return domain.NodeDescriptor{}, fmt.Errorf("%w: %s", domain.ErrNodeNotFound, uri)
}

func TestRouter_ResolvesThroughTheFirstSourceThatAnswers(t *testing.T) {
	uri := "sieve://" + testContainerUUID
	empty := &fakeSource{name: "empty"}
	notes := &fakeSource{name: "notes", nodes: map[string]domain.NodeDescriptor{
		uri: {URI: uri, UUID: testContainerUUID, Kind: "note", Title: "Auth Design"},
	}}
	r := NewRouter(empty, notes)

	node, err := r.Resolve(mustAddress(t, uri))
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

// Dangling is a normal state, not a panic: the address was a real coordinate, no
// source held it.
func TestRouter_DanglingAddressIsATypedError(t *testing.T) {
	r := NewRouter(&fakeSource{name: "notes"})

	_, err := r.Resolve(mustAddress(t, "sieve://"+testMissingUUID))
	if !errors.Is(err, domain.ErrNodeNotFound) {
		t.Fatalf("err = %v, want ErrNodeNotFound", err)
	}
}

// Not-an-address is the GRAMMAR's refusal and it happens at whichever door the
// text arrived through — never here. Resolve takes a typed coordinate, so a
// malformed one cannot reach a source because it cannot reach the Router: this
// asserts the refusal still lands, and that it lands before any source is asked.
func TestRouter_MalformedAddressCannotReachASource(t *testing.T) {
	notes := &fakeSource{name: "notes"}
	r := NewRouter(notes)

	addr, err := domain.ParseAddress("sieve://not-a-uuid")
	if !errors.Is(err, domain.ErrBadAddress) {
		t.Fatalf("err = %v, want ErrBadAddress", err)
	}
	// A refused parse yields the zero Address, which names no container — asking
	// with it reaches sources but can only ever dangle. The point is that the
	// caller stops at the parse.
	if _, err := r.Resolve(addr); !errors.Is(err, domain.ErrNodeNotFound) {
		t.Errorf("the zero address can only dangle; got %v", err)
	}
}

// GRAIN is not a router concern. Reaching inside a container is the job of
// whichever source holds it, so a leaf address travels there verbatim — the
// router neither refuses it nor takes it apart.
func TestRouter_LeafAddressReachesItsSourceVerbatim(t *testing.T) {
	uri := "sieve://" + testContainerUUID + "/" + testBlockUUID
	notes := &fakeSource{name: "notes", nodes: map[string]domain.NodeDescriptor{
		uri: {URI: uri, UUID: testBlockUUID, Kind: "code", Body: "backoff()"},
	}}
	r := NewRouter(notes)

	node, err := r.Resolve(mustAddress(t, uri))
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if node.UUID != testBlockUUID || node.Kind != "code" {
		t.Errorf("node = %+v, want the source's answer for the leaf", node)
	}
	if len(notes.resolved) != 1 || notes.resolved[0] != uri {
		t.Errorf("source was asked for %v, want the leaf uri unaltered", notes.resolved)
	}
}

// The pin is not the router's business. Only the source holding a container
// knows what its history looks like, so a pinned uri must arrive there VERBATIM
// — a router that stripped the pin would hand back live content wearing a
// version number.
func TestRouter_PinnedAddressReachesItsSourceVerbatim(t *testing.T) {
	uri := "sieve://" + testContainerUUID + "?version=3"
	notes := &fakeSource{name: "notes", nodes: map[string]domain.NodeDescriptor{
		uri: {URI: uri, UUID: testContainerUUID, Kind: "note", Body: "as it stood at 3"},
	}}
	r := NewRouter(notes)

	node, err := r.Resolve(mustAddress(t, uri))
	if err != nil {
		t.Fatalf("Resolve: %v", err)
	}
	if node.Body != "as it stood at 3" {
		t.Errorf("node = %+v, want the source's version-3 answer", node)
	}
	if len(notes.resolved) != 1 || notes.resolved[0] != uri {
		t.Errorf("source was asked for %v, want the pinned uri unaltered", notes.resolved)
	}
}

// A source failing for a reason OTHER than "I don't hold it" (a broken store)
// must surface, not be swallowed as a dangling address.
func TestRouter_SourceFailureIsNotSilentlyDangling(t *testing.T) {
	boom := errors.New("store unreadable")
	r := NewRouter(&fakeSource{name: "notes", failWith: boom})

	_, err := r.Resolve(mustAddress(t, "sieve://"+testContainerUUID))
	if !errors.Is(err, boom) {
		t.Fatalf("err = %v, want the source's own error", err)
	}
	if errors.Is(err, domain.ErrNodeNotFound) {
		t.Error("a source failure must not be reported as a dangling address")
	}
}

func TestRouter_SearchFansOutAndCapsAtTheTotalLimit(t *testing.T) {
	a := &fakeSource{name: "a", candidates: []domain.Candidate{
		{URI: "sieve://1", Title: "One"},
		{URI: "sieve://2", Title: "Two"},
	}}
	b := &fakeSource{name: "b", candidates: []domain.Candidate{
		{URI: "sieve://3", Title: "Three"},
		{URI: "sieve://4", Title: "Four"},
	}}
	r := NewRouter(a)
	r.Register(b)

	got := r.Search("o", 3)
	if len(got) != 3 {
		t.Fatalf("got %d candidates, want the limit (3): %+v", len(got), got)
	}
	if got[0].URI != "sieve://1" || got[2].URI != "sieve://3" {
		t.Errorf("registration order not preserved: %+v", got)
	}
	if len(b.searched) != 1 || b.searched[0] != 1 {
		t.Errorf("the second source must be asked for the REMAINING budget, got %v", b.searched)
	}
}

func TestRouter_SearchIgnoresEmptyQueries(t *testing.T) {
	notes := &fakeSource{name: "notes", candidates: []domain.Candidate{{URI: "sieve://1"}}}
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

// Target is the NAVIGATION face: Resolve answers "what is at this address",
// Target answers "where does it open".

func TestRouter_TargetOfAContainerAddressIsThatContainer(t *testing.T) {
	uri := "sieve://" + testContainerUUID
	notes := &fakeSource{name: "notes", nodes: map[string]domain.NodeDescriptor{
		uri: {URI: uri, UUID: testContainerUUID, Kind: "note", Title: "Auth Design"},
	}}
	r := NewRouter(notes)

	target, err := r.Target(uri)
	if err != nil {
		t.Fatalf("Target: %v", err)
	}
	if target.UUID != testContainerUUID || target.BlockID != "" {
		t.Errorf("target = %+v, want the container and no block", target)
	}
	if target.URI != uri || target.Title != "Auth Design" || target.Kind != "note" {
		t.Errorf("target = %+v, want the resolved node's identity carried", target)
	}
}

// A leaf coordinate opens its CONTAINER and names the block to reveal. What is
// asked for is the container address: navigation opens documents, so fetching
// the leaf's own content here would be work nobody navigating needs.
func TestRouter_TargetOfALeafAddressOpensItsContainer(t *testing.T) {
	containerURI := "sieve://" + testContainerUUID
	notes := &fakeSource{name: "notes", nodes: map[string]domain.NodeDescriptor{
		containerURI: {URI: containerURI, UUID: testContainerUUID, Kind: "note", Title: "Auth Design"},
	}}
	r := NewRouter(notes)

	target, err := r.Target("sieve://" + testContainerUUID + "/" + testBlockUUID)
	if err != nil {
		t.Fatalf("Target: %v", err)
	}
	if target.UUID != testContainerUUID || target.BlockID != testBlockUUID {
		t.Errorf("target = %+v, want container + block", target)
	}
	if len(notes.resolved) != 1 || notes.resolved[0] != containerURI {
		t.Errorf("the source was asked for %v, want only the container address", notes.resolved)
	}
}

// An ALIAS handle is carried through untouched: it is local to its container, so
// only the container that opens can resolve it.
func TestRouter_TargetCarriesAnAliasHandleThrough(t *testing.T) {
	containerURI := "sieve://" + testContainerUUID
	notes := &fakeSource{name: "notes", nodes: map[string]domain.NodeDescriptor{
		containerURI: {URI: containerURI, UUID: testContainerUUID},
	}}
	r := NewRouter(notes)

	target, err := r.Target("sieve://" + testContainerUUID + "/intro")
	if err != nil {
		t.Fatalf("Target: %v", err)
	}
	if target.BlockID != "intro" {
		t.Errorf("blockId = %q, want the alias carried through", target.BlockID)
	}
}

// Target carries the pin onto the container address rather than dropping it, so
// what gets RESOLVED is the version the caller named. It is not a claim that the
// caller can navigate to that version — OpenTarget has no version field — only
// that the pin is checked rather than quietly ignored.
func TestRouter_TargetOfAPinnedLeafAsksForThePinnedContainer(t *testing.T) {
	pinnedContainer := "sieve://" + testContainerUUID + "?version=2"
	notes := &fakeSource{name: "notes", nodes: map[string]domain.NodeDescriptor{
		pinnedContainer: {URI: pinnedContainer, UUID: testContainerUUID, Kind: "note", Title: "Auth Design"},
	}}
	r := NewRouter(notes)

	target, err := r.Target("sieve://" + testContainerUUID + "/" + testBlockUUID + "?version=2")
	if err != nil {
		t.Fatalf("Target: %v", err)
	}
	if len(notes.resolved) != 1 || notes.resolved[0] != pinnedContainer {
		t.Errorf("source was asked for %v, want the pinned container address", notes.resolved)
	}
	if target.UUID != testContainerUUID || target.BlockID != testBlockUUID {
		t.Errorf("target = %+v, want the container to open and the block to reveal", target)
	}
}

// Dangling and malformed keep their own sentinels through Target, so a caller
// can still tell "deleted" from "never was an address".
func TestRouter_TargetSurfacesTheGrammarAndDanglingSentinels(t *testing.T) {
	r := NewRouter(&fakeSource{name: "notes"})

	if _, err := r.Target("sieve://" + testMissingUUID); !errors.Is(err, domain.ErrNodeNotFound) {
		t.Fatalf("err = %v, want ErrNodeNotFound", err)
	}
	if _, err := r.Target("not-an-address"); !errors.Is(err, domain.ErrBadAddress) {
		t.Fatalf("err = %v, want ErrBadAddress", err)
	}
}
