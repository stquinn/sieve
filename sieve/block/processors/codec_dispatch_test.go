package processors

import (
	"strings"
	"testing"

	"sieve/sieve/block"
)

// A prose block whose content contains a fence round-trips as ONE prose block with
// its id preserved (the shape parser delivers the whole <!--s:--> span opaquely, so
// the inner fence is never split out). This is the core guarantee of the
// segmentation work and must hold across the dispatch rewrite.
func TestCodec_proseBlockContainingFence_roundTripsAsOneBlock(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor("ai-block", NewAIBlockProcessor(block.BlockServices{}))
	t.Cleanup(resetRegistry)

	codec := block.NewDocumentCodec(block.GlobalRegistry())
	src := "<!--s:pr-1-->\nNotes.\n\n```mermaid\ngraph\n```\n\nMore.\n<!--/s:pr-1-->"
	blocks, err := codec.Deserialize(src)
	if err != nil {
		t.Fatalf("deserialize: %v", err)
	}
	if len(blocks) != 1 {
		t.Fatalf("want 1 block, got %d: %#v", len(blocks), blocks)
	}
	if blocks[0].ID != "pr-1" || blocks[0].Kind != block.KindProse {
		t.Fatalf("want prose pr-1, got id=%q kind=%q", blocks[0].ID, blocks[0].Kind)
	}
	if !strings.Contains(blocks[0].Content(), "```mermaid") {
		t.Fatalf("inner fence lost: %q", blocks[0].Content())
	}
}

// A structured block between two prose runs dispatches to its own processor (not
// prose), and the prose runs surround it — prose is the terminal acceptor, never
// shadowing a structured recogniser.
func TestCodec_structuredBlockBetweenProse_dispatchesByKind(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor("ai-block", NewAIBlockProcessor(block.BlockServices{}))
	t.Cleanup(resetRegistry)

	codec := block.NewDocumentCodec(block.GlobalRegistry())
	src := "<!--s:pr-1-->\nbefore\n<!--/s:pr-1-->\n\n```ai-block\nid: ab-1\nresponse: hi\n```\n\n<!--s:pr-2-->\nafter\n<!--/s:pr-2-->"
	blocks, err := codec.Deserialize(src)
	if err != nil {
		t.Fatalf("deserialize: %v", err)
	}
	if len(blocks) != 3 {
		t.Fatalf("want 3 blocks (prose, ai-block, prose), got %d: %#v", len(blocks), blocks)
	}
	if blocks[0].Kind != block.KindProse || blocks[1].Kind != "ai-block" || blocks[2].Kind != block.KindProse {
		t.Fatalf("kinds: %q %q %q", blocks[0].Kind, blocks[1].Kind, blocks[2].Kind)
	}
	if blocks[1].ID != "ab-1" {
		t.Fatalf("ai-block id: %q", blocks[1].ID)
	}
}
