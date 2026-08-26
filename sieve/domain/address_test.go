package domain

import (
	"errors"
	"net/url"
	"strings"
	"testing"
)

const (
	cUUID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
	bUUID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a99"
	dUUID = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4b77"
)

func TestParseAddress_RoundTrip(t *testing.T) {
	for _, s := range []string{
		"sieve://" + cUUID,
		"sieve://" + cUUID + "?version=7",
		"sieve://" + cUUID + "/" + bUUID,
		"sieve://" + cUUID + "/" + bUUID + "?version=7",
		"sieve://" + cUUID + "/the-retry-loop",
		"sieve://" + cUUID + "/diagram.png",
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
	a, err := ParseAddress("sieve://" + cUUID + "/the-retry-loop?version=7")
	if err != nil {
		t.Fatal(err)
	}
	if a.Container != cUUID || a.Leaf != "the-retry-loop" || a.Version != 7 {
		t.Fatalf("fields: %+v", a)
	}
	if !a.IsPinned() {
		t.Fatal("IsPinned() false for ?version=7")
	}
	if a.IsContainer() {
		t.Fatal("IsContainer() true for an address naming a leaf")
	}
}

func TestParseAddress_ContainerHasNoLeaf(t *testing.T) {
	a, err := ParseAddress("sieve://" + cUUID)
	if err != nil {
		t.Fatal(err)
	}
	if !a.IsContainer() {
		t.Fatal("IsContainer() false for a bare container address")
	}
	if a.Leaf != "" {
		t.Fatalf("container address invented a leaf: %q", a.Leaf)
	}
	if a.IsPinned() {
		t.Fatal("unpinned address reported as pinned")
	}
}

// The authority is canonicalised through ident.Canonical. net/url does not fold
// an authority, so an uppercase spelling would parse, be persisted by String(),
// and then miss the lowercase-named document directory at load.
func TestParseAddress_CanonicalisesTheAuthority(t *testing.T) {
	a, err := ParseAddress("sieve://" + strings.ToUpper(cUUID))
	if err != nil {
		t.Fatal(err)
	}
	if a.Container != cUUID {
		t.Fatalf("container = %q, want the canonical lowercase spelling", a.Container)
	}
	if want := "sieve://" + cUUID; a.String() != want {
		t.Fatalf("String() = %q, want %q", a.String(), want)
	}
}

// THE TRAP: a leaf is NEVER case-folded in storage. An asset key is a filename on
// a case-sensitive filesystem, so a folded leaf reaches a store lookup — or a
// served asset URL — in a spelling the file does not have. Folding only the
// uuid-shaped leaves would be worse: it would mean the parser deciding what a
// leaf is from its shape, which is the container's judgement at lookup.
//
// The true spelling is stored and comparison folds instead; see
// TestAddress_EqualFoldsCase.
func TestParseAddress_LeavesTheLeafVerbatim(t *testing.T) {
	for _, leaf := range []string{
		"README.md",
		"Design Notes.md",
		"The-Retry-Loop",
		strings.ToUpper(bUUID),
	} {
		t.Run(leaf, func(t *testing.T) {
			a, err := ParseAddress("sieve://" + cUUID + "/" + url.PathEscape(leaf))
			if err != nil {
				t.Fatal(err)
			}
			if a.Leaf != leaf {
				t.Fatalf("leaf = %q, want %q verbatim", a.Leaf, leaf)
			}
			if round, err := ParseAddress(a.String()); err != nil || round.Leaf != leaf {
				t.Fatalf("round trip: leaf = %q, err = %v; want %q", round.Leaf, err, leaf)
			}
		})
	}
}

// One container has one identity, however its uuid was written.
func TestParseAddress_TwoSpellingsOfOneContainerAreEqual(t *testing.T) {
	shouty, err := ParseAddress("sieve://" + strings.ToUpper(cUUID))
	if err != nil {
		t.Fatal(err)
	}
	quiet, err := ParseAddress("sieve://" + cUUID)
	if err != nil {
		t.Fatal(err)
	}
	if !shouty.Equal(quiet) {
		t.Fatalf("%+v != %+v — one container must have one identity", shouty, quiet)
	}
}

func TestParseAddress_Rejects(t *testing.T) {
	for _, s := range []string{
		"",
		"sieve://",
		"sieve:" + cUUID,  // no // authority
		"sieve:/" + cUUID, // still no authority
		"block:" + bUUID,  // the retired grammar does not parse forever
		"container:" + cUUID,
		"block:" + cUUID + "/the-retry-loop",
		"thing://" + cUUID, // the scheme names shape, not service
		"https://example.com",
		"sieve://not-a-uuid",
		"sieve://" + cUUID + ":8080",                // port
		"sieve://user@" + cUUID,                     // userinfo
		"sieve://" + cUUID + "#frag",                // fragment
		"sieve://" + cUUID + "/a/b",                 // more than one leaf segment
		"sieve://" + cUUID + "/",                    // a trailing slash names no leaf
		"sieve://" + cUUID + "?",                    // a query delimiter naming no parameter
		"sieve://" + cUUID + "?version=0",           // 0 is the live sentinel
		"sieve://" + cUUID + "?version=-1",          //
		"sieve://" + cUUID + "?version=x",           //
		"sieve://" + cUUID + "?version=1&version=2", // a repeated pin has no meaning
		"sieve://" + cUUID + "?v=3",                 // the pin is spelled in full
		"sieve://" + cUUID + "?version=3&mode=raw",  // no other parameter is admitted
		"/" + bUUID,                                 // relative — that is ResolveAddress's question
		bUUID,
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

func TestResolveAddress_RelativeLeaf(t *testing.T) {
	base := NewContainerAddress(cUUID)
	got, err := ResolveAddress("/"+bUUID, base)
	if err != nil {
		t.Fatal(err)
	}
	if want := NewLeafAddress(cUUID, bUUID); !got.Equal(want) {
		t.Fatalf("resolved %+v, want %+v", got, want)
	}
}

func TestResolveAddress_RelativeRefDropsTheBasePin(t *testing.T) {
	base, err := ParseAddress("sieve://" + cUUID + "?version=7")
	if err != nil {
		t.Fatal(err)
	}
	got, err := ResolveAddress("/"+bUUID, base)
	if err != nil {
		t.Fatal(err)
	}
	// RFC 3986: a ref carrying a path replaces the base's query. A leaf written
	// inside a frozen container still means the live leaf unless it says otherwise.
	if got.IsPinned() {
		t.Fatalf("relative ref inherited the base pin: %+v", got)
	}
	if got.String() != "sieve://"+cUUID+"/"+bUUID {
		t.Fatalf("resolved to %q", got.String())
	}
}

func TestResolveAddress_RelativeRefMayPinItself(t *testing.T) {
	got, err := ResolveAddress("/"+bUUID+"?version=3", NewContainerAddress(cUUID))
	if err != nil {
		t.Fatal(err)
	}
	if got.Version != 3 {
		t.Fatalf("ref's own pin lost: %+v", got)
	}
}

func TestResolveAddress_AbsoluteRefIgnoresTheBase(t *testing.T) {
	base, err := ParseAddress("sieve://" + cUUID + "?version=7")
	if err != nil {
		t.Fatal(err)
	}
	got, err := ResolveAddress("sieve://"+dUUID+"/"+bUUID, base)
	if err != nil {
		t.Fatal(err)
	}
	if want := NewLeafAddress(dUUID, bUUID); !got.Equal(want) {
		t.Fatalf("absolute ref resolved to %+v, want %+v", got, want)
	}
}

func TestResolveAddress_Rejects(t *testing.T) {
	base := NewContainerAddress(cUUID)
	for name, tc := range map[string]struct {
		ref  string
		base Address
	}{
		"zero base":         {ref: "/" + bUUID, base: Address{}},
		"empty ref":         {ref: "   ", base: base},
		"two segments":      {ref: "/a/b", base: base},
		"trailing slash":    {ref: "/", base: base},
		"foreign scheme":    {ref: "https://example.com/x", base: base},
		"retired grammar":   {ref: "block:" + bUUID, base: base},
		"bad absolute ref":  {ref: "sieve://not-a-uuid/x", base: base},
		"unknown query":     {ref: "/" + bUUID + "?v=3", base: base},
		"zero version":      {ref: "/" + bUUID + "?version=0", base: base},
		"fragment":          {ref: "/" + bUUID + "#frag", base: base},
		"escapes the leaf":  {ref: "/a%2Fb", base: base},
		"climbs to no host": {ref: "//not-a-uuid/x", base: base},
	} {
		t.Run(name, func(t *testing.T) {
			a, err := ResolveAddress(tc.ref, tc.base)
			if err == nil {
				t.Fatalf("ResolveAddress(%q) accepted: %+v", tc.ref, a)
			}
			if !errors.Is(err, ErrBadAddress) {
				t.Fatalf("err = %v, want it to wrap ErrBadAddress", err)
			}
		})
	}
}

func TestNewContainerAddress_EmitsTheLiveContainerForm(t *testing.T) {
	got := NewContainerAddress("  " + cUUID + "  ").String()
	if got != "sieve://"+cUUID {
		t.Fatalf("String() = %q, want the bare container form", got)
	}
	if _, err := ParseAddress(got); err != nil {
		t.Fatalf("the constructor emitted something the grammar rejects: %v", err)
	}
}

func TestNewLeafAddress_EmitsTheLiveLeafForm(t *testing.T) {
	got := NewLeafAddress("  "+cUUID+"  ", "  "+bUUID+"  ").String()
	if got != "sieve://"+cUUID+"/"+bUUID {
		t.Fatalf("String() = %q, want the live leaf form", got)
	}
	if _, err := ParseAddress(got); err != nil {
		t.Fatalf("the constructor emitted something the grammar rejects: %v", err)
	}
}

// "Case never distinguishes two Sieve coordinates" must hold on EVERY path that
// produces an Address, not only the parser's: a constructor fed a mis-cased uuid
// would otherwise emit an uppercase String() straight into a store lookup that
// misses the lowercase-named document directory.
func TestConstructors_CanonicaliseTheAuthority(t *testing.T) {
	shouty := strings.ToUpper(cUUID)

	container := NewContainerAddress("  " + shouty + "  ")
	if container.Container != cUUID {
		t.Fatalf("NewContainerAddress container = %q, want the canonical spelling", container.Container)
	}
	if want := "sieve://" + cUUID; container.String() != want {
		t.Fatalf("NewContainerAddress String() = %q, want %q", container.String(), want)
	}
	parsedContainer, err := ParseAddress("sieve://" + cUUID)
	if err != nil {
		t.Fatal(err)
	}
	if !container.Equal(parsedContainer) {
		t.Fatalf("%+v != %+v — constructed and parsed must agree", container, parsedContainer)
	}

	leaf := NewLeafAddress("  "+shouty+"  ", "  README.md  ")
	if leaf.Container != cUUID {
		t.Fatalf("NewLeafAddress container = %q, want the canonical spelling", leaf.Container)
	}
	if want := "sieve://" + cUUID + "/README.md"; leaf.String() != want {
		t.Fatalf("NewLeafAddress String() = %q, want %q", leaf.String(), want)
	}
	parsedLeaf, err := ParseAddress("sieve://" + cUUID + "/README.md")
	if err != nil {
		t.Fatal(err)
	}
	if !leaf.Equal(parsedLeaf) {
		t.Fatalf("%+v != %+v — constructed and parsed must agree", leaf, parsedLeaf)
	}
	// The leaf is NOT folded by the constructor either — only trimmed.
	if leaf.Leaf != "README.md" {
		t.Fatalf("leaf = %q, want its case preserved", leaf.Leaf)
	}
}

// The constructors are total and validate nothing, so the round-trip guarantee
// is the PARSER's alone. This pins where it stops: a leaf carrying "/" — which
// nothing legitimate produces, since block ids are uuids and asset keys are bare
// filenames — emits a string the grammar refuses.
func TestNewLeafAddress_ASlashInTheLeafEmitsSomethingTheGrammarRejects(t *testing.T) {
	got := NewLeafAddress(cUUID, "docs/api.yaml").String()
	if got != "sieve://"+cUUID+"/docs/api.yaml" {
		t.Fatalf("String() = %q", got)
	}
	if _, err := ParseAddress(got); !errors.Is(err, ErrBadAddress) {
		t.Fatalf("err = %v, want ErrBadAddress", err)
	}
}

func TestAddress_ContainerAddressKeepsThePin(t *testing.T) {
	a, err := ParseAddress("sieve://" + cUUID + "/the-retry-loop?version=7")
	if err != nil {
		t.Fatal(err)
	}
	c := a.ContainerAddress()
	if !c.IsContainer() {
		t.Fatal("ContainerAddress kept the leaf")
	}
	if c.Version != 7 {
		t.Fatalf("ContainerAddress dropped the pin: %+v", c)
	}
	if c.String() != "sieve://"+cUUID+"?version=7" {
		t.Fatalf("String() = %q", c.String())
	}
}

func TestAddress_Equal(t *testing.T) {
	leaf, _ := ParseAddress("sieve://" + cUUID + "/" + bUUID)
	same, _ := ParseAddress("sieve://" + cUUID + "/" + bUUID)
	frozen, _ := ParseAddress("sieve://" + cUUID + "/" + bUUID + "?version=7")
	otherFrozen, _ := ParseAddress("sieve://" + cUUID + "/" + bUUID + "?version=3")
	elsewhere, _ := ParseAddress("sieve://" + dUUID + "/" + bUUID)
	container, _ := ParseAddress("sieve://" + cUUID)

	if !leaf.Equal(same) {
		t.Fatal("identical leaf addresses must be equal")
	}
	if leaf.Equal(frozen) {
		t.Fatal("live and frozen must not be equal")
	}
	if frozen.Equal(otherFrozen) {
		t.Fatal("different pins must not be equal")
	}
	if leaf.Equal(elsewhere) {
		t.Fatal("the same leaf name in two containers is two different things")
	}
	if container.Equal(leaf) {
		t.Fatal("a container and a leaf inside it are not the same thing")
	}
}

// Case never distinguishes two Sieve coordinates. The authority is canonicalised
// by the parser and the leaf is folded here, because the leaf's true spelling is
// load-bearing for the URLs built from it.
func TestAddress_EqualFoldsCase(t *testing.T) {
	base, err := ParseAddress("sieve://" + cUUID + "/Design Notes.md")
	if err != nil {
		t.Fatal(err)
	}

	shoutyLeaf, err := ParseAddress("sieve://" + cUUID + "/DESIGN NOTES.MD")
	if err != nil {
		t.Fatal(err)
	}
	if !base.Equal(shoutyLeaf) {
		t.Fatalf("%+v != %+v — leaf case must not distinguish two coordinates", base, shoutyLeaf)
	}
	// Folded for identity, verbatim in storage: both spellings survive intact.
	if base.Leaf == shoutyLeaf.Leaf {
		t.Fatal("the two leaves were normalised to one spelling; they must stay verbatim")
	}

	shoutyAuthority, err := ParseAddress("sieve://" + strings.ToUpper(cUUID) + "/Design Notes.md")
	if err != nil {
		t.Fatal(err)
	}
	if !base.Equal(shoutyAuthority) {
		t.Fatalf("%+v != %+v — authority case must not distinguish two coordinates", base, shoutyAuthority)
	}

	// The pin is the one field case has nothing to say about.
	pinned, err := ParseAddress("sieve://" + cUUID + "/Design Notes.md?version=2")
	if err != nil {
		t.Fatal(err)
	}
	if base.Equal(pinned) {
		t.Fatal("a live address and a pinned one are different coordinates")
	}
	otherPin, err := ParseAddress("sieve://" + cUUID + "/DESIGN NOTES.MD?version=3")
	if err != nil {
		t.Fatal(err)
	}
	if pinned.Equal(otherPin) {
		t.Fatal("different pins must not be equal, whatever the leaf case")
	}
}

func TestAddress_EqualComparesNamedLeaves(t *testing.T) {
	// A name is unique within its container, and every address carries its
	// container, so a named leaf compares like any other.
	named, _ := ParseAddress("sieve://" + cUUID + "/the-retry-loop")
	same, _ := ParseAddress("sieve://" + cUUID + "/the-retry-loop")
	other, _ := ParseAddress("sieve://" + cUUID + "/the-other-loop")

	if !named.Equal(same) {
		t.Fatal("two spellings of the same named leaf must be equal")
	}
	if named.Equal(other) {
		t.Fatal("two different names must not be equal")
	}
}
