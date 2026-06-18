package sieve

import "testing"

func TestBlockDocToFrontendBlocks_ProseAndStructured(t *testing.T) {
	doc := BlockDoc{Blocks: []DocBlock{
		{ID: "pr-1", Kind: KindProse, Content: "Hello **world**.", Aliases: []string{"pr-0"}},
		{ID: "co-1", Kind: "code", Attrs: map[string]interface{}{"id": "co-1", "source": "x = 1"}},
		{Kind: KindProse, Content: "Tail."},
	}}

	fbs, err := BlockDocToFrontendBlocks(doc)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}
	if len(fbs) != 3 {
		t.Fatalf("want 3 frontend blocks, got %d: %+v", len(fbs), fbs)
	}

	// Prose carries Content + handle + aliases; no fence text.
	if fbs[0].Kind != KindProse || fbs[0].ID != "pr-1" || fbs[0].Content != "Hello **world**." {
		t.Fatalf("prose block 0: %+v", fbs[0])
	}
	if len(fbs[0].Aliases) != 1 || fbs[0].Aliases[0] != "pr-0" {
		t.Fatalf("prose block 0 aliases: %+v", fbs[0].Aliases)
	}
	if fbs[0].SerialisedForm != "" {
		t.Fatalf("prose block 0 should have no serialised form: %q", fbs[0].SerialisedForm)
	}

	// Structured carries the fence text in SerialisedForm; no prose content.
	if fbs[1].Kind != "code" || fbs[1].ID != "co-1" {
		t.Fatalf("structured block 1: %+v", fbs[1])
	}
	if fbs[1].Content != "" {
		t.Fatalf("structured block 1 should have no content: %q", fbs[1].Content)
	}
	want := "```code\nid: co-1\nsource: x = 1\n```"
	if fbs[1].SerialisedForm != want {
		t.Fatalf("structured block 1 serialised form:\n got: %q\nwant: %q", fbs[1].SerialisedForm, want)
	}

	// Handle-less prose still converts (positional id is empty for now).
	if fbs[2].Kind != KindProse || fbs[2].ID != "" || fbs[2].Content != "Tail." {
		t.Fatalf("prose block 2: %+v", fbs[2])
	}
}

// Structured blocks travel as their PROPERTIES (Attrs), not just a fence string —
// the block model is properties-in/properties-out, so the client renders the
// NodeView straight from attrs (no markdown re-parse). Prose carries no attrs.
func TestBlockDocToFrontendBlocks_StructuredCarriesAttrs(t *testing.T) {
	doc := BlockDoc{Blocks: []DocBlock{
		{ID: "co-1", Kind: "code", Attrs: map[string]interface{}{"id": "co-1", "source": "x = 1"}},
		{ID: "pr-1", Kind: KindProse, Content: "Prose."},
	}}
	fbs, err := BlockDocToFrontendBlocks(doc)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}
	if fbs[0].Attrs == nil || fbs[0].Attrs["source"] != "x = 1" || fbs[0].Attrs["id"] != "co-1" {
		t.Fatalf("structured block must carry attrs: %+v", fbs[0].Attrs)
	}
	if fbs[1].Attrs != nil {
		t.Fatalf("prose block must not carry attrs: %+v", fbs[1].Attrs)
	}
}
