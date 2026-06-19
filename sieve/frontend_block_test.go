package sieve

import "testing"

func TestBlockDocToFrontendBlocks_ProseAndStructured(t *testing.T) {
	doc := BlockDoc{Blocks: []DocBlock{
		{ID: "pr-1", Kind: KindProse, Attrs: map[string]interface{}{"content": "Hello **world**."}, Aliases: []string{"pr-0"}},
		{ID: "co-1", Kind: "code", Attrs: map[string]interface{}{"id": "co-1", "source": "x = 1"}},
		{Kind: KindProse, Attrs: map[string]interface{}{"content": "Tail."}},
	}}

	fbs, err := BlockDocToFrontendBlocks(doc)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}
	if len(fbs) != 3 {
		t.Fatalf("want 3 frontend blocks, got %d: %+v", len(fbs), fbs)
	}

	// Prose carries its body in Attrs["content"] + handle + aliases; no fence text.
	if fbs[0].Kind != KindProse || fbs[0].ID != "pr-1" || fbs[0].Attrs["content"] != "Hello **world**." {
		t.Fatalf("prose block 0: %+v", fbs[0])
	}
	if len(fbs[0].Aliases) != 1 || fbs[0].Aliases[0] != "pr-0" {
		t.Fatalf("prose block 0 aliases: %+v", fbs[0].Aliases)
	}
	if fbs[0].SerialisedForm != "" {
		t.Fatalf("prose block 0 should have no serialised form: %q", fbs[0].SerialisedForm)
	}

	// Structured carries the fence text in SerialisedForm; no content attr.
	if fbs[1].Kind != "code" || fbs[1].ID != "co-1" {
		t.Fatalf("structured block 1: %+v", fbs[1])
	}
	if fbs[1].Attrs["content"] != nil {
		t.Fatalf("structured block 1 should have no content attr: %v", fbs[1].Attrs["content"])
	}
	want := "```code\nid: co-1\nsource: x = 1\n```"
	if fbs[1].SerialisedForm != want {
		t.Fatalf("structured block 1 serialised form:\n got: %q\nwant: %q", fbs[1].SerialisedForm, want)
	}

	// Handle-less prose still converts (positional id is empty for now).
	if fbs[2].Kind != KindProse || fbs[2].ID != "" || fbs[2].Attrs["content"] != "Tail." {
		t.Fatalf("prose block 2: %+v", fbs[2])
	}
}

// Every block travels as its PROPERTIES (Attrs) — uniform shape. Structured
// blocks carry their YAML props; prose carries its body at Attrs["content"]. The
// client renders the right thing by KIND, not by which field holds the payload.
func TestBlockDocToFrontendBlocks_StructuredCarriesAttrs(t *testing.T) {
	doc := BlockDoc{Blocks: []DocBlock{
		{ID: "co-1", Kind: "code", Attrs: map[string]interface{}{"id": "co-1", "source": "x = 1"}},
		{ID: "pr-1", Kind: KindProse, Attrs: map[string]interface{}{"content": "Prose."}},
	}}
	fbs, err := BlockDocToFrontendBlocks(doc)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}
	if fbs[0].Attrs == nil || fbs[0].Attrs["source"] != "x = 1" || fbs[0].Attrs["id"] != "co-1" {
		t.Fatalf("structured block must carry attrs: %+v", fbs[0].Attrs)
	}
	if fbs[1].Attrs == nil || fbs[1].Attrs["content"] != "Prose." {
		t.Fatalf("prose block must carry its body in Attrs[content]: %+v", fbs[1].Attrs)
	}
}
