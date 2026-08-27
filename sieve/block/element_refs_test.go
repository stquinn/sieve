package block

import (
	"strings"
	"testing"
)

// fakeParentProc is a fake block-mode kind whose payload holds elements — the
// BlockParent capability, without reaching across into the processors package
// for the one real implementor.
type fakeParentProc struct{ fakeProc }

func newFakeParentProc(kind string) *fakeParentProc {
	return &fakeParentProc{fakeProc{FencedDeserializer: FencedDeserializer{Kind: kind}}}
}

func (p *fakeParentProc) Children(blk *SieveBlock) []*SieveBlock {
	return blk.Elements(QuestionAttr)
}

// registerParentKind installs the parent kind for one test and takes it back out
// again — the registry is package-global.
func registerParentKind(t *testing.T, kind string) {
	t.Helper()
	RegisterProcessor(newFakeParentProc(kind))
	t.Cleanup(func() { UnregisterProcessor(kind) })
}

const (
	elemDocUUID     = "0197b1f4-1111-7000-8000-00000000aaaa"
	elemOtherUUID   = "0197b1f4-2222-7000-8000-00000000bbbb"
	elemTargetBlock = "0197b1f4-3333-7000-8000-00000000cccc"
	elemSecondBlock = "0197b1f4-4444-7000-8000-00000000dddd"
)

// element builds one stored element entry in the persisted encoding.
func element(kind string, attrs map[string]interface{}) map[string]interface{} {
	return map[string]interface{}{"kind": kind, "attrs": attrs}
}

// parentBlock builds a block of the parent kind holding the given elements.
func parentBlock(kind string, elements ...interface{}) SieveBlock {
	return SieveBlock{ID: "parent-1", Kind: kind, Attrs: map[string]interface{}{
		"id":         "parent-1",
		QuestionAttr: elements,
	}}
}

// A parent's outgoing edges are the LOCAL, BLOCK-GRAIN reference elements its
// payload holds: kind plus address facts decide, and nothing else does.
func TestOutgoingRefs_HarvestsLocalBlockGrainElements(t *testing.T) {
	registerParentKind(t, "fk-parent")

	b := parentBlock("fk-parent",
		element("reference", map[string]interface{}{"uri": "sieve://" + elemDocUUID + "/" + elemTargetBlock}),
		element("prose", map[string]interface{}{"content": "what does this mean?"}),
		element("reference", map[string]interface{}{"uri": "sieve://" + elemDocUUID + "/" + elemSecondBlock}),
	)

	got := b.outgoingRefs(elemDocUUID)
	if want := elemTargetBlock + "," + elemSecondBlock; strings.Join(got, ",") != want {
		t.Fatalf("outgoingRefs = %v, want %q in element order", got, want)
	}
}

// Everything a leaf address in THIS container is not: the whole container, a
// leaf somewhere else, a frozen snapshot, a non-reference element, and an
// address that is not one.
func TestOutgoingRefs_RejectsEverythingButALocalLeaf(t *testing.T) {
	registerParentKind(t, "fk-parent")

	cases := []struct {
		name string
		el   map[string]interface{}
	}{
		{"own container", element("reference", map[string]interface{}{"uri": "sieve://" + elemDocUUID})},
		{"another container", element("reference", map[string]interface{}{"uri": "sieve://" + elemOtherUUID})},
		{"a leaf elsewhere", element("reference", map[string]interface{}{"uri": "sieve://" + elemOtherUUID + "/" + elemTargetBlock})},
		{"a frozen local leaf", element("reference", map[string]interface{}{"uri": "sieve://" + elemDocUUID + "/" + elemTargetBlock + "?version=3"})},
		{"a prose element", element("prose", map[string]interface{}{"content": elemTargetBlock})},
		{"an unparseable uri", element("reference", map[string]interface{}{"uri": "not-an-address"})},
		{"no uri at all", element("reference", map[string]interface{}{})},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := parentBlock("fk-parent", tc.el).outgoingRefs(elemDocUUID); len(got) != 0 {
				t.Fatalf("outgoingRefs = %v, want none — %s is not a local block edge", got, tc.name)
			}
		})
	}
}

