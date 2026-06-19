package sieve

import (
	"strings"
	"testing"
)

// The core tenet of the block-document model (brainstorm-block-document-model.md
// §42): serialization is a per-BlockProcessor concern. The save spine WALKS the
// blocks and asks EACH flavour to serialize itself — no `if KindProse`, no free
// serializer functions. Prose owns its markers; structured kinds share the fence.
func TestSerialize_IsProcessorOwned_NoKindSwitch(t *testing.T) {
	resetRegistry() // restores the built-in prose flavour
	RegisterProcessor("code", &CodeBlockProcessor{})
	t.Cleanup(func() { UnregisterProcessor("code") })

	blocks := []SieveBlock{
		{ID: "pr-1", Kind: KindProse, Attrs: map[string]interface{}{"content": "Hello **world**."}},
		{ID: "co-1", Kind: "code", Attrs: map[string]interface{}{"id": "co-1", "source": "x = 1"}},
	}

	got, err := SerializeBlockDocWithHandles(blocks)
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}

	// Prose serialized BY ProseProcessor — content wrapped in handle markers.
	wantProse := "<!--s:pr-1-->\nHello **world**.\n<!--/s:pr-1-->"
	if !strings.Contains(got, wantProse) {
		t.Fatalf("prose not serialized by its flavour (markers):\n%s", got)
	}
	// Structured serialized BY the shared FencedSerializer — a fence.
	if !strings.Contains(got, "```code\nid: co-1\nsource: x = 1\n```") {
		t.Fatalf("code not serialized via the shared fenced flavour:\n%s", got)
	}
}

// ProseProcessor owns prose serialization directly — the delimiters live ON the
// flavour, not in the spine.
func TestProseProcessor_Serialize_InjectsHandleDelimiters(t *testing.T) {
	p := &ProseProcessor{}
	got, err := p.Serialize(SieveBlock{
		ID:      "pr-aaaa",
		Kind:    KindProse,
		Attrs:   map[string]interface{}{"content": "Merged block."},
		Aliases: []string{"pr-bbbb"},
	})
	if err != nil {
		t.Fatalf("serialize: %v", err)
	}
	want := "<!--s:pr-aaaa pr-bbbb-->\nMerged block.\n<!--/s:pr-aaaa-->"
	if got != want {
		t.Fatalf("prose serialize:\n got: %q\nwant: %q", got, want)
	}
}

// Prose extract seam: Transform turns entries (e.g. an AI block's table) into a
// prose block's content — so "extract into the document as prose" has a path.
func TestProseProcessor_Transform_ExtractsEntriesToContent(t *testing.T) {
	p := &ProseProcessor{}
	attrs := p.Transform([]ContentEntry{
		{MIMEType: "text/markdown", Content: "| a | b |\n|---|---|\n| 1 | 2 |"},
	}, "uuid", "pr-1")
	if attrs["content"] != "| a | b |\n|---|---|\n| 1 | 2 |" {
		t.Fatalf("extract to prose content failed: %+v", attrs)
	}
}
