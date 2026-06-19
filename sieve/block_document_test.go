package sieve

import "testing"

// newSieveBlock is the sole sanctioned construction point for a block: it mints an
// id when none is given, so the invariant "a block never exists without an id"
// is owned in ONE place rather than swept after the fact. (Go has no enforced
// constructors; this factory + the serialize-time guard are the idiomatic teeth.)
func TestNewSieveBlock_MintsWhenNoID(t *testing.T) {
	b := newSieveBlock(KindProse, "", "hello", nil)
	if b.ID == "" {
		t.Fatalf("expected a minted id, got empty")
	}
	if b.Kind != KindProse || b.Content() != "hello" {
		t.Fatalf("unexpected block: %+v", b)
	}
}

func TestNewSieveBlock_KeepsGivenID(t *testing.T) {
	b := newSieveBlock(KindProse, "pr-given", "hi", nil)
	if b.ID != "pr-given" {
		t.Fatalf("id = %q, want the supplied %q", b.ID, "pr-given")
	}
}

// The serializer is the persistence boundary: it must REFUSE to write an id-less
// block (the runtime backstop behind the factory). A block built by a rogue path
// that bypassed the factory can never reach disk silently.
func TestSerializeBlockDocWithHandles_RefusesIdlessProse(t *testing.T) {
	doc := []SieveBlock{{Kind: KindProse, Attrs: map[string]interface{}{"content": "x"}}} // bypasses the factory
	if _, err := SerializeBlockDocWithHandles(doc); err == nil {
		t.Fatalf("expected an error refusing to persist an id-less prose block")
	}
}

func TestParseBlockDoc_ProseAndFence(t *testing.T) {
	RegisterProcessor("code", NewCodeBlockProcessor(BlockServices{}))
	t.Cleanup(func() { UnregisterProcessor("code") })

	md := "Hello.\n\n```code\nid: co-1\nsource: x = 1\n```\n\nWorld."
	doc, err := ParseBlockDocWithHandles(md)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(doc) != 3 {
		t.Fatalf("want 3 blocks, got %d: %+v", len(doc), doc)
	}
	if doc[0].Kind != KindProse || doc[0].Content() != "Hello." {
		t.Fatalf("block 0: %+v", doc[0])
	}
	if doc[1].Kind != "code" || doc[1].ID != "co-1" {
		t.Fatalf("block 1: %+v", doc[1])
	}
	if doc[2].Kind != KindProse || doc[2].Content() != "World." {
		t.Fatalf("block 2: %+v", doc[2])
	}
}

// A structured fence separates undelimited prose runs, but blank lines WITHIN a
// run never split it: each maximal run between fences is one prose block (D.4 —
// whitespace is parse-meaningless). Multi-paragraph content stays verbatim.
func TestParseBlockDoc_UndelimitedRunsBetweenFences(t *testing.T) {
	RegisterProcessor("code", NewCodeBlockProcessor(BlockServices{}))
	t.Cleanup(func() { UnregisterProcessor("code") })

	md := "# Title\n\nIntro prose.\n\n```code\nid: co-1\nsource: x = 1\n```\n\nFirst tail.\n\nSecond tail."
	doc, err := ParseBlockDocWithHandles(md)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	wantKinds := []struct {
		kind    string
		content string
	}{
		{KindProse, "# Title\n\nIntro prose."},
		{"code", ""},
		{KindProse, "First tail.\n\nSecond tail."},
	}
	if len(doc) != len(wantKinds) {
		t.Fatalf("want %d blocks, got %d: %+v", len(wantKinds), len(doc), doc)
	}
	for i, w := range wantKinds {
		if doc[i].Kind != w.kind {
			t.Fatalf("block %d kind: want %q got %q", i, w.kind, doc[i].Kind)
		}
		if w.kind == KindProse && doc[i].Content() != w.content {
			t.Fatalf("block %d content: want %q got %q", i, w.content, doc[i].Content())
		}
	}
}

func TestBlockDoc_RoundTripStable(t *testing.T) {
	RegisterProcessor("code", NewCodeBlockProcessor(BlockServices{}))
	t.Cleanup(func() { UnregisterProcessor("code") })

	// Each prose block is a single paragraph so per-paragraph segmentation
	// (Stage B.1) preserves the block count through the round-trip.
	// column-row has no registered processor — it round-trips via the codec's
	// fence-fallback (unclaimedFenceBlock), so no extra registration needed.
	doc := []SieveBlock{
		newSieveBlock(KindProse, "pr-1", "# Title", nil),
		newSieveBlock("code", "co-1", "", map[string]interface{}{"id": "co-1", "source": "x = 1"}),
		newSieveBlock(KindProse, "pr-2", "Between.", nil),
		newSieveBlock(KindColumnRow, "cr-1", "", map[string]interface{}{"id": "cr-1", "widths": []interface{}{0.5, 0.5}}),
		newSieveBlock(KindProse, "pr-3", "Tail.", nil),
	}

	c := NewDocumentCodec(globalRegistry())
	md1, err := c.Serialize(doc)
	if err != nil {
		t.Fatalf("serialize 1: %v", err)
	}
	parsed, err := c.Deserialize(md1)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(parsed) != len(doc) {
		t.Fatalf("block count drift: want %d got %d", len(doc), len(parsed))
	}
	md2, err := c.Serialize(parsed)
	if err != nil {
		t.Fatalf("serialize 2: %v", err)
	}
	if md1 != md2 {
		t.Fatalf("round-trip not stable:\n md1: %q\n md2: %q", md1, md2)
	}
}
