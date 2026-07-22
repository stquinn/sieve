package block

import (
	"strings"
	"testing"
)

// dropKind builds the closure BlockFilter callers pass to drop exactly one kind.
func dropKind(kind string) BlockFilter {
	return func(b SieveBlock) bool { return b.Kind != kind }
}

// deriveMarkdownFiltered with a filter dropping ai-blocks must serialize prose +
// code UNCHANGED (byte-identical to the unfiltered whole minus the ai-block), and
// must NOT contain the ai-block fence or its stale response text. A nil filter
// yields today's full output. This is the TARGET-leak fix at the DocView seam.
func TestDeriveMarkdownFiltered_DropsAIBlock(t *testing.T) {
	codec := NewDocumentCodec(GlobalRegistry())
	blocks := []SieveBlock{
		{ID: "pr-1", Kind: KindProse, Attrs: map[string]interface{}{"content": "Original prose."}},
		{ID: "co-1", Kind: "code", Attrs: map[string]interface{}{"id": "co-1", "source": "x = 1"}},
		{ID: "ab-1", Kind: "ai-block", Attrs: map[string]interface{}{
			"id": "ab-1", "question": "what is x?", "response": "stale answer about x",
		}},
	}
	doc := DocView{Blocks: blocks, codec: codec}

	// Nil filter == today's full output.
	full := doc.deriveMarkdownFiltered(nil)
	if full != doc.deriveMarkdown() {
		t.Fatalf("nil filter must equal deriveMarkdown().\nnil:  %q\nbase: %q", full, doc.deriveMarkdown())
	}
	if !strings.Contains(full, "stale answer about x") {
		t.Fatalf("sanity: unfiltered output should carry the ai-block response, got %q", full)
	}

	// Filtered: ai-block gone, everything else byte-identical.
	filtered := doc.deriveMarkdownFiltered(dropKind("ai-block"))
	if strings.Contains(filtered, "ai-block") || strings.Contains(filtered, "stale answer about x") {
		t.Fatalf("filtered output must not contain the ai-block fence or its response, got %q", filtered)
	}

	// Byte-identical to serializing just the surviving blocks.
	want, err := codec.Serialize([]SieveBlock{blocks[0], blocks[1]})
	if err != nil {
		t.Fatalf("serialize survivors: %v", err)
	}
	if filtered != want {
		t.Fatalf("filtered output not byte-identical to survivors.\ngot:  %q\nwant: %q", filtered, want)
	}
	if !strings.Contains(filtered, "Original prose.") || !strings.Contains(filtered, "x = 1") {
		t.Fatalf("filtered output lost prose or code, got %q", filtered)
	}
}

// Markdown (breakglass) mode has no block tree to filter: the raw buffer is
// returned verbatim regardless of the filter — the documented conscious gap.
func TestDeriveMarkdownFiltered_MarkdownModeReturnsRawBuffer(t *testing.T) {
	raw := "# Heading\n\n```ai-block\nid: ab-1\nresponse: still here\n```"
	doc := DocView{rawAuthoritative: true, mdModeBuffer: raw}
	if got := doc.deriveMarkdownFiltered(dropKind("ai-block")); got != raw {
		t.Fatalf("markdown mode must return raw buffer verbatim even with a filter, got %q", got)
	}
}
