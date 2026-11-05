package block

import (
	"testing"

	"sieve/sieve/domain"
)

func TestBlockDocToFrontendBlocks_ProseAndStructured(t *testing.T) {
	doc := []domain.SieveBlock{
		{ID: "pr-1", Kind: KindProse, Attrs: map[string]interface{}{"content": "Hello **world**."}, Aliases: []string{"pr-0"}},
		{ID: "co-1", Kind: "code", Attrs: map[string]interface{}{"id": "co-1", "source": "x = 1"}},
		{Kind: KindProse, Attrs: map[string]interface{}{"content": "Tail."}},
	}

	fbs, err := BlockDocToFrontendBlocks(doc)
	if err != nil {
		t.Fatalf("convert: %v", err)
	}
	if len(fbs) != 3 {
		t.Fatalf("want 3 frontend blocks, got %d: %+v", len(fbs), fbs)
	}

	// Prose carries its body in Attrs["content"] + handle + aliases.
	if fbs[0].Kind != KindProse || fbs[0].ID != "pr-1" || fbs[0].Attrs["content"] != "Hello **world**." {
		t.Fatalf("prose block 0: %+v", fbs[0])
	}
	if len(fbs[0].Aliases) != 1 || fbs[0].Aliases[0] != "pr-0" {
		t.Fatalf("prose block 0 aliases: %+v", fbs[0].Aliases)
	}

	// Structured carries its props in Attrs — no markdown/fence on the wire.
	if fbs[1].Kind != "code" || fbs[1].ID != "co-1" {
		t.Fatalf("structured block 1: %+v", fbs[1])
	}
	if fbs[1].Attrs["source"] != "x = 1" || fbs[1].Attrs["id"] != "co-1" {
		t.Fatalf("structured block 1 must carry its props in attrs: %+v", fbs[1].Attrs)
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
	doc := []domain.SieveBlock{
		{ID: "co-1", Kind: "code", Attrs: map[string]interface{}{"id": "co-1", "source": "x = 1"}},
		{ID: "pr-1", Kind: KindProse, Attrs: map[string]interface{}{"content": "Prose."}},
	}
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

// The wire projection the WYSIWYG load consumes must carry Attrs["id"] for a block
// whose id was minted (the end-to-end guard for the vanishing code block).
func TestBlockDocToFrontendBlocks_carriesID(t *testing.T) {
	b := domain.NewSieveBlock("code", "", map[string]interface{}{"source": "x"})
	fb, err := BlockDocToFrontendBlocks([]domain.SieveBlock{b})
	if err != nil {
		t.Fatal(err)
	}
	if got, _ := fb[0].Attrs["id"].(string); got != b.ID || got == "" {
		t.Fatalf("wire Attrs[\"id\"] = %q, want %q", got, b.ID)
	}
}
