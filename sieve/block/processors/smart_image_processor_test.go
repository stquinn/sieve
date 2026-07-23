package processors

import (
	"encoding/json"
	"sieve/sieve/block"
	"testing"
)

// A stored smart-image src is a bare asset filename. MarkdownRepresentation must emit a
// WORKING served URL (/sieve/<uuid>/<filename>) — not the bare filename — because the
// embedded markdown renders as a plain <img> with no NodeView resolveSrc to fix it.
// (Regression: embedding a smart-image produced ![](im-82d3.png), which 404s.)
func TestSmartImageProcessor_MarkdownRepresentation_servedURL(t *testing.T) {
	p := NewSmartImageProcessor(block.BlockServices{})
	blk := block.SieveBlock{Attrs: map[string]interface{}{"src": "im-82d3.png", "alt": "a sprite"}}

	got := p.MarkdownRepresentation(blk, "doc-uuid-1")
	want := "![a sprite](/sieve/doc-uuid-1/im-82d3.png)"
	if got != want {
		t.Errorf("MarkdownRepresentation: got %q, want %q (must carry the served /sieve/<uuid>/ URL)", got, want)
	}
}

func TestSmartImageProcessor_MarkdownRepresentation_stripsAssetsPrefixAndPath(t *testing.T) {
	p := NewSmartImageProcessor(block.BlockServices{})
	blk := block.SieveBlock{Attrs: map[string]interface{}{"src": ".assets/im-9.png"}}

	if got := p.MarkdownRepresentation(blk, "u1"); got != "![](/sieve/u1/im-9.png)" {
		t.Errorf("got %q, want the basename under /sieve/u1/", got)
	}
}

func TestSmartImageProcessor_MarkdownRepresentation_emptySrc(t *testing.T) {
	p := NewSmartImageProcessor(block.BlockServices{})
	if got := p.MarkdownRepresentation(block.SieveBlock{Attrs: map[string]interface{}{}}, "u1"); got != "" {
		t.Errorf("empty src must yield empty markdown, got %q", got)
	}
}

// A plantuml diagram entry only has something to extract once it has actually
// been rendered — the frontend's acquisition path (renderDiagramSvgEntry) fetches
// the persisted svgAsset; a never-rendered block has no SVG to fetch.
func TestSmartImageProcessor_IsSupportedContent_plantumlWithSvgAssetOffersSieveActions(t *testing.T) {
	p := NewSmartImageProcessor(block.BlockServices{})
	attrs := map[string]interface{}{
		"diagramType": "plantuml",
		"source":      "A -> B",
		"svgAsset":    "di-1.svg",
	}
	raw, err := json.Marshal(attrs)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	entries := []block.ContentEntry{{MIMEType: "sieve/diagram", Content: string(raw)}}

	got := p.IsSupportedContent(entries)
	if !got.Has(block.ActionExtract) {
		t.Error("plantuml diagram with a non-empty svgAsset must offer extract-to-image")
	}
}

func TestSmartImageProcessor_IsSupportedContent_plantumlWithoutSvgAssetNotOffered(t *testing.T) {
	p := NewSmartImageProcessor(block.BlockServices{})
	attrs := map[string]interface{}{
		"diagramType": "plantuml",
		"source":      "A -> B",
		"svgAsset":    "",
	}
	raw, err := json.Marshal(attrs)
	if err != nil {
		t.Fatalf("marshal fixture: %v", err)
	}
	entries := []block.ContentEntry{{MIMEType: "sieve/diagram", Content: string(raw)}}

	got := p.IsSupportedContent(entries)
	if got.Has(block.ActionExtract) {
		t.Error("plantuml diagram with no rendered svgAsset must not offer extract-to-image — there is nothing to extract yet")
	}
}

// The raw ```plantuml fence path stays mermaid-only: there is no client-side
// plantuml renderer able to resolve a bare fence into an image (unlike mermaid,
// which SmartImageRenderer's resolveEntries renders locally).
func TestSmartImageProcessor_IsSupportedContent_plantumlFenceNotOffered(t *testing.T) {
	p := NewSmartImageProcessor(block.BlockServices{})
	content := "```plantuml\n@startuml\nA -> B\n@enduml\n```"
	entries := []block.ContentEntry{{MIMEType: "text/plain", Content: content}}

	got := p.IsSupportedContent(entries)
	if got.Has(block.ActionPaste) || got.Has(block.ActionTransform) {
		t.Error("a raw plantuml fence must not be offered as smart-image content")
	}
}
