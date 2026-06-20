package processors

import (
	"testing"

	"sieve/sieve/block"
)

// In markdown (breakglass) mode the live Blocks tree is FROZEN while the user edits
// the raw buffer. SnapshotForJob must still hand a background job a COHERENT DocView:
// a per-block read (e.g. an AI ref chain resolved while the job runs) must reflect
// the fresh buffer, not the stale frozen tree. Save stays verbatim — that is the
// separate ContentForSave guarantee, untouched here. Codec-exercising, so it lives
// with the real ProseProcessor and uses only ShadowDocument's PUBLIC API.
func TestSnapshotForJob_markdownModeDerivesBlocksFromBuffer(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor("ai-block", NewAIBlockProcessor(block.BlockServices{}))
	t.Cleanup(resetRegistry)

	codec := block.NewDocumentCodec(block.GlobalRegistry())
	// Frozen tree (parsed on open) carries STALE content for ab-1.
	shadow := block.NewShadow("u", "```ai-block\nid: ab-1\nresponse: STALE\n```", codec, 0, nil)
	// Flip to markdown breakglass mode; the buffer (authoritative) carries FRESH
	// content. The frozen tree still says STALE.
	shadow.EnterMarkdownMode("```ai-block\nid: ab-1\nresponse: FRESH\n```")

	_, doc, ok := shadow.SnapshotForJob("ab-1")
	if !ok {
		t.Fatal("expected SnapshotForJob to find ab-1")
	}
	blk, found := doc.GetBlock("ab-1")
	if !found {
		t.Fatal("expected DocView.GetBlock to resolve ab-1")
	}
	if got := blk.StringAttr("response"); got != "FRESH" {
		t.Errorf("markdown-mode snapshot served stale per-block content: response=%q, want FRESH", got)
	}
}
