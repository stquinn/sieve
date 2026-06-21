package processors

import (
	"testing"

	"sieve/sieve/block"
)

// Regression: in production the DocumentCodec is constructed BEFORE the fenced
// processors register (service_provider builds the codec, then registers
// diagram/code/ai-block/…). The codec must collect shapes from the LIVE registry
// at scan time, not snapshot them at construction — otherwise it knows only the
// init-registered prose shape and every fence falls through to the prose mop-up
// ("all nodes become prose; AI blocks wrapped in prose delimiters").
func TestCodec_collectsShapesFromLiveRegistry_notConstructionTime(t *testing.T) {
	resetRegistry() // prose only (registered via init)
	// Build the codec FIRST — mirrors service_provider wiring order.
	codec := block.NewDocumentCodec(block.GlobalRegistry())
	// Register the fenced processor AFTER the codec exists.
	block.RegisterProcessor(NewAIBlockProcessor(block.BlockServices{}))
	t.Cleanup(resetRegistry)

	src := "```ai-block\nid: ab-1\nresponse: hi\n```"
	blocks, err := codec.Deserialize(src)
	if err != nil {
		t.Fatalf("deserialize: %v", err)
	}
	if len(blocks) != 1 {
		t.Fatalf("want 1 block, got %d: %#v", len(blocks), blocks)
	}
	if blocks[0].Kind != "ai-block" || blocks[0].ID != "ab-1" {
		t.Fatalf("ai-block must be recognised though the codec was built before it registered; got kind=%q id=%q (prose => the construction-order bug)", blocks[0].Kind, blocks[0].ID)
	}
}
