package processors

import (
	"strings"
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
	block.RegisterProcessor(NewAIBlockProcessor(block.BlockServices{}))
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

// Issue #49 Phase 2 caveat pin: EnterWysiwygMode COMMITS the markdown edit — it
// reparses the tree from the buffer, then lowers the raw-authoritative flag AND
// clears the buffer. After the round-trip the shadow is wysiwyg-authoritative: a
// subsequent TREE edit must win in ContentForSave, proving the (now cleared)
// buffer is no longer consulted. The old code left mdModeBuffer set on wysiwyg
// re-entry — one refactor away from a stale-buffer bug had derivation keyed on
// buffer non-emptiness instead of the explicit flag.
func TestEnterWysiwygMode_roundTripLeavesTreeAuthoritative(t *testing.T) {
	resetRegistry()
	block.RegisterProcessor(NewAIBlockProcessor(block.BlockServices{}))
	t.Cleanup(resetRegistry)

	codec := block.NewDocumentCodec(block.GlobalRegistry())
	shadow := block.NewShadow("u", "```ai-block\nid: ab-1\nresponse: ORIGINAL\n```", codec, 0, nil)

	// Round-trip through markdown mode: the buffer carries an interim edit, then
	// EnterWysiwygMode commits it back into the tree.
	shadow.EnterMarkdownMode("```ai-block\nid: ab-1\nresponse: FROM_BUFFER\n```")
	shadow.EnterWysiwygMode()

	// The commit is visible (tree reparsed from the buffer).
	if got := shadow.ContentForSave(); !strings.Contains(got, "FROM_BUFFER") {
		t.Fatalf("expected the committed buffer edit in the tree, got:\n%s", got)
	}

	// Now edit the TREE. If the shadow were still (wrongly) raw-authoritative on a
	// leftover buffer, this update would be invisible to save. It must win.
	shadow.MergeBlock(block.SieveBlock{ID: "ab-1", Kind: "ai-block", Attrs: map[string]interface{}{"response": "FROM_TREE"}})
	got := shadow.ContentForSave()
	if !strings.Contains(got, "FROM_TREE") {
		t.Errorf("post-round-trip tree edit lost — shadow is not wysiwyg-authoritative:\n%s", got)
	}
	if strings.Contains(got, "FROM_BUFFER") {
		t.Errorf("stale markdown buffer leaked after the round-trip:\n%s", got)
	}
}
