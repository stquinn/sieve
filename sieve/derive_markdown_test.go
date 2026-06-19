package sieve

import (
	"strings"
	"testing"
)

// The drift bug Task 3 fixes: an id=="doc" AI ask in WYSIWYG mode must reflect
// the CURRENT tree, not a stale stored Markdown field. D-r.5 stopped prose
// doc-updates, so a prose-only session's old Markdown field went stale —
// deriveMarkdown serializes the live tree instead, so it can never drift.
func TestDeriveMarkdown_WysiwygReflectsLiveTree(t *testing.T) {
	shadow := &ShadowDocument{
		UUID: "u",
		Mode: "wysiwyg",
		Blocks: []SieveBlock{
			{ID: "pr-1", Kind: KindProse, Attrs: map[string]interface{}{"content": "Original prose."}},
		},
	}

	// Mutate the tree the way an edit would — no Markdown field to keep in sync.
	shadow.setBlock(SieveBlock{ID: "ab-1", Kind: "ai-block", Attrs: map[string]interface{}{
		"id": "ab-1", "response": "fresh answer",
	}})

	got := BuildContextForID("doc", DocView{Mode: "wysiwyg", Blocks: shadow.Blocks}, map[string]bool{})
	if !strings.Contains(got, "Original prose.") {
		t.Errorf("doc context lost prose: %q", got)
	}
	if !strings.Contains(got, "fresh answer") {
		t.Errorf("doc context did not reflect the live tree edit: %q", got)
	}
}

// Markdown mode is authoritative on the raw buffer: deriveMarkdown returns it
// verbatim, NOT a re-serialization of the (frozen) tree.
func TestDeriveMarkdown_MarkdownModeIsRawBuffer(t *testing.T) {
	raw := "# Heading\n\nuser is mid-typing ```cod"
	shadow := &ShadowDocument{UUID: "u", Mode: "markdown", mdModeBuffer: raw}
	if got := shadow.deriveMarkdown(); got != raw {
		t.Errorf("markdown mode must return raw buffer verbatim, got %q", got)
	}
}
