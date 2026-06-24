package processors

import (
	"sieve/sieve/block"
	"testing"
)

// NewSieveBlock is the sole sanctioned construction point for a block: it mints an
// id when none is given, so the invariant "a block never exists without an id"
// is owned in ONE place rather than swept after the fact. (Go has no enforced
// constructors; this factory + the serialize-time guard are the idiomatic teeth.)
func TestNewSieveBlock_MintsWhenNoID(t *testing.T) {
	b := block.NewSieveBlock(block.KindProse, "", map[string]interface{}{"content": "hello"})
	if b.ID == "" {
		t.Fatalf("expected a minted id, got empty")
	}
	if b.Kind != block.KindProse || b.Content() != "hello" {
		t.Fatalf("unexpected block: %+v", b)
	}
}

func TestNewSieveBlock_KeepsGivenID(t *testing.T) {
	b := block.NewSieveBlock(block.KindProse, "pr-given", map[string]interface{}{"content": "hi"})
	if b.ID != "pr-given" {
		t.Fatalf("id = %q, want the supplied %q", b.ID, "pr-given")
	}
}

// The serializer is the persistence boundary: it must REFUSE to write an id-less
// block (the runtime backstop behind the factory). A block built by a rogue path
// that bypassed the factory can never reach disk silently.
func TestSerialize_RefusesIdlessProse(t *testing.T) {
	doc := []block.SieveBlock{{Kind: block.KindProse, Attrs: map[string]interface{}{"content": "x"}}} // bypasses the factory
	if _, err := block.NewDocumentCodec(block.GlobalRegistry()).Serialize(doc); err == nil {
		t.Fatalf("expected an error refusing to persist an id-less prose block")
	}
}

func TestParseBlockDoc_ProseAndFence(t *testing.T) {
	block.RegisterProcessor(NewCodeBlockProcessor(block.BlockServices{}))
	t.Cleanup(func() { block.UnregisterProcessor("code") })

	md := "Hello.\n\n```code\nid: co-1\nsource: x = 1\n```\n\nWorld."
	doc, err := block.NewDocumentCodec(block.GlobalRegistry()).Deserialize(md)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(doc) != 3 {
		t.Fatalf("want 3 blocks, got %d: %+v", len(doc), doc)
	}
	if doc[0].Kind != block.KindProse || doc[0].Content() != "Hello." {
		t.Fatalf("block 0: %+v", doc[0])
	}
	if doc[1].Kind != "code" || doc[1].ID != "co-1" {
		t.Fatalf("block 1: %+v", doc[1])
	}
	if doc[2].Kind != block.KindProse || doc[2].Content() != "World." {
		t.Fatalf("block 2: %+v", doc[2])
	}
}

// A structured fence separates undelimited prose runs, but blank lines WITHIN a
// run never split it: each maximal run between fences is one prose block (D.4 —
// whitespace is parse-meaningless). Multi-paragraph content stays verbatim.
func TestParseBlockDoc_UndelimitedRunsBetweenFences(t *testing.T) {
	block.RegisterProcessor(NewCodeBlockProcessor(block.BlockServices{}))
	t.Cleanup(func() { block.UnregisterProcessor("code") })

	md := "# Title\n\nIntro prose.\n\n```code\nid: co-1\nsource: x = 1\n```\n\nFirst tail.\n\nSecond tail."
	doc, err := block.NewDocumentCodec(block.GlobalRegistry()).Deserialize(md)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	wantKinds := []struct {
		kind    string
		content string
	}{
		{block.KindProse, "# Title\n\nIntro prose."},
		{"code", ""},
		{block.KindProse, "First tail.\n\nSecond tail."},
	}
	if len(doc) != len(wantKinds) {
		t.Fatalf("want %d blocks, got %d: %+v", len(wantKinds), len(doc), doc)
	}
	for i, w := range wantKinds {
		if doc[i].Kind != w.kind {
			t.Fatalf("block %d kind: want %q got %q", i, w.kind, doc[i].Kind)
		}
		if w.kind == block.KindProse && doc[i].Content() != w.content {
			t.Fatalf("block %d content: want %q got %q", i, w.content, doc[i].Content())
		}
	}
}

func TestBlockDoc_RoundTripStable(t *testing.T) {
	block.RegisterProcessor(NewCodeBlockProcessor(block.BlockServices{}))
	t.Cleanup(func() { block.UnregisterProcessor("code") })

	// Each prose block is a single paragraph so per-paragraph segmentation
	// (Stage B.1) preserves the block count through the round-trip. Only kinds
	// with a registered processor (prose, code) stay structured through the codec;
	// processor-less kinds coalesce to prose, so they are not exercised here.
	doc := []block.SieveBlock{
		(ProseProcessor{}).newProseBlock("pr-1", "# Title"),
		block.NewSieveBlock("code", "co-1", map[string]interface{}{"id": "co-1", "source": "x = 1"}),
		(ProseProcessor{}).newProseBlock("pr-2", "Between."),
		(ProseProcessor{}).newProseBlock("pr-3", "Tail."),
	}

	c := block.NewDocumentCodec(block.GlobalRegistry())
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
