package processors

import (
	"testing"

	"sieve/sieve/block"
)

func TestProse_IsSupportedContent_anySieveSource_offersTransform(t *testing.T) {
	p := NewProseProcessor(block.BlockServices{})
	// A code block source (not sieve/prose) — prose must offer TRANSFORM (embed).
	got := p.IsSupportedContent([]block.ContentEntry{{MIMEType: "sieve/code", Content: `{"source":"x := 1","language":"go"}`}})
	if !got.Has(block.ActionTransform) {
		t.Fatalf("prose should offer transform for any sieve source, got %v", got.Actions)
	}
}

func TestProse_IsSupportedContent_ownKind_offersPasteAndTransform(t *testing.T) {
	p := NewProseProcessor(block.BlockServices{})
	// A copied prose block round-trips on paste AND can be embedded (transform).
	got := p.IsSupportedContent([]block.ContentEntry{{MIMEType: "sieve/prose", Content: `{"content":"hello"}`}})
	if !got.Has(block.ActionPaste) {
		t.Fatalf("prose should offer paste for sieve/prose source, got %v", got.Actions)
	}
	if !got.Has(block.ActionTransform) {
		t.Fatalf("prose should offer transform for sieve/prose source, got %v", got.Actions)
	}
}

func TestProse_IsSupportedContent_plainText_noMatch(t *testing.T) {
	p := NewProseProcessor(block.BlockServices{})
	got := p.IsSupportedContent([]block.ContentEntry{{MIMEType: "text/plain", Content: "hello"}})
	if len(got.Actions) != 0 {
		t.Fatalf("prose must never claim a non-sieve mime, got %v", got.Actions)
	}
}

// A code/diagram/log source embeds as its raw source text (not a fence).
func TestProse_Transform_codeSource_embedsRawSourceText(t *testing.T) {
	p := NewProseProcessor(block.BlockServices{})
	out := p.Transform([]block.ContentEntry{{MIMEType: "sieve/code", Content: `{"source":"x := 1","language":"go"}`}}, "uuid", "id", block.ActionTransform)
	if out["content"] != "x := 1" {
		t.Fatalf("code source should embed as its raw source text, got %v", out["content"])
	}
}

// Guards the data-loss bug: a code source with a MISSING "source" key must NOT yield
// content:nil (a silent blank block) — it falls through instead.
func TestProse_Transform_codeNoSource_neverNilContent(t *testing.T) {
	p := NewProseProcessor(block.BlockServices{})
	out := p.Transform([]block.ContentEntry{{MIMEType: "sieve/code", Content: `{"language":"go"}`}}, "uuid", "id", block.ActionTransform)
	if c, ok := out["content"]; !ok || c == nil {
		t.Fatalf("missing source must not produce nil content (data loss), got %#v", out["content"])
	}
}
