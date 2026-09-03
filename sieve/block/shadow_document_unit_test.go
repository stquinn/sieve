package block

import (
	"strings"
	"testing"
)

// ShadowDocument unit tests (white-box: same package as ShadowDocument). These
// exercise data mechanics that do NOT serialize prose, so they need no processor
// registry — construction via the struct + internal accessors is legitimate here.

func TestContentForSave_markdownModeIsVerbatim(t *testing.T) {
	md := "# Hello\n\n```ai-block\nid: ab-1234\nresponse: original\n```"
	shadow := &ShadowDocument{
		UUID:             "test-uuid",
		mdModeBuffer:     md,
		rawAuthoritative: true,
	}

	result := shadow.ContentForSave()

	if result != md {
		t.Errorf("expected ContentForSave to return markdown verbatim, got:\n%s", result)
	}
}

// Editor mechanic: a SetBlock update must win in ContentForSave, and sibling
// blocks are preserved. Kind-agnostic — uses a fake block, not prose/ai (this is
// not a prose test).
func TestContentForSave_replacesBlockInWysiwyg(t *testing.T) {
	ResetRegistry()
	RegisterProcessor(newFakeProc("fk"))
	t.Cleanup(ResetRegistry)

	shadow := &ShadowDocument{
		UUID:  "test-uuid",
		codec: NewDocumentCodec(GlobalRegistry()),
		Blocks: []SieveBlock{
			{ID: "fk-1", Kind: "fk", Attrs: map[string]interface{}{"id": "fk-1", "response": "Old answer"}},
			{ID: "fk-2", Kind: "fk", Attrs: map[string]interface{}{"id": "fk-2", "keep": "me"}},
		},
	}

	shadow.MergeBlock(SieveBlock{ID: "fk-1", Kind: "fk", Attrs: map[string]interface{}{"response": "New answer"}})

	result := shadow.ContentForSave()
	if !strings.Contains(result, "response: New answer") {
		t.Errorf("expected updated response in save, got:\n%s", result)
	}
	if strings.Contains(result, "Old answer") {
		t.Errorf("expected old response gone, got:\n%s", result)
	}
	if !strings.Contains(result, "keep: me") {
		t.Errorf("expected sibling block preserved, got:\n%s", result)
	}
}

func TestShadowDocument_setBlockCreatesEntry(t *testing.T) {
	shadow := &ShadowDocument{UUID: "test-uuid"}

	shadow.MergeBlock(SieveBlock{
		Kind:  "code",
		ID:    "cb-0001",
		Attrs: map[string]interface{}{"id": "cb-0001", "source": "fmt.Println()"},
	})

	blk := shadow.findBlockIn("cb-0001")
	if blk == nil {
		t.Fatal("expected block cb-0001 to exist")
	}
	if blk.Kind != "code" {
		t.Errorf("expected Kind=code, got %q", blk.Kind)
	}
}

func TestShadowDocument_setBlockMergesAttrs(t *testing.T) {
	shadow := &ShadowDocument{
		UUID: "test-uuid",
		Blocks: []SieveBlock{
			{ID: "cb-0001", Kind: "code", Attrs: map[string]interface{}{
				"id": "cb-0001", "source": "old", "language": "unknown",
			}},
		},
	}

	shadow.MergeBlock(SieveBlock{
		Kind:  "code",
		ID:    "cb-0001",
		Attrs: map[string]interface{}{"language": "python", "status": "COMPLETE"},
	})

	blk := shadow.findBlockIn("cb-0001")
	if blk.Attrs["source"] != "old" {
		t.Errorf("expected source to be preserved, got %v", blk.Attrs["source"])
	}
	if blk.Attrs["language"] != "python" {
		t.Errorf("expected language=python, got %v", blk.Attrs["language"])
	}
	if !strings.Contains(blk.StringAttr("status"), "COMPLETE") {
		t.Errorf("expected status merged, got %v", blk.Attrs["status"])
	}
}

// ResolveAnchor is the whole translation between how the wire names a position
// (the block it follows) and the index every insertion path takes. These five
// statements are all an anchor can make.
func TestShadowDocument_ResolveAnchor(t *testing.T) {
	shadow := &ShadowDocument{
		UUID:   "test-uuid",
		Blocks: []SieveBlock{{ID: "b1", Kind: "code"}, {ID: "b2", Kind: "code"}, {ID: "b3", Kind: "code"}},
	}
	for _, tc := range []struct {
		name   string
		anchor Anchor
		want   int
	}{
		{"after the first block", Anchor{AfterBlockID: "b1"}, 1},
		{"after the last block", Anchor{AfterBlockID: "b3"}, 3},
		{"after a block this document does not hold", Anchor{AfterBlockID: "gone"}, AppendIndex},
		{"the front", Anchor{AtFront: true}, 0},
		{"no anchor at all", Anchor{}, AppendIndex},
		{"an id wins over the front", Anchor{AfterBlockID: "b1", AtFront: true}, 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := shadow.ResolveAnchor(tc.anchor); got != tc.want {
				t.Errorf("ResolveAnchor(%+v) = %d, want %d", tc.anchor, got, tc.want)
			}
		})
	}
}

// A resolved AppendIndex must reach the end of the document, never the front —
// the direction a naive negative clamp gets wrong.
func TestShadowDocument_insertBlockAtAppendsOnAppendIndex(t *testing.T) {
	shadow := &ShadowDocument{UUID: "test-uuid", Blocks: []SieveBlock{{ID: "b1"}, {ID: "b2"}}}
	shadow.insertBlockAt(AppendIndex, SieveBlock{ID: "new"})
	if got := shadow.Blocks[len(shadow.Blocks)-1].ID; got != "new" {
		t.Errorf("AppendIndex must land at the end; document is %v", shadow.Blocks)
	}
}
