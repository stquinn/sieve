package sieve

import "testing"

func TestSerializeBlockDoc_ProseAndFence(t *testing.T) {
	doc := BlockDoc{Blocks: []DocBlock{
		{Kind: KindProse, Content: "Hello."},
		{ID: "co-1", Kind: "code", Attrs: map[string]interface{}{
			"id":     "co-1",
			"source": "x = 1",
		}},
	}}
	got, err := SerializeBlockDoc(doc)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	want := "Hello.\n\n```code\nid: co-1\nsource: x = 1\n```"
	if got != want {
		t.Fatalf("serialize mismatch:\n got: %q\nwant: %q", got, want)
	}
}

func TestParseBlockDoc_ProseAndFence(t *testing.T) {
	RegisterProcessor("code", &CodeBlockProcessor{})
	t.Cleanup(func() { UnregisterProcessor("code") })

	md := "Hello.\n\n```code\nid: co-1\nsource: x = 1\n```\n\nWorld."
	doc, err := ParseBlockDoc(md)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(doc.Blocks) != 3 {
		t.Fatalf("want 3 blocks, got %d: %+v", len(doc.Blocks), doc.Blocks)
	}
	if doc.Blocks[0].Kind != KindProse || doc.Blocks[0].Content != "Hello." {
		t.Fatalf("block 0: %+v", doc.Blocks[0])
	}
	if doc.Blocks[1].Kind != "code" || doc.Blocks[1].ID != "co-1" {
		t.Fatalf("block 1: %+v", doc.Blocks[1])
	}
	if doc.Blocks[2].Kind != KindProse || doc.Blocks[2].Content != "World." {
		t.Fatalf("block 2: %+v", doc.Blocks[2])
	}
}

func TestBlockDoc_RoundTripStable(t *testing.T) {
	RegisterProcessor("code", &CodeBlockProcessor{})
	t.Cleanup(func() { UnregisterProcessor("code") })
	RegisterProcessor("column-row", &CodeBlockProcessor{}) // any block-mode processor suffices for the parse gate
	t.Cleanup(func() { UnregisterProcessor("column-row") })

	doc := BlockDoc{Blocks: []DocBlock{
		{Kind: KindProse, Content: "# Title\n\nIntro prose."},
		{ID: "co-1", Kind: "code", Attrs: map[string]interface{}{"id": "co-1", "source": "x = 1"}},
		{Kind: KindProse, Content: "Between."},
		{ID: "cr-1", Kind: KindColumnRow, Attrs: map[string]interface{}{"id": "cr-1", "widths": []interface{}{0.5, 0.5}}},
		{Kind: KindProse, Content: "Tail."},
	}}

	md1, err := SerializeBlockDoc(doc)
	if err != nil {
		t.Fatalf("serialize 1: %v", err)
	}
	parsed, err := ParseBlockDoc(md1)
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if len(parsed.Blocks) != len(doc.Blocks) {
		t.Fatalf("block count drift: want %d got %d", len(doc.Blocks), len(parsed.Blocks))
	}
	md2, err := SerializeBlockDoc(parsed)
	if err != nil {
		t.Fatalf("serialize 2: %v", err)
	}
	if md1 != md2 {
		t.Fatalf("round-trip not stable:\n md1: %q\n md2: %q", md1, md2)
	}
}
