package block

import (
	"strings"
	"testing"
	"time"

	"sieve/sieve/domain"
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
		LiveBlocks: LiveBlocks{Blocks: []domain.SieveBlock{
			{ID: "fk-1", Kind: "fk", Attrs: map[string]interface{}{"id": "fk-1", "response": "Old answer"}},
			{ID: "fk-2", Kind: "fk", Attrs: map[string]interface{}{"id": "fk-2", "keep": "me"}},
		}},
	}

	shadow.MergeBlock(domain.SieveBlock{ID: "fk-1", Kind: "fk", Attrs: map[string]interface{}{"response": "New answer"}})

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

// ResolveAnchor is the whole translation between how the wire names a position
// (the block it follows) and the index every insertion path takes. These five
// statements are all an anchor can make.
func TestShadowDocument_ResolveAnchor(t *testing.T) {
	shadow := &ShadowDocument{
		UUID:       "test-uuid",
		LiveBlocks: LiveBlocks{Blocks: []domain.SieveBlock{{ID: "b1", Kind: "code"}, {ID: "b2", Kind: "code"}, {ID: "b3", Kind: "code"}}},
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
	shadow := &ShadowDocument{UUID: "test-uuid", LiveBlocks: LiveBlocks{Blocks: []domain.SieveBlock{{ID: "b1"}, {ID: "b2"}}}}
	shadow.insertBlockAt(AppendIndex, domain.SieveBlock{ID: "new"})
	if got := shadow.Blocks[len(shadow.Blocks)-1].ID; got != "new" {
		t.Errorf("AppendIndex must land at the end; document is %v", shadow.Blocks)
	}
}

// A document's LiveBlocks hook is its autosave: a job's patch arms the
// debounce, and a job's claim does not.
func TestShadowDocument_liveBlocksHookArmsTheDebounce(t *testing.T) {
	for _, tc := range []struct {
		name  string
		op    func(s *ShadowDocument)
		armed bool
	}{
		{"PatchBlock", func(s *ShadowDocument) {
			s.PatchBlock(domain.SieveBlock{ID: "b", Attrs: map[string]interface{}{"k": "v"}})
		}, true},
		{"TryDispatch", func(s *ShadowDocument) { s.TryDispatch("b") }, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			shadow := NewShadow("test-uuid", "", NewDocumentCodec(GlobalRegistry()), time.Hour, func() {})
			t.Cleanup(shadow.StopDebounce)
			shadow.Blocks = []domain.SieveBlock{{ID: "b", Kind: "code", Attrs: map[string]interface{}{"status": BlockStatusPending}}}
			tc.op(shadow)
			shadow.mu.Lock()
			armed := shadow.timer != nil
			shadow.mu.Unlock()
			if armed != tc.armed {
				t.Errorf("debounce armed = %v, want %v", armed, tc.armed)
			}
		})
	}
}
