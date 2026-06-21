package processors

import (
	"sieve/sieve/block"
	"strings"
	"testing"
)

// TestProseProcessor_BuildContextEmitsHighlightTargets: the retired block-anchor's
// "Specifically regarding" targets feature is replicated on prose — derived from
// the ==highlighted== words that live in the block's content.
func TestProseProcessor_BuildContextEmitsHighlightTargets(t *testing.T) {
	var p ProseProcessor
	blk := block.NewSieveBlock(block.KindProse, "pr-1", "The patient showed ==acute== and ==rapid onset== symptoms.", nil)
	ctx := p.BuildContext(blk, block.DocView{}, nil).String()
	if !strings.Contains(ctx, "Specifically regarding") {
		t.Errorf("expected targets hint, got %q", ctx)
	}
	if !strings.Contains(ctx, `"acute"`) || !strings.Contains(ctx, `"rapid onset"`) {
		t.Errorf("expected both targets quoted, got %q", ctx)
	}
	if !strings.Contains(ctx, "==acute==") {
		t.Errorf("expected highlight content preserved verbatim, got %q", ctx)
	}
}

func TestProseProcessor_BuildContextNoHighlightsNoHint(t *testing.T) {
	var p ProseProcessor
	blk := block.NewSieveBlock(block.KindProse, "pr-1", "Plain prose, no highlights.", nil)
	ctx := p.BuildContext(blk, block.DocView{}, nil).String()
	if strings.Contains(ctx, "Specifically regarding") {
		t.Errorf("expected no hint without highlights, got %q", ctx)
	}
}

func TestProseProcessor_DeserializeSplitsAtMarkers(t *testing.T) {
	var p ProseProcessor
	raw := "<!--s:pr-1-->\nHello world\n<!--/s:pr-1-->\n\n<!--s:pr-2 pr-old-->\nSecond\n<!--/s:pr-2-->"
	blocks, err := p.Deserialize(block.Region{Raw: raw})
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 2 {
		t.Fatalf("want 2 prose blocks, got %d: %#v", len(blocks), blocks)
	}
	if blocks[0].ID != "pr-1" || blocks[0].Content() != "Hello world" {
		t.Errorf("block0 = %q/%q", blocks[0].ID, blocks[0].Content())
	}
	if blocks[1].ID != "pr-2" || len(blocks[1].Aliases) != 1 || blocks[1].Aliases[0] != "pr-old" {
		t.Errorf("block1 id/aliases = %q/%v", blocks[1].ID, blocks[1].Aliases)
	}
}

func TestProseProcessor_DeserializeUndelimitedMintsOneBlock(t *testing.T) {
	var p ProseProcessor
	blocks, err := p.Deserialize(block.Region{Raw: "just some prose\nover two lines"})
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 1 || blocks[0].ID == "" {
		t.Fatalf("want one minted prose block, got %#v", blocks)
	}
	if blocks[0].Content() != "just some prose\nover two lines" {
		t.Errorf("content = %q", blocks[0].Content())
	}
}

func TestProseProcessor_DeserializeKeepsUnclaimedFenceAsContent(t *testing.T) {
	var p ProseProcessor
	raw := "text before\n```python\nprint(1)\n```\ntext after"
	blocks, err := p.Deserialize(block.Region{Raw: raw})
	if err != nil {
		t.Fatal(err)
	}
	if len(blocks) != 1 {
		t.Fatalf("want one prose block holding the fence verbatim, got %d", len(blocks))
	}
	if blocks[0].Content() != raw {
		t.Errorf("content = %q, want verbatim %q", blocks[0].Content(), raw)
	}
}

func TestProseProcessor_AcceptsIsTerminal(t *testing.T) {
	var p ProseProcessor
	if !p.Accepts(block.Region{Kind: "anything", Raw: "x"}) {
		t.Error("prose must accept everything (terminal mop-up)")
	}
}
