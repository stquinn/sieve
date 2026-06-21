package processors

import (
	"strings"
	"testing"

	"sieve/sieve/block"
)

// Prose-SPECIFIC ShadowDocument tests — they assert prose serialization / handle
// minting, so they live here, local to ProseProcessor (the real prose terminal),
// and use only ShadowDocument's PUBLIC API (NewShadow / SetMarkdown / ContentForSave).

func TestContentForSave_roundTripsWysiwyg(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor("ai-block", NewAIBlockProcessor(block.BlockServices{}))
	t.Cleanup(resetRegistry)

	md := "# Hello\n\n```ai-block\nid: ab-1234\nresponse: untouched\n```"
	shadow := block.NewShadow("test-uuid", md, block.NewDocumentCodec(block.GlobalRegistry()), 0, nil)

	result := shadow.ContentForSave()
	if !strings.Contains(result, "# Hello") || !strings.Contains(result, "response: untouched") {
		t.Fatalf("expected content preserved, got:\n%s", result)
	}
	// parse -> serialize -> parse is a fixpoint.
	if again := block.NewShadow("test-uuid", result, block.NewDocumentCodec(block.GlobalRegistry()), 0, nil).ContentForSave(); again != result {
		t.Fatalf("serialization not stable:\n first: %q\nsecond: %q", result, again)
	}
}

// A doc-update carrying id-less prose must never persist id-less: Go mints a
// handle for every id-less prose block on reparse, so ContentForSave always emits
// delimited, addressable blocks. Backend discipline — a block has an id, period.
func TestShadowDocument_DocUpdateMintsHandlesForIdlessProse(t *testing.T) {
	resetRegistry()
	t.Cleanup(resetRegistry)

	shadow := block.NewShadow("test-uuid", "", block.NewDocumentCodec(block.GlobalRegistry()), 0, nil)
	shadow.SetMarkdown("First paragraph.\n\nSecond paragraph.")

	for i, b := range shadow.Blocks {
		if b.Kind == block.KindProse && b.ID == "" {
			t.Fatalf("block %d persisted id-less: %+v", i, b)
		}
	}

	out := shadow.ContentForSave()
	if !strings.Contains(out, "<!--s:") || !strings.Contains(out, "<!--/s:") {
		t.Fatalf("expected delimited (id-bearing) prose on save, got:\n%s", out)
	}
	if again := block.NewShadow("test-uuid", out, block.NewDocumentCodec(block.GlobalRegistry()), 0, nil).ContentForSave(); again != out {
		t.Fatalf("minted handles not stable:\n first: %q\nsecond: %q", out, again)
	}
}
