package processors

import (
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