// A block whose kind holds no elements answers exactly what its `ref` attr says,
// so GC behaviour for every other kind is untouched.
func TestOutgoingRefs_NonParentKindReadsOnlyTheRefAttr(t *testing.T) {
	registerParentKind(t, "fk-parent")

	b := SieveBlock{ID: "co-1", Kind: "code", Attrs: map[string]interface{}{
		"ref": "pr-a, pr-b",
		QuestionAttr: []interface{}{
			element("reference", map[string]interface{}{"uri": "sieve://" + elemDocUUID + "/" + elemTargetBlock}),
		},
	}}

	if got := b.outgoingRefs(elemDocUUID); strings.Join(got, ",") != "pr-a,pr-b" {
		t.Fatalf("outgoingRefs = %v, want the ref attr alone — code holds no elements", got)
	}
}

// With no container to recognise a local address against, an element edge cannot
// be classified, so none is claimed.
func TestOutgoingRefs_NoContainerClaimsNoElementEdge(t *testing.T) {
	registerParentKind(t, "fk-parent")

	b := parentBlock("fk-parent",
		element("reference", map[string]interface{}{"uri": "sieve://" + elemDocUUID + "/" + elemTargetBlock}),
	)
	if got := b.outgoingRefs(""); len(got) != 0 {
		t.Fatalf("outgoingRefs = %v, want none without a naming authority", got)
	}
}

// The GC prunes element edges exactly as it prunes ref-attr ones.
func TestGCRefs_PrunesDanglingElementEdges(t *testing.T) {
	registerParentKind(t, "fk-parent")

	b := parentBlock("fk-parent",
		element("reference", map[string]interface{}{"uri": "sieve://" + elemDocUUID + "/" + elemTargetBlock}),
		element("reference", map[string]interface{}{"uri": "sieve://" + elemDocUUID + "/" + elemSecondBlock}),
		element("reference", map[string]interface{}{"uri": "sieve://" + elemDocUUID + "/" + elemTargetBlock}),
	)

	got := b.gcRefs(elemDocUUID, map[string]bool{elemTargetBlock: true})
	if strings.Join(got, ",") != elemTargetBlock {
		t.Fatalf("gcRefs = %v, want [%s] — dangling dropped, duplicate deduped", got, elemTargetBlock)
	}
}

// Elements are not addressable: they live inside their parent and nowhere else,
// so no document-level handle resolves to one.
func TestAnswersTo_ElementIDsAreNotHandles(t *testing.T) {
	registerParentKind(t, "fk-parent")

	b := parentBlock("fk-parent",
		element("prose", map[string]interface{}{"id": "element-prose", "content": "hi"}),
		element("reference", map[string]interface{}{"id": "element-ref", "uri": "sieve://" + elemDocUUID + "/" + elemTargetBlock}),
	)
	b.Aliases = []string{"named"}

	got := b.answersTo()
	if strings.Join(got, ",") != "parent-1,named" {
		t.Fatalf("answersTo = %v, want the block's own handles only", got)
	}

	sd := ShadowDocument{Blocks: []SieveBlock{b}}
	handles := sd.collectHandles()
	for _, id := range []string{"element-prose", "element-ref"} {
		if handles[id] {
			t.Fatalf("collectHandles indexed element id %q — an element is not addressable", id)
		}
	}
}

// rewriteRefs upgrades the legacy `ref` attr, whose inverse is withRefs. It must
// never answer an element edge by writing a `ref` attr back onto a parent, which
// would resurrect the form the question list replaced.
func TestBlockIdentityMigrator_LeavesAParentsRefAttrAbsent(t *testing.T) {
	registerParentKind(t, "fk-parent")

	legacy := SieveBlock{ID: "pr-a", Kind: KindProse, Attrs: map[string]interface{}{"id": "pr-a"}}
	parent := parentBlock("fk-parent",
		element("reference", map[string]interface{}{"uri": "sieve://" + elemDocUUID + "/pr-a"}),
	)

	out, _ := BlockIdentityMigrator{}.Migrate([]SieveBlock{legacy, parent})

	if _, present := out[1].Attrs["ref"]; present {
		t.Fatalf("a parent grew a ref attr: %#v", out[1].Attrs["ref"])
	}
}
