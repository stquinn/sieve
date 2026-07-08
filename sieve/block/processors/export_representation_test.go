package processors

import (
	"sieve/sieve/block"
	"testing"
)

// SmartCard and WebClip must satisfy block.ExportRepresenter so clean export uses
// their reduced form instead of the richer MarkdownRepresentation (AI context).
func TestExportRepresenter_implementedBySmartCardAndWebClip(t *testing.T) {
	var _ block.ExportRepresenter = NewSmartCardProcessor(block.BlockServices{})
	var _ block.ExportRepresenter = NewWebClipBlockProcessor(block.BlockServices{})
}

// A URL card's clean export reduces to a plain [title](href) link — the derived
// siteName/description (which MarkdownRepresentation embeds for AI context) is DROPPED
// because export preserves only the user-authored seed (the URL + resolved title).
func TestSmartCardProcessor_ExportMarkdown_reducesToLink(t *testing.T) {
	p := NewSmartCardProcessor(block.BlockServices{})

	full := block.SieveBlock{Kind: "smart-card", Attrs: map[string]interface{}{
		"href":        "https://example.com",
		"title":       "Example",
		"siteName":    "Example.com",
		"description": "A long derived description that must NOT appear in export.",
	}}
	if got, want := p.ExportMarkdown(full, ""), "[Example](https://example.com)"; got != want {
		t.Errorf("ExportMarkdown: got %q, want %q", got, want)
	}
	// Sanity: the AI-facing representation still carries the derived content.
	if md := p.MarkdownRepresentation(full, ""); md == "[Example](https://example.com)" {
		t.Errorf("MarkdownRepresentation must keep its richer form for AI context, got %q", md)
	}

	// No title ⇒ bare URL.
	bare := block.SieveBlock{Kind: "smart-card", Attrs: map[string]interface{}{"href": "https://bare.example"}}
	if got, want := p.ExportMarkdown(bare, ""), "https://bare.example"; got != want {
		t.Errorf("ExportMarkdown (no title): got %q, want %q", got, want)
	}

	// No href ⇒ nothing to export.
	if got := p.ExportMarkdown(block.SieveBlock{Kind: "smart-card", Attrs: map[string]interface{}{}}, ""); got != "" {
		t.Errorf("ExportMarkdown (no href): got %q, want empty", got)
	}
}

// A web-clip's clean export reduces to a plain [title](source) link to the clipped
// page — the clipped/summarised content (which MarkdownRepresentation embeds) is
// DROPPED, keeping only the user-authored seed (the source URL + resolved title).
func TestWebClipProcessor_ExportMarkdown_reducesToLink(t *testing.T) {
	p := NewWebClipBlockProcessor(block.BlockServices{})

	full := block.SieveBlock{Kind: "web-clip", Attrs: map[string]interface{}{
		"source":  "https://news.example/article",
		"title":   "Big Story",
		"content": "The full clipped article body that must NOT appear in export.",
	}}
	if got, want := p.ExportMarkdown(full, ""), "[Big Story](https://news.example/article)"; got != want {
		t.Errorf("ExportMarkdown: got %q, want %q", got, want)
	}
	// Sanity: the AI-facing representation still embeds the clipped content.
	if md := p.MarkdownRepresentation(full, ""); md == "[Big Story](https://news.example/article)" {
		t.Errorf("MarkdownRepresentation must keep the full clipped content for AI context, got %q", md)
	}

	// No title ⇒ bare source URL.
	bare := block.SieveBlock{Kind: "web-clip", Attrs: map[string]interface{}{
		"source": "https://bare.example", "content": "body",
	}}
	if got, want := p.ExportMarkdown(bare, ""), "https://bare.example"; got != want {
		t.Errorf("ExportMarkdown (no title): got %q, want %q", got, want)
	}

	// No source ⇒ nothing to export.
	if got := p.ExportMarkdown(block.SieveBlock{Kind: "web-clip", Attrs: map[string]interface{}{"content": "body"}}, ""); got != "" {
		t.Errorf("ExportMarkdown (no source): got %q, want empty", got)
	}
}
